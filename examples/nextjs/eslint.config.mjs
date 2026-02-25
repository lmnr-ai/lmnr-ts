
import eslint from "@eslint/js";
import nextPlugin from "@next/eslint-plugin-next";
import tseslint from "typescript-eslint";

const nextPlugins = {
  "@next/next": nextPlugin,
};

const eslintRulesCommon = {
  "arrow-body-style": ["warn", "as-needed"],
  "no-duplicate-imports": "error",
  "no-console": "warn",
};


const eslintConfig = [
  {
    ignores: [".next/**", "node_modules/**", "next-env.d.ts"],
  },

  eslint.configs.recommended,
  ...tseslint.configs.recommended,

  // TS and TSX files
  {
    files: ["**/*.ts", "**/*.tsx"],
    plugins: nextPlugins,
    rules: eslintRulesCommon,
  },
];

export default eslintConfig;
