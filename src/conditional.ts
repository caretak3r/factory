import type { DagState, PipelineEvent } from "./types";

export type ConditionValue = boolean | number | string;

export interface ConditionContext {
  dag: DagState;
  events: PipelineEvent[];
}

/**
 * Evaluate a `when:` expression against the current run state.
 *
 * Whitelisted DSL — no eval, no string concatenation into prompts.
 * Throws ConditionError on parse failures or unknown references.
 *
 * Supported references:
 *   agent.<id>.completed | failed | running | pending | dispatched
 *   agent.<id>.tokens | duration_ms | retry_count
 *   gate.<step>.passed | failed
 *   metrics.total_tokens | total_retries | gates_passed | gates_failed
 *
 * Operators: `and` `or` `not`, comparisons `== != > >= < <=`,
 *            grouping `( )`, literals: numbers, "strings", true, false
 */
export function evaluateCondition(expr: string, ctx: ConditionContext): boolean {
  const parser = new Parser(tokenize(expr));
  const ast = parser.parseExpr();
  parser.expect("eof");
  const result = evalNode(ast, ctx);
  return Boolean(result);
}

export class ConditionError extends Error {
  constructor(message: string) {
    super(`condition: ${message}`);
    this.name = "ConditionError";
  }
}

// ─── Tokenizer ─────────────────────────────────────

type TokKind =
  | "ident"
  | "num"
  | "str"
  | "dot"
  | "lparen"
  | "rparen"
  | "op"
  | "and"
  | "or"
  | "not"
  | "true"
  | "false"
  | "eof";

interface Token {
  kind: TokKind;
  value: string;
  pos: number;
}

const KEYWORDS = new Set(["and", "or", "not", "true", "false"]);

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n") {
      i++;
      continue;
    }
    if (c === "(") {
      out.push({ kind: "lparen", value: c, pos: i++ });
      continue;
    }
    if (c === ")") {
      out.push({ kind: "rparen", value: c, pos: i++ });
      continue;
    }
    if (c === ".") {
      out.push({ kind: "dot", value: c, pos: i++ });
      continue;
    }
    if (c === "=" && src[i + 1] === "=") {
      out.push({ kind: "op", value: "==", pos: i });
      i += 2;
      continue;
    }
    if (c === "!" && src[i + 1] === "=") {
      out.push({ kind: "op", value: "!=", pos: i });
      i += 2;
      continue;
    }
    if (c === ">" && src[i + 1] === "=") {
      out.push({ kind: "op", value: ">=", pos: i });
      i += 2;
      continue;
    }
    if (c === "<" && src[i + 1] === "=") {
      out.push({ kind: "op", value: "<=", pos: i });
      i += 2;
      continue;
    }
    if (c === ">" || c === "<") {
      out.push({ kind: "op", value: c, pos: i++ });
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      while (j < src.length && src[j] !== quote) j++;
      if (j >= src.length) throw new ConditionError(`unterminated string at ${i}`);
      out.push({ kind: "str", value: src.slice(i + 1, j), pos: i });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[0-9_]/.test(src[j])) j++;
      out.push({ kind: "num", value: src.slice(i, j).replace(/_/g, ""), pos: i });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_-]/.test(src[j])) j++;
      const word = src.slice(i, j);
      if (KEYWORDS.has(word)) {
        out.push({ kind: word as TokKind, value: word, pos: i });
      } else {
        out.push({ kind: "ident", value: word, pos: i });
      }
      i = j;
      continue;
    }
    throw new ConditionError(`unexpected '${c}' at ${i}`);
  }
  out.push({ kind: "eof", value: "", pos: i });
  return out;
}

// ─── Parser (recursive descent) ───────────────────

type Node =
  | { type: "or" | "and"; left: Node; right: Node }
  | { type: "not"; arg: Node }
  | { type: "cmp"; op: string; left: Node; right: Node }
  | { type: "lit"; value: ConditionValue }
  | { type: "ref"; path: string[] };

class Parser {
  private i = 0;
  constructor(private tokens: Token[]) {}

  peek(): Token {
    return this.tokens[this.i];
  }
  next(): Token {
    return this.tokens[this.i++];
  }
  expect(kind: TokKind): Token {
    const t = this.next();
    if (t.kind !== kind) {
      throw new ConditionError(`expected ${kind} at ${t.pos}, got ${t.kind} (${t.value})`);
    }
    return t;
  }

