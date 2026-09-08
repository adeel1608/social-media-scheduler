import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  validateDeployConfiguration,
  validateReviewModeMatch,
} from "./deploy-config.mjs";

const result = validateDeployConfiguration(process.env);
if (
  !validateReviewModeMatch(
    process.env,
    readFileSync(resolve("apps/worker/wrangler.toml"), "utf8"),
  )
) {
  result.errors.push(
    "Worker and Pages Meta review mode must match exactly before deployment",
  );
  result.valid = false;
}
if (!result.valid) {
  console.error("Production deployment configuration is invalid:");
  for (const error of result.errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(
  "Production deployment configuration is present, non-placeholder, and structurally valid; values were not printed.",
);
