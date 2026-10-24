/** WHAT IT'S FOR: React table access and explicit live/demo startup. Owner: D. */
import { useSyncExternalStore } from "react";
import type { TableName, TableRows } from "../../shared/src/schema.ts";
import { emptyTables } from "./dashboard";
import { getSnapshot, replaceTables, setConnection, subscribe } from "./store";
import { startLive, type Bindings } from "./live";
import { startDemo } from "./demo";
export { setRows } from "./store";

export function useDashboard() {
  return useSyncExternalStore(subscribe, getSnapshot);
}
export function useRows<T extends TableName>(table: T): TableRows[T][] {
  return useSyncExternalStore(subscribe, () => getSnapshot().tables[table]);
}
let stop: (() => void) | undefined;
let epoch = 0;
export function connect(): () => void {
  stop?.();
  const current = ++epoch;
  replaceTables(emptyTables());
  stop = undefined;
  if (new URLSearchParams(location.search).has("demo")) {
    setConnection({
      phase: "demo",
      detail: "Simulated data. No agents or database are connected.",
    });
    stop = startDemo();
  } else {
    const database = import.meta.env.VITE_STDB_DB?.trim();
    const host =
      import.meta.env.VITE_STDB_HOST?.trim() ||
      "https://maincloud.spacetimedb.com";
    // C's real generated index is discovered at build time. An empty glob is intentional today.
    const generated = import.meta.glob("../../shared/module_bindings/index.ts");
    const load = generated["../../shared/module_bindings/index.ts"];
    if (!database || !load) {
      setConnection({
        phase: "unconfigured",
        detail: !database
          ? "Set VITE_STDB_DB in the root .env, then restart the dashboard."
          : "Waiting for generated SpacetimeDB bindings from C. Generate them, then restart the dashboard.",
      });
    } else {
      setConnection({
        phase: "connecting",
        detail: "Loading the database client…",
      });
      void load()
        .then((module) => {
          if (current !== epoch) return;
          const bindings = module as Partial<Bindings>;
          if (!bindings.DbConnection?.builder)
            throw new Error(
              "Generated bindings must export DbConnection.builder().",
            );
          stop = startLive(bindings as Bindings, host, database);
        })
        .catch((error) => {
          if (current === epoch)
            setConnection({
              phase: "error",
              detail:
                error instanceof Error
                  ? error.message
                  : "Could not load database bindings.",
            });
        });
    }
  }
  return () => {
    if (current === epoch) {
      epoch++;
      stop?.();
      stop = undefined;
    }
  };
}
