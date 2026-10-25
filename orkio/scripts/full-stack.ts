/**
 * scripts/full-stack.ts
 *
 * WHAT IT'S FOR
 *   `npm run full-stack -- --demo <your demo clone>`: puts the team's full stack (the orchestrator's
 *   cowork/full-stack branch: main plus everyone's latest work that passes the checks together)
 *   in "<clone>-full-stack", so anyone can run the whole project from a terminal. The same as the
 *   agents' get_full_stack tool (shared/src/full-stack.ts). Your own clone isn't touched.
 *
 * OWNER: A (branch feat/orchestrator).
 */
import { parseArgs } from "node:util";
import { getFullStack } from "../shared/src/full-stack.ts";

const { values } = parseArgs({ options: { demo: { type: "string" } } });
if (!values.demo) {
  console.error("Usage: npm run full-stack -- --demo <your demo clone>");
  process.exitCode = 1;
} else {
  const result = await getFullStack(values.demo);
  console.log(result.text);
  process.exitCode = result.ok ? 0 : 1;
}
