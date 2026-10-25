/**
 * scripts/review.ts
 *
 * WHAT IT'S FOR
 *   A person's answer when a fix changed existing tests (conflict status "needs_human"). The
 *   dashboard has the same two buttons; this is the fallback when the dashboard isn't connected.
 *
 * USAGE (signs in with this laptop's `spacetime login`; needs editor access)
 *   npm run review                                   list conflicts waiting for a person
 *   npm run review -- <id> approve ["comment"]       accept the test change (needs a green check)
 *   npm run review -- <id> reject  ["comment"]       send it back; the fixer is woken to put the tests back
 *
 * OWNER: A. Calls Part C's review_test_change reducer.
 */
import { config, missingSettings } from "../shared/src/config.ts";
import { callReducer, finishProcess, selectRows } from "../shared/src/stdb-http.ts";

async function main(): Promise<number> {
  const missing = missingSettings(["stdbDb"]);
  if (missing.length > 0) {
    console.error(`Fill in ${missing.join(", ")} in .env first (see .env.example).`);
    return 1;
  }

  const [idArg, decision, ...words] = process.argv.slice(2);
  const waiting = await selectRows("conflict", "status = 'needs_human'");

  if (!idArg) {
    if (waiting.length === 0) console.log(`Nothing is waiting for a person in ${config.stdbDb}.`);
    for (const c of waiting) {
      console.log(`#${c.id}  ${c.agentA}${c.agentB ? ` x ${c.agentB}` : ""}  fixer ${c.fixer}`);
      console.log(`     ${c.error.split("\n")[0]}`);
    }
    if (waiting.length > 0) console.log('\nnpm run review -- <id> approve|reject ["comment"]');
    return 0;
  }

  const id = Number(idArg);
  if (!Number.isInteger(id) || (decision !== "approve" && decision !== "reject")) {
    console.error('Usage: npm run review -- <id> approve|reject ["comment"]');
    return 1;
  }
  if (!waiting.some((c) => c.id === id)) {
    console.error(`Conflict #${id} isn't waiting for a person. Run \`npm run review\` to see the ones that are.`);
    return 1;
  }

  try {
    await callReducer("review_test_change", [id, decision === "approve", words.join(" ")]);
  } catch (error) {
    console.error(`The database refused: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const [after] = await selectRows("conflict", `id = ${id}`);
  console.log(
    decision === "approve"
      ? `Approved. Conflict #${id} is ${after?.status ?? "gone"}.`
      : `Sent back. Conflict #${id} is ${after?.status ?? "gone"}; ${after?.fixer ?? "the fixer"} is being woken to put the tests back.`,
  );
  return 0;
}

await finishProcess(
  await main().catch((error: unknown) => {
    console.error(`review failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }),
);
