import type { Notification, Notifier } from "./ports.js";
import { singleLine } from "./redact.js";

const ICON: Record<Notification["severity"], string> = {
  critical: "[CRITICAL]",
  high: "[HIGH]",
  medium: "[MEDIUM]",
  low: "[LOW]",
};

export function formatNotification(n: Notification): string {
  // Title and URL are single-line so content can't forge extra lines; the body is plain text.
  return [
    `${ICON[n.severity]} ${singleLine(n.projectId, 60)}: ${singleLine(n.title, 200)}`,
    n.body.replace(/\r/g, "").slice(0, 2000),
    n.url ? singleLine(n.url, 500) : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Telegram Bot API `sendMessage`. */
export class TelegramNotifier implements Notifier {
  constructor(private readonly opts: { botToken: string; chatId: string; fetch?: typeof fetch }) {}

  async notify(n: Notification): Promise<void> {
    const doFetch = this.opts.fetch ?? fetch;
    const res = await doFetch(`https://api.telegram.org/bot${this.opts.botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: this.opts.chatId,
        text: formatNotification(n),
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) throw new Error(`telegram ${res.status}`);
  }
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

/** Port: the mail transport (SMTP client, provider API, …). */
export interface EmailTransport {
  send(message: EmailMessage): Promise<void>;
}

export class EmailNotifier implements Notifier {
  constructor(private readonly opts: { to: string; transport: EmailTransport }) {}

  async notify(n: Notification): Promise<void> {
    await this.opts.transport.send({
      to: this.opts.to,
      // No CR/LF in the subject: header injection with permissive transports.
      subject: singleLine(`${ICON[n.severity]} ${n.title}`, 180),
      text: formatNotification(n),
    });
  }
}

/** Fan-out; one failing channel doesn't block the others. */
export class MultiNotifier implements Notifier {
  constructor(private readonly targets: Notifier[]) {}

  async notify(n: Notification): Promise<void> {
    const results = await Promise.allSettled(this.targets.map((t) => t.notify(n)));
    const failed = results.filter((r) => r.status === "rejected");
    if (failed.length === this.targets.length && failed.length > 0) {
      throw new Error("all notification channels failed");
    }
  }
}
