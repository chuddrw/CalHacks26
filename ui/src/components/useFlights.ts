/**
 * WHAT IT'S FOR: turn new transfers (transfers.ts) into short-lived arrows. The first full picture
 * after connecting only sets the baseline; after that, each new transfer gets an arrow for
 * ARROW_MS. Several at once play one after another, oldest first. Flights are in start order.
 */
import { useEffect, useRef, useState } from "react";
import type { ConnectionPhase, Tables } from "../dashboard";
import { newTransfers, transfers, type Transfer } from "../transfers";

export const ARROW_MS = 4000;
/** Gap between arrows of one burst: long enough to read each label (only the newest shows one). */
const STAGGER_MS = 1200;
/** A burst larger than this (say, after a long reconnect) only plays its newest transfers. */
const MAX_BURST = 12;

export interface Flight {
  id: number;
  transfer: Transfer;
}

export function useFlights(tables: Tables, phase: ConnectionPhase): Flight[] {
  const seen = useRef<Set<string> | null>(null);
  const nextStart = useRef(0);
  const counter = useRef(0);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const [flights, setFlights] = useState<Flight[]>([]);
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending) clearTimeout(timer);
      pending.clear();
    };
  }, []);
  useEffect(() => {
    if (phase !== "live" || tables.agent.length === 0) {
      seen.current = null; // Reconnecting: the next full picture is a new baseline, not a burst.
      return;
    }
    const all = transfers(tables);
    const previous = seen.current;
    seen.current = new Set(all.map((x) => x.key));
    if (!previous) return;
    const later = (ms: number, run: () => void) => {
      const timer = setTimeout(() => {
        timers.current.delete(timer);
        run();
      }, ms);
      timers.current.add(timer);
    };
    for (const transfer of newTransfers(previous, all).slice(-MAX_BURST)) {
      const now = Date.now();
      const start = Math.max(now, nextStart.current);
      nextStart.current = start + STAGGER_MS;
      const flight = { id: ++counter.current, transfer };
      later(start - now, () => setFlights((f) => [...f, flight]));
      later(start - now + ARROW_MS, () =>
        setFlights((f) => f.filter((x) => x !== flight)),
      );
    }
  }, [tables, phase]);
  return flights;
}
