import js from "@eslint/js";

const recommendedFiles = ["src/spectrum.js", "src/spectrum/**/*.js", "src/punch-turn.js"];

export default [
  { ...js.configs.recommended, files: recommendedFiles },
  {
    files: recommendedFiles,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        URL: "readonly",
        AbortSignal: "readonly",
        AbortController: "readonly",
      },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    files: ["src/**/*.js"],
    ignores: ["src/memory.js"],
    languageOptions: { ecmaVersion: "latest", sourceType: "module" },
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{ group: ["**/memory-db.js"], message: "Use src/memory.js so write-time dedupe and supersede rules apply." }],
      }],
    },
  },
];
