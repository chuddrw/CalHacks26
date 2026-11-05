# Laptop B setup (read this if you are the second laptop)

You are agent **b**. Laptop A (Catherine) runs the orchestrator and the dashboard. Together you run the Orkio
evals and benchmarks: two real Claude Code agents, each on its own laptop, editing the same small project.
Everything below is about 15 minutes. Nothing here needs an API key except your own Claude Code login.

## 1. Install (once)

| Tool | Check | Get it |
|---|---|---|
| Node 24 or newer | `node -v` | https://nodejs.org |
| git | `git --version` | https://git-scm.com |
| SpacetimeDB CLI | `spacetime --version` | `curl -sSf https://install.spacetimedb.com -o install.sh`, read it, then `sh install.sh` |
| Claude Code, signed in | `claude --version` | the VS Code extension or the CLI |

## 2. Get the code and your identity

```sh
git clone https://github.com/chuddrw/CalHacks26.git
cd CalHacks26
git checkout catherine-branch-update-after-hackathon
./teammate-setup.sh
```
`teammate-setup.sh` signs you in to SpacetimeDB and prints your **public identity** (a 64-character hex string,
also copied to your clipboard). Send it to Catherine. Never send a token or `spacetime login show --token`.

> **Use a different SpacetimeDB account from Catherine's.** One identity can be only one agent. If you are Catherine
> on a second machine, sign in with a second account on this laptop.

## 3. Wait for approval, then join

Catherine runs one command on her side. When she says "approved":
```sh
./teammate-setup.sh join b
```
That installs packages, clones the project `catou88/OrkioDemo` into `../workspace`, installs the hooks and MCP server,
and runs the doctor. It must end with the doctor saying **ready**. The doctor also tells you if you cannot push:
you need **write access to `catou88/OrkioDemo`** (Catherine adds you under Settings → Collaborators) and a signed-in
git (`git push` must work without a password prompt: use the macOS keychain, `gh auth login`, or a token).

## 4. Smoke test (5 minutes, do this first)

Open `../workspace` in VS Code and start Claude Code there. Leave it idle. Catherine sends agent a a request.
You should see, **without typing anything**: Claude in your window gets woken with a task from the orchestrator.
If nothing wakes it within a minute, tell Catherine. Do not start the benchmark until this works.

## 5. The benchmark trials

For each trial Catherine tells you the **task** and the **condition**. You type exactly one prompt (do not improvise:
the prompt text is part of the experiment). Start when Catherine says "go"; say "done" when you stop.

| Task | Your prompt (agent b) |
|---|---|
| units-change | `You own the sessions module. Add src/sessions/idle.ts exporting idleSeconds(user: User, now: Date): number, the whole seconds since the user's lastLogin, with a vitest test next to it. Keep the change small. Run npm run typecheck and npm test before you finish. Do not touch git; just edit files.` |
| rename-field | `You own the sessions module. Add src/sessions/last-seen.ts exporting lastSeen(user: User): number that returns the user's login time as stored on the User. Add a vitest test next to it. Keep the change small. Run npm run typecheck and npm test before you finish. Do not touch git; just edit files.` |
| independent-feature | `You own the sessions module. Add src/sessions/limits.ts exporting the constant MAX_SESSIONS_PER_USER = 5, with a test. Keep the change small. Run npm run typecheck and npm test before you finish. Do not touch git; just edit files.` |

- **Orkio condition:** use `../workspace` as set up in step 3 (hooks on). If Claude is woken with extra tasks or a conflict
  thread, let it work; each extra thing you have to type counts as a human prompt, so write down how many you typed.
- **Plain-git condition:** Catherine will tell you to use a plain clone with **no hooks**:
  `git clone https://github.com/catou88/OrkioDemo.git ../plain-b`, open that folder, and merge through GitHub afterwards.
- **After every trial:** run `/cost` in Claude Code and send Catherine the **total tokens and dollars**, plus your human-prompt
  count and whether Claude finished or gave up. Between trials: `./run.sh clean --yes`.

## 6. Keep costs down

- Use the same model setting every trial (Catherine will say which). Do not switch models mid-experiment.
- One prompt, no chatting, no side questions: extra turns cost tokens and break the comparison.
- Close other Claude Code windows on the laptop; they can wake or edit the wrong clone.

## 7. When something fails

| You see | Do this |
|---|---|
| `not authorized` / 403 | Catherine has not approved your identity yet, or you are signed in with another account (`spacetime login show`). |
| `You are X, not b` | Your identity is bound to another handle. Catherine rebinds it. |
| `Permission denied` pushing | You are not a collaborator on `catou88/OrkioDemo`. |
| `Permission denied` creating `../workspace` | Dev container: `sudo chown "$USER" /workspaces`. |
| Claude never wakes up | Tell Catherine; she checks the dashboard (http://localhost:5173/ on her laptop). |
