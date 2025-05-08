import eslint from "@eslint/js";
import stylisticJs from '@stylistic/eslint-plugin-js';
import simpleImportSort from "eslint-plugin-simple-import-sort";
import unusedImports from "eslint-plugin-unused-imports";
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      '**/*.min.cjs',
      '**/*.min.js',
      'assets/**/*.min.cjs',
      'assets/**/*.min.js',
      'tsup.config.ts',
      'eslint.config.js',
      'examples/**',
    ],
  },
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    plugins: {
      "unused-imports": unusedImports,
      "simple-import-sort": simpleImportSort,
      "@stylistic/js": stylisticJs,
    },

    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
    },

    rules: {
      "@typescript-eslint/no-explicit-any": ["warn"],
      "@typescript-eslint/no-unsafe-argument": ["warn"],
      "@typescript-eslint/no-unsafe-assignment": ["warn"],
      "@typescript-eslint/no-unsafe-member-access": ["warn"],
      "@typescript-eslint/no-unsafe-call": ["warn"],

      "arrow-body-style": ["warn", "as-needed"],
      "no-duplicate-imports": ["error"],

      "@stylistic/js/indent": ["error", 2, {
        SwitchCase: 1,
      }],

      "@stylistic/js/eol-last": ["error", "always"],

      "@stylistic/js/max-len": ["error", {
        code: 100,
        ignoreUrls: true,
        ignoreStrings: false,
        ignoreTemplateLiterals: false,
      }],

      "@stylistic/js/semi": ["error", "always"],
      "@stylistic/js/no-trailing-spaces": ["error"],

      "@stylistic/js/comma-dangle": ["error", "always-multiline"],

      "unused-imports/no-unused-imports": ["error"],
      "simple-import-sort/imports": "error",
      "simple-import-sort/exports": "error",
    },
  }
);
