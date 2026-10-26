import { expect, test } from "vitest";
import { gate } from "./machine.js";
import {
  acceptanceCriteria,
  isManualQaHandoff,
  manualQaPlan,
  manualQaReason,
  manualQaReceipt,
  manualQaStillAllowed,
  requiredDeviceSurfaces,
  ticketSurfaces,
} from "./manual-qa.js";
import { testProject } from "./testing/fakes.js";

const android = testProject({ qa: { surfaces: ["android"], driver: "manual" } });

test("ticket surface lines are parsed loosely but only known surfaces count", () => {
  expect(ticketSurfaces("Intro\nQA: Surface: Android, iOS\n")).toEqual(["android", "ios"]);
  expect(ticketSurfaces("- **QA:** Surfaces: web")).toEqual(["web"]);
  expect(ticketSurfaces("QA: Surface: android-tv; rm -rf")).toEqual([]);
  expect(ticketSurfaces("mentions QA: Surface: android mid-line")).toEqual([]);
});

test("ticket text can narrow configured surfaces, never add one", () => {
  const both = testProject({ qa: { surfaces: ["android", "ios"], driver: "manual" } });
  expect(requiredDeviceSurfaces(both, { body: "" })).toEqual(["android", "ios"]);
  expect(requiredDeviceSurfaces(both, { body: "QA: Surface: ios" })).toEqual(["ios"]);
  // Naming no configured surface cannot escape device QA.
  expect(requiredDeviceSurfaces(both, { body: "QA: Surface: web" })).toEqual(["android", "ios"]);
  const mixed = testProject({ qa: { surfaces: ["android", "web"], driver: "manual" } });
  // Naming only a non-lane surface cannot escape device QA either (only a backend-only diff can).
  expect(requiredDeviceSurfaces(mixed, { body: "QA: Surface: web" })).toEqual(["android"]);
  // No project config: a ticket claiming android cannot opt into anything.
  expect(requiredDeviceSurfaces(testProject(), { body: "QA: Surface: android" })).toEqual([]);
  const manualOnlyWeb = testProject({ qa: { surfaces: ["web"], driver: "manual" } });
  expect(manualQaPlan(manualOnlyWeb, { body: "QA: Surface: android" })).toEqual({ mode: "auto" });
});

test("manual only with the operator opt-in and no driver for the surface", () => {
  expect(manualQaPlan(android, { body: "" })).toEqual({
    mode: "manual",
    surfaces: ["android"],
    tester: "human",
  });
  expect(
    manualQaPlan({ ...android, qa: { surfaces: ["android"], driver: "agent" } }, { body: "" }),
  ).toEqual({ mode: "manual", surfaces: ["android"], tester: "agent" });
  expect(manualQaPlan(android, { body: "" }, ["host", "android"])).toEqual({ mode: "auto" });
  const none = testProject({ qa: { surfaces: ["android"] } });
  expect(manualQaPlan(none, { body: "" })).toEqual({ mode: "unavailable", surfaces: ["android"] });
  expect(manualQaPlan(testProject(), { body: "QA: Surface: android" })).toEqual({ mode: "auto" });
});

test("acceptance criteria come from the ticket's public section only", () => {
  const body = [
    "Let users export trips.",
    "## Acceptance criteria",
    "- [ ] Export button on the trip screen",
    "1. Tapping it shares a PDF",
    "* Works offline",
    "## Notes",
    "- not a criterion",
    "**Acceptance:**",
    "- Shows a toast",
  ].join("\n");
  expect(acceptanceCriteria(body)).toEqual([
    "Export button on the trip screen",
    "Tapping it shares a PDF",
    "Works offline",
    "Shows a toast",
  ]);
  expect(acceptanceCriteria("no section\n- item")).toEqual([]);
  expect(acceptanceCriteria("Acceptance criteria:\n- a\u200bb")).toEqual(["ab"]);
});

test("the handoff receipt passes the QA gate and is re-checked against config", () => {
  const receipt = manualQaReceipt(["android"], ["Export works"], 3);
  expect(isManualQaHandoff(receipt)).toBe(true);
  expect(receipt.summary).not.toContain("Export works");
  expect(gate("qa", { ok: true, summary: "", receipts: [receipt] }, android).pass).toBe(true);
  expect(
    gate(
      "qa",
      { ok: true, summary: "", receipts: [receipt, { kind: "test", ok: false, summary: "x" }] },
      android,
    ).pass,
  ).toBe(false);
  const data = receipt.data as Parameters<typeof manualQaStillAllowed>[1];
  expect(manualQaStillAllowed(android, data)).toBe(true);
  expect(manualQaStillAllowed(testProject({ qa: { surfaces: ["android"] } }), data)).toBe(false);
  expect(manualQaStillAllowed(testProject(), data)).toBe(false);
  expect(isManualQaHandoff({ kind: "test", ok: true, summary: "", data: receipt.data })).toBe(
    false,
  );
  expect(manualQaReason(["android"])).toBe("manual Android QA required — draft PR ready");
});
