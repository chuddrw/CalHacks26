# Example project using Orkio

This is a separate app with its own source and package manifest. Orkio is a development tool dependency (`file:../orkio`): it coordinates the coding agents working on the app through Claude Code hooks and MCP. The app runs independently of the database.

```sh
npm install --offline
npm start
npm run typecheck
npm test
npm run orkio -- --help
```

The initial app prints a small task list and has no behavior tests yet. Replace it with your own application.

## Connect Orkio

Orkio snapshots and merges a project's Git branches, so live coordination needs this folder to be an independent repository with an initial commit and a shared `origin` remote. The scaffold is initially part of the outer workspace for review. To use it with a team, copy this folder into a separate repository (keep `../orkio` beside it, or update the dependency path). Alternatively, initialize it as a separate nested repository and manage its history independently from the outer workspace.

1. Install the tool's dependencies from `../orkio` if needed (`npm ci`).
2. Configure `../orkio/.env` for your approved SpacetimeDB database and sign in with `spacetime login`. The database owner must grant your identity Editor access.
3. In `cowork.owners.json`, replace `app` with your agent name and add teammates' ownership entries.
4. From this project's independent Git repository, run:

   ```sh
   npm run orkio:connect -- --name app
   npm run orkio:doctor
   ```

The installer writes the Claude Code hooks and cowork MCP connection for this project, and sets the agent name in the tool's `.env`. Open this project in Claude Code to use them. Rerun the installer if you move either folder.

On the orchestrator machine, set `DEMO_REPO_PATH` in the tool's `.env` to a separate clone of **this app**, then run `npm run orchestrator` from `../orkio`. Run `npm run ui` there for the dashboard. Configuration currently belongs to the tool checkout, so use a separate tool checkout for each simultaneously coordinated project.
