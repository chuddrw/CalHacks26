/** WHAT THIS FILE IS FOR: root-relative config integration tests in copied fixture projects with
 * sanitized child environments; never imports config from this project's real .env or credentials.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { recordCoverageCopy, coverageChildEnvironment } from "../../module/tests/coverage-source.mjs";

function fixture(t: { after(fn: () => void): void }, contents?: string) {
  const root = mkdtempSync(path.join(os.tmpdir(), "cowork-config-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "shared/src"), { recursive: true });
  mkdirSync(path.join(root, "unrelated-cwd"));
  writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  copyFileSync(path.join(import.meta.dirname, "config.ts"), path.join(root, "shared/src/config.ts"));
  recordCoverageCopy(path.join(import.meta.dirname, "config.ts"), path.join(root, "shared/src/config.ts"));
  if (contents !== undefined) writeFileSync(path.join(root, ".env"), contents);
  function read(extra: Record<string, string> = {}) {
    const source = `import { config, configLoadError, missingSettings } from ${JSON.stringify(pathToFileURL(path.join(root, "shared/src/config.ts")).href)}; console.log(JSON.stringify({config, configLoadError, missing:missingSettings(["stdbDb", "stdbToken", "factoryApiKey", "anthropicApiKey"])}));`;
    return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", source], {
      cwd: path.join(root, "unrelated-cwd"), encoding: "utf8", timeout: 10000,
      env: { PATH: process.env.PATH, ...coverageChildEnvironment(), ...extra },
    }));
  }
  return { root, read };
}

test("missing fixture .env does not throw and reports required settings without loading real credentials", t => {
  const f = fixture(t);
  const result = f.read();
  assert.equal(result.config.repoRoot, realpathSync(f.root));
  assert.equal(result.config.gitRemote, "origin");
  assert.equal(result.config.listenerMinutes, 25);
  assert.equal(result.configLoadError, null);
  assert.deepEqual(result.missing, ["stdbDb", "stdbToken", "factoryApiKey", "anthropicApiKey"]);
});

test("an unloadable fixture .env preserves import and process settings with a fixed safe signal", t => {
  const f = fixture(t);
  mkdirSync(path.join(f.root, ".env"));
  const result = f.read({ STDB_DB: "process-setting-survives" });
  assert.equal(result.configLoadError, "env_load_failed");
  assert.equal(result.config.stdbDb, "process-setting-survives");
  assert.deepEqual(result.missing, ["stdbToken", "factoryApiKey", "anthropicApiKey"]);
});

test("loads fixture-root .env independently of cwd and respects existing environment overrides", t => {
  const f = fixture(t, ["STDB_DB=fixture-db", "COWORK_NAME=fixture-agent", "GIT_REMOTE=team", "LISTENER_MINUTES=7", "CHECK_DEBOUNCE_MS=125", "DIAGNOSE_WITH=claude", ""].join("\n"));
  const result = f.read({ STDB_DB: "override-db" });
  assert.equal(result.config.stdbDb, "override-db");
  assert.equal(result.config.agent, "fixture-agent");
  assert.equal(result.config.gitRemote, "team");
  assert.equal(result.config.listenerMinutes, 7);
  assert.equal(result.config.checkDebounceMs, 125);
  assert.equal(result.config.diagnoseWith, "claude");
  assert.deepEqual(result.missing, ["stdbToken", "factoryApiKey", "anthropicApiKey"]);
});
