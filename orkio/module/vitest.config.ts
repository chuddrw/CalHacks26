/** WHAT IT'S FOR: run module reducers against SpacetimeDB's real in-memory test datastore. */
import { defineConfig, type Plugin } from 'vitest/config';
import { spacetimedbModuleTestPlugin } from 'spacetimedb/server/test-utils/vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { vitestSourceFiles } from './tests/coverage-scope.mjs';

const require = createRequire(import.meta.url);

export default defineConfig({
  plugins: [spacetimedbModuleTestPlugin() as unknown as Plugin],
  resolve: { alias: [
    { find: /^@factory\/droid-sdk\/node$/, replacement: require.resolve('@factory/droid-sdk/node') },
    { find: /^@anthropic-ai\/sdk\/helpers\/zod$/, replacement: require.resolve('@anthropic-ai/sdk/helpers/zod') },
    { find: /^@anthropic-ai\/sdk$/, replacement: require.resolve('@anthropic-ai/sdk') },
    { find: /^zod\/v4$/, replacement: require.resolve('zod/v4') },
    { find: /^.*shared\/src\/config\.ts$/, replacement: fileURLToPath(new URL('./tests/fixtures/config.mjs', import.meta.url)) },
  ] },
  test: {
    environment: 'node', include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8', allowExternal: true,
      include: vitestSourceFiles.map(file => path.relative(fileURLToPath(new URL('.', import.meta.url)), file)),
      reporter: ['json', 'json-summary'],
    },
  },
});
