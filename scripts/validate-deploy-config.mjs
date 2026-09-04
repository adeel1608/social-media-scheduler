import { validateDeployConfiguration } from "./deploy-config.mjs";

const result = validateDeployConfiguration(process.env);
if (!result.valid) {
  console.error("Production deployment configuration is invalid:");
  for (const error of result.errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(
  "Production deployment configuration is present, non-placeholder, and structurally valid; values were not printed.",
);
