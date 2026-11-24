import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "tls-client/wasm-exec.cjs",
    "next-env.d.ts",
    "**/.cloudflare/**",
    "**/node_modules/**",
  ]),
]);

export default eslintConfig;