  parseExpr(): Node {
    return this.parseOr();
  }
  private parseOr(): Node {
    let left = this.parseAnd();
    while (this.peek().kind === "or") {
      this.next();
      const right = this.parseAnd();
      left = { type: "or", left, right };
    }
    return left;
  }
  private parseAnd(): Node {
    let left = this.parseUnary();
    while (this.peek().kind === "and") {
      this.next();
      const right = this.parseUnary();
      left = { type: "and", left, right };
    }
    return left;
  }
  private parseUnary(): Node {
    if (this.peek().kind === "not") {
      this.next();
      return { type: "not", arg: this.parseUnary() };
    }
    return this.parseComparison();
  }
  private parseComparison(): Node {
    const left = this.parsePrimary();
    if (this.peek().kind === "op") {
      const op = this.next().value;
      const right = this.parsePrimary();
      return { type: "cmp", op, left, right };
    }
    return left;
  }
  private parsePrimary(): Node {
    const t = this.peek();
    if (t.kind === "lparen") {
      this.next();
      const inner = this.parseExpr();
      this.expect("rparen");
      return inner;
    }
    if (t.kind === "num") {
      this.next();
      return { type: "lit", value: Number(t.value) };
    }
    if (t.kind === "str") {
      this.next();
      return { type: "lit", value: t.value };
    }
    if (t.kind === "true") {
      this.next();
      return { type: "lit", value: true };
    }
    if (t.kind === "false") {
      this.next();
      return { type: "lit", value: false };
    }
    if (t.kind === "ident") {
      const path: string[] = [];
      path.push(this.next().value);
      while (this.peek().kind === "dot") {
        this.next();
        const next = this.next();
        if (next.kind !== "ident") {
          throw new ConditionError(`expected identifier after '.' at ${next.pos}`);
        }
        path.push(next.value);
      }
      return { type: "ref", path };
    }
    throw new ConditionError(`unexpected ${t.kind} '${t.value}' at ${t.pos}`);
  }
}

// ─── Evaluator ────────────────────────────────────

function evalNode(node: Node, ctx: ConditionContext): ConditionValue {
  switch (node.type) {
    case "lit":
      return node.value;
    case "ref":
      return resolveRef(node.path, ctx);
    case "not":
      return !evalNode(node.arg, ctx);
    case "and":
      return Boolean(evalNode(node.left, ctx)) && Boolean(evalNode(node.right, ctx));
    case "or":
      return Boolean(evalNode(node.left, ctx)) || Boolean(evalNode(node.right, ctx));
    case "cmp": {
      const l = evalNode(node.left, ctx);
      const r = evalNode(node.right, ctx);
      switch (node.op) {
        case "==":
          return l === r;
        case "!=":
          return l !== r;
        case ">":
          return Number(l) > Number(r);
        case ">=":
          return Number(l) >= Number(r);
        case "<":
          return Number(l) < Number(r);
        case "<=":
          return Number(l) <= Number(r);
        default:
          throw new ConditionError(`unknown operator ${node.op}`);
      }
    }
  }
}

function resolveRef(path: string[], ctx: ConditionContext): ConditionValue {
  const [root, ...rest] = path;
  if (root === "agent") {
    if (rest.length !== 2) throw new ConditionError(`agent reference needs <id>.<field>`);
    const [agentId, field] = rest;
    const node = ctx.dag.nodes[agentId];
    if (!node) throw new ConditionError(`unknown agent: ${agentId}`);
    switch (field) {
      case "completed":
        return node.status === "completed";
      case "failed":
        return node.status === "failed";
      case "running":
        return node.status === "running";
      case "pending":
        return node.status === "pending";
      case "dispatched":
        return node.status === "dispatched";
      case "tokens":
        return node.tokens_used;
      case "duration_ms":
        return node.duration_ms;
      case "retry_count":
        return node.retry_count;
      default:
        throw new ConditionError(`unknown agent field: ${field}`);
    }
  }
  if (root === "gate") {
    if (rest.length !== 2) throw new ConditionError(`gate reference needs <step>.<field>`);
    const [step, field] = rest;
    const ev = ctx.events
      .filter((e) => e.event_type === "gate_eval" && e.details.gate === step)
      .pop();
    if (!ev) {
      // Gate hasn't run yet — passed/failed = false
      return false;
    }
    if (field === "passed") return ev.details.pass === true;
    if (field === "failed") return ev.details.pass === false;
    throw new ConditionError(`unknown gate field: ${field}`);
  }
  if (root === "metrics") {
    if (rest.length !== 1) throw new ConditionError(`metrics reference needs <field>`);
    const [field] = rest;
    switch (field) {
      case "total_tokens":
        return ctx.dag.total_tokens;
      case "total_duration_ms":
        return ctx.dag.total_duration_ms;
      case "total_retries":
        return Object.values(ctx.dag.nodes).reduce((s, n) => s + n.retry_count, 0);
      case "gates_passed":
        return ctx.events.filter(
          (e) => e.event_type === "gate_eval" && e.details.pass === true
        ).length;
      case "gates_failed":
        return ctx.events.filter(
          (e) => e.event_type === "gate_eval" && e.details.pass === false
        ).length;
      default:
        throw new ConditionError(`unknown metrics field: ${field}`);
    }
  }
  throw new ConditionError(`unknown reference root: ${root}`);
}
