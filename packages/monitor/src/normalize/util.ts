import { createHash } from "node:crypto";
import type { SignalLevel, StackFrame } from "../signal.js";

export type Json = Record<string, unknown>;

export const obj = (v: unknown): Json =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};

export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : typeof v === "number" ? String(v) : undefined;

export const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v)
    ? v
    : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))
      ? Number(v)
      : undefined;

export const shortHash = (...parts: string[]) =>
  createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 16);

export function level(v: unknown, fallback: SignalLevel = "error"): SignalLevel {
  const s = str(v)?.toLowerCase();
  if (s === "fatal" || s === "critical" || s === "page") return "fatal";
  if (s === "error" || s === "high") return "error";
  if (s === "warning" || s === "warn" || s === "medium") return "warning";
  if (s === "info" || s === "low" || s === "debug") return "info";
  return fallback;
}

/** ISO timestamp from seconds, milliseconds or a date string; falls back to `fallback`. */
export function isoTime(v: unknown, fallback: string): string {
  const n = num(v);
  if (n !== undefined) {
    const ms = n < 1e12 ? n * 1000 : n;
    return new Date(ms).toISOString();
  }
  const s = str(v);
  if (s) {
    // "2026-10-12 09:20:00.000" (Uptime Kuma, many DB dumps) has no zone: treat it as UTC.
    const naive = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s);
    const d = new Date(naive ? `${s.replace(" ", "T")}Z` : s);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date(fallback).toISOString();
}

/** Sentry-style frames (oldest first). Returned crash-site first, which is what grouping wants. */
export function frames(raw: unknown): StackFrame[] {
  const out: StackFrame[] = [];
  for (const f of arr(raw)) {
    const o = obj(f);
    const file = str(o.filename) ?? str(o.abs_path) ?? str(o.module) ?? str(o.source);
    if (!file) continue;
    const fn = str(o.function) ?? str(o.resolved_name) ?? str(o.mangled_name);
    const line = num(o.lineno) ?? num(o.line);
    out.push({
      file,
      ...(fn ? { function: fn } : {}),
      ...(line !== undefined ? { line: Math.trunc(line) } : {}),
      inApp: o.in_app === undefined ? !file.includes("node_modules") : o.in_app === true,
    });
  }
  return out.reverse();
}

export function withOptional<T extends object>(base: T, extras: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(extras)) if (v !== undefined) out[k] = v;
  return out as T;
}
