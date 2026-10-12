import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { SourceSecrets } from "../webhooks.js";

export type WebhookSource = keyof SourceSecrets;

/**
 * Per-project webhook secrets, issued through the API and kept in a host-owned JSON file (mode 600).
 * `projects` is the live object the webhook routes read, so a newly issued secret works immediately.
 */
export class WebhookSecretStore {
  readonly projects: Record<string, SourceSecrets>;

  constructor(private readonly file?: string) {
    this.projects =
      file && existsSync(file)
        ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, SourceSecrets>)
        : {};
  }

  /** Issues (or rotates) a secret; the value is returned once and never listed. */
  issue(projectId: string, source: WebhookSource): string {
    const secret = randomBytes(32).toString("hex");
    this.projects[projectId] = { ...this.projects[projectId], [source]: secret };
    if (this.file) {
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.projects), { mode: 0o600 });
      renameSync(tmp, this.file);
    }
    return secret;
  }

  configured(projectId: string): WebhookSource[] {
    return Object.keys(this.projects[projectId] ?? {}) as WebhookSource[];
  }
}
