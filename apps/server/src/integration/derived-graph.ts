import { join } from "node:path";
import { FactoryToolingError } from "@matrix/core";
import { graphArtifacts } from "@matrix/graph";
import type { PrivateStateOwner } from "../state-owner.js";
import { publishOwnedFile } from "./owned-files.js";

export function derivedGraphHandover(
  workdir: string,
  signal: AbortSignal,
  owner?: PrivateStateOwner,
) {
  const check = () => {
    signal.throwIfAborted();
    owner?.assertOwned();
  };
  return {
    generate: async (staging: string) => {
      check();
      try {
        const artifacts = await graphArtifacts(staging);
        check();
        return artifacts.files;
      } catch (error) {
        check();
        throw new FactoryToolingError(
          `host-derived code graph generation failed: ${error instanceof Error ? error.message : "unknown"}`,
        );
      }
    },
    publish: (files: Record<string, { content: string; previous?: string }>) => {
      for (const [path, file] of Object.entries(files)) {
        check();
        publishOwnedFile({ root: workdir, path: join(workdir, path), ...file, owner });
      }
    },
  };
}
