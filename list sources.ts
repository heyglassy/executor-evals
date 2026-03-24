import { allEvalCases } from "./evals/cases/index.js";
import { runSuite } from "./evals/shared/harness.js";

const args = process.argv.slice(2);
const shouldList = args.includes("--list");
const selectedIDs = args.filter((argument) => !argument.startsWith("--"));

if (shouldList) {
  for (const evalCase of allEvalCases) {
    console.log(`${evalCase.id}\t${evalCase.title}`);
  }
  process.exit(0);
}

const selectedCases =
  selectedIDs.length > 0
    ? allEvalCases.filter((evalCase) => selectedIDs.includes(evalCase.id))
    : allEvalCases;

const unknownIDs = selectedIDs.filter(
  (selectedID) => !allEvalCases.some((evalCase) => evalCase.id === selectedID),
);

if (unknownIDs.length > 0) {
  console.error(`Unknown eval case IDs: ${unknownIDs.join(", ")}`);
  process.exit(1);
}

if (selectedCases.length === 0) {
  console.error("No eval cases selected.");
  process.exit(1);
}

const summary = await runSuite(selectedCases);

console.log(
  JSON.stringify(
    {
      ok: summary.ok,
      artifactRoot: summary.artifactRoot,
      passed: summary.passed,
      failed: summary.failed,
      caseCount: summary.results.length,
      results: summary.results.map((result) => ({
        id: result.id,
        ok: result.ok,
        reason: result.reason,
        artifactDir: result.artifactDir,
      })),
    },
    null,
    2,
  ),
);

if (!summary.ok) {
  process.exitCode = 1;
}
