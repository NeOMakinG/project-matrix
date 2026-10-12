import { setupWorker } from "msw/browser";
import { restHandlers } from "./handlers";
import { sseHandlers } from "./sse";

export const worker = setupWorker(...restHandlers, ...sseHandlers);
