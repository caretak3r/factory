/**
 * Deterministic ReDoS guard for the model-controlled `grep` tool (SECURITY-02).
 *
 * Threat model: the regex pattern and flags come from LLM output (and are
 * therefore steerable via prompt injection — see SECURITY-03). A catastrophic-
 * backtracking pattern executed synchronously blocks the Workers isolate;
 * `withTimeout` in sandbox.ts is a Promise.race and cannot interrupt sync CPU.
 *
 * Strategy — deterministic bounds rather than "evil regex" detection:
 *
 *  1. `vetGrepPattern` syntactically rejects every construct that enables
 *     exponential backtracking in V8's engine: quantifiers applied to groups
 *     (`(...)+`, `(a+)+`), alternation INSIDE a group (`(a|a)`, `(.|.)` — a
 *     chain of these stacks to 2^k choice points with no quantifier at all),
 *     backreferences (`\1`, `\k<n>`), lookbehind, and lookahead. Top-level
 *     alternation (`TODO|FIXME`) is linear and stays allowed. It also caps length
 *     and the number of VARIABLE-WIDTH
 *     quantifiers (`*`, `+`, `{m,}`, and any `{m,n}` range — a `{0,50}`
 *     backtracks like `.*`), bounding the residual polynomial family
 *     (`a*a*a*b`, `.{0,50}.{0,50}...`) to degree <= MAX_GREP_VARIABLE_QUANTIFIERS.
 *
 *  2. `boundedGrepScan` hands the regex at most GREP_SEGMENT_LENGTH characters
 *     per `.test()` call and checks a wall-clock budget BETWEEN calls.
 *
 * PARTIAL MITIGATION — read before trusting this. Syntactic vetting cannot fully
 * bound a backtracking engine, and this guard does NOT. It rejects the worst
 * families (>1 variable-width quantifier, quantified/alternation groups,
 * lookahead/lookbehind, backrefs), but a single ACCEPTED pattern that combines
 * one greedy quantifier + an optional chain + a large fixed `{n}` tail — e.g.
 * `.+.?.?.?.?.?.{300}z` — still blocks ONE synchronous `.test()` for several
 * seconds (measured ~7.5s at 1024 chars, Node v26/V8). The budget is checked
 * only between lines, so it cannot interrupt that single call. Eliminating this
 * residual requires a linear-time engine (RE2) or genuinely interruptible
 * execution — see the SECURITY-02 follow-up. What this guard buys today: it
 * removes the 13-84s families and every construct-level exponential blowup.
 *
 * Pure module — no I/O — unit-tested in test/grep-guard.test.ts.
 */

export const MAX_GREP_PATTERN_LENGTH = 128;
export const MAX_GREP_PATTERN_QUANTIFIERS = 8;
/**
 * Max VARIABLE-WIDTH quantifiers (`*`, `+`, `{m,}`, and ANY `{m,n}` range) in
 * one pattern. Kept at 1 (not 2) because it strictly LOWERS the residual worst
 * case, not because it makes the guard safe: at 2, `.*.*.{500}z` blocks a single
 * `.test()` ~84s; at 1 the worst known accepted pattern (`.+.?.?.?.?.?.{300}z`)
 * blocks ~7.5s. A lone greedy `.+`/`.*` plus the engine's unanchored
 * start-position retry ALREADY yields O(n^2); an optional chain (2^k) and a
 * fixed `{n}` tail (O(n) rescan) multiply it further. This cap is a mitigation
 * — the residual is only removed by a linear-time engine or interruptible
 * execution (SECURITY-02 follow-up), never by syntactic degree analysis.
 */
export const MAX_GREP_VARIABLE_QUANTIFIERS = 1;
/** Max characters handed to a single RegExp.test() call. */
export const GREP_SEGMENT_LENGTH = 1024;
/** Wall-clock budget for one grep scan, checked between .test() calls. */
export const GREP_BUDGET_MS = 2000;
export const MAX_GREP_MATCHES = 200;
/** Matched lines longer than this are truncated in the tool output. */
export const GREP_OUTPUT_SNIPPET_LENGTH = 2000;

export type PatternVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Single-pass, escape- and character-class-aware syntactic vet.
 * Rejects, in order: overlong patterns, lookbehind, backreferences,
 * quantified groups, alternation inside a group, too many quantifiers, too many
 * variable-width quantifiers.
 */
