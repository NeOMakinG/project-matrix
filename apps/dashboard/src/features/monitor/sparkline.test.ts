import { describe, expect, it } from "vitest";
import { gatewayTone } from "@/components/sidebar";
import { sparklinePath } from "./monitor-page";

describe("sparklinePath", () => {
  it("maps the max to the top and the min to the bottom", () => {
    expect(sparklinePath([0, 1], 100, 50, 10)).toBe("M10.0,40.0 L90.0,10.0");
  });
  it("handles flat and empty series", () => {
    expect(sparklinePath([], 100, 50)).toBe("");
    expect(sparklinePath([2, 2, 2], 100, 50, 0)).toBe("M0.0,50.0 L50.0,50.0 L100.0,50.0");
  });
});

describe("gatewayTone", () => {
  it("is green at 75% healthy, amber below, red at zero", () => {
    expect(gatewayTone(4, 5)).toBe("green");
    expect(gatewayTone(2, 5)).toBe("amber");
    expect(gatewayTone(0, 5)).toBe("red");
  });
});
