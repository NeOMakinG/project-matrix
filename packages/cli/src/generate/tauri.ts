import type { MatrixConfig } from "@matrix/config";
import type { Files } from "./docs";
import { html, identSegment, jsxText, tomlString } from "./escape";
import { pick } from "./versions";

type Desktop = NonNullable<MatrixConfig["desktop"]>;

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
/** Rust crate and lib names must be identifiers: letters, digits, `_`, starting with a letter. */
const crate = (pkg: string) => identSegment(pkg, "_");

/** First brand colour if it is a plain hex colour (it lands inside SVG markup). */
const accent = (c: MatrixConfig) =>
  c.design.brandColors.find((col) => /^#[0-9a-fA-F]{6}$/.test(col)) ?? "#22c55e";

/** Text-only source icon; `bun run icons` renders every PNG/ICNS/ICO size Tauri needs. */
const appIcon = (color: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024" role="img"><title>App icon</title><rect width="1024" height="1024" rx="224" fill="#0f172a"/><circle cx="512" cy="512" r="256" fill="${color}"/></svg>\n`;

/** Tauri v2 desktop app with a React (Vite) UI in apps/desktop. */
export function tauriFiles(c: MatrixConfig, d: Desktop, pkg: string): Files {
  const name = c.business.name;
  const lib = `${crate(pkg)}_lib`;
  const deps = ["react", "react-dom", "zod", "@tauri-apps/api"];
  if (d.updater) deps.push("@tauri-apps/plugin-updater");
  const dev = [
    "vite",
    "@vitejs/plugin-react",
    "typescript",
    "@types/react",
    "@types/react-dom",
    "@tauri-apps/cli",
  ];
  const permissions = ["core:default", ...(d.updater ? ["updater:default"] : [])];

  const files: Files = {
    "apps/desktop/package.json": json({
      name: `${pkg}-desktop`,
      private: true,
      type: "module",
      scripts: {
        dev: "vite",
        build: "tsc -p tsconfig.json --noEmit && vite build",
        tauri: "tauri",
        icons: "tauri icon app-icon.svg",
        typecheck: "tsc -p tsconfig.json --noEmit",
        "check:rust": "bun run icons && cargo check --manifest-path src-tauri/Cargo.toml",
        test: "echo 'desktop UI tests run with Playwright against vite dev'",
      },
      dependencies: pick(deps),
      devDependencies: pick(dev),
    }),
    "apps/desktop/tsconfig.json": json({
      extends: "../../tsconfig.base.json",
      compilerOptions: {
        jsx: "react-jsx",
        lib: ["ES2023", "DOM", "DOM.Iterable"],
        types: ["vite/client"],
      },
      include: ["src", "vite.config.ts"],
    }),
    "apps/desktop/vite.config.ts": `import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Tauri expects a fixed dev port and must not clear its own Rust output.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  envPrefix: ["VITE_", "TAURI_ENV_"],
});
`,
    "apps/desktop/index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${html(name)}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
    "apps/desktop/src/main.tsx": `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

function App() {
  return (
    <main>
      <h1>${jsxText(name)}</h1>
      <p>${jsxText(c.business.valueProposition)}</p>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
`,
    "apps/desktop/src-tauri/Cargo.toml": `[package]
name = ${tomlString(crate(pkg))}
version = "0.1.0"
edition = "2021"

[lib]
name = ${tomlString(lib)}
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
${d.updater ? '\n[target.\'cfg(not(any(target_os = "android", target_os = "ios")))\'.dependencies]\ntauri-plugin-updater = "2"\n' : ""}`,
    "apps/desktop/src-tauri/build.rs": "fn main() {\n    tauri_build::build()\n}\n",
    "apps/desktop/src-tauri/src/main.rs": `// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    ${lib}::run()
}
`,
    "apps/desktop/src-tauri/src/lib.rs": `#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()${d.updater ? "\n        .plugin(tauri_plugin_updater::Builder::new().build())" : ""}
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
`,
    "apps/desktop/src-tauri/tauri.conf.json": json({
      $schema: "https://schema.tauri.app/config/2",
      productName: name,
      version: "0.1.0",
      identifier: `com.${identSegment(pkg)}.desktop`,
      build: {
        beforeDevCommand: "bun run dev",
        devUrl: "http://localhost:1420",
        beforeBuildCommand: "bun run build",
        frontendDist: "../dist",
      },
      app: {
        windows: [{ title: name, width: 1200, height: 800 }],
        security: {
          csp: "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'",
        },
      },
      bundle: {
        active: true,
        targets: "all",
        icon: [
          "icons/32x32.png",
          "icons/128x128.png",
          "icons/128x128@2x.png",
          "icons/icon.icns",
          "icons/icon.ico",
        ],
        createUpdaterArtifacts: d.updater,
      },
      ...(d.updater
        ? {
            plugins: {
              updater: {
                // Generate with \`bunx tauri signer generate\`; the private key lives in CI secrets.
                pubkey: "REPLACE_WITH_UPDATER_PUBLIC_KEY",
                endpoints: ["https://example.com/releases/latest.json"],
              },
            },
          }
        : {}),
    }),
    "apps/desktop/src-tauri/capabilities/default.json": json({
      $schema: "../gen/schemas/desktop-schema.json",
      identifier: "default",
      description: "Least-privilege permissions for the main window (see the desktop shell ADR).",
      windows: ["main"],
      permissions,
    }),
    "apps/desktop/src-tauri/.gitignore": "/target/\n/gen/schemas\n",
    "apps/desktop/app-icon.svg": appIcon(accent(c)),
  };
  return files;
}
