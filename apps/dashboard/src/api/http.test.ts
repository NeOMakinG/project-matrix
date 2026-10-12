import { afterEach, describe, expect, it } from "vitest";
import { pathOf, setCsrfToken, withCsrf } from "./http";

afterEach(() => setCsrfToken(null));

describe("http helpers", () => {
  it("encodes every path parameter", () => {
    expect(pathOf("/v1/runs/{id}/events", { id: "a/b?c#d" })).toBe("/v1/runs/a%2Fb%3Fc%23d/events");
    expect(() => pathOf("/v1/runs/{id}", {})).toThrow("missing path param id");
  });

  it("sends cookies and a CSRF header only on mutations", () => {
    setCsrfToken("tok");
    const get = withCsrf();
    const post = withCsrf({ method: "post" });
    expect(get.credentials).toBe("include");
    expect(new Headers(get.headers).has("x-csrf-token")).toBe(false);
    expect(new Headers(post.headers).get("x-csrf-token")).toBe("tok");
  });

  it("falls back to the double-submit cookie", () => {
    document.cookie = "matrix_csrf=from-cookie";
    expect(new Headers(withCsrf({ method: "DELETE" }).headers).get("x-csrf-token")).toBe(
      "from-cookie",
    );
    document.cookie = "matrix_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT";
  });
});
