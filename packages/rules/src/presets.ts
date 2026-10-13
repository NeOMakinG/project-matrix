import type { MatrixConfig } from "@matrix/config";

export interface LintPreset {
  tool: "biome" | "eslint-prettier";
  /** Config files to write at the project root. */
  files: Record<string, string>;
  /** devDependency names; the scaffold pins versions. */
  devDependencies: string[];
  scripts: Record<string, string>;
}

/** Build output and generated code of every stack pack. */
const IGNORED = [
  "**/dist",
  "**/node_modules",
  ".matrix",
  "**/.next",
  "**/.output",
  "**/.expo",
  "**/.tanstack",
  "**/routeTree.gen.ts",
  "**/src-tauri/target",
  "**/src-tauri/gen",
];

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

function biomePreset(react: boolean): LintPreset {
  return {
    tool: "biome",
    files: {
      "biome.json": json({
        $schema: "https://biomejs.dev/schemas/2.2.0/schema.json",
        files: { includes: ["**", ...IGNORED.map((g) => `!${g}`)] },
        formatter: { indentStyle: "space", indentWidth: 2, lineWidth: 100 },
        // Tailwind v4 (@theme) and NativeWind (@tailwind) directives in CSS.
        css: { parser: { tailwindDirectives: true } },
        linter: {
          enabled: true,
          rules: {
            recommended: true,
            suspicious: { noExplicitAny: "error" },
            correctness: { noUnusedImports: "error", noUnusedVariables: "warn" },
          },
          ...(react ? { domains: { react: "recommended" } } : {}),
        },
        assist: { actions: { source: { organizeImports: "on" } } },
        // NativeWind (Tailwind v3) entry CSS uses @tailwind directives.
        overrides: [
          {
            includes: ["**/global.css"],
            linter: { rules: { suspicious: { noUnknownAtRules: "off" } } },
          },
        ],
      }),
    },
    devDependencies: ["@biomejs/biome"],
    scripts: { lint: "biome check .", format: "biome format --write ." },
  };
}

function eslintPreset(react: boolean): LintPreset {
  const config = `import js from "@eslint/js";
import globals from "globals";
${react ? 'import reactHooks from "eslint-plugin-react-hooks";\n' : ""}import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ${JSON.stringify(IGNORED)} },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: { "@typescript-eslint/no-explicit-any": "error" },
  },${react ? '\n  reactHooks.configs["recommended-latest"],' : ""}
);
`;
  return {
    tool: "eslint-prettier",
    files: {
      "eslint.config.js": config,
      ".prettierrc.json": json({ printWidth: 100, semi: true, singleQuote: false }),
      ".prettierignore": `${IGNORED.join("\n")}\n`,
    },
    devDependencies: [
      "eslint",
      "@eslint/js",
      "typescript-eslint",
      "globals",
      "prettier",
      ...(react ? ["eslint-plugin-react-hooks"] : []),
    ],
    scripts: { lint: "eslint . && prettier --check .", format: "prettier --write ." },
  };
}

/** Lint and format setup for a generated project, from its stack answers. */
export function lintPreset(c: MatrixConfig): LintPreset {
  const fe = c.frontend;
  if (fe?.framework === "react")
    return fe.lint === "eslint-prettier" ? eslintPreset(true) : biomePreset(true);
  return biomePreset(false);
}
