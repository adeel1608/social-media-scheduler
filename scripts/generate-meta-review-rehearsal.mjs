import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

const repositoryRoot = resolve(".");
const commit = commandOutput("git", ["rev-parse", "HEAD"]);
const shortCommit = commit.slice(0, 12);
const artifactRoot = resolve(repositoryRoot, "artifacts/meta-review-rehearsal");
const artifactDirectory = resolve(artifactRoot, commit);
if (
  dirname(artifactDirectory) !== artifactRoot ||
  !/^[a-f0-9]{40}$/.test(commit)
) {
  throw new Error("Refusing to prepare an unvalidated rehearsal directory");
}
await rm(artifactDirectory, { recursive: true, force: true });
await mkdir(artifactDirectory, { recursive: true });

run(
  process.platform === "win32" ? "cmd.exe" : "corepack",
  process.platform === "win32"
    ? [
        "/d",
        "/s",
        "/c",
        "corepack pnpm exec vitest run apps/worker/test/publisher-state-machine.test.ts packages/platforms/test/adapters.test.ts",
      ]
    : [
        "pnpm",
        "exec",
        "vitest",
        "run",
        "apps/worker/test/publisher-state-machine.test.ts",
        "packages/platforms/test/adapters.test.ts",
      ],
);

run(
  process.platform === "win32" ? "cmd.exe" : "corepack",
  process.platform === "win32"
    ? ["/d", "/s", "/c", "corepack pnpm test:meta-review-simulation"]
    : ["pnpm", "test:meta-review-simulation"],
  { POSTLINE_REHEARSAL_DIR: artifactDirectory },
);

const requiredVideos = [
  "01-reviewer-login-and-connect.webm",
  "02-create-schedule-and-publish.webm",
  "03-view-instagram-insights.webm",
  "04-revocation-and-restrictions.webm",
];
for (const name of requiredVideos) {
  const file = resolve(artifactDirectory, name);
  if ((await stat(file)).size < 10_000)
    throw new Error(`${name} is unexpectedly small`);
}

const convertedVideos = [];
if (commandAvailable("ffmpeg") && commandAvailable("ffprobe")) {
  for (const name of requiredVideos) {
    const target = name.replace(/\.webm$/, ".mp4");
    run("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      resolve(artifactDirectory, name),
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      resolve(artifactDirectory, target),
    ]);
    convertedVideos.push(target);
  }
  const concatFile = resolve(artifactDirectory, "video-concat.txt");
  await writeFile(
    concatFile,
    convertedVideos
      .slice(0, 3)
      .map(
        (name) =>
          `file '${resolve(artifactDirectory, name).replaceAll("\\", "/").replaceAll("'", "'\\''")}'`,
      )
      .join("\n"),
    "utf8",
  );
  run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    concatFile,
    "-c",
    "copy",
    "-movflags",
    "+faststart",
    resolve(artifactDirectory, "00-complete-meta-review-rehearsal.mp4"),
  ]);
  convertedVideos.push("00-complete-meta-review-rehearsal.mp4");
  await rm(concatFile, { force: true });
}

const videos = [];
for (const name of [...requiredVideos, ...convertedVideos]) {
  const file = resolve(artifactDirectory, name);
  const probe = JSON.parse(
    commandOutput("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "stream=codec_name,width,height,duration:format=duration,size",
      "-of",
      "json",
      file,
    ]),
  );
  const stream = probe.streams?.find((item) => item.codec_name);
  const duration = Number(stream?.duration ?? probe.format?.duration ?? 0);
  const size = Number(probe.format?.size ?? (await stat(file)).size);
  if (
    !stream ||
    stream.width !== 1440 ||
    stream.height !== 900 ||
    !Number.isFinite(duration) ||
    duration < 3 ||
    size < 10_000
  ) {
    throw new Error(`${name} failed media validation`);
  }
  const blackDetection = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-i",
      file,
      "-vf",
      `blackdetect=d=${Math.max(2, duration - 0.5).toFixed(2)}:pix_th=0.98`,
      "-an",
      "-f",
      "null",
      process.platform === "win32" ? "NUL" : "/dev/null",
    ],
    { encoding: "utf8" },
  );
  if (
    `${blackDetection.stdout}${blackDetection.stderr}`.includes(
      "black_duration",
    )
  )
    throw new Error(`${name} appears to be an all-black recording`);
  videos.push({
    name,
    codec: stream.codec_name,
    width: stream.width,
    height: stream.height,
    durationSeconds: Number(duration.toFixed(3)),
    sizeBytes: size,
    sha256: await sha256(file),
  });
}

const evidenceFiles = (await readdir(artifactDirectory))
  .filter((name) => name.endsWith("-evidence.json"))
  .sort();
