shared/module_bindings/README.txt

WHAT THIS IS FOR
  This folder holds the TypeScript client bindings that `spacetime generate` writes from
  module/src/index.ts (spacetime CLI 2.13). The watcher, the MCP server and the UI import them to
  get typed tables and reducers over the WebSocket SDK.

HOW TO FILL IT (C, after every module change)
  npm run module:generate        (run from the repo root)

RULES
  - Don't edit the generated files by hand. Change the module and regenerate.
  - Commit them, so teammates can run the watcher and the UI without installing the spacetime CLI.
  - If the generated types disagree with shared/src/schema.ts, the module is wrong.
  - Generated files may import each other without ".ts" extensions. That's why the watcher, the
    MCP server and the scripts run with tsx, while the hooks (which never import these files)
    run with plain node.
