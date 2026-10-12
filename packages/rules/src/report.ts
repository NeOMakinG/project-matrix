import type { Receipt } from "@matrix/core";
import type { CheckResult, RuleCheckResult } from "./engine";

type Reportable = RuleCheckResult & Partial<CheckResult>;

export function summarize(r: Reportable): string {
  const errors = r.violations.filter((v) => v.severity === "error").length;
  const warnings = r.violations.length - errors;
  const parts = [
    `${r.stats.enforced}/${r.stats.rules} ADR rules enforced on ${r.stats.files} files`,
    `${errors} error${errors === 1 ? "" : "s"}`,
    `${warnings} warning${warnings === 1 ? "" : "s"}`,
  ];
  if (r.invalid.length > 0) parts.push(`${r.invalid.length} invalid rule block(s)`);
  if (r.failures?.length) parts.push(`${r.failures.length} fail-closed issue(s)`);
  if (r.rulesSource?.kind === "git") parts.push(`rules from ${r.rulesSource.commit.slice(0, 12)}`);
  if (r.requiresReview) parts.push(`${r.adrChanges?.length ?? 0} ADR change(s) need human review`);
  return parts.join(", ");
}

/** Human-readable report; every violation names its ADR and file:line. */
export function formatHuman(r: Reportable): string {
  const out: string[] = [];
  for (const f of r.failures ?? []) out.push(`fail     ${f}`);
  for (const c of r.adrChanges ?? [])
    out.push(`review   ${c.file} ${c.change} (ADR changes need human review)`);
  for (const i of r.invalid) out.push(`invalid  ${i.adr} ${i.adrFile}:${i.line}  ${i.message}`);
  const byAdr = new Map<string, Reportable["violations"]>();
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
export function toReceipt(r: Reportable): Receipt {
  return { kind: "adr-check", ok: r.ok, summary: summarize(r), data: r };
}
