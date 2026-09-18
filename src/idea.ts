import { z } from "zod";

/** Crockford Base32 (ULID alphabet). */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export const SOURCE_KINDS = [
  "form",
  "x_like",
  "x_bookmark",
  "file",
  "cli",
  "watch",
  "extension",
  "gha",
] as const;

export const IDEA_ACTIONS = ["auto", "skip", "spec", "scaffold"] as const;
export const IDEA_STATUSES = [
  "inbox",
  "held",
  "spec",
  "scaffold",
  "done",
  "skip",
] as const;

export const MAX_IDEA_BODY_BYTES = 64 * 1024;
export const MAX_SLUG_CHARS = 80;
export const IDEA_ID_RE = /^ide_[0-9A-HJKMNP-TV-Z]{26}$/;
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const SourceSchema = z.object({
  kind: z.enum(SOURCE_KINDS),
  external_id: z.string().min(1).nullable().default(null),
  url: z.string().url().nullable().default(null),
});

const GithubSchema = z.object({
  repo: z.string().min(1).nullable().default(null),
  issue: z.string().min(1).nullable().default(null),
});

/** Wire format after normalize. Zod is the source of truth for this module. */
export const IdeaV1Schema = z.object({
  schema: z.literal("idea.v1"),
  id: z.string().regex(IDEA_ID_RE),
  source: SourceSchema,
  slug: z
    .string()
    .min(1)
    .max(MAX_SLUG_CHARS)
    .regex(SLUG_RE)
    .nullable(),
  title: z.string().min(1).nullable(),
  body: z.string().min(1),
  links: z.array(z.string().url()),
  goal: z.string(),
  action: z.enum(IDEA_ACTIONS),
  status: z.enum(IDEA_STATUSES),
  github: GithubSchema,
});

export type IdeaV1 = z.infer<typeof IdeaV1Schema>;
export type SourceKind = (typeof SOURCE_KINDS)[number];
export type IdeaAction = (typeof IDEA_ACTIONS)[number];
export type IdeaStatus = (typeof IDEA_STATUSES)[number];

const IdeaInputSchema = z.object({
  schema: z.literal("idea.v1").optional(),
  id: z.string().optional(),
  source: z
    .object({
      kind: z.enum(SOURCE_KINDS).optional(),
      external_id: z.string().nullable().optional(),
      url: z.string().nullable().optional(),
    })
    .optional(),
  slug: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  body: z.string(),
  links: z.array(z.string()).optional(),
  goal: z.string().optional(),
  action: z.enum(IDEA_ACTIONS).optional(),
  status: z.enum(IDEA_STATUSES).optional(),
  github: z
    .object({
      repo: z.string().nullable().optional(),
      issue: z.string().nullable().optional(),
    })
    .optional(),
});

export type NormalizeOk = { success: true; data: IdeaV1 };
export type NormalizeFail = { success: false; errors: string[] };
export type NormalizeResult = NormalizeOk | NormalizeFail;

export interface NewIdeaIdOpts {
  nowMs?: number;
  random?: Uint8Array;
}

function encodeCrockford(bytes: Uint8Array): string {
  // Encode 16 bytes (128 bits) into 26 Crockford chars (130 bits; 2 bits unused).
  let bits = 0;
  let acc = 0;
  let out = "";
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD[(acc >> bits) & 31];
    }
  }
  if (bits > 0) {
    out += CROCKFORD[(acc << (5 - bits)) & 31];
  }
  return out;
}

/**
 * `ide_` + 26-char ULID. Time is 48-bit unix ms; randomness is 80-bit.
 * Inject `nowMs`/`random` in tests.
 */
