/** WHAT IT'S FOR: run module reducers against SpacetimeDB's real in-memory test datastore. */
import { defineConfig, type Plugin } from 'vitest/config';
import { spacetimedbModuleTestPlugin } from 'spacetimedb/server/test-utils/vitest';

export default defineConfig({
  plugins: [spacetimedbModuleTestPlugin() as unknown as Plugin],
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
