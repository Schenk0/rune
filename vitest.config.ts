import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

process.env.UPLOAD_TOKEN = "test-token";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: { UPLOAD_TOKEN: "test-token" },
        ratelimits: {
          READ_LIMITER: { namespace_id: "9202101", simple: { limit: 10000, period: 60 } },
          WRITE_LIMITER: { namespace_id: "9202102", simple: { limit: 10000, period: 60 } },
        },
      },
    }),
  ],
});
