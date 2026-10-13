import { describe, expect, it } from "vitest";
import { canManageProject, type Session } from "./contracts";

const session: Session = {
  csrfToken: "test",
  expiresAt: "2026-10-13T00:00:00Z",
  key: {
    id: "test",
    name: "test",
    kind: "human",
    scope: { actions: ["admin"], projects: ["allowed"] },
  },
};
describe("session-derived init permissions", () => {
  it("requires scoped admin permission and global scope to create projects", () => {
    expect(canManageProject(session, "allowed")).toBe(true);
    expect(canManageProject(session, "other")).toBe(false);
    expect(canManageProject(session)).toBe(false);
    expect(
      canManageProject({
        ...session,
        key: { ...session.key!, scope: { actions: ["admin"], projects: "*" } },
      }),
    ).toBe(true);
  });
  it("fails closed when a session omits its permissions", () => {
    expect(canManageProject(undefined)).toBe(false);
    expect(canManageProject({ ...session, key: null }, "allowed")).toBe(false);
    expect(
      canManageProject({ ...session, key: { id: "test", name: "test", kind: "human" } }, "allowed"),
    ).toBe(false);
  });
});
