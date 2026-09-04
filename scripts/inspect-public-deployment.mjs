import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PUBLIC_ROUTES = ["/", "/privacy", "/terms", "/data-deletion"];

export async function inspectPublicDeployment(
  { appUrl, workerUrl, expectedWorkerStatus },
  { fetcher = fetch } = {},
) {
  const appOrigin = requireHttpsOrigin("POSTLINE_PUBLIC_APP_URL", appUrl);
  const workerOrigin = requireHttpsOrigin(
    "POSTLINE_PUBLIC_WORKER_URL",
    workerUrl,
  );
  if (
    !Number.isInteger(expectedWorkerStatus) ||
    expectedWorkerStatus < 100 ||
    expectedWorkerStatus > 599
  ) {
    throw new Error(
      "POSTLINE_EXPECTED_WORKER_STATUS must be an HTTP status code",
    );
  }

  const observations = [];
  for (const route of PUBLIC_ROUTES) {
    const url = new URL(route, appOrigin).href;
    const status = await getStatus(fetcher, url);
    observations.push({ surface: route, status });
    if (status !== 200)
      throw new Error(`${route} returned HTTP ${status}; expected 200`);
  }

  const workerStatus = await getStatus(fetcher, `${workerOrigin}/`);
  observations.push({ surface: "worker /", status: workerStatus });
  if (workerStatus !== expectedWorkerStatus) {
    throw new Error(
      `Worker returned HTTP ${workerStatus}; expected ${expectedWorkerStatus}`,
    );
  }
  return observations;
}

async function getStatus(fetcher, url) {
  const response = await fetcher(url, {
    method: "GET",
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  return response.status;
}

function requireHttpsOrigin(name, value) {
  try {
    const url = new URL(typeof value === "string" ? value.trim() : "");
    if (
      url.protocol !== "https:" ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    ) {
      throw new Error("not an HTTPS origin");
    }
    return url.origin;
  } catch {
    throw new Error(`${name} must be a credential-free HTTPS origin`);
  }
}

const directRun =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (directRun) {
  const expectedWorkerStatus = Number(
    process.env.POSTLINE_EXPECTED_WORKER_STATUS,
  );
  const observations = await inspectPublicDeployment({
    appUrl: process.env.POSTLINE_PUBLIC_APP_URL,
    workerUrl: process.env.POSTLINE_PUBLIC_WORKER_URL,
    expectedWorkerStatus,
  });
  for (const observation of observations) {
    console.log(`${observation.surface}: HTTP ${observation.status}`);
  }
  console.log("Read-only public deployment inspection passed.");
}
