import vinext from "vinext";
import { defineConfig } from "vite";

const LOCAL_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

const localBindingConfig = {
  main: "./build/worker.ts",
  compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
  d1_databases: [
    {
      binding: "DB",
      database_name: "schedule-my-agents-d1",
      database_id: LOCAL_PLACEHOLDER_DATABASE_ID,
    },
  ],
};

export default defineConfig(async () => {
  process.env.CLOUDFLARE_CF_FETCH_ENABLED ??= "false";
  process.env.WRANGLER_SEND_METRICS ??= "false";
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.WRANGLER_REGISTRY_PATH ??= ".wrangler/dev-registry";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    plugins: [
      vinext(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        inspectorPort: false,
        config: localBindingConfig,
      }),
    ],
  };
});
