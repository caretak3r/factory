#!/usr/bin/env bash
# Example: evaluate whether to adopt Svelte 5 for an internal dashboard rebuild
#
# Prerequisites:
#   1. Deploy agentx-factory: npx wrangler deploy
#   2. Upload the pipeline: curl -X POST $URL/api/pipelines -d @examples/tech-evaluation.yaml
#
# Usage:
#   URL=https://agentx-factory.YOUR_SUBDOMAIN.workers.dev ./examples/tech-evaluation-run.sh

URL="${URL:-http://localhost:8787}"

echo "Starting tech evaluation pipeline..."

RUN_ID=$(curl -s -X POST "$URL/api/runs" \
  -H "Content-Type: application/json" \
  -d '{
    "pipeline": "tech-evaluation",
    "input": {
      "technology": "Svelte 5 with SvelteKit",
      "context": "Rebuilding our internal dashboard. Currently React 18 + Next.js. Team of 4, all React-experienced. Dashboard has ~40 routes, lots of forms and tables, minimal SEO needs. Timeline: 3 months.",
      "constraints": "Must support SSR. Must have good TypeScript support. Must not require retraining the whole team for more than 2 weeks."
    }
  }' | jq -r '.run_id')

echo "Run started: $RUN_ID"
echo ""
echo "Poll for status:"
echo "  curl $URL/api/runs/$RUN_ID"
echo ""
echo "View individual agent outputs:"
echo "  curl $URL/api/runs/$RUN_ID/artifacts/runs/$RUN_ID/agents/advocate/output.json"
echo "  curl $URL/api/runs/$RUN_ID/artifacts/runs/$RUN_ID/agents/critic/output.json"
echo "  curl $URL/api/runs/$RUN_ID/artifacts/runs/$RUN_ID/agents/pragmatist/output.json"
echo "  curl $URL/api/runs/$RUN_ID/artifacts/runs/$RUN_ID/agents/synthesizer/output.json"
