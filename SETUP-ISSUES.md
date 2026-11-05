# Setup issues found on 2026-11-05

> **To whoever picks this up:** fix each issue below, check it off, and once every box is checked
> **delete this file** (`git rm SETUP-ISSUES.md`) in the same commit as the last fix. It is a to-do
> list, not documentation; nothing should link to it.

These came up while putting a new laptop (VS Code dev container, user `node`) on the team with
`./run.sh` for a two-laptop eval run on branch `orkio-catherine`.

## Code bugs

- [ ] **The approval line `run.sh` prints names the wrong database on first run.**
  `grantCommand()` in `shared/src/members.ts:86` uses `config.stdbDb || "agent-cowork-orch"`.
  `config` is read when the module is imported, before `fillEnv()` in `scripts/join.ts` writes
  `STDB_DB=orkio-catherine` to `.env`. On a fresh laptop the printed line therefore says
  `grant agent-cowork-orch ...`, and the owner would approve the person on a database the team no longer
  uses. A second `./run.sh` prints the correct `orkio-catherine`.
  Fix: pass the database into `grantCommand()` (join.ts has `TEAM_DB`), or make the fallback
  `orkio-catherine`.

- [ ] **The old database name is still everywhere else.** `scripts/join.ts:40` makes `orkio-catherine`
  the team database, but these still say `agent-cowork-orch`: `.env.example`, `README.md`,
  `module/ACCESS.md`, `module/README.md`, `ui/README.md`, `external/spacetimedb-maincloud.txt`,
  `scripts/doctor.ts`, `shared/src/members.ts`, `module/tests/admin-cli.unit.test.mjs`.
  Pick one name and use it everywhere (or read it from one constant).

- [ ] **`run.sh` can't create the workspace in a dev container.** It clones into `../workspace`, which
  here is `/workspaces/workspace`. `/workspaces` is owned by root, so the clone fails with
  `Permission denied`. Making the folder by hand doesn't help either: `prepareWorkspace()`
  (`scripts/join.ts:115`) refuses any folder it didn't create. Workaround used:
  `sudo chown node:node /workspaces`. Fix: say this in the error message, or accept an empty folder,
  or add a `postCreateCommand` to the dev container that gives `/workspaces` to `node`.

- [ ] **`package-lock.json` has a stray `pip` dependency.** The committed lockfile lists `"pip": "^0.0.1"`
  (plus `freckle` and `minimist@0.0.10` it pulls in), but `package.json` doesn't. Every `npm install`
  deletes those 51 lines, so everyone gets a dirty lockfile. Probably someone ran `npm install pip`
  by mistake. Fix: run `npm install` and commit the cleaned lockfile.

## Access (the owner, `chuddrw`, has to do these)

- [ ] **GitHub:** give `catou88` write access to `chuddrw/CalHacks26-Demo`. Doctor fails with
  `Permission to chuddrw/CalHacks26-Demo.git denied to catou88`, so the agent can't push `wip/maria`.
- [ ] **SpacetimeDB:** approve the new laptop on `orkio-catherine` (doctor gets a 403 until then):
  ```sh
  npm run access --prefix module -- grant orkio-catherine c20013240af397a830f797d31d20af5598f37109d363cea6084ce1a80fd9bbfe editor --name maria --display "Maria"
  ```
- [ ] Approve the second laptop the same way, using the line its own `./run.sh` prints.

## Worth knowing (decide whether to fix)

- [ ] **The CLI installer gets a newer `spacetime` than the module uses.** The install line in
  `run.sh`'s error message installs the latest CLI (2.14.1 today); the module and bindings use 2.13.0,
  and doctor warns about it. Either pin the version in the install instructions or confirm 2.14 is fine
  and drop the warning.
- [ ] **One laptop needs Droid for the orchestrator.** Install the `droid` CLI and put
  `FACTORY_API_KEY` in `.env` on the laptop that runs `./run.sh --orchestrator`. Neither is set up yet.
- [ ] **A stale `.git/index.lock` was in the dev container image.** It was dated Oct 31, was empty, and
  no git process was running, but it blocked `git stash` until deleted. If the container is built from a
  snapshot, make sure the lock isn't baked in.
