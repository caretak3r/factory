import { describe, it, expect } from "vitest";
import {
  newIdeaId,
  normalizeIdea,
  dedupKey,
  seenKey,
  ideaKvKey,
  ideaR2Key,
  shouldStartVerdictRun,
  IDEA_ID_RE,
  MAX_IDEA_BODY_BYTES,
  type IdeaV1,
} from "../src/idea";

const ZERO_RAND = new Uint8Array(10);

describe("newIdeaId", () => {
  it("is ide_ plus a 26-char Crockford ULID", () => {
    const id = newIdeaId({ nowMs: 1_700_000_000_000, random: ZERO_RAND });
    expect(id).toMatch(IDEA_ID_RE);
    expect(id.startsWith("ide_")).toBe(true);
  });

  it("is deterministic for the same time and random bytes", () => {
    const a = newIdeaId({ nowMs: 1_700_000_000_000, random: ZERO_RAND });
    const b = newIdeaId({ nowMs: 1_700_000_000_000, random: ZERO_RAND });
    expect(a).toBe(b);
  });

  it("changes when the timestamp changes", () => {
    const a = newIdeaId({ nowMs: 1_700_000_000_000, random: ZERO_RAND });
    const b = newIdeaId({ nowMs: 1_700_000_000_001, random: ZERO_RAND });
    expect(a).not.toBe(b);
  });

  it("rejects random that is not 10 bytes", () => {
    expect(() => newIdeaId({ random: new Uint8Array(9) })).toThrow(/10 bytes/);
  });
});

describe("normalizeIdea", () => {
  const opts = { nowMs: 1_700_000_000_000, random: ZERO_RAND };

  it("fills defaults for a form paste", () => {
    const result = normalizeIdea({ body: "  a watch that logs lifts  " }, opts);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const idea = result.data;
    expect(idea.schema).toBe("idea.v1");
    expect(idea.id).toMatch(IDEA_ID_RE);
    expect(idea.source).toEqual({
      kind: "form",
      external_id: null,
      url: null,
    });
    expect(idea.body).toBe("a watch that logs lifts");
    expect(idea.slug).toBeNull();
    expect(idea.title).toBeNull();
    expect(idea.links).toEqual([]);
    expect(idea.goal).toBe("");
    expect(idea.action).toBe("auto");
    expect(idea.status).toBe("inbox");
    expect(idea.github).toEqual({ repo: null, issue: null });
  });

  it("rejects empty body", () => {
    const result = normalizeIdea({ body: "   " }, opts);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errors.some((e) => e.includes("body"))).toBe(true);
  });

  it("rejects a body over the byte cap", () => {
    const result = normalizeIdea({ body: "x".repeat(MAX_IDEA_BODY_BYTES + 1) }, opts);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errors[0]).toMatch(/exceeds/);
  });

  it("accepts a kebab slug and all source kinds", () => {
    for (const kind of [
      "form",
      "x_like",
      "x_bookmark",
      "file",
      "cli",
      "watch",
      "extension",
      "gha",
    ] as const) {
      const result = normalizeIdea(
        {
          body: "niche tool",
          slug: "helm-diff-tui",
          source: { kind },
        },
        opts
      );
      expect(result.success, kind).toBe(true);
      if (!result.success) return;
      expect(result.data.source.kind).toBe(kind);
      expect(result.data.slug).toBe("helm-diff-tui");
    }
  });

  it("rejects a slug that is not kebab-case", () => {
    const result = normalizeIdea({ body: "x", slug: "Hello World" }, opts);
    expect(result.success).toBe(false);
  });

  it("keeps a caller-supplied valid id", () => {
    const id = newIdeaId(opts);
    const result = normalizeIdea({ body: "x", id }, opts);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.id).toBe(id);
  });

  it("rejects a malformed id", () => {
    const result = normalizeIdea({ body: "x", id: "nope" }, opts);
    expect(result.success).toBe(false);
  });

  it("normalizes source.url and links, rejects junk URLs", () => {
    const ok = normalizeIdea(
      {
        body: "x",
        source: {
          kind: "x_like",
          external_id: "2061101641189716386",
          url: "https://x.com/i/web/status/2061101641189716386",
        },
        links: ["https://example.com/a"],
      },
      opts
    );
    expect(ok.success).toBe(true);
    if (!ok.success) return;
    expect(ok.data.source.external_id).toBe("2061101641189716386");
    expect(ok.data.links).toEqual(["https://example.com/a"]);

    const bad = normalizeIdea({ body: "x", links: ["not-a-url"] }, opts);
    expect(bad.success).toBe(false);
  });

  it("unknown source kind is a validation error", () => {
    const result = normalizeIdea(
      { body: "x", source: { kind: "rss" } },
      opts
    );
    expect(result.success).toBe(false);
  });
});

describe("dedup and storage keys", () => {
  const base: IdeaV1 = {
    schema: "idea.v1",
    id: newIdeaId({ nowMs: 1, random: ZERO_RAND }),
    source: { kind: "form", external_id: null, url: null },
    slug: null,
    title: null,
    body: "x",
    links: [],
    goal: "",
    action: "auto",
    status: "inbox",
    github: { repo: null, issue: null },
  };

  it("form pastes have no dedup key", () => {
    expect(dedupKey(base)).toBeNull();
  });

  it("X likes dedup on kind + tweet id", () => {
    const idea: IdeaV1 = {
      ...base,
      source: {
        kind: "x_like",
        external_id: "2061101641189716386",
        url: null,
      },
    };
    expect(dedupKey(idea)).toBe("seen:x_like:2061101641189716386");
    expect(seenKey("x_like", "2061101641189716386")).toBe(dedupKey(idea));
  });

  it("kv and r2 keys are derived from the idea id", () => {
    expect(ideaKvKey(base.id)).toBe(`idea:${base.id}`);
    expect(ideaR2Key(base.id)).toBe(`ideas/${base.id}.json`);
  });
});

describe("shouldStartVerdictRun", () => {
  const idea = (over: Partial<IdeaV1>): IdeaV1 => ({
    schema: "idea.v1",
    id: newIdeaId({ nowMs: 1, random: ZERO_RAND }),
    source: { kind: "form", external_id: null, url: null },
    slug: null,
    title: null,
    body: "x",
    links: [],
    goal: "",
    action: "auto",
    status: "inbox",
    github: { repo: null, issue: null },
    ...over,
  });

  it("starts for inbox auto", () => {
    expect(shouldStartVerdictRun(idea({}))).toBe(true);
  });

  it("does not start when held", () => {
    expect(shouldStartVerdictRun(idea({ status: "held" }))).toBe(false);
  });

  it("does not start when action is skip", () => {
    expect(shouldStartVerdictRun(idea({ action: "skip" }))).toBe(false);
  });
});
