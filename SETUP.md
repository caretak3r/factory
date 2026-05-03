# Setup

Deploying AgentX Factory to a real Cloudflare account. If you only want to poke
at it locally, jump to [Local development](#local-development).

## Prerequisites

| Requirement | Why |
|---|---|
| Cloudflare account on **Workers Paid** ($5/mo) | Free tier doesn't include Durable Objects or Queues |
| Anthropic API key | Every agent call hits Anthropic |
| `wrangler login` run once on your machine | Provisions credentials for `wrangler` CLI |
| Node.js ≥ 20 + `npm` | Vitest, wrangler, build tooling |

```bash
npx wrangler login    # opens browser, authorizes the CLI
node --version        # should print 20.x or higher
```

## 1 — Install + run tests locally

```bash
npm install
npx vitest run        # should print "Tests 137 passed"
```

If tests fail before you've changed anything, stop here and open an issue.

## 2 — Create Cloudflare resources

Order matters: the dispatch consumer in `wrangler.toml` references the DLQ, so
the DLQ has to exist first.

```bash
# 1. KV namespace — keep the returned id, you'll paste it into wrangler.toml
npx wrangler kv namespace create PIPELINE_KV
# → 🌀 Creating namespace with title "agentx-factory-PIPELINE_KV"
# → ✨ Success!
# → id = "abc123def456..."

# 2. R2 bucket
npx wrangler r2 bucket create agentx-artifacts

# 3. Queues — DLQ first
npx wrangler queues create agentx-dlq
npx wrangler queues create agentx-dispatch
npx wrangler queues create agentx-results
```

## 3 — Patch `wrangler.toml`

The default config ships with `id = "placeholder"` for KV. Replace it with the
real ID from step 2.1:

```toml
[[kv_namespaces]]
binding = "PIPELINE_KV"
id = "abc123def456..."   # ← paste the real id here
```

The Durable Object bindings, queue producer/consumer wiring, and migrations
(`v1`: Supervisor + Agent, `v2`: CircuitBreaker) are already configured and
should not be changed unless you know why.

## 4 — Set your Anthropic API key

```bash
npx wrangler secret put ANTHROPIC_API_KEY
# (paste your sk-ant-... key when prompted)
```

Stored encrypted in Cloudflare. Never committed to the repo.

## 5 — Deploy

```bash
npx wrangler deploy
```

First deploy applies both DO migrations. Subsequent deploys only run new
migrations (so v3 onward, if you add tables to existing DO classes).

You should see output ending with:

```
Published agentx-factory (1.12 MiB)
  https://agentx-factory.<your-subdomain>.workers.dev
```

## 6 — Smoke test

```bash
URL="https://agentx-factory.<your-subdomain>.workers.dev"

# Health
curl $URL/api/health
# {"status":"ok","service":"agentx-factory"}

# Open the dashboard in your browser
open $URL/

# Upload the bundled code-review pipeline
curl -X POST $URL/api/pipelines \
  -H "Content-Type: text/yaml" \
  --data-binary @pipelines/code-review.yaml
# {"name":"code-review","status":"saved"}

# Trigger a run
curl -X POST $URL/api/runs \
  -H "Content-Type: application/json" \
  -d '{"pipeline":"code-review","input":{"diff":"+ const x = eval(userInput)"}}'
# {"run_id":"...","status":"started"}

# Watch progress in the dashboard
open "$URL/runs/<the-run-id>"
```

## Operations

```bash
# Live tail of console.log + uncaught errors from your worker
npx wrangler tail

# List DO classes / KV / R2 / queues
npx wrangler whoami

# Delete a deployment
npx wrangler delete agentx-factory
# (NOTE: does NOT delete DOs, R2 data, or KV — those persist across deploys)
```

## Local development

If you don't want to spin up real Cloudflare resources, `wrangler dev` runs the
worker locally with in-memory simulators for KV, R2, DOs, and Queues.

```bash
npx wrangler dev
# Worker is now running at http://localhost:8787
```

The same `curl` commands from §6 work against `http://localhost:8787`. Local
state is wiped when you Ctrl-C the dev server.

You'll still need `ANTHROPIC_API_KEY` for any pipeline run that actually calls
the LLM. Local-dev secrets live in a `.dev.vars` file:

```bash
# .dev.vars (gitignored — never commit this)
ANTHROPIC_API_KEY=sk-ant-...
```

## Common deploy failures

| Symptom | Fix |
|---|---|
| `KV namespace "placeholder" not found` | You skipped step 3. Real KV id into `wrangler.toml`. |
| `Queue "agentx-dlq" not found` during deploy | Step 2.3 — create the DLQ before `agentx-dispatch`. |
| 402 / "this account doesn't support DOs" | You're on free tier. Upgrade to Workers Paid. |
| `Unauthorized: must be logged in` | Run `npx wrangler login`. |
| Run starts but no events appear | Check `wrangler tail` — usually `ANTHROPIC_API_KEY` not set, or queue consumers haven't been wired. |
| Dashboard 500s with "X.idFromName is not a function" | DO bindings missing. Confirm `wrangler.toml` has all three DO bindings (SUPERVISOR, AGENT, CIRCUIT_BREAKER). |
| SSE event stream disconnects after ~30s | Workers extends only on paid plans. Free tier caps at 30s — HTMX will auto-reconnect via the `since=` cursor. |
| Migration error on second deploy | DO migrations are append-only. Don't edit `[[migrations]]` blocks; add a new `tag = "vN"` block instead. |

## Cost expectations

You'll see two line items on your Cloudflare bill plus Anthropic usage:

- **Workers Paid** — $5/mo flat, includes 10M requests + most DO ops
- **Anthropic** — metered per token. Every agent in every run is a billable
  call. Use `model: classification` (Haiku) for cheap agents and
  `model: planning` (Opus) only where you need it
- **R2** — 10 GB storage free
- **Queues** — 1M ops/mo free

A typical code-review run with 4 agents (3 parallel reviewers + synthesizer)
costs ~$0.05–$0.30 on Anthropic depending on diff size.

## Hardening before you actually rely on it

This repo is single-user dogfood. Before exposing it to anyone else:

1. **Add auth.** Today `/api/runs` is unauthenticated — anyone with the URL can
   spend your Anthropic credit. Wrap routes in a Hono middleware that checks a
   shared secret or Cloudflare Access JWT.
2. **Rate-limit pipeline starts.** Cloudflare's `@cloudflare/workers-types`
   rate-limit binding is one line of config + a few lines of Hono middleware.
3. **Set `budget.max_tokens` low** in any pipeline that takes user input —
   the gate will halt runaway costs.
4. **Rotate the Anthropic key** if you ever paste it into a chat or log.

See `PROJECT_CONTEXT.md` for the broader phase plan and design decisions.
