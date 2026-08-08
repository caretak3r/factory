/**
 * ReDoS guard for the model-controlled `grep` tool (SECURITY-02).
 *
 * Threat model: the regex pattern and flags come from LLM output (and are
 * therefore steerable via prompt injection — see SECURITY-03). A catastrophic-
 * backtracking pattern executed synchronously blocks the Workers isolate;
 * `withTimeout` in sandbox.ts is a Promise.race and cannot interrupt sync CPU.
 *
 * Strategy — linear-time execution, plus deterministic bounds as defense-in-depth:
 *
 *  1. `compileLinearPattern` compiles the pattern with RE2JS (a JS port of
 *     RE2's NFA simulation), which matches in O(input × pattern) with NO
 *     backtracking — the entire catastrophic-backtracking class, including the
 *     former residual `.+.?.?.?.?.?.{300}z` (~7.5s on one native `.test()` at
 *     1024 chars, Node v26/V8; ~3ms under RE2JS), is structurally impossible.
 *     RE2 also rejects backreferences and lookaround at compile time, so those
 *     cannot execute even if the syntactic vet were bypassed.
 *
 *  2. `vetGrepPattern` stays in front of the engine as defense-in-depth: it
 *     rejects quantified groups, grouped alternation, backreferences, and
 *     lookaround, and caps pattern length and variable-width quantifier count.
 *     Its job today is to keep the guarantees independent of the engine choice
 *     — if the execution path ever regresses to a backtracking engine, the vet
 *     again removes the worst (13-84s) construct families on its own.
 *
 *  3. `boundedGrepScan` hands the matcher at most GREP_SEGMENT_LENGTH
 *     characters per `.test()` call and checks a wall-clock budget BETWEEN
 *     calls, bounding total scan time and match-count output.
 *
 * Pure module — no I/O — unit-tested in test/grep-guard.test.ts.
 */

import { RE2JS } from "re2js";

export const MAX_GREP_PATTERN_LENGTH = 128;
export const MAX_GREP_PATTERN_QUANTIFIERS = 8;
/**
 * Max VARIABLE-WIDTH quantifiers (`*`, `+`, `{m,}`, and ANY `{m,n}` range) in
 * one pattern. Execution is linear-time (RE2JS), so this cap no longer bounds
 * the worst case — it exists as defense-in-depth for a hypothetical regression
 * to a backtracking engine, where at 2 variables `.*.*.{500}z` blocks a single
 * native `.test()` ~84s and at 1 the worst accepted pattern
 * (`.+.?.?.?.?.?.{300}z`) blocks ~7.5s (Node v26/V8, 1024 chars).
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

/**
 * Minimal stateless matcher contract for boundedGrepScan. `test` must not
 * carry state between calls (a native /g RegExp's lastIndex violates this —
 * production always passes the RE2JS-backed matcher from compileLinearPattern).
 */
export interface LineMatcher {
  test(segment: string): boolean;
}

/** Flags accepted by the grep tool. `g` and `u` are no-ops under RE2JS. */
export const GREP_FLAGS_RE = /^[gimsu]*$/;

/**
 * Compile a model-supplied pattern with the linear-time RE2 engine.
 * Throws RE2JSSyntaxException on invalid syntax — including backreferences and
 * lookaround, which RE2 does not support (that rejection is a feature here).
 * `g` is meaningless for per-segment boolean tests and `u` is RE2JS's default
 * Unicode behavior; both are accepted for API compatibility and ignored.
 */
export function compileLinearPattern(pattern: string, flags: string): LineMatcher {
  let f = 0;
  if (flags.includes("i")) f |= RE2JS.CASE_INSENSITIVE;
  if (flags.includes("m")) f |= RE2JS.MULTILINE;
  if (flags.includes("s")) f |= RE2JS.DOTALL;
  const re2 = RE2JS.compile(pattern, f);
  return {
    test: (segment: string) => re2.matcher(segment).find(),
  };
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
  matcher: LineMatcher,
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
      hit = matcher.test(line);
    } else {
      for (let off = 0; off < line.length; off += segmentLength) {
        if (now() - start > budgetMs) {
          aborted = true;
          break outer;
        }
        hit = matcher.test(line.slice(off, off + segmentLength));
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
