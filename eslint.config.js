import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "spikes/**",
      ".claude/**",
      "apps/desktop/out/**",
      "apps/desktop/release/**",
      "apps/desktop/test-results/**",
      "apps/desktop/playwright-report/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // tsc already resolves identifiers; this rule misfires on Node globals.
      "no-undef": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
);
