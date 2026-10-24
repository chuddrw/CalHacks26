/** WHAT IT'S FOR: inert Part C test settings; never loads a developer's .env or live credentials. */
import { fileURLToPath } from 'node:url';
export const config = Object.freeze({
  repoRoot: fileURLToPath(new URL('../../../', import.meta.url)),
  agent: '', stdbHost: 'http://127.0.0.1:1', stdbDb: '', stdbToken: '',
  gitRemote: 'origin', mainBranch: 'main', listenerMinutes: 25, demoRepoPath: '',
  checkDebounceMs: 2000, diagnoseWith: 'droid', factoryApiKey: '', droidModelId: '',
  anthropicApiKey: '', claudeModel: 'fixture-model',
});
export function missingSettings(names) { return names.filter(name => config[name] === ''); }
