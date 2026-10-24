/** WHAT IT'S FOR: exercise subscription readiness, batched changes, reconnects, and teardown. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay, setImmediate } from "node:timers/promises";
import {
  startLive,
  tableNames,
  type Bindings,
  type ConnectionBuilder,
} from "../src/live.ts";
import { emptyTables } from "../src/dashboard.ts";
import { getSnapshot, replaceTables, subscribe } from "../src/store.ts";

function fakeTransport() {
  const rows: Record<string, unknown[]> = Object.fromEntries(
    tableNames.map((t) => [t, []]),
  );
  const listeners = new Set<() => void>();
  let connected: (
    connection: ReturnType<ConnectionBuilder["build"]>,
  ) => void = () => {};
  let disconnected: (...args: unknown[]) => void = () => {};
  let applied: () => void = () => {};
  let subscriptionError: () => void = () => {};
  let builds = 0;
  let unsubscribes = 0;
  const tokens: string[] = [];
  const connection = {
    db: Object.fromEntries(
      tableNames.map((t) => [
        t,
        {
          iter: () => rows[t],
          onInsert: (cb: () => void) => {
            listeners.add(cb);
          },
          onUpdate: (cb: () => void) => {
            listeners.add(cb);
          },
          onDelete: (cb: () => void) => {
            listeners.add(cb);
          },
          removeOnInsert: (cb: () => void) => {
            listeners.delete(cb);
          },
          removeOnUpdate: (cb: () => void) => {
            listeners.delete(cb);
          },
          removeOnDelete: (cb: () => void) => {
            listeners.delete(cb);
          },
        },
      ]),
    ),
    disconnect: () => {
      disconnected();
    },
    subscriptionBuilder: () => {
      const builder = {
        onApplied: (cb: () => void) => {
          applied = cb;
          return builder;
        },
        onError: (cb: () => void) => {
          subscriptionError = cb;
          return builder;
        },
        subscribe: (queries: string[]) => {
          assert.equal(queries.length, 7);
          return {
            unsubscribe: () => {
              unsubscribes++;
            },
          };
        },
      };
      return builder;
    },
  };
  const builder = {
    withUri: () => builder,
    withDatabaseName: () => builder,
    withToken: (token: string) => {
      tokens.push(token);
      return builder;
    },
    onConnect: (cb: typeof connected) => {
      connected = cb;
      return builder;
    },
    onConnectError: () => builder,
    onDisconnect: (cb: typeof disconnected) => {
      disconnected = cb;
      return builder;
    },
    build: () => {
      builds++;
      queueMicrotask(() => connected(connection));
      return connection;
    },
  };
  const bindings: Bindings = { DbConnection: { builder: () => builder } };
  return {
    bindings,
    rows,
    listeners,
    applied: () => applied(),
    disconnect: () => disconnected(),
    error: () => subscriptionError(),
    builds: () => builds,
    unsubscribes: () => unsubscribes,
    tokens,
  };
}
test("connection stays syncing until subscription applied; row events batch and teardown removes listeners", async () => {
  replaceTables(emptyTables());
  const fake = fakeTransport();
  const stop = startLive(fake.bindings, "ws://localhost:3000", "test");
  try {
    await setImmediate();
    assert.equal(getSnapshot().connection.phase, "syncing");
    fake.applied();
    assert.equal(getSnapshot().connection.phase, "live");
    let updates = 0;
    const off = subscribe(() => {
      updates++;
    });
    fake.rows.agent.push({
      name: "a",
      online: true,
      status: "working",
      intent: "change",
      files: [],
      lastSnapshotAt: 42n,
    });
    fake.listeners.forEach((cb) => {
      cb();
      cb();
      cb();
    });
    await setImmediate();
    off();
    assert.equal(updates, 1);
    assert.equal(getSnapshot().tables.agent[0].lastSnapshotAt, 42);
  } finally {
    stop();
  }
  assert.equal(fake.listeners.size, 0);
  assert.equal(fake.unsubscribes(), 1);
});
test("authenticated reconnect uses the current session and never falls back to anonymous", async () => {
  const fake = fakeTransport();
  let token: string | undefined = "test-session-one";
  const stop = startLive(fake.bindings, "ws://localhost:3000", "test", {
    getToken: () => token,
  });
  try {
    await setImmediate();
    fake.applied();
    token = "test-session-two";
    fake.disconnect();
    await delay(1100);
    assert.deepEqual(fake.tokens, ["test-session-one", "test-session-two"]);
    fake.applied();
    token = undefined;
    fake.disconnect();
    await delay(1100);
    assert.equal(fake.builds(), 2);
    assert.equal(getSnapshot().connection.phase, "error");
    assert.deepEqual(getSnapshot().tables, emptyTables());
    assert.doesNotMatch(JSON.stringify(getSnapshot()), /test-session/);
  } finally {
    stop();
  }
});
test("session retrieval errors do not expose credentials or open an anonymous connection", () => {
  const fake = fakeTransport();
  const stop = startLive(fake.bindings, "ws://localhost:3000", "test", {
    getToken: () => {
      throw new Error("private-session-value");
    },
  });
  try {
    assert.equal(fake.builds(), 0);
    assert.equal(getSnapshot().connection.phase, "error");
    assert.doesNotMatch(JSON.stringify(getSnapshot()), /private-session-value/);
  } finally {
    stop();
  }
});
test("interrupted connection is visibly stale, reconnects, and waits for fresh subscription", async () => {
  const fake = fakeTransport();
  const stop = startLive(fake.bindings, "ws://localhost:3000", "test");
  try {
    await setImmediate();
    fake.applied();
    fake.disconnect();
    assert.equal(getSnapshot().connection.phase, "reconnecting");
    assert.match(getSnapshot().connection.detail, /stale/);
    await delay(1100);
    assert.equal(fake.builds(), 2);
    assert.equal(getSnapshot().connection.phase, "syncing");
    fake.applied();
    assert.equal(getSnapshot().connection.phase, "live");
  } finally {
    stop();
  }
});
test("a session arriving after teardown cannot create a socket or change connection state", async () => {
  const fake = fakeTransport();
  let deliver!: (token: string) => void;
  const pending = new Promise<string>((resolve) => {
    deliver = resolve;
  });
  const stop = startLive(fake.bindings, "ws://localhost:3000", "test", {
    getToken: () => pending,
  });
  stop();
  const before = getSnapshot();
  deliver("late-session");
  await setImmediate();
  assert.equal(fake.builds(), 0);
  assert.equal(getSnapshot(), before);
});
test("invalid SDK rows and subscription errors never report live", async () => {
  const fake = fakeTransport();
  const stop = startLive(fake.bindings, "ws://localhost:3000", "test");
  try {
    await setImmediate();
    fake.rows.agent.push({ name: "invalid" });
    fake.applied();
    assert.equal(getSnapshot().connection.phase, "reconnecting");
    assert.match(getSnapshot().connection.detail, /Invalid agent/);
  } finally {
    stop();
  }
  const second = fakeTransport();
  const stopSecond = startLive(second.bindings, "ws://localhost:3000", "test");
  try {
    await setImmediate();
    second.error();
    assert.equal(getSnapshot().connection.phase, "reconnecting");
  } finally {
    stopSecond();
  }
});
