import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  { ignores: ["dist", "node_modules", ".vercel"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ["test/**"], rules: { "@typescript-eslint/no-explicit-any": "off" } },
  {
    languageOptions: { globals: globals.node },
    rules: {
      "no-console": ["warn", { allow: ["warn", "error", "info"] }],
    },
  },
);
