import { expect, test, vi } from "vitest";
import { fenceDatabase } from "./ownership-fence.js";

test("query await boundaries fence a lost owner before another statement or transaction commit", async () => {
  let owned = true;
  let finish!: () => void;
  const suspended = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const publication = vi.fn(async () => {});
  const committed = vi.fn();
  const rolledBack = vi.fn();
  const database = {
    select: () => suspended,
    insert: publication,
    transaction: async (
      action: (tx: { select: () => Promise<void>; insert: typeof publication }) => Promise<void>,
    ) => {
      try {
        await action(database);
        committed();
      } catch (error) {
        rolledBack();
        throw error;
      }
    },
  };
  const fenced = fenceDatabase(database, () => {
    if (!owned) throw new Error("ownership lost");
  });
  const pending = fenced.transaction(async (tx) => {
    await tx.select();
    await tx.insert();
  });
  const failed = expect(pending).rejects.toThrow("ownership lost");
  owned = false;
  finish();
  await failed;
  expect(publication).not.toHaveBeenCalled();
  expect(committed).not.toHaveBeenCalled();
  expect(rolledBack).toHaveBeenCalledTimes(1);
});
