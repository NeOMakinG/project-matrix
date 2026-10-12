import type { RedactOptions } from "../redact.js";

export interface NormalizeOptions {
  /**
   * `provider:project` pairs (e.g. `sentry:ledgerly-api`) whose events come from server SDKs only,
   * with a DSN that never ships to clients. Only these can produce `trust: "server"` signals.
   */
  trustedServerProjects?: string[];
  redact?: RedactOptions;
}
