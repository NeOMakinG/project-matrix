import type { Notification, Notifier } from "./ports.js";

const ICON: Record<Notification["severity"], string> = {
  critical: "[CRITICAL]",
  high: "[HIGH]",
  medium: "[MEDIUM]",
  low: "[LOW]",
};

export function formatNotification(n: Notification): string {
  return [`${ICON[n.severity]} ${n.projectId}: ${n.title}`, n.body, n.url ?? ""]
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
      subject: `${ICON[n.severity]} ${n.title}`.slice(0, 180),
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
