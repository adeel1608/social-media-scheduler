import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const productionEntrypoint = await readFile(
  resolve("apps/web/src/main.tsx"),
  "utf8",
);
const workerFiles = await listFiles(resolve("apps/worker/src"));
const workerSource = (
  await Promise.all(workerFiles.map((file) => readFile(file, "utf8")))
).join("\n");
const deploymentWorkflow = await readFile(
  resolve(".github/workflows/deploy.yml"),
  "utf8",
);
const rehearsalWorkflow = await readFile(
  resolve(".github/workflows/meta-review-rehearsal.yml"),
  "utf8",
);

if (productionEntrypoint.includes("AuthTestAdapter"))
  throw new Error("The production React entrypoint installs the test adapter");
if (/\/simulation(?:\/|\b)/.test(workerSource))
  throw new Error("A simulation endpoint is present in the production Worker");
if (/META_REVIEW_SIMULATION|SIMULATION_ONLY_/.test(deploymentWorkflow))
  throw new Error(
    "The production deployment workflow references simulation controls",
  );
if (!/^\s{2}workflow_dispatch:\s*$/m.test(rehearsalWorkflow))
  throw new Error("The rehearsal workflow is not manually dispatched");
if (/^\s{2}(push|pull_request|schedule):/m.test(rehearsalWorkflow))
  throw new Error("The rehearsal workflow has an automatic trigger");
if (/\b(?:secrets|environment):/i.test(rehearsalWorkflow))
  throw new Error(
    "The rehearsal workflow references secrets or an environment",
  );
if (
  /wrangler\s+(?:deploy|versions|secret)|pages\s+deploy/i.test(
    rehearsalWorkflow,
  )
)
  throw new Error("The rehearsal workflow contains a deployment command");

console.log(
  "Simulation isolation passed: no Worker endpoint, production activation path, production workflow hook, secret reference, or deployment command.",
);

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(path)));
    else if (/\.[cm]?[jt]sx?$/.test(entry.name)) files.push(path);
  }
  return files;
}
