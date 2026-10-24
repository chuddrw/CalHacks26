/** WHAT IT'S FOR: resolve C diagnosis test SDKs from module devDependencies and replace only the
 * real shared settings module with inert fixtures. No B workspace setup or developer .env is used.
 */
import { createRequire, registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
const require = createRequire(new URL('../package.json', import.meta.url));
const configuration = fileURLToPath(new URL('../../shared/src/config.ts', import.meta.url));
const fixture = new URL('./fixtures/config.mjs', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    let candidate;
    if (specifier.startsWith('.') || specifier.startsWith('file:')) {
      try { candidate = fileURLToPath(new URL(specifier, context.parentURL)); } catch { /* Not a local module. */ }
    }
    if (candidate === configuration) return nextResolve(fixture, context);
    if (context.parentURL?.includes('/watcher/src/diagnose/')
      && /^(?:@factory\/droid-sdk|@anthropic-ai\/sdk|zod)(?:\/|$)/.test(specifier)) {
      return nextResolve(require.resolve(specifier), context);
    }
    return nextResolve(specifier, context);
  },
});
