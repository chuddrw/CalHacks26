/** WHAT IT'S FOR: explicit C production-source denominator shared by both coverage collectors. */
import path from 'node:path';
import {fileURLToPath} from 'node:url';
export const root=fileURLToPath(new URL('../..',import.meta.url));
export const relativeSources=[
  'module/src/index.ts','module/access.mjs','module/manage.mjs','module/generate.mjs',
  'orchestrator/src/diagnose/index.ts','orchestrator/src/diagnose/droid.ts','orchestrator/src/diagnose/claude.ts',
  'orchestrator/src/diagnose/permissions.ts','orchestrator/src/diagnose/prompt.ts','orchestrator/src/diagnose/text.ts',
  'shared/src/schema.ts','shared/src/config.ts','scripts/demo-reset.ts',
];
export const sourceFiles=relativeSources.map(file=>path.join(root,file));

// A single authoritative collector per file avoids duplicate counters from different transforms.
export const vitestSourceFiles=['module/src/index.ts','orchestrator/src/diagnose/claude.ts'].map(file=>path.join(root,file));
