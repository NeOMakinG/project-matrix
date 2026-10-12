export const name = "@matrix/server";
export { Guard, HttpError, type Principal } from "./auth/guard.js";
export { ACTIONS, type Action, type ApiKeyRecord, type KeyScope, KeyStore } from "./auth/keys.js";
export type * from "./core-port.js";
export { CoreError } from "./core-port.js";
export { createServer, type ServerOptions } from "./http/app.js";
export { MemoryCore } from "./memory-core.js";
export { Operations } from "./ops.js";