const evidence = await Promise.all(
  evidenceFiles.map(async (name) =>
    JSON.parse(await readFile(resolve(artifactDirectory, name), "utf8")),
  ),
);
if (
  evidence.some(
    (item) =>
      item.providerCallsWereSimulated !== true ||
      item.externalNetworkAttempts.length !== 0,
  )
) {
  throw new Error("Rehearsal network-isolation evidence failed");
}

const screenshotFiles = await listFiles(
  resolve(artifactDirectory, "screenshots"),
);
const screenshots = await Promise.all(
  screenshotFiles.map(async (file) => ({
    name: relative(artifactDirectory, file).replaceAll("\\", "/"),
    sizeBytes: (await stat(file)).size,
    sha256: await sha256(file),
  })),
);
if (screenshots.length < 12)
  throw new Error(
    "The rehearsal did not produce enough representative screenshots",
  );

await rm(resolve(artifactDirectory, "raw-videos"), {
  recursive: true,
  force: true,
});
await rm(resolve(artifactDirectory, "playwright-output"), {
  recursive: true,
  force: true,
});

const reportMarkdown =
  `# Postline Meta Review Rehearsal\n\n` +
  `Tested commit: \`${commit}\`\n\n` +
  `Generated: ${new Date().toISOString()}\n\n` +
  `> SIMULATION — NOT FOR META SUBMISSION\n\n` +
  `All provider behavior was simulated locally. Browser network isolation recorded zero non-localhost requests. No production system, provider API, real account, or real credential was used.\n\n` +
  `The generator also executed the production Worker publication state-machine and Instagram adapter tests with provider stubs before recording the UI.\n\n` +
  `## Recordings\n\n` +
  videos
    .map(
      (video) =>
        `- ${video.name}: ${video.codec}, ${video.width}x${video.height}, ${video.durationSeconds}s, ${video.sizeBytes} bytes, SHA-256 ${video.sha256}`,
    )
    .join("\n") +
  `\n\n## Evidence\n\n` +
  evidence
    .map(
      (item) =>
        `- ${item.flow}: zero external requests; simulated calls ${JSON.stringify(item.providerCalls)}`,
    )
    .join("\n") +
  `\n\n## Limitations\n\nThis rehearsal validates Postline navigation, reviewer restrictions, deterministic browser behavior, OAuth/session choreography, and publication-state presentation. It is not evidence of real Meta OAuth, review approval, account discovery, API publishing, or insights retrieval. Those steps require a separately controlled real-provider recording.\n`;
await writeFile(
  resolve(artifactDirectory, "rehearsal-report.md"),
  reportMarkdown,
  "utf8",
);
await writeFile(
  resolve(artifactDirectory, "rehearsal-report.html"),
  `<!doctype html><html lang="en"><meta charset="utf-8"><title>Postline Meta Review Rehearsal</title><style>body{max-width:960px;margin:40px auto;padding:0 24px;font:16px/1.6 system-ui;color:#172554}pre{white-space:pre-wrap;background:#f8fafc;padding:24px;border-radius:12px}</style><h1>Postline Meta Review Rehearsal</h1><p><strong>SIMULATION — NOT FOR META SUBMISSION</strong></p><pre>${escapeHtml(reportMarkdown)}</pre></html>`,
  "utf8",
);

const reportFiles = await Promise.all(
  ["rehearsal-report.md", "rehearsal-report.html"].map(async (name) => ({
    name,
    sizeBytes: (await stat(resolve(artifactDirectory, name))).size,
    sha256: await sha256(resolve(artifactDirectory, name)),
  })),
);
const manifest = {
  schemaVersion: 1,
  testedCommit: commit,
  shortCommit,
  generatedAt: new Date().toISOString(),
  viewport: { width: 1440, height: 900 },
  providerCallsWereSimulated: true,
  productionSystemsContacted: false,
  externalBrowserNetworkAttempts: 0,
  productionStateMachineTests: {
    verified: true,
    files: [
      "apps/worker/test/publisher-state-machine.test.ts",
      "packages/platforms/test/adapters.test.ts",
    ],
  },
  watermark: "SIMULATION — NOT FOR META SUBMISSION",
  videos,
  screenshots,
  evidence,
  reports: reportFiles,
};
await writeFile(
  resolve(artifactDirectory, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8",
);
console.log(`Validated rehearsal artifacts: ${artifactDirectory}`);
console.log(
  `${videos.length} video files, ${screenshots.length} screenshots, zero external browser requests`,
);

function run(command, arguments_, extraEnvironment = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: repositoryRoot,
    env: { ...process.env, ...extraEnvironment },
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} failed with exit code ${result.status}`);
}

function commandOutput(command, arguments_) {
  const result = spawnSync(command, arguments_, {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} failed with exit code ${result.status}`);
  return result.stdout.trim();
}

function commandAvailable(command) {
  const lookup = spawnSync(
    process.platform === "win32" ? "where.exe" : "which",
    [command],
    { encoding: "utf8" },
  );
  return lookup.status === 0;
}

async function sha256(file) {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(path)));
    else files.push(path);
  }
  return files.sort();
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
