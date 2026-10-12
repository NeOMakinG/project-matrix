import { expect, test } from "vitest";
import { name } from "./index";

test("app name", () => {
  expect(name).toBe("@matrix/server");
});
