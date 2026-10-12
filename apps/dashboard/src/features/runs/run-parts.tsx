import { Check, ExternalLink, FileVideo, Image, Terminal } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef } from "react";
import { type StreamState, useRunEvents } from "@/api/run-events";
import type { FindingView, HoldoutView, ReceiptView, RunEvent, RunView, Tone } from "@/api/view";
import { Card, CardHeader } from "@/components/ui/card";
import { Pill } from "@/components/ui/pill";
import { cn } from "@/lib/cn";
import { clock } from "@/lib/format";

const KIND_TONE: Record<RunEvent["kind"], string> = {
  log: "text-fg-secondary",
  tool: "text-violet",
  file: "text-accent",
  cost: "text-info",
  error: "text-danger",
  done: "text-accent",
};

export function PhaseStepper({ phases }: { phases: RunView["phases"] }) {
  return (
    <ol aria-label="Run phases" className="flex flex-wrap items-center gap-2">
      {phases.map(({ phase, state }, i) => (
        <li key={phase} className="flex items-center gap-2">
          {i > 0 ? (
            <span
              aria-hidden
              className={cn("h-px w-4", state === "pending" ? "bg-border-strong" : "bg-accent/50")}
            />
          ) : null}
          <span
            aria-current={state === "active" ? "step" : undefined}
            className={cn(
              "inline-flex h-7 items-center gap-2 rounded-control px-2.5 text-label",
              state === "done" && "bg-accent-dim text-fg",
              state === "active" && "bg-info-dim text-fg",
              state === "pending" && "border border-border-subtle text-fg-muted",
              state === "failed" && "bg-danger-dim text-danger",
            )}
          >
            <span
              aria-hidden
              className={cn(
                "size-1.5 rounded-full",
                state === "done" && "bg-accent",
                state === "active" && "bg-info",
                state === "pending" && "bg-fg-muted",
                state === "failed" && "bg-danger",
              )}
            />
            {phase}
            <span className="sr-only"> ({state})</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

const STREAM_PILL: Record<StreamState, { label: string; tone: Tone }> = {
  connecting: { label: "connecting", tone: "amber" },
  live: { label: "streaming", tone: "green" },
  reconnecting: { label: "reconnecting", tone: "amber" },
  ended: { label: "run finished", tone: "neutral" },
  closed: { label: "disconnected", tone: "red" },
};

export function LiveLog({ runId }: { runId: string }) {
  const { events, state } = useRunEvents(runId);
  const end = useRef<HTMLLIElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "nearest" });
  }, [events.length]);
  const pill = STREAM_PILL[state];

  return (
    <Card>
      <CardHeader title="Live log" meta={<Pill tone={pill.tone}>{pill.label}</Pill>} />
      <ol
        aria-label="Run log"
        aria-live="polite"
        className="max-h-[360px] space-y-1.5 overflow-y-auto px-4 pb-4"
      >
        {events.length === 0 ? (
          <li className="text-caption text-fg-muted">
            {state === "closed" ? "Live log unavailable." : "Waiting for the first event…"}
          </li>
        ) : null}
        <AnimatePresence initial={false}>
          {events.map((event) => (
            <motion.li
              key={`${event.at}|${event.kind}|${event.message}`}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              className="grid grid-cols-[64px_48px_minmax(0,1fr)] gap-2 font-mono text-caption"
            >
              <span className="text-fg-muted">{clock(event.at)}</span>
              <span className={KIND_TONE[event.kind]}>{event.kind}</span>
              <span className="break-words text-fg">{event.message}</span>
            </motion.li>
          ))}
        </AnimatePresence>
        <li ref={end} aria-hidden />
      </ol>
    </Card>
  );
}

const SEVERITY_TONE: Record<FindingView["severity"], Tone> = { P1: "red", P2: "amber", P3: "blue" };

export function Findings({ findings }: { findings: FindingView[] }) {
  const p1 = findings.filter((f) => f.severity === "P1").length;
  return (
    <Card>
      <CardHeader title="Review findings" meta={`${findings.length} findings · P1 ${p1}`} />
      {findings.length === 0 ? (
        <p className="px-4 pb-4 text-body text-fg-secondary">No review findings yet.</p>
      ) : (
        <ul className="px-4 pb-2">
          {findings.map((f) => (
            <li
              key={f.id}
              className="grid grid-cols-[48px_72px_minmax(0,1fr)_auto] items-center gap-3 border-border-subtle border-b py-3 last:border-0"
            >
              <Pill tone={f.resolution === "accepted" ? "neutral" : SEVERITY_TONE[f.severity]}>
                {f.severity}
              </Pill>
              <span className="truncate font-mono text-caption text-fg-muted">{f.lane}</span>
              <span className="text-body text-fg">{f.text}</span>
              <span className="font-mono text-caption text-fg-secondary">{f.resolution}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

const RECEIPT_ICON: Record<ReceiptView["kind"], typeof Check> = {
  screenshot: Image,
  video: FileVideo,
  curl: Terminal,
  test: Check,
  log: Terminal,
};

function ReceiptLink({ receipt, children }: { receipt: ReceiptView; children: React.ReactNode }) {
  return receipt.url ? (
    <a
      href={receipt.url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 hover:text-accent"
    >
      {children}
      <ExternalLink aria-hidden className="size-3" />
    </a>
  ) : (
    <>{children}</>
  );
}

export function Receipts({ receipts }: { receipts: ReceiptView[] }) {
  const shots = receipts.filter((r) => r.kind === "screenshot");
  const chips = receipts.filter((r) => r.kind !== "screenshot");
  const allOk = receipts.length > 0 && receipts.every((r) => r.ok);
  return (
    <Card>
      <CardHeader
        title="QA receipts"
        meta={<Pill tone={allOk ? "green" : "amber"}>{`${receipts.length} receipts`}</Pill>}
      />
      <div className="px-4 pb-4">
        {receipts.length === 0 ? (
          <p className="text-body text-fg-secondary">No receipts yet.</p>
        ) : null}
        <div className="grid grid-cols-3 gap-2">
          {shots.map((shot) => (
            <figure key={shot.label}>
              <div className="flex h-16 flex-col justify-between rounded-control border border-border-subtle bg-raised p-2">
                <span className="h-1.5 w-1/2 rounded bg-border-strong" />
                <span className="h-3 w-1/3 rounded bg-accent-dim" />
              </div>
              <figcaption className="mt-1 truncate font-mono text-caption text-fg-secondary">
                <ReceiptLink receipt={shot}>{shot.label}</ReceiptLink>
              </figcaption>
            </figure>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {chips.map((chip) => {
            const Icon = RECEIPT_ICON[chip.kind];
            return (
              <span
                key={chip.label}
                className="inline-flex items-center gap-1.5 rounded-control border border-border-subtle bg-raised px-2 py-1 font-mono text-caption text-fg"
              >
                <Icon className={cn("size-3", chip.ok ? "text-accent" : "text-danger")} />
                <ReceiptLink receipt={chip}>{chip.label}</ReceiptLink>
              </span>
            );
          })}
        </div>
      </div>
    </Card>
  );
}

export function Holdout({ holdout }: { holdout: HoldoutView }) {
  const ratio = holdout.total ? holdout.satisfied / holdout.total : 0;
  return (
    <Card>
      <CardHeader title="Holdout scenarios" meta="hidden from implementer" />
      <div className="px-4 pb-4">
        <div className="flex items-baseline gap-3">
          <span className="font-mono text-stat font-medium">
            {holdout.satisfied} / {holdout.total}
          </span>
          <span className="text-caption text-fg-secondary">
            satisfaction {holdout.score.toFixed(2)} · judge {holdout.judge}
          </span>
        </div>
        <div
          role="progressbar"
          aria-label="Holdout satisfaction"
          aria-valuemin={0}
          aria-valuemax={holdout.total}
          aria-valuenow={holdout.satisfied}
          className="mt-3 h-1.5 overflow-hidden rounded-full bg-raised"
        >
          <div className="h-full rounded-full bg-accent" style={{ width: `${ratio * 100}%` }} />
        </div>
        {holdout.pending ? (
          <p className="mt-3 text-body text-fg-secondary">{holdout.pending}</p>
        ) : null}
      </div>
    </Card>
  );
}
