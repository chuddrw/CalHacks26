# Orkio workspace

This workspace contains the tool and a separate project that uses it:

- [`orkio/`](orkio/README.md): all of the original CalHacks26 files, including the hooks, MCP server, orchestrator, dashboard, database module, and existing demo.
- [`example-project/`](example-project/README.md): a small Node.js task-list app with a local dependency on Orkio.

The existing Git history stays at this workspace root. Run the tool's existing commands from `orkio/` (for example, `cd orkio && npm run ui`). Existing local environment files and dependencies moved with the tool.

To run the consumer project:

```sh
cd example-project
npm install --offline
npm start
npm run orkio -- --help
```

The dependency is `"orkio": "file:../orkio"`; it uses the local tool without publishing to npm. See the example's README to connect its coding agent to Orkio. Database access still requires a signed-in, approved identity.
