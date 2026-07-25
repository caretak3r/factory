import { describe, it, expect } from "vitest";
import {
  vetGrepPattern,
  boundedGrepScan,
  MAX_GREP_PATTERN_LENGTH,
} from "../src/tools/grep-guard";

describe("grep-guard.vetGrepPattern", () => {
  it("accepts simple literals and alternation", () => {
    expect(vetGrepPattern("ga").ok).toBe(true);
    expect(vetGrepPattern("TODO|FIXME").ok).toBe(true);
  });

  it("accepts common patterns with at most one variable-width quantifier", () => {
    expect(vetGrepPattern("foo.*bar").ok).toBe(true);
    expect(vetGrepPattern("\\w+\\(").ok).toBe(true);
    expect(vetGrepPattern("a{2,10}b").ok).toBe(true);
    expect(vetGrepPattern("https?://").ok).toBe(true); // ? is fixed-max-width
    expect(vetGrepPattern("[a-f0-9]{8}").ok).toBe(true); // fixed {n}
    expect(vetGrepPattern("\\bclass\\s+\\w").ok).toBe(true);
  });

  it("treats quantifier characters inside a character class as literals", () => {
    expect(vetGrepPattern("[+*?]").ok).toBe(true);
  });

  it("allows a quantifier after an escaped paren literal", () => {
    expect(vetGrepPattern("\\)+").ok).toBe(true);
  });

  it("rejects patterns longer than the cap", () => {
    const v = vetGrepPattern("a".repeat(MAX_GREP_PATTERN_LENGTH + 1));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("too long");
  });

  it("rejects backreferences", () => {
    const v = vetGrepPattern("(a)\\1");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("backreferences");
  });

  it("rejects named backreferences", () => {
    expect(vetGrepPattern("\\k<name>").ok).toBe(false);
  });

  it("rejects quantified groups (the exponential ReDoS family)", () => {
    expect(vetGrepPattern("(a+)+").ok).toBe(false);
    expect(vetGrepPattern("(a|a)*").ok).toBe(false);
    expect(vetGrepPattern("err(or)?s").ok).toBe(false);
  });

  it("rejects alternation inside a group (stacked ambiguous alternation)", () => {
    // (a|a)(a|a)...z and (.|.)(.|.)...z have ZERO quantifiers yet explore 2^k
    // paths; measured (Node v26/V8) at 1024 chars: "(a|a)x23 z"=9.1s,
    // "(.|.)x22 z"=3.8s on ARBITRARY prose. Grouped `|` must be rejected.
    const v = vetGrepPattern("(a|a)".repeat(23) + "z");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("alternation inside a group");
    expect(vetGrepPattern("(.|.)".repeat(22) + "z").ok).toBe(false);
    expect(vetGrepPattern("(?:a|b)(?:c|d)").ok).toBe(false);
    // top-level alternation is linear and stays allowed
    expect(vetGrepPattern("TODO|FIXME").ok).toBe(true);
    expect(vetGrepPattern("foo|bar|baz").ok).toBe(true);
    // a plain (non-alternation) group is still fine
    expect(vetGrepPattern("(abc)def").ok).toBe(true);
  });

  it("rejects too many variable-width quantifiers", () => {
    const v = vetGrepPattern("a*b*c*d*");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("variable-width");
  });

  it("rejects multi-variable families that block RegExp.test() for seconds", () => {
    // Measured (Node v26/V8) at 1024 chars: ".*.*.*z"=51.7s, "a*a*a*b"=41.2s,
    // "\\w*\\w*\\w*!"=40.9s. Each has >1 variable-width quantifier, so it
    // exceeds the single-variable cap and never reaches a .test() call.
    for (const p of [".*.*.*z", "a*a*a*b", "\\w*\\w*\\w*!"]) {
      const v = vetGrepPattern(p);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.reason).toContain("variable-width");
    }
  });

  it("rejects two variable-width quantifiers — the ~170ms base a tail amplifies to 84s", () => {
    // .*.*z alone is only ~170ms, but with a fixed/optional tail it explodes:
    // measured .*.*.{500}z=84s, .*.*.?.?.?.?.?.?z=25s. The n^2 partition-search
    // needs TWO overlapping greedy quantifiers, so variable-width is capped at 1.
    expect(vetGrepPattern(".*.*z").ok).toBe(false);
    expect(vetGrepPattern("import\\s+.*from").ok).toBe(false); // \s+ and .* = 2
    expect(vetGrepPattern(".*.*.{500}z").ok).toBe(false);
    expect(vetGrepPattern(".*.*.?.?.?.?.?.?z").ok).toBe(false);
    // one variable-width quantifier with a fixed/optional tail stays linear
    expect(vetGrepPattern(".*.{500}z").ok).toBe(true); // measured 329ms
    expect(vetGrepPattern(".*.?.?.?.?.?.?z").ok).toBe(true); // measured 76ms
  });

  it("counts every variable-width {m,n} range toward the degree budget", () => {
    // A {0,50} range backtracks like `.*` regardless of the small upper bound;
    // measured through boundedGrepScan (Node v26/V8, 1024-char line):
    // ".{0,50}.{0,50}.{0,50}.{0,50}z"=13.3s (zero stars!), ".*.*.{0,50}z"=18.1s.
    // The {m,n} upper bound must not buy a free backtracking level.
    expect(vetGrepPattern(".{0,50}.{0,50}.{0,50}.{0,50}z").ok).toBe(false);
    expect(vetGrepPattern(".*.*.{0,50}z").ok).toBe(false);
    expect(vetGrepPattern(".*.*.{0,50}.{0,50}z").ok).toBe(false);
    expect(vetGrepPattern("x{2,}y{3,}z{1,200}w*").ok).toBe(false);
    // fixed-width {n} (no comma) cannot backtrack — must NOT be penalized
    expect(vetGrepPattern("a{3}b{3}c{3}d{3}e{3}").ok).toBe(true);
    // two variable-width ranges now exceed the single-variable cap
    expect(vetGrepPattern("\\d{1,3}\\.\\d{1,3}").ok).toBe(false);
    // one range plus a fixed {n} stays allowed
    expect(vetGrepPattern("\\d{1,3}\\.\\d{3}").ok).toBe(true);
  });

  it("rejects lookbehind", () => {
    const v = vetGrepPattern("(?<=a)b");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("lookbehind");
  });

  it("rejects lookahead (re-introduces the per-start-position rescan)", () => {
    const v = vetGrepPattern("(?=.*x)y");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("lookahead");
    expect(vetGrepPattern("(?!.*x)y").ok).toBe(false);
    // the specific bypass: one inner variable × the lookahead's n-position multiplier
    expect(vetGrepPattern("(?=.*.{500}x)z").ok).toBe(false);
  });
});

