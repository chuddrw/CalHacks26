# Example project using Orkio

This is a separate app with its own source and package manifest. Orkio is a development tool dependency (`file:../orkio`): it coordinates the coding agents working on the app through Claude Code hooks and MCP. The app runs independently of the database.

```sh
npm ci
npm start
npm run typecheck
npm test
npm run orkio -- --help
```

Open the URL printed by `npm start`. Add products to the cart and choose Checkout. Payment is explicitly simulated: use card `4242 4242 4242 4242`, CVC `123`, any name, a valid email, and an unexpired date. No money is charged. Successful payment shows the paid amount and empties the cart.

The app's `src/main.ts` mounts the catalog and cart view using one shared cart, then connects `initializeCheckout(cart)` and `openCheckout()`. All totals come from the cart service. `npm test` runs the feature tests and combined DOM integration checks; `npm run build` creates the production app in `dist/`.

The cart and catalog modules were imported unchanged from the team repository, [CalHacks26-Demo](https://github.com/chuddrw/CalHacks26-Demo): cart agent commit `11d4a02` and catalog agent commit `6a1d203`. Checkout and the app entry compose those implementations locally. This import does not update that separate repository.

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