export function newIdeaId(opts: NewIdeaIdOpts = {}): string {
  const nowMs = opts.nowMs ?? Date.now();
  const rand = opts.random ?? crypto.getRandomValues(new Uint8Array(10));
  if (rand.length !== 10) {
    throw new Error("newIdeaId random must be 10 bytes");
  }
  const time = BigInt(nowMs);
  const timeBytes = new Uint8Array(6);
  let t = time;
  for (let i = 5; i >= 0; i--) {
    timeBytes[i] = Number(t & 0xffn);
    t >>= 8n;
  }
  const bytes = new Uint8Array(16);
  bytes.set(timeBytes, 0);
  bytes.set(rand, 6);
  const encoded = encodeCrockford(bytes);
  return `ide_${encoded.slice(0, 26)}`;
}

function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).byteLength;
}

function emptyToNull(s: string | null | undefined): string | null {
  if (s == null) return null;
  const t = s.trim();
  return t.length === 0 ? null : t;
}

export function seenKey(kind: SourceKind, externalId: string): string {
  return `seen:${kind}:${externalId}`;
}

export function ideaKvKey(id: string): string {
  return `idea:${id}`;
}

export function ideaR2Key(id: string): string {
  return `ideas/${id}.json`;
}

/** Dedup only when the source carries a stable external id (X tweet id, file path). */
export function dedupKey(idea: IdeaV1): string | null {
  const ext = idea.source.external_id;
  if (!ext) return null;
  return seenKey(idea.source.kind, ext);
}

export function shouldStartVerdictRun(idea: IdeaV1): boolean {
  if (idea.status === "held") return false;
  if (idea.action === "skip") return false;
  return true;
}

export function normalizeIdea(
  raw: unknown,
  opts: NewIdeaIdOpts = {}
): NormalizeResult {
  const parsed = IdeaInputSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      success: false,
      errors: parsed.error.issues.map(
        (i) => `${i.path.join(".") || "root"}: ${i.message}`
      ),
    };
  }
  const input = parsed.data;
  const body = input.body.trim();
  if (!body) {
    return { success: false, errors: ["body: required"] };
  }
  if (utf8Bytes(body) > MAX_IDEA_BODY_BYTES) {
    return {
      success: false,
      errors: [`body: exceeds ${MAX_IDEA_BODY_BYTES} bytes`],
    };
  }

  let id = input.id?.trim() || "";
  if (id) {
    if (!IDEA_ID_RE.test(id)) {
      return { success: false, errors: ["id: must match ide_ + 26-char ULID"] };
    }
  } else {
    id = newIdeaId(opts);
  }

  const slugRaw = emptyToNull(input.slug);
  if (slugRaw && (!SLUG_RE.test(slugRaw) || slugRaw.length > MAX_SLUG_CHARS)) {
    return {
      success: false,
      errors: [
        `slug: kebab-case [a-z0-9-], max ${MAX_SLUG_CHARS} chars`,
      ],
    };
  }

  const links: string[] = [];
  for (const link of input.links ?? []) {
    const t = link.trim();
    if (!t) continue;
    try {
      links.push(new URL(t).toString());
    } catch {
      return { success: false, errors: [`links: invalid URL ${t}`] };
    }
  }

  let url: string | null = emptyToNull(input.source?.url ?? null);
  if (url) {
    try {
      url = new URL(url).toString();
    } catch {
      return { success: false, errors: ["source.url: invalid URL"] };
    }
  }

  const ext = emptyToNull(input.source?.external_id ?? null);

  const idea: IdeaV1 = {
    schema: "idea.v1",
    id,
    source: {
      kind: input.source?.kind ?? "form",
      external_id: ext,
      url,
    },
    slug: slugRaw,
    title: emptyToNull(input.title),
    body,
    links,
    goal: (input.goal ?? "").trim(),
    action: input.action ?? "auto",
    status: input.status ?? "inbox",
    github: {
      repo: emptyToNull(input.github?.repo ?? null),
      issue: emptyToNull(input.github?.issue ?? null),
    },
  };

  const checked = IdeaV1Schema.safeParse(idea);
  if (!checked.success) {
    return {
      success: false,
      errors: checked.error.issues.map(
        (i) => `${i.path.join(".")}: ${i.message}`
      ),
    };
  }
  return { success: true, data: checked.data };
}
