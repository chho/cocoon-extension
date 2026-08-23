import eslint from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

const sourceFiles = ["*.{js,mjs,ts}", "src/**/*.{js,mjs,ts}", "scripts/**/*.{js,mjs,ts}"];
const typeAwareFiles = ["*.ts", "src/**/*.ts", "scripts/**/*.{ts,mjs}"];
const testFiles = ["src/**/*.test.ts", "scripts/**/*.test.{ts,mjs}"];

function asWarnings(rules) {
  return Object.fromEntries(
    Object.entries(rules ?? {}).map(([name, setting]) => {
      const severity = Array.isArray(setting) ? setting[0] : setting;
      if (severity === "off" || severity === 0) {
        return [name, "off"];
      }
      return [name, Array.isArray(setting) ? ["warn", ...setting.slice(1)] : "warn"];
    }),
  );
}

export default tseslint.config(
  {
    ignores: ["docs/**", "dist/**", "node_modules/**", ".pi/**"],
  },
  {
    ...eslint.configs.recommended,
    files: sourceFiles,
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.webextensions,
      },
    },
    rules: asWarnings(eslint.configs.recommended.rules),
  },
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: typeAwareFiles,
    rules: asWarnings(config.rules),
  })),
  {
    files: typeAwareFiles,
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.eslint.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": [
        "error",
        {
          allowForKnownSafeCalls: [{ from: "package", name: "test", package: "node:test" }],
        },
      ],
      "@typescript-eslint/no-misused-promises": "error",
    },
  },
  {
    files: ["*.ts", "src/**/*.ts", "scripts/**/*.ts"],
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { fixStyle: "inline-type-imports", prefer: "type-imports" },
      ],
      "@typescript-eslint/switch-exhaustiveness-check": "error",
    },
  },
  {
    files: sourceFiles,
    rules: {
      complexity: ["warn", { max: 10, variant: "modified" }],
      "max-depth": ["warn", 3],
      "max-lines": ["warn", { max: 500, skipBlankLines: true, skipComments: true }],
      "max-lines-per-function": ["warn", { max: 50, skipBlankLines: true, skipComments: true }],
      "max-params": ["warn", 4],
    },
  },
  {
    files: testFiles,
    rules: {
      "max-lines": "off",
      "max-lines-per-function": ["warn", { max: 80, skipBlankLines: true, skipComments: true }],
    },
  },
  prettier,
);
