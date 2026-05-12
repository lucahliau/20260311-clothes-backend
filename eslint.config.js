// ESLint v9 flat config. One file, no .eslintrc soup. See
// https://eslint.org/docs/latest/use/configure/configuration-files for the
// reasoning behind this shape.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default [
  {
    ignores: ["dist/**", "generated/**", "node_modules/**", "prisma/migrations/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier, // turn off ESLint rules that conflict with Prettier
  {
    rules: {
      // Underscore-prefixed unused vars/args are intentional placeholders.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Tests + scripts use looser typing on purpose (fakes, raw queries).
    files: ["**/*.test.ts", "scripts/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
];
