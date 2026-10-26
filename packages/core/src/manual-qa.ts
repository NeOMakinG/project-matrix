import type { Receipt } from "./ports.js";
import { laneSurfaceSet, routeQaSurfaces } from "./qa-surfaces.js";
import type { ProjectConfig, QaSurface } from "./types.js";

/** Surfaces only a device/simulator driver can exercise (host probes cannot). */
export const UI_DEVICE_SURFACES: ReadonlySet<QaSurface> = new Set(["android", "ios"]);
export const QA_SURFACES: readonly QaSurface[] = ["host", "api", "web", "android", "ios"];
export const MANUAL_QA_PROVENANCE = "matrix:manual-qa:v1";
const MAX_CRITERIA = 30;

/**
 * Surfaces a ticket declares with `QA: Surface: android, ios` lines. Ticket text is untrusted:
 * callers may only use it to narrow the surfaces the project config declares, never to add one.
 */
export function ticketSurfaces(body: string): QaSurface[] {
  const out = new Set<QaSurface>();
  for (const line of body.split("\n")) {
    const m = line.match(/^\s*[-*>]*\s*\**QA\**\s*:\s*\**\s*Surfaces?\**\s*:\s*\**\s*(.+)$/i);
    if (!m?.[1]) continue;
    for (const raw of m[1].toLowerCase().split(/[\s,/|]+/)) {
      const word = raw.replace(/[^a-z]/g, "");
      if ((QA_SURFACES as readonly string[]).includes(word)) out.add(word as QaSurface);
    }
  }
  return [...out];
}

/**
 * Lane surfaces the ticket needs (android/ios, plus web with the agent driver): project config,
 * narrowed by the ticket's labels and `QA: Surface:` line, then by the change's paths
 * (`qa-surfaces.ts`). Ticket text never escapes lane QA on its own; a backend-only diff does.
 */
export function requiredDeviceSurfaces(
  project: ProjectConfig,
  ticket: { body: string; labels?: readonly string[] },
  changedPaths?: readonly string[],
): QaSurface[] {
  return routeQaSurfaces(project, ticket, changedPaths, ticketSurfaces(ticket.body)).surfaces;
}

/** Who tests a handed-off draft PR: a human, or the agent QA lane (`qa.driver: "agent"`). */
export type QaTester = "human" | "agent";

export function handoffTester(project: ProjectConfig): QaTester | undefined {
  if (project.qa?.driver === "manual") return "human";
  if (project.qa?.driver === "agent") return "agent";
  return undefined;
}

export type ManualQaPlan =
  | { mode: "auto" }
  | { mode: "manual"; surfaces: QaSurface[]; tester: QaTester }
  | { mode: "unavailable"; surfaces: QaSurface[] };

/**
 * `manual` only when the operator opted in (`qa.driver: "manual"` or `"agent"` in project config)
 * and a required device surface has no driver on this host. With a driver for every surface QA runs
 * automatically; without the opt-in a missing driver blocks with a clear reason.
 */
export function manualQaPlan(
  project: ProjectConfig,
  ticket: { body: string; labels?: readonly string[] },
  driverSurfaces: readonly QaSurface[] = [],
  changedPaths?: readonly string[],
): ManualQaPlan {
  // Web goes to the agent lane's Chrome even when an in-run web probe exists (owner rule).
  const agent = handoffTester(project) === "agent";
  const missing = requiredDeviceSurfaces(project, ticket, changedPaths).filter(
    (s) => (agent && s === "web") || !driverSurfaces.includes(s),
  );
  if (!missing.length) return { mode: "auto" };
  const tester = handoffTester(project);
  return tester
    ? { mode: "manual", surfaces: missing, tester }
    : { mode: "unavailable", surfaces: missing };
}

const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2064]/g;
const HEADING = /^\s*(?:#{1,6}\s+(.+?)|\*\*(.+?)\*\*\s*:?|([A-Za-z][\w ]{0,60}):)\s*$/;

/**
 * Public acceptance criteria from the ticket body (list items under an "Acceptance criteria"
 * heading), for the human QA checklist. Never derived from the hidden holdout scenarios.
 */
export function acceptanceCriteria(body: string): string[] {
  const out: string[] = [];
  let inSection = false;
  for (const line of body.replace(CONTROL, "").split("\n")) {
    const heading = line.match(HEADING);
    if (heading) {
      inSection = /^acceptance(\s+criteria)?\b/i.test(
        (heading[1] ?? heading[2] ?? heading[3] ?? "").trim(),
      );
      continue;
    }
    if (!inSection) continue;
    const item = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.+)$/);
    if (item?.[1]) out.push(item[1].trim().slice(0, 300));
    if (out.length >= MAX_CRITERIA) break;
  }
  return out;
}

export interface ManualQaData {
  provenance: typeof MANUAL_QA_PROVENANCE;
  surfaces: QaSurface[];
  criteria: string[];
  scenarioCount: number;
  /** Absent on receipts written before the agent lane: a human tester. */
  tester?: QaTester;
}

export function manualQaReceipt(
  surfaces: QaSurface[],
  criteria: string[],
  scenarioCount: number,
  tester: QaTester = "human",
): Receipt {
  const data: ManualQaData = {
    provenance: MANUAL_QA_PROVENANCE,
    surfaces,
    criteria,
    scenarioCount,
    tester,
  };
  return {
    kind: "log",
    ok: true,
    summary:
      tester === "agent"
        ? `agent ${surfaces.join("/")} QA on the draft PR: the agent QA lane tests it on a device; ${scenarioCount} private scenarios stay hidden`
        : `manual ${surfaces.join("/")} QA required: no driver on this host; ${scenarioCount} private scenarios stay hidden`,
    data,
  };
}

/** The core-produced handoff receipt (QA driver-supplied copies are discarded by the handler). */
export function manualQaData(receipt: Receipt): ManualQaData | undefined {
  const data = receipt.data as Partial<ManualQaData> | undefined;
  if (receipt.kind !== "log" || data?.provenance !== MANUAL_QA_PROVENANCE) return undefined;
  if (!Array.isArray(data.surfaces) || !Array.isArray(data.criteria)) return undefined;
  if (data.tester !== undefined && data.tester !== "human" && data.tester !== "agent")
    return undefined;
  return data as ManualQaData;
}

export function isManualQaHandoff(receipt: Receipt): boolean {
  return manualQaData(receipt) !== undefined;
}

/** A handoff still honours the project config: same tester opt-in kept, surfaces still configured. */
export function manualQaStillAllowed(project: ProjectConfig, data: ManualQaData): boolean {
  const tester = handoffTester(project);
  // A human handoff stays valid when the project later moved to the agent driver (a human still
  // tests or hands it to the lane); an agent handoff never survives a move back to manual.
  const was = data.tester ?? "human";
  const kept = tester === was || (tester === "agent" && was === "human");
  if (!kept || !data.surfaces.length) return false;
  const lane = laneSurfaceSet(project);
  return data.surfaces.every((s) => lane.has(s) && project.qa?.surfaces?.includes(s));
}

const SURFACE_NAMES: Record<QaSurface, string> = {
  host: "host",
  api: "API",
  web: "web",
  android: "Android",
  ios: "iOS",
};

export function manualQaReason(surfaces: readonly QaSurface[], tester: QaTester = "human"): string {
  const names = surfaces.map((s) => SURFACE_NAMES[s]).join("/");
  return tester === "agent"
    ? `agent ${names} QA running on the draft PR`
    : `manual ${names} QA required — draft PR ready`;
}