export function vetGrepPattern(pattern: string): PatternVerdict {
  if (pattern.length > MAX_GREP_PATTERN_LENGTH) {
    return {
      ok: false,
      reason: `pattern too long (${pattern.length} chars, max ${MAX_GREP_PATTERN_LENGTH})`,
    };
  }
  if (pattern.includes("(?<=") || pattern.includes("(?<!")) {
    return { ok: false, reason: "lookbehind is not allowed" };
  }
  if (pattern.includes("(?=") || pattern.includes("(?!")) {
    // A lookahead is re-evaluated at every start position, so an inner scan
    // (e.g. `(?=.*.{n}x)`) re-introduces the per-position multiplier that the
    // single-variable cap removes from the main pattern. Grep needs no
    // lookahead; reject it outright (SECURITY-02).
    return { ok: false, reason: "lookahead is not allowed" };
  }

  let escaped = false;
  let inClass = false;
  let prevGroupClose = false;
  let quantifiers = 0;
  let variable = 0;
  let parenDepth = 0;

  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (escaped) {
      if (ch >= "1" && ch <= "9") {
        return { ok: false, reason: "backreferences are not allowed" };
      }
      if (ch === "k") {
        return { ok: false, reason: "named backreferences are not allowed" };
      }
      escaped = false;
      prevGroupClose = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      prevGroupClose = false;
      continue;
    }
    if (ch === "*" || ch === "+" || ch === "?" || ch === "{") {
      quantifiers++;
      if (ch === "*" || ch === "+") {
        variable++;
      } else if (ch === "{") {
        // A repeat containing a comma ({m,} or {m,n}) is variable-width and
        // drives the same backtracking degree as `*`/`+`; the upper bound only
        // caps the per-level constant, not the degree. {n} (no comma) is
        // fixed-width and cannot backtrack.
        const m = pattern.slice(i + 1).match(/^\d+(,\d*)?\}/);
        if (m && m[1] !== undefined) {
          variable++;
        }
      }
      if (prevGroupClose) {
        return {
          ok: false,
          reason: "quantifier applied to a group is not allowed (ReDoS guard)",
        };
      }
      prevGroupClose = false;
      continue;
    }
    if (ch === "(") {
      parenDepth++;
      prevGroupClose = false;
      continue;
    }
    if (ch === ")") {
      if (parenDepth > 0) parenDepth--;
      prevGroupClose = true;
      continue;
    }
    if (ch === "|" && parenDepth > 0) {
      // A chain of ambiguous alternation groups — (a|a)(a|a)... or (.|.)(.|.)...
      // — has no quantifier yet explores 2^k paths on a failing tail, blocking
      // a single RegExp.test() for seconds. Top-level `|` (TODO|FIXME) is linear
      // and allowed; grouped `|` is not (SECURITY-02).
      return {
        ok: false,
        reason: "alternation inside a group is not allowed (ReDoS guard)",
      };
    }
    prevGroupClose = false;
  }

  if (quantifiers > MAX_GREP_PATTERN_QUANTIFIERS) {
    return {
      ok: false,
      reason: `too many quantifiers (${quantifiers}, max ${MAX_GREP_PATTERN_QUANTIFIERS})`,
    };
  }
  if (variable > MAX_GREP_VARIABLE_QUANTIFIERS) {
    return {
      ok: false,
      reason: `too many variable-width quantifiers (${variable}, max ${MAX_GREP_VARIABLE_QUANTIFIERS})`,
    };
  }
  return { ok: true };
}

export interface GrepScanOptions {
  segmentLength?: number;
  budgetMs?: number;
  matchCap?: number;
  snippetLength?: number;
  /** Injectable clock for tests; defaults to Date.now. */
  now?: () => number;
}

export interface GrepScanResult {
  /** "lineNumber: lineText" entries; long lines truncated to snippetLength. */
  matches: string[];
  /** True when the wall-clock budget expired before the scan finished. */
  aborted: boolean;
  /** True when matchCap was reached before the scan finished. */
  capped: boolean;
  scannedLines: number;
  totalLines: number;
}

/**
 * Budgeted line scan. Lines longer than segmentLength are tested in
 * consecutive segments (a match spanning a segment boundary may be missed —
 * documented limitation, keeps single .test() calls bounded).
 */
export function boundedGrepScan(
  text: string,
  regex: RegExp,
  opts: GrepScanOptions = {}
): GrepScanResult {
  const segmentLength = opts.segmentLength ?? GREP_SEGMENT_LENGTH;
  const budgetMs = opts.budgetMs ?? GREP_BUDGET_MS;
  const matchCap = opts.matchCap ?? MAX_GREP_MATCHES;
  const snippetLength = opts.snippetLength ?? GREP_OUTPUT_SNIPPET_LENGTH;
  const now = opts.now ?? Date.now;

  const start = now();
  const lines = text.split("\n");
  const matches: string[] = [];
  let aborted = false;
  let capped = false;
  let scannedLines = 0;

  outer: for (let i = 0; i < lines.length; i++) {
    if (now() - start > budgetMs) {
      aborted = true;
      break;
    }
    if (matches.length >= matchCap) {
      capped = true;
      break;
    }
    const line = lines[i];
    let hit = false;
    if (line.length <= segmentLength) {
      hit = regex.test(line);
      regex.lastIndex = 0; // reset for /g flag across calls
    } else {
      for (let off = 0; off < line.length; off += segmentLength) {
        if (now() - start > budgetMs) {
          aborted = true;
          break outer;
        }
        hit = regex.test(line.slice(off, off + segmentLength));
        regex.lastIndex = 0;
        if (hit) break;
      }
    }
    scannedLines = i + 1;
    if (hit) {
      const shown =
        line.length > snippetLength
          ? line.slice(0, snippetLength) + "...[line truncated]"
          : line;
      matches.push(`${i + 1}: ${shown}`);
    }
  }

  return { matches, aborted, capped, scannedLines, totalLines: lines.length };
}
