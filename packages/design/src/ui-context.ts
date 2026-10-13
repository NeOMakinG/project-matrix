import {
  hostUiContextSchema,
  type ProjectConfig,
  targetsUi,
  type UiContextPort,
  type WorkflowState,
} from "@matrix/core";
import { z } from "zod";

const snapshotSchema = z
  .object({
    baseSha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    headSha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    complete: z.literal(true),
    files: hostUiContextSchema.shape.files,
    changes: z
      .array(z.object({ path: z.string(), oldPath: z.string().optional() }).strict())
      .max(100000),
    graph: z
      .array(
        z
          .object({ path: z.string(), role: z.enum(["ui", "server", "shared", "unknown"]) })
          .strict(),
      )
      .max(100000),
  })
  .strict();
export interface SafeGitReadOnlyPort {
  inspect(project: ProjectConfig, workflow: WorkflowState): Promise<z.input<typeof snapshotSchema>>;
}
export class HostUiContext implements UiContextPort {
  constructor(readonly git: SafeGitReadOnlyPort) {}
  async inspect(project: ProjectConfig, workflow: WorkflowState) {
    try {
      const snapshot = snapshotSchema.parse(await this.git.inspect(project, workflow));
      const roles = new Map(snapshot.graph.map((item) => [item.path, item.role]));
      if (roles.size !== snapshot.graph.length) throw new Error("duplicate graph paths");
      const changedPaths = [
        ...new Set(
          snapshot.changes.flatMap((item) => [item.path, ...(item.oldPath ? [item.oldPath] : [])]),
        ),
      ];
      const files = [...new Set([...snapshot.files, ...changedPaths])];
      const uiFiles = files.filter((path) => targetsUi([], [path]) || roles.get(path) === "ui");
      const nonUiFiles = files.filter(
        (path) => roles.get(path) === "server" && !uiFiles.includes(path),
      );
      const projectKind = !files.length
        ? "unknown"
        : nonUiFiles.length === files.length
          ? "server-only"
          : uiFiles.length === files.length
            ? "ui"
            : files.every((path) => uiFiles.includes(path) || nonUiFiles.includes(path))
              ? "mixed"
              : "unknown";
      return hostUiContextSchema.parse({ projectKind, files, uiFiles, nonUiFiles, changedPaths });
    } catch {
      return hostUiContextSchema.parse({ projectKind: "unknown", files: [] });
    }
  }
}
