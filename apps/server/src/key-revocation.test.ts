import { describe, expect, test } from "vitest";
import { setup } from "./test-helpers.js";

describe("key revocation authorization", () => {
  test.each(["human", "agent"] as const)(
    "an agent admin cannot revoke a %s admin key",
    async (kind) => {
      const context = await setup();
      const target = context.server.keys.create({
        name: "protected-admin",
        kind,
        scope: { projects: "*", actions: ["admin"] },
      });
      expect(
        (await context.call(context.admin, "DELETE", `/v1/keys/${target.key.id}`)).status,
      ).toBe(403);
      expect(context.server.keys.verify(target.token)).not.toBeNull();
    },
  );

  test("an agent admin cannot revoke a human read-only key", async () => {
    const context = await setup();
    const target = context.server.keys.create({
      name: "human-reader",
      kind: "human",
      scope: { projects: [context.project.id], actions: ["read"] },
    });
    expect((await context.call(context.admin, "DELETE", `/v1/keys/${target.key.id}`)).status).toBe(
      403,
    );
    expect(context.server.keys.verify(target.token)).not.toBeNull();
  });

  test("human admins may revoke other keys; ordinary agents cannot revoke unrelated agents", async () => {
    const context = await setup();
    const admin = context.server.keys.create({
      name: "human-admin",
      kind: "human",
      scope: { projects: "*", actions: ["admin"] },
    });
    const target = context.server.keys.create({
      name: "unrelated-agent",
      kind: "agent",
      scope: { projects: [context.project.id], actions: ["read"] },
    });
    expect(
      (await context.call(context.key(["read"]), "DELETE", `/v1/keys/${target.key.id}`)).status,
    ).toBe(403);
    expect(context.server.keys.verify(target.token)).not.toBeNull();
    expect((await context.call(admin.token, "DELETE", `/v1/keys/${target.key.id}`)).status).toBe(
      200,
    );
    expect(context.server.keys.verify(target.token)).toBeNull();
  });

  test("owners can revoke their agent keys and themselves, without admin grants", async () => {
    const context = await setup();
    const owner = context.server.keys.create({
      name: "owner",
      kind: "agent",
      scope: { projects: [context.project.id], actions: ["tickets:write"] },
    });
    const target = context.server.keys.create({
      name: "owned-agent",
      kind: "agent",
      createdByKeyId: owner.key.id,
      scope: { projects: [context.project.id], actions: ["read"] },
    });
    expect((await context.call(owner.token, "DELETE", `/v1/keys/${target.key.id}`)).status).toBe(
      200,
    );
    expect(context.server.keys.verify(target.token)).toBeNull();
    expect((await context.call(owner.token, "DELETE", `/v1/keys/${owner.key.id}`)).status).toBe(
      200,
    );
    expect(context.server.keys.verify(owner.token)).toBeNull();
    expect(
      context.server.audit
        .list({ keyId: owner.key.id })
        .filter((entry) => entry.method === "DELETE" && entry.status === 200),
    ).toHaveLength(2);
  });

  test.each([true, false])(
    "ownership=%s does not allow revocation outside project scope",
    async (owned) => {
      const context = await setup();
      const caller = context.server.keys.create({
        name: "scoped-admin",
        kind: "human",
        scope: { projects: [context.project.id], actions: ["admin"] },
      });
      const target = context.server.keys.create({
        name: "other-project-agent",
        kind: "agent",
        scope: { projects: [context.other.id], actions: ["read"] },
        ...(owned ? { createdByKeyId: caller.key.id } : {}),
      });
      expect((await context.call(caller.token, "DELETE", `/v1/keys/${target.key.id}`)).status).toBe(
        403,
      );
      expect(context.server.keys.verify(target.token)).not.toBeNull();
    },
  );

  test("creation stamps ownership from the authenticated caller, never the request body", async () => {
    const context = await setup();
    const caller = context.server.keys.verify(context.admin)!;
    const response = await context.call(context.admin, "POST", "/v1/keys", {
      name: "created-agent",
      kind: "agent",
      scope: { projects: [context.project.id], actions: ["read"] },
      createdByKeyId: "forged-owner",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      token: string;
      key: { id: string; createdByKeyId?: string; hash?: string };
    };
    expect(context.server.keys.get(body.key.id)?.createdByKeyId).toBe(caller.id);
    expect(body.key.createdByKeyId).toBeUndefined();
    expect(body.key.hash).toBeUndefined();
    expect((await context.call(context.admin, "DELETE", `/v1/keys/${body.key.id}`)).status).toBe(
      200,
    );
  });
});
