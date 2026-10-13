import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { createServer } from "../http/app.js";
import { ErrorBody, Project as ProjectSchema } from "../http/schemas.js";
import { createFactory } from "./factory.js";

vi.mock("node:child_process", async (load) => {
  const original = await load<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  return {
    ...original,
    execFile: Object.assign(
      () => {
        throw new Error("unexpected non-promisified execution");
      },
      {
        [promisify.custom]: async (binary: string, args: string[], options: object) =>
          binary === "git"
            ? { stdout: "", stderr: "" }
            : promisify(original.execFile)(binary, args, options),
      },
    ),
  };
});

test.each(["missing", "failed"])(
  "tracker %s returns safe HTTP 503, removes only its unpublished repo, and allows retry (mock Git, fake runtime)",
  async (reason) => {
    const directory = await mkdtemp(join(tmpdir(), "matrix-tracker-error-"));
    const binary = join(directory, "bd-fixture");
    const planted = "planted-fixture-secret-never-return";
    if (reason === "failed")
      await writeFile(
        binary,
        `#!/bin/sh\nmkdir -p .beads\necho partial > .beads/partial\necho '${planted}' >&2\nexit 7\n`,
        { mode: 0o755 },
      );
    const factory = await createFactory({
      runtime: "fake",
      dataDir: directory,
      host: "test",
      binaries: { bd: binary },
      log: () => {},
    });
    const server = createServer({ core: factory.core });
    const { token } = server.keys.create({
      name: "admin",
      kind: "human",
      scope: { projects: "*", actions: ["admin"] },
    });
    const projects = join(directory, "projects");
    await mkdir(join(projects, "existing"));
    await writeFile(join(projects, "existing", "preserve"), "saved project");
    const create = (tickets?: { kind: "markdown" }) =>
      server.app.request("/v1/projects", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          name: "test",
          description: "",
          workspace: "native",
          ...(tickets ? { tickets } : {}),
        }),
      });
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await create();
        expect(response.status).toBe(503);
        const body = ErrorBody.parse(await response.json());
        expect(body.error.code).toBe("tracker_unavailable");
        expect(body.error.message).toContain(
          reason === "missing" ? "binary bd is missing" : "initialization failed using bd",
        );
        expect(body.error.message).toContain("markdown or github");
        for (const unsafe of [planted, directory, "ENOENT", "stack", "Command failed"])
          expect(JSON.stringify(body)).not.toContain(unsafe);
        expect(await readdir(projects)).toEqual(["existing"]);
        expect(await readFile(join(projects, "existing", "preserve"), "utf8")).toBe(
          "saved project",
        );
        expect(await factory.store.listProjects()).toEqual([]);
      }
      const retry = await create({ kind: "markdown" });
      expect(retry.status).toBe(200);
      const project = ProjectSchema.parse(await retry.json());
      expect((await factory.store.listProjects()).map((entry) => entry.id)).toEqual([project.id]);
      expect((await readdir(projects)).sort()).toEqual(["existing", project.id].sort());
    } finally {
      await server.close();
      await factory.stop();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
