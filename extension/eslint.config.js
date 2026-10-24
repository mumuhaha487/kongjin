import js from "@eslint/js";
import ts from "typescript-eslint";
export default ts.config(
  { ignores: ["tests/.*/*", "tests/**/*.mjs", "src/vendor/protocol-store/**"] },
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}", "tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
    },
  },
);
