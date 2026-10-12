import { expect, test } from "vitest";
import { name } from "./index";

test("package name", () => {
  expect(name).toBe("@matrix/watch");
});