describe("grep-guard.boundedGrepScan", () => {
  it("finds matches with 1-based line numbers", () => {
    const r = boundedGrepScan("alpha\nbeta\nGAMMA\ndelta", /ga/i);
    expect(r.matches).toEqual(["3: GAMMA"]);
    expect(r.aborted).toBe(false);
    expect(r.capped).toBe(false);
    expect(r.totalLines).toBe(4);
  });

  it("stops at the match cap and reports capped", () => {
    const r = boundedGrepScan("m\nm\nm\nm\nm", /m/, { matchCap: 2 });
    expect(r.matches).toHaveLength(2);
    expect(r.capped).toBe(true);
  });

  it("aborts when the wall-clock budget is exhausted", () => {
    let t = 0;
    const fakeNow = () => {
      t += 10;
      return t;
    };
    const r = boundedGrepScan("a\nb\nc\nd", /x/, { budgetMs: 5, now: fakeNow });
    expect(r.aborted).toBe(true);
    expect(r.scannedLines).toBeLessThan(4);
  });

  it("searches long single-line text in segments and truncates output snippets", () => {
    const long = "x".repeat(4000) + "NEEDLE" + "x".repeat(500);
    const r = boundedGrepScan("a\n" + long, /NEEDLE/);
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0].startsWith("2: ")).toBe(true);
    expect(r.matches[0]).toContain("...[line truncated]");
    expect(r.matches[0].length).toBeLessThan(2100);
  });
});
