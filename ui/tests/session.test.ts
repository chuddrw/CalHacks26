/** WHAT IT'S FOR: verify the local credential bridge rejects remote/cross-origin requests and never caches tokens. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { permitsSessionRequest, sessionHandler } from "../session-server.ts";

test("only loopback, exact-origin POST requests with the custom header can read a session", () => {
  const request = {
    method: "POST",
    socket: { remoteAddress: "127.0.0.1" },
    headers: {
      host: "127.0.0.1:5173",
      origin: "http://127.0.0.1:5173",
      "x-cowork-session": "1",
      "sec-fetch-site": "same-origin",
    },
  } as unknown as IncomingMessage;
  assert.equal(permitsSessionRequest(request, 5173), true);
  for (const change of [
    { method: "GET" },
    { socket: { remoteAddress: "192.168.1.10" } },
    ...[
      { origin: "https://evil.example" },
      { host: "evil.example:5173" },
      { origin: undefined },
      { "x-cowork-session": undefined },
      { "sec-fetch-site": "cross-site" },
      { host: "127.0.0.1:9999" },
    ].map((headers) => ({ headers: { ...request.headers, ...headers } })),
  ])
    assert.equal(
      permitsSessionRequest({ ...request, ...change } as IncomingMessage, 5173),
      false,
    );
});

test("session endpoint refreshes credentials, rejects cross-origin reads, and hides lookup errors", async () => {
  let calls = 0;
  let port = 0;
  const handler = sessionHandler(
    () => port,
    async () => {
      calls++;
      if (calls === 3) throw new Error("credential-do-not-leak");
      return `test-session-${calls}`;
    },
  );
  const server = createServer((req, res) => {
    void handler(req, res, () => {
      res.statusCode = 404;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  port = address.port;
  const origin = `http://127.0.0.1:${port}`;
  const request = (source = origin) =>
    fetch(`${origin}/__cowork/session`, {
      method: "POST",
      headers: { Origin: source, "X-Cowork-Session": "1" },
    });
  try {
    assert.equal((await request("https://evil.example")).status, 403);
    assert.equal(calls, 0);
    const first = await request();
    assert.equal(first.headers.get("cache-control"), "no-store");
    assert.equal(first.headers.get("access-control-allow-origin"), null);
    assert.deepEqual(await first.json(), { token: "test-session-1" });
    assert.deepEqual(await (await request()).json(), {
      token: "test-session-2",
    });
    const failed = await request();
    assert.equal(failed.status, 401);
    assert.doesNotMatch(await failed.text(), /credential-do-not-leak/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
