import { join } from "node:path";
import { type HoldoutScenario, HoldoutStore } from "@matrix/core";
import type { PrivateStateOwner } from "../state-owner.js";
import { publishOwnedFile } from "./owned-files.js";

export class OwnedHoldoutStore extends HoldoutStore {
  constructor(
    private readonly directory: string,
    private readonly owner: PrivateStateOwner,
  ) {
    super(directory);
  }

  override async save(
    projectId: string,
    ticketId: string,
    scenarios: HoldoutScenario[],
  ): Promise<void> {
    this.owner.assertOwned();
    if (![projectId, ticketId].every((id) => /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(id)))
      throw new Error("unsafe project or ticket id for holdout path");
    publishOwnedFile({
      root: this.directory,
      path: join(this.directory, projectId, `${ticketId}.json`),
      content: JSON.stringify(scenarios, null, 2),
      replace: true,
      mode: 0o600,
      owner: this.owner,
    });
  }
}
