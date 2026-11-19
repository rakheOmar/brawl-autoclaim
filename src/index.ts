const STORE_URL = "https://store.supercell.com/en/brawlstars";
const CLAIM_URL = "https://store.supercell.com/api/v4/brawlstars/offer/claim";
const FREE_SKU = /com\.supercell\.laser\.scid\.specialoffertier0\.free:chronos:\d+-\d+:\d+/g;
const ACCOUNT_ID = /accountId(?:\\?"|&quot;)?\s*:\s*(?:\\?"|&quot;)[\w-]/;
const REQUEST_TIMEOUT_MS = 20_000;
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_CONFLICT = 409;

type Fetch = typeof fetch;
type Mode = "status" | "claim";
type ClaimResult = "claimed" | "already-claimed" | "rejected" | "unknown";
type Environment = Record<string, string | undefined>;
type LogLevel = "info" | "error";
const EXIT = { success: 0, configuration: 2, store: 3, session: 4, discovery: 5, rejected: 6, uncertain: 7 } as const;

function log(level: LogLevel, message: string): void {
  const entry = `${JSON.stringify({ level, message })}\n`;
  (level === "error" ? process.stderr : process.stdout).write(entry);
}

export function findDailySkus(html: string): string[] {
  return [...new Set(html.match(FREE_SKU) ?? [])];
}

function hasValidQuota(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (!("quotaConsumed" in value) || !("quotaLimit" in value)) return false;
  const { quotaConsumed, quotaLimit } = value;
  return typeof quotaConsumed === "number" && Number.isInteger(quotaConsumed) &&
    typeof quotaLimit === "number" && Number.isInteger(quotaLimit) &&
    quotaConsumed > 0 && quotaLimit >= quotaConsumed;
}

export function classifyClaim(status: number, body: unknown): ClaimResult {
  if (status === HTTP_BAD_REQUEST || status === HTTP_CONFLICT) return "rejected";
  if (status !== HTTP_OK || !Array.isArray(body)) return "unknown";
  if (body.length === 0) return "already-claimed";
  if (body.length !== 1) return "unknown";
  const item: unknown = body[0];
  if (typeof item !== "object" || item === null || !("result" in item)) return "unknown";
  return hasValidQuota(item.result) ? "claimed" : "unknown";
}

function cookieHeader(env: Environment): string {
  const locale = env.NEXT_LOCALE === undefined || env.NEXT_LOCALE === "" ? "en" : env.NEXT_LOCALE;
  const cookies = [
    ["SESSION_COOKIE", env.SESSION_COOKIE],
    ["sc-store-q", env.SC_STORE_Q],
    ["scsso_scid", env.SCSO_SCID],
    ["NEXT_LOCALE", locale],
  ] as const;
  if (cookies.some(([, value]) => value === undefined || value === "" || /[;\r\n]/.test(value))) {
    throw new Error("Missing or invalid session configuration.");
  }
  return cookies.map(([name, value]) => `${name}=${value}`).join("; ");
}

function storeHeaders(env: Environment): Record<string, string> {
  return {
    cookie: cookieHeader(env),
    "accept-language": "en-US,en;q=0.9",
    referer: STORE_URL,
    origin: "https://store.supercell.com",
  };
}

async function fetchOffers(request: Fetch, headers: Record<string, string>): Promise<{ skus: string[] } | { error: number }> {
  const response = await request(STORE_URL, {
    headers, redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.ok === false) {
    log("error", `Store request failed (HTTP ${response.status}).`);
    return { error: EXIT.store };
  }
  const html = await response.text();
  if (ACCOUNT_ID.test(html) === false) {
    log("error", "Could not verify the store session. Cookies may have expired or the page format may have changed.");
    return { error: EXIT.session };
  }
  const skus = findDailySkus(html);
  if (skus.length === 0) {
    log("error", "No recognized daily free offer found; it may be unavailable or the store format may have changed.");
    return { error: EXIT.discovery };
  }
  return { skus };
}

async function readClaimResponse(response: Response): Promise<ClaimResult> {
  try {
    const body: unknown = await response.json();
    return classifyClaim(response.status, body);
  } catch {
    return classifyClaim(response.status, undefined);
  }
}

function reportClaim(result: ClaimResult, status: number): number {
  if (result === "claimed") {
    log("info", "A daily offer was claimed.");
    return EXIT.success;
  }
  if (result === "already-claimed") {
    log("info", "A daily offer appears to have already been claimed (empty response).");
    return EXIT.success;
  }
  const message = result === "rejected"
    ? `A daily offer was rejected (HTTP ${status}); the reason and claim outcome are unconfirmed.`
    : status === 401 || status === 403
      ? `Claim request was denied (HTTP ${status}); check session credentials and store access.`
      : status === 429
        ? "Claim request was rate limited (HTTP 429); the outcome is unconfirmed."
        : status >= 500
          ? `The store returned a server error (HTTP ${status}); the claim outcome is unconfirmed.`
          : `A daily offer returned an unexpected response (HTTP ${status}); the claim outcome is unconfirmed.`;
  log("error", message);
  return result === "rejected" ? EXIT.rejected : EXIT.uncertain;
}

async function claimOffer(sku: string, headers: Record<string, string>, request: Fetch): Promise<number> {
  try {
    const response = await request(CLAIM_URL, {
      method: "POST",
      headers: { ...headers, accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ skus: [sku] }),
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return reportClaim(await readClaimResponse(response), response.status);
  } catch {
    // A timeout can occur after the server processes a claim; never retry blindly.
    log("error", "Claim request failed or timed out; its outcome is unknown.");
    return EXIT.uncertain;
  }
}

async function claimOffers(skus: string[], headers: Record<string, string>, request: Fetch): Promise<number> {
  let exitCode: number = EXIT.success;
  for (const sku of skus) {
    const result = await claimOffer(sku, headers, request);
    if (exitCode === EXIT.success && result !== EXIT.success) exitCode = result;
  }
  return exitCode;
}

export async function run(mode: Mode, env: Environment, request: Fetch = fetch): Promise<number> {
  let headers: Record<string, string>;
  try {
    headers = storeHeaders(env);
  } catch {
    log("error", "Missing or invalid session configuration. Check the required cookie values.");
    return EXIT.configuration;
  }
  try {
    const offers = await fetchOffers(request, headers);
    if ("error" in offers) return offers.error;
    if (mode === "claim") return await claimOffers(offers.skus, headers, request);
    log("info", `Found ${offers.skus.length} matching daily free offer(s). No claims submitted.`);
    return EXIT.success;
  } catch {
    // Exceptions may contain sensitive request details.
    log("error", "Store request failed or timed out. Check network access and store availability.");
    return EXIT.store;
  }
}

if (import.meta.main) {
  const command = process.argv[2];
  if (command !== "claim" && command !== "status") {
    log("error", "Usage: bun src/index.ts <status|claim>");
    process.exitCode = 2;
  } else {
    process.exitCode = await run(command, process.env);
  }
}
