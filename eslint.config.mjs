import obsidian from "eslint-plugin-obsidianmd";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";

export default [
  {
    ignores: ["main.js", "esbuild.config.mjs", "eslint.config.mjs", "*.json", "*.mjs", "src/**/*.test.ts"],
  },
  ...obsidian.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        project: "./tsconfig.json",
        sourceType: "module",
      },
    },
    plugins: {
      obsidianmd: obsidian,
      "@typescript-eslint": tseslint,
    },
    rules: {
      // Brand names (OpenClaw, Tailscale) trigger false positives.
      "obsidianmd/ui/sentence-case": "off",

      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],

      "no-console": ["error", { allow: ["warn", "error", "debug"] }],
      "no-undef": "off",
    },
  },
];
