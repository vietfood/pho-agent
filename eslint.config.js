import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const forbiddenProductImports = {
  group: ["@pho-code/*", "electron", "react", "react-dom"],
  message: "Pho Agent must not depend on a product or UI package.",
};
const forbiddenNodeImports = {
  group: ["node:*"],
  message: "The protocol package must remain JSON-only and runtime-neutral.",
};
const forbiddenPiImports = {
  group: ["@earendil-works/*"],
  message: "Only the runtime package may import the Pi SDK.",
};

export default tseslint.config(
  { ignores: ["node_modules/**", "**/dist/**", "**/out/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,js}"],
    languageOptions: {
      parserOptions: { ecmaVersion: 2022, sourceType: "module" },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-restricted-imports": ["error", { patterns: [forbiddenProductImports] }],
    },
  },
  {
    files: ["packages/protocol/**/*.{ts,js}"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [forbiddenProductImports, forbiddenNodeImports, forbiddenPiImports] },
      ],
    },
  },
  {
    files: ["packages/evals/**/*.{ts,js}"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [forbiddenProductImports, forbiddenPiImports] },
      ],
    },
  },
  {
    files: ["packages/**/*.test.ts"],
    languageOptions: {
      globals: { ...globals.node, bun: "readonly" },
    },
  },
);
