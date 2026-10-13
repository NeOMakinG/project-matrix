import { describe, expect, test } from "vitest";
import { verifyTauriCapabilities } from "./tauri";

const ALLOW = ["core:default", "updater:default"];
const run = (files: Record<string, string>) =>
  verifyTauriCapabilities(Object.keys(files), async (f) => files[f] ?? "", ALLOW);

const conf = '{"productName":"x","identifier":"com.x.app"}';

describe("Tauri capabilities resolved like Tauri (round 2, P1-A)", () => {
  test("configured references fail closed, including unparseable targets", async () => {
    const found = await run({
      "src-tauri/tauri.conf.json": JSON.stringify({
        app: { security: { capabilities: ["missing", "broken", "safe"] } },
      }),
      "src-tauri/capabilities/broken.json": "{",
      "src-tauri/capabilities/safe.json": '{"identifier":"safe","permissions":["core:default"]}',
    });
    expect(found.map((finding) => finding.message).join()).toContain("reference missing");
    expect(found.map((finding) => finding.message).join()).toContain("reference broken");
    expect(found.map((finding) => finding.message).join()).not.toContain("reference safe");
  });

  test("capability directories without an adjacent config cannot hide dangerous permissions", async () => {
    const found = await run({
      "desktop/capabilities/evil.json": '{"permissions":[" SHELL:ALLOW-SPAWN "]}',
    });
    expect(found[0]?.message).toContain("dangerous");
  });

  test("broad scope and normalized dangerous families cannot be ADR-allowed", async () => {
    const found = await verifyTauriCapabilities(
      ["capabilities/a.json"],
      async () =>
        JSON.stringify({
          permissions: [
            " ＰＲＯＣＥＳＳ:default ",
            {
              identifier: "fs:allow-read-file",
              allow: [{ path: "$HOME/**" }, { path: "$APPDATA\\..\\secret" }],
            },
          ],
        }),
      ["process:default", "fs:allow-read-file"],
    );
    expect(found).toHaveLength(3);
  });
  test("TOML and JSON5 capability files are parsed and checked", async () => {
    const found = await run({
      "src-tauri/tauri.conf.json": conf,
      "src-tauri/capabilities/caps.toml":
        'identifier = "t"\nwindows = ["main"]\npermissions = ["shell:allow-execute"]\n',
      "src-tauri/capabilities/caps.json5":
        "{ identifier: 'j', windows: ['main'], permissions: ['shell:allow-execute'], }",
    });
    const files = new Set(found.map((f) => f.file));
    expect(files).toContain("src-tauri/capabilities/caps.toml");
    expect(files).toContain("src-tauri/capabilities/caps.json5");
  });

  test("inline capabilities in tauri.conf.json and platform overrides are checked", async () => {
    const inline = (perms: string[]) =>
      JSON.stringify({
        app: { security: { capabilities: [{ identifier: "i", permissions: perms }] } },
      });
    const found = await run({
      "src-tauri/tauri.conf.json": inline(["shell:allow-execute", "fs:read-all"]),
      "src-tauri/tauri.macos.conf.json": inline(["process:allow-restart"]),
    });
    expect(found.filter((f) => f.file === "src-tauri/tauri.conf.json")).toHaveLength(2);
    expect(found.map((f) => f.file)).toContain("src-tauri/tauri.macos.conf.json");
  });

  test("Tauri.toml configs with inline capabilities are checked", async () => {
    const found = await run({
      "src-tauri/Tauri.toml":
        '[[app.security.capabilities]]\nidentifier = "i"\npermissions = ["fs:read-all"]\n',
    });
    expect(found.map((f) => f.file)).toContain("src-tauri/Tauri.toml");
  });

  test("unknown formats, unparseable files and custom capability paths fail closed", async () => {
    const found = await run({
      "src-tauri/tauri.conf.json": conf,
      "src-tauri/capabilities/caps.yaml": "permissions: [shell:allow-execute]\n",
      "src-tauri/capabilities/broken.json": "{ nope",
      "src-tauri/build.rs":
        'fn main() { tauri_build::try_build(tauri_build::Attributes::new().capabilities_path_pattern("./perms/**")).unwrap() }',
    });
    const files = new Set(found.map((f) => f.file));
    for (const f of [
      "src-tauri/capabilities/caps.yaml",
      "src-tauri/capabilities/broken.json",
      "src-tauri/build.rs",
    ])
      expect(files).toContain(f);
  });

  test("an unparseable tauri.conf fails closed", async () => {
    const found = await run({ "src-tauri/tauri.conf.json": "{ broken" });
    expect(found[0]?.message).toContain("unverifiable");
  });

  test("the generated least-privilege setup passes", async () => {
    const found = await run({
      "apps/desktop/src-tauri/tauri.conf.json": conf,
      "apps/desktop/src-tauri/capabilities/default.json": JSON.stringify({
        identifier: "default",
        windows: ["main"],
        permissions: ["core:default", "updater:default"],
      }),
    });
    expect(found).toEqual([]);
  });
});
