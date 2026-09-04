import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

import { containsPotentialSecret } from "./secret-patterns.mjs";

const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard"],
  { encoding: "utf8" },
)
  .split(/\r?\n/)
  .filter(Boolean)
  .filter(
    (file) =>
      !file.endsWith("pnpm-lock.yaml") && !file.includes("secret-scan.mjs"),
  );
const findings = [];
for (const file of files) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch {
    continue;
  }
  if (containsPotentialSecret(text)) findings.push(file);
}
if (findings.length) {
  console.error(`Potential secrets found in: ${findings.join(", ")}`);
  process.exit(1);
}
console.log(`Secret scan passed for ${files.length} source files.`);
