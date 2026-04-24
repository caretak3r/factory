import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          kvNamespaces: ["PIPELINE_KV"],
          r2Buckets: ["ARTIFACT_STORE"],
          queueProducers: {
            DISPATCH_QUEUE: "agentx-dispatch",
            RESULT_QUEUE: "agentx-results",
          },
          durableObjects: {
            SUPERVISOR: "Supervisor",
            AGENT: "Agent",
          },
        },
      },
    },
  },
});
