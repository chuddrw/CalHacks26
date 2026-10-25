shared/module_bindings/README.txt

WHAT THIS IS FOR
  Authenticated-view TypeScript WebSocket bindings generated from Part C's SpacetimeDB 2.13.0 module.
  Public IDs and millisecond timestamps remain JavaScript numbers. Status/kind strings are
  validated by the module; shared/src/schema.ts carries the narrower application unions.

REGENERATE
  npm run module:generate
  Install the official matching CLI. If needed set SPACETIME_CLI to its real binary and
  SPACETIMEDB_SCHEMA_EXTRACTOR to its spacetimedb-standalone sibling.

WHY THE WRAPPER
  2.13.0 extract-schema drops the module's CaseConversionPolicy.None section. The generation
  helper in module/generate.mjs restores only that omitted descriptor setting, then invokes
  official CLI --module-def generation. It verifies every public column's order, original SQL
  name, and numeric type before copying the untouched generated files here. The published
  module preserves camelCase SQL names directly. No hooks, orchestrator or UI adaptations are needed.

RULES
  - Do not edit generated .ts files by hand. Change the module, then regenerate.
  - Commit generated bindings so clients don't need the CLI at runtime.
  - Generated imports omit extensions; WebSocket clients use tsx/bundler resolution.
  - No private backing, membership, connection or schedule table is exposed here.
  - Authenticate with the caller's own signed-in session. Owner grants Reader/Editor membership;
    see module/ACCESS.md. Login alone grants no access. Existing query names and rows are retained.
