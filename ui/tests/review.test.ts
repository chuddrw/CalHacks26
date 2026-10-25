/** WHAT IT'S FOR: the dashboard's sign-in endpoint guard and the review buttons on a live connection. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { allowSessionRequest } from "../dev-session.ts";
import { startLive, tableNames, type Bindings } from "../src/live.ts";
import { reviewTestChange } from "../src/stdb.ts";
import { getSnapshot, setConnection } from "../src/store.ts";

const local = { method: "GET", headers: { host: "localhost:5173", "x-cowork-dashboard": "1" }, socket: { remoteAddress: "127.0.0.1" } };

test("the session token goes only to a page on this laptop", () => {
  assert.equal(allowSessionRequest(local), true);
  assert.equal(allowSessionRequest({ ...local, headers: { ...local.headers, origin: "http://localhost:5173" } }), true);
  assert.equal(allowSessionRequest({ ...local, socket: { remoteAddress: "::1" }, headers: { ...local.headers, host: "[::1]:5173" } }), true);
  assert.equal(allowSessionRequest({ ...local, method: "POST" }), false, "GET only");
  assert.equal(allowSessionRequest({ ...local, socket: { remoteAddress: "192.168.1.20" } }), false, "another machine on the network");
  assert.equal(allowSessionRequest({ ...local, headers: { ...local.headers, host: "evil.example:5173" } }), false, "DNS rebinding");
  assert.equal(allowSessionRequest({ ...local, headers: { host: "localhost:5173" } }), false, "no custom header");
  assert.equal(allowSessionRequest({ ...local, headers: { ...local.headers, origin: "https://evil.example" } }), false, "another site's page");
  assert.equal(allowSessionRequest({ ...local, headers: { ...local.headers, origin: "not a url" } }), false);
});

test("live mode: signs in with the session token and calls review_test_change on the live connection", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const tokens: string[] = [];
  let connected: (c: unknown) => void = () => {};
  let applied: () => void = () => {};
  const table = { iter: () => [], onInsert() {}, onUpdate() {}, onDelete() {}, removeOnInsert() {}, removeOnUpdate() {}, removeOnDelete() {} };
  const connection = {
    db: Object.fromEntries(tableNames.map((t) => [t, table])),
    reducers: {
      reviewTestChange: async (args: Record<string, unknown>) => {
        calls.push(args);
      },
    },
    disconnect() {},
    subscriptionBuilder() {
      const b = {
        onApplied: (cb: () => void) => ((applied = cb), b),
        onError: () => b,
        subscribe: () => ({ unsubscribe() {} }),
      };
      return b;
    },
  };
  const builder = {
    withUri: () => builder,
    withDatabaseName: () => builder,
    withToken: (token: string) => (tokens.push(token), builder),
    onConnect: (cb: (c: unknown) => void) => ((connected = cb), builder),
    onConnectError: () => builder,
    onDisconnect: () => builder,
    build: () => (queueMicrotask(() => connected(connection)), connection),
  };
  setConnection({ phase: "connecting", detail: "" });
  const stop = startLive({ DbConnection: { builder: () => builder } } as unknown as Bindings, "ws://localhost:3000", "test", {
    getToken: () => "session-token",
  });
  try {
    await setImmediate();
    applied();
    assert.equal(getSnapshot().connection.phase, "live");
    assert.deepEqual(tokens, ["session-token"]);
    await reviewTestChange(7, false, "keep the 31-minute test");
    assert.deepEqual(calls, [{ conflictId: 7, approve: false, comment: "keep the 31-minute test" }]);
  } finally {
    stop();
  }
  await assert.rejects(reviewTestChange(7, true, ""), /isn't connected/);
});
