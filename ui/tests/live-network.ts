/** WHAT IT'S FOR: exercise D's actual adapter and generated bindings against an isolated real database.
 * No user login, team database, model calls or agent edits. Requires official 2.13 CLI/server paths.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { DbConnection } from "../../shared/module_bindings/index.ts";
import { startLive, type Bindings } from "../src/live.ts";
import { getSnapshot } from "../src/store.ts";
import { teamHealth } from "../src/dashboard.ts";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import { sessionHandler } from "../session-server.ts";

const root = path.resolve(import.meta.dirname, "../..");
assert.ok(
  !process.argv.includes("--browser") || process.stdin.isTTY,
  "Browser verification requires an interactive terminal so Enter can advance and clean up.",
);
const temporary = mkdtempSync(path.join(os.tmpdir(), "cowork-dashboard-"));
const database = `cowork-dashboard-${process.pid}`;
const env = { ...process.env };
for (const key of Object.keys(env))
  if (/TOKEN|SECRET|PASSWORD|API_KEY/.test(key)) delete env[key];
const cli = process.env.SPACETIME_CLI;
const standalone = process.env.SPACETIMEDB_STANDALONE;
assert.ok(
  cli && standalone,
  "Set SPACETIME_CLI and SPACETIMEDB_STANDALONE to official 2.13 binaries",
);
let server: ReturnType<typeof spawn> | undefined;
let stop: (() => void) | undefined;
let web: ViteDevServer | undefined;
const peers: DbConnection[] = [];
const agents: DbConnection[] = [];
let checks = 0;
function pass(label: string) {
  checks++;
  console.log(`PASS ${label}`);
}
async function until(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 15_000;
  while (!(await check())) {
    assert.ok(
      Date.now() < deadline,
      `${label}; phase=${getSnapshot().connection.phase}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
try {
  const reserve = createServer();
  await new Promise<void>((resolve) => reserve.listen(0, "127.0.0.1", resolve));
  const address = reserve.address();
  assert.ok(address && typeof address !== "string");
  const host = `http://127.0.0.1:${address.port}`;
  await new Promise<void>((resolve) => reserve.close(() => resolve()));
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const privateFile = path.join(temporary, "private.pem"),
    publicFile = path.join(temporary, "public.pem");
  writeFileSync(
    privateFile,
    keys.privateKey.export({ type: "pkcs8", format: "pem" }),
  );
  writeFileSync(
    publicFile,
    keys.publicKey.export({ type: "spki", format: "pem" }),
  );
  server = spawn(
    standalone,
    [
      "start",
      "--listen-addr",
      `127.0.0.1:${address.port}`,
      "--data-dir",
      path.join(temporary, "data"),
      "--in-memory",
      "--non-interactive",
      "--jwt-priv-key-path",
      privateFile,
      "--jwt-pub-key-path",
      publicFile,
    ],
    { env, stdio: "ignore", windowsHide: true },
  );
  server.on("error", () => {});
  await until(async () => {
    try {
      return (await fetch(`${host}/v1/ping`)).ok;
    } catch {
      return false;
    }
  }, "server readiness");
  type User = { identity: string; token: string };
  const identity = async (): Promise<User> =>
    (await fetch(`${host}/v1/identity`, { method: "POST" })).json();
  const [owner, reader, editor, outsider] = await Promise.all([
    identity(),
    identity(),
    identity(),
    identity(),
  ]);
  const published = spawnSync(
    cli,
    [
      "--config-path",
      path.join(temporary, "cli.toml"),
      "publish",
      database,
      "--module-path",
      path.join(root, "module"),
      "--server",
      host,
      "--anonymous",
      "--yes=remote,skip-login,break-clients",
    ],
    {
      env: { ...env, ACCESS_OWNER_IDENTITY: owner.identity },
      encoding: "utf8",
      timeout: 90_000,
      windowsHide: true,
    },
  );
  assert.equal(
    published.status,
    0,
    `Publish isolated module failed: ${published.stderr.slice(-1000)}`,
  );
  const call = async (user: User, reducer: string, args: unknown[]) => {
    const result = await fetch(
      `${host}/v1/database/${database}/call/${reducer}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${user.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(args),
      },
    );
    assert.ok(result.ok, `${reducer} HTTP ${result.status}`);
  };
  await call(owner, "grant_access", [reader.identity, "reader"]);
  await call(owner, "grant_access", [editor.identity, "editor"]);
  stop = startLive({ DbConnection } as unknown as Bindings, host, database, {
    getToken: async () => reader.token,
  });
  await until(
    () => getSnapshot().connection.phase === "live",
    "reader subscription applied",
  );
  pass("real generated bindings synchronize all seven authenticated views");
  const peer = async () =>
    new Promise<DbConnection>((resolve, reject) => {
      const connection = DbConnection.builder()
        .withUri(host)
        .withDatabaseName(database)
        .withToken(reader.token)
        .onConnect((conn) => {
          conn
            .subscriptionBuilder()
            .onApplied(() => resolve(conn))
            .onError(() => reject(new Error("peer subscription")))
            .subscribe([
              "SELECT * FROM agent",
              "SELECT * FROM conflict",
              "SELECT * FROM intent",
            ]);
        })
        .onConnectError(() => reject(new Error("peer authentication")))
        .build();
      peers.push(connection);
    });
  await Promise.all([peer(), peer()]);
  const seed = (scene: string) => {
    const result = spawnSync(
      process.execPath,
      [
        path.join(root, "node_modules/tsx/dist/cli.mjs"),
        path.join(root, "scripts/seed-fake.ts"),
        "--scene",
        scene,
      ],
      {
        env: {
          ...env,
          STDB_HOST: host,
          STDB_DB: database,
          STDB_TOKEN: editor.token,
        },
        encoding: "utf8",
        timeout: 30_000,
        windowsHide: true,
      },
    );
    assert.equal(
      result.status,
      0,
      `Seed ${scene}: ${result.stderr.slice(-1000)}`,
    );
  };
  seed("conflict");
  await until(
    () =>
      getSnapshot().tables.conflict.some((c) => c.status === "open") &&
      getSnapshot().tables.diagnosis_step.length > 0,
    "conflict and diagnosis updates",
  );
  assert.equal(getSnapshot().tables.agent.length, 4);
  assert.notEqual(
    teamHealth(getSnapshot().tables, getSnapshot().connection).tone,
    "green",
  );
  await until(
    () =>
      peers.every(
        (p) =>
          [...p.db.agent.iter()].length === 4 &&
          [...p.db.conflict.iter()].length === 1,
      ),
    "three subscriber consistency",
  );
  pass(
    "conflict seed, four agents, streamed diagnosis and three synchronized SDK clients",
  );
  for (const name of ["a", "b", "c", "d"]) {
    const user = await identity();
    await call(owner, "grant_access", [user.identity, "editor"]);
    await new Promise<void>((resolve, reject) => {
      const connection = DbConnection.builder()
        .withUri(host)
        .withDatabaseName(database)
        .withToken(user.token)
        .onConnect((conn) => {
          void conn.reducers
            .registerAgent({ agent: name })
            .then(() => resolve(), reject);
        })
        .onConnectError(() => reject(new Error("agent presence connection")))
        .build();
      agents.push(connection);
    });
  }
  await until(
    () => getSnapshot().tables.agent.filter((a) => a.online).length === 4,
    "four agents online",
  );
  pass(
    "four independent editor identities appear online through real lifecycle reducers",
  );
  if (process.argv.includes("--browser")) {
    // Dedicated browser-verification server: ephemeral Reader only, no real CLI or account.
    web = await createViteServer({
      root: path.join(root, "ui"),
      configFile: false,
      envDir: false,
      plugins: [
        react(),
        {
          name: "isolated-dashboard-reader",
          configureServer(server) {
            server.middlewares.use(
              sessionHandler(
                () => 5174,
                async () => reader.token,
              ),
            );
          },
        },
      ],
      define: {
        "import.meta.env.VITE_STDB_HOST": JSON.stringify(host),
        "import.meta.env.VITE_STDB_DB": JSON.stringify(database),
        "import.meta.env.VITE_PROJECT_LABEL": JSON.stringify(
          "Isolated DB · seeded verification",
        ),
      },
      server: {
        host: "127.0.0.1",
        port: 5174,
        strictPort: true,
        fs: { allow: [root] },
      },
    });
    await web.listen();
    console.log(
      "Browser verification ready: http://127.0.0.1:5174/ (real local database, seeded rows). Send Enter to finish checks and clean up.",
    );
    await new Promise<void>((resolve) =>
      process.stdin.once("data", () => resolve()),
    );
  }
  agents.pop()!.disconnect();
  await until(
    () =>
      getSnapshot().tables.agent.find((a) => a.name === "d")?.online === false,
    "presence disconnect",
  );
  pass(
    "disconnecting agent D updates real presence without affecting the other three",
  );
  await call(editor, "post_intent", [
    "b",
    "live intent update",
    ["src/b.ts"],
    [],
  ]);
  await until(
    () =>
      getSnapshot().tables.intent.some(
        (i) => i.summary === "live intent update",
      ),
    "intent insertion",
  );
  pass("real table inserts update dashboard state");
  stop();
  stop = startLive({ DbConnection } as unknown as Bindings, host, database, {
    getToken: () => reader.token,
  });
  await until(() => getSnapshot().connection.phase === "live", "reconnect");
  assert.equal(getSnapshot().tables.agent.length, 4);
  pass("disconnect/reconnect rehydrates the real table cache");
  await call(owner, "reset_all", []);
  await until(
    () =>
      getSnapshot().tables.agent.length === 0 &&
      getSnapshot().tables.conflict.length === 0,
    "table deletes",
  );
  pass("real deletions clear dashboard rows");
  seed("resolved");
  await until(
    () =>
      getSnapshot().tables.conflict.some((c) => c.status === "resolved") &&
      getSnapshot().tables.intent.some((i) => i.verified),
    "resolution and memory",
  );
  await until(
    () => peers.every((p) => [...p.db.intent.iter()].some((i) => i.verified)),
    "memory on all subscribers",
  );
  assert.equal(
    teamHealth(getSnapshot().tables, getSnapshot().connection).tone,
    "green",
  );
  pass("resolved seed publishes verified memory to all three subscribers");
  if (web) {
    console.log(
      "Browser: resolved scene and verified memory are now live. Send Enter to continue.",
    );
    await new Promise<void>((resolve) =>
      process.stdin.once("data", () => resolve()),
    );
  }
  await call(owner, "reset_all", []);
  seed("needs_human");
  await until(
    () => getSnapshot().tables.conflict.some((c) => c.status === "needs_human"),
    "human review",
  );
  pass("test-edit guard seed surfaces human-review state");
  if (web) {
    console.log(
      "Browser: human-review scene is now live. Send Enter to finish and clean up.",
    );
    await new Promise<void>((resolve) =>
      process.stdin.once("data", () => resolve()),
    );
    await web.close();
    web = undefined;
  }
  await call(owner, "revoke_access", [reader.identity]);
  await until(
    () =>
      getSnapshot().connection.phase !== "live" ||
      getSnapshot().tables.agent.length === 0,
    "revocation",
  );
  assert.notEqual(
    teamHealth(getSnapshot().tables, getSnapshot().connection).tone,
    "green",
  );
  pass("reader revocation cannot leave a healthy live dashboard");
  stop();
  stop = startLive({ DbConnection } as unknown as Bindings, host, database, {
    getToken: () => outsider.token,
  });
  await until(
    () => getSnapshot().connection.phase === "reconnecting",
    "unauthorized account rejection",
  );
  pass("unapproved session cannot synchronize");
  console.log(
    `Dashboard real-server checks: ${checks}/${checks}. Three clients are on one machine; physical presentation screens remain a rehearsal requirement.`,
  );
} finally {
  process.stdin.pause();
  if (process.argv.includes("--browser")) process.stdin.destroy();
  await web?.close();
  stop?.();
  for (const peer of peers) peer.disconnect();
  for (const agent of agents) agent.disconnect();
  if (server && server.exitCode === null) {
    const exit = new Promise((resolve) => server!.once("exit", resolve));
    server.kill();
    await exit;
  }
  const cleanupTarget = path.resolve(temporary);
  assert.equal(path.dirname(cleanupTarget), path.resolve(os.tmpdir()));
  assert.ok(path.basename(cleanupTarget).startsWith("cowork-dashboard-"));
  rmSync(cleanupTarget, { recursive: true, force: true });
}
