import { posix } from "node:path";
import JSON5 from "json5";
import { parse as parseToml } from "smol-toml";
import { capabilityObjects, checkCapabilityObject } from "./structural";

export interface TauriFinding {
  file: string;
  message: string;
}

/** Tauri config files, including platform overrides (`tauri.macos.conf.json`, `Tauri.linux.toml`). */
const CONFIG = /^(tauri(\.[a-z0-9-]+)?\.conf\.(json|json5|toml)|Tauri(\.[a-z0-9-]+)?\.toml)$/;

const parseByExtension = (file: string, text: string): unknown => {
  if (file.endsWith(".json")) return JSON.parse(text);
  if (file.endsWith(".json5")) return JSON5.parse(text);
  if (file.endsWith(".toml")) return parseToml(text);
  throw new Error("unsupported capability format (Tauri reads JSON, JSON5 and TOML)");
};

/** TOML/`Tauri.toml` configs use kebab-case keys; JSON configs camelCase. */
const inlineCapabilities = (config: unknown): unknown[] => {
  const app = (config as { app?: unknown })?.app as { security?: unknown } | undefined;
  const sec = app?.security as Record<string, unknown> | undefined;
  const caps = sec?.capabilities;
  return Array.isArray(caps) ? caps.filter((c) => typeof c === "object" && c !== null) : [];
};

/**
 * Resolves capabilities the way Tauri does: every file under each app's `capabilities/` directory
 * (JSON, JSON5, TOML) plus inline capabilities in every tauri.conf / Tauri.toml variant. Unknown
 * formats, unparseable files and custom capability paths in build.rs are violations.
 */
export async function verifyTauriCapabilities(
  allFiles: string[],
  read: (file: string) => Promise<string>,
  allow: string[],
): Promise<TauriFinding[]> {
  const findings: TauriFinding[] = [];
  const roots = new Set<string>();
  for (const f of allFiles) if (CONFIG.test(posix.basename(f))) roots.add(posix.dirname(f));
  for (const file of allFiles) {
    const match = /^(.*\/)?capabilities\//.exec(file);
    if (match) roots.add(match[1]?.slice(0, -1) || ".");
  }

  for (const root of roots) {
    const inRoot = (f: string) => (root === "." ? !f.includes("/") : posix.dirname(f) === root);
    const prefix = root === "." ? "" : `${root}/`;
    const identifiers = new Set<string>();
    for (const file of allFiles.filter((file) => file.startsWith(`${prefix}capabilities/`))) {
      try {
        for (const capability of capabilityObjects(parseByExtension(file, await read(file)))) {
          const identifier = (capability as { identifier?: unknown })?.identifier;
          if (typeof identifier === "string") {
            if (identifiers.has(identifier))
              findings.push({ file, message: `duplicate capability identifier ${identifier}` });
            identifiers.add(identifier);
          }
        }
      } catch {
        identifiers.delete(file);
      }
    }

    for (const file of allFiles.filter((f) => inRoot(f) && CONFIG.test(posix.basename(f)))) {
      let config: unknown;
      try {
        config = parseByExtension(file, await read(file));
      } catch (e) {
        findings.push({
          file,
          message: `Tauri config cannot be parsed, so capabilities are unverifiable (${String(e)})`,
        });
        continue;
      }
      const capabilities = (config as { app?: { security?: { capabilities?: unknown } } })?.app
        ?.security?.capabilities;
      if (capabilities !== undefined && !Array.isArray(capabilities)) {
        findings.push({ file, message: "configured capabilities must be an array: unverifiable" });
      }
      if (Array.isArray(capabilities)) {
        for (const reference of capabilities) {
          if (typeof reference === "string" && !identifiers.has(reference)) {
            findings.push({
              file,
              message: `unknown or missing capability reference ${reference}: unverifiable`,
            });
          } else if (
            typeof reference !== "string" &&
            (!reference || typeof reference !== "object")
          ) {
            findings.push({ file, message: "invalid capability reference: unverifiable" });
          }
        }
      }
      for (const cap of inlineCapabilities(config))
        for (const f of checkCapabilityObject(cap, allow))
          findings.push({ file, message: `inline capability: ${f.message}` });
    }

    const build = `${prefix}build.rs`;
    if (allFiles.includes(build) && /capabilities_path_pattern/.test(await read(build)))
      findings.push({
        file: build,
        message:
          "custom capabilities_path_pattern: capabilities outside capabilities/ are unverifiable",
      });

    for (const file of allFiles.filter((f) => f.startsWith(`${prefix}capabilities/`))) {
      let doc: unknown;
      try {
        doc = parseByExtension(file, await read(file));
      } catch (e) {
        findings.push({ file, message: `capability file cannot be verified (${String(e)})` });
        continue;
      }
      for (const cap of capabilityObjects(doc))
        for (const f of checkCapabilityObject(cap, allow))
          findings.push({ file, message: f.message });
    }
  }
  return findings;
}
