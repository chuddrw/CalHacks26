/** WHAT IT'S FOR: one shared clock for relative times, without one timer per row. */
import { useSyncExternalStore } from "react";
let now = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();
function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  if (!timer) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      listeners.forEach((listener) => listener());
    }, 1000);
  }
  return () => {
    listeners.delete(callback);
    if (!listeners.size && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}
export function useNow(): number {
  return useSyncExternalStore(subscribe, () => now);
}
