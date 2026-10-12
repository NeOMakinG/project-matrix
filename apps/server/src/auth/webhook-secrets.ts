import { randomBytes } from "node:crypto";
import { PrivateState } from "../private-state.js";
import type { PrivateStateOwner } from "../state-owner.js";
import type { SourceSecrets } from "../webhooks.js";

export type WebhookSource = keyof SourceSecrets;

/**
 * Per-project webhook secrets, issued through the API and kept in a host-owned JSON file (mode 600).
 * `projects` is the live object the webhook routes read, so a newly issued secret works immediately.
 */
export class WebhookSecretStore {
  readonly projects: Record<string, SourceSecrets>;
  private readonly state: PrivateState<Record<string, SourceSecrets>>;

  constructor(file?: string, owner?: PrivateStateOwner) {
    this.state = new PrivateState(file, owner);
    this.projects = this.state.load({});
  }

  /** Issues (or rotates) a secret; the value is returned once and never listed. */
  issue(projectId: string, source: WebhookSource): string {
    const secret = randomBytes(32).toString("hex");
    this.projects[projectId] = { ...this.projects[projectId], [source]: secret };
    this.state.save(this.projects);
    return secret;
  }

  configured(projectId: string): WebhookSource[] {
    return Object.keys(this.projects[projectId] ?? {}) as WebhookSource[];
  }
}
