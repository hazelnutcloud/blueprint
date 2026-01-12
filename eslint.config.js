// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";
import eslintPluginPrettier from "eslint-plugin-prettier/recommended";

export default tseslint.config(
  // Global ignores
  {
    ignores: [
      "**/dist/",
      "**/out/",
      "**/node_modules/",
      "**/*.d.ts",
      "**/coverage/",
      "packages/tree-sitter-blueprint/",
    ],
  },

  // Base ESLint recommended config
  eslint.configs.recommended,

  // TypeScript ESLint recommended configs
  ...tseslint.configs.recommended,

  // Global settings for all files
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },

  // TypeScript-specific settings
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Allow unused vars prefixed with underscore
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      // Allow explicit any in some cases (can be tightened later)
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },

  // Test files - more relaxed rules
  {
    files: ["**/*.test.ts", "**/*.spec.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },

  // JavaScript files - disable type-checked rules
  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    ...tseslint.configs.disableTypeChecked,
  },

  // Prettier must be last to override other formatting rules
  eslintPluginPrettier
);
