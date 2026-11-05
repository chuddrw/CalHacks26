/**
 * hooks/src/lib/usage.ts
 *
 * WHAT IT'S FOR
 *   Reads the new part of a Claude Code transcript (JSONL) since the last report and sums the token
 *   usage of its assistant messages, so the Stop hook can send one report_usage per turn.
 *   A cursor file per session remembers the byte offset already reported. Streaming writes the
 *   same assistant message several times, so a message id counts once.
 *   costUsd is left at 0: prices change, so the dashboard computes cost from tokens and a price table.
 *   The trace id is the request id (the caller passes it); this file doesn't know it.
 */
import { closeSync, mkdirSync, openSync, readFileSync, readSync, fstatSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface UsageDelta {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Byte offset to store once the delta has been reported. */
  nextOffset: number;
}

const cursorDir = () => path.join(os.tmpdir(), "cowork-usage-cursors");
const cursorFile = (session: string) => path.join(cursorDir(), `${session.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);

export function readCursor(session: string): number {
  try {
    const value = JSON.parse(readFileSync(cursorFile(session), "utf8")) as { offset?: unknown };
    return typeof value.offset === "number" && value.offset >= 0 ? value.offset : 0;
  } catch {
    return 0;
  }
}

export function writeCursor(session: string, offset: number): void {
  try {
    mkdirSync(cursorDir(), { recursive: true });
    writeFileSync(cursorFile(session), JSON.stringify({ offset }));
  } catch {
    // Losing the cursor only means the next report repeats some usage; never fail a hook for it.
  }
}

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

/** Sums assistant usage in transcript bytes after `offset`. Returns undefined when there is nothing new. */
export function usageSince(transcriptPath: string, offset: number): UsageDelta | undefined {
  let fd: number;
  try {
    fd = openSync(transcriptPath, "r");
  } catch {
    return undefined;
  }
  try {
    const size = fstatSync(fd).size;
    if (size <= offset) return undefined;
    const buffer = Buffer.alloc(size - offset);
    readSync(fd, buffer, 0, buffer.length, offset);
    const text = buffer.toString("utf8");
    // Only whole lines count; a half-written last line waits for the next turn.
    const end = text.lastIndexOf("\n") + 1;
    if (end === 0) return undefined;
    const seen = new Set<string>();
    const total: UsageDelta = { model: "", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, nextOffset: offset + Buffer.byteLength(text.slice(0, end)) };
    for (const line of text.slice(0, end).split("\n")) {
      if (!line.trim()) continue;
      let entry: { type?: string; message?: { id?: string; model?: string; usage?: Record<string, unknown> } };
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const message = entry.message;
      if (entry.type !== "assistant" || !message?.usage) continue;
      if (message.id) {
        if (seen.has(message.id)) continue;
        seen.add(message.id);
      }
      total.inputTokens += num(message.usage.input_tokens);
      total.outputTokens += num(message.usage.output_tokens);
      total.cacheReadTokens += num(message.usage.cache_read_input_tokens);
      total.cacheWriteTokens += num(message.usage.cache_creation_input_tokens);
      if (message.model) total.model = message.model;
    }
    const any = total.inputTokens + total.outputTokens + total.cacheReadTokens + total.cacheWriteTokens;
    return any > 0 ? total : undefined;
  } finally {
    closeSync(fd);
  }
}
