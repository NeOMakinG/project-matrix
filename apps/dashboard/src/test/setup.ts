import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterAll, afterEach, beforeAll } from "vitest";
import { setCsrfToken } from "@/api/http";
import { resetMockDb } from "@/mocks/handlers";
import { clearRenderedRoutes } from "./render";
import { server } from "./server";

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= NoopResizeObserver as unknown as typeof ResizeObserver;

beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(async () => {
  cleanup();
  await clearRenderedRoutes();
  setCsrfToken(null);
  server.resetHandlers();
  resetMockDb();
});
afterAll(() => server.close());

if (typeof window !== "undefined") {
  class DOMMatrixReadOnlyStub {
    m22: number;
    constructor(transform?: string) {
      const scale = transform?.match(/scale\(([\d.]+)\)/)?.[1];
      this.m22 = scale !== undefined ? Number(scale) : 1;
    }
  }
  globalThis.DOMMatrixReadOnly ??= DOMMatrixReadOnlyStub as unknown as typeof DOMMatrixReadOnly;
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
  window.scrollTo = () => {};
}
