import type { Receipt } from "@matrix/core";
import type { CheckResult } from "./engine";

export function summarize(r: CheckResult): string {
  const errors = r.violations.filter((v) => v.severity === "error").length;
  const warnings = r.violations.length - errors;
  const parts = [
    `${r.stats.enforced}/${r.stats.rules} ADR rules enforced on ${r.stats.files} files`,
    `${errors} error${errors === 1 ? "" : "s"}`,
    `${warnings} warning${warnings === 1 ? "" : "s"}`,
  ];
  if (r.invalid.length > 0) parts.push(`${r.invalid.length} invalid rule block(s)`);
  return parts.join(", ");
}

/** Human-readable report; every violation names its ADR and file:line. */
export function formatHuman(r: CheckResult): string {
  const out: string[] = [];
  for (const i of r.invalid) out.push(`invalid  ${i.adr} ${i.adrFile}:${i.line}  ${i.message}`);
  const byAdr = new Map<string, CheckResult["violations"]>();
  for (const v of r.violations) byAdr.set(v.adr, [...(byAdr.get(v.adr) ?? []), v]);
  for (const [adr, vs] of [...byAdr.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const first = vs[0];
    if (!first) continue;
    out.push(`${adr} ${first.adrTitle} (${first.adrFile})`);
    for (const v of vs)
      out.push(
        `  ${v.severity === "error" ? "error" : "warn "}  ${v.file}:${v.line}  ${v.message}  — ${v.description}`,
      );
  }
  for (const u of r.unenforced)
    out.push(`note     ${u.adr} not enforced: ${u.description} (${u.reason})`);
  out.push(`${r.ok ? "ok" : "failed"}: ${summarize(r)}`);
  return out.join("\n");
}

/** Loop receipt for the checks phase. */
export function toReceipt(r: CheckResult): Receipt {
  return { kind: "adr-check", ok: r.ok, summary: summarize(r), data: r };
}
