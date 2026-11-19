import { describe, expect, mock, test } from "bun:test";
import { classifyClaim, findDailySkus, run } from "../src/index";

const sku = "com.supercell.laser.scid.specialoffertier0.free:chronos:123-0:0";
const secondSku = "com.supercell.laser.scid.specialoffertier0.free:chronos:124-0:0";
const env = { SESSION_COOKIE: "secret-one", SC_STORE_Q: "secret-two", SCSO_SCID: "secret-three" };
const page = (offers: string) => new Response(`{"profile":{"accountId":"43-test"},"offers":"${offers}"}`);
const success = () => Response.json([{ result: { quotaConsumed: 1, quotaLimit: 1 } }]);

describe("daily offer discovery", () => {
  test("finds all unique daily SKUs and ignores unrelated offers", () => {
    expect(findDailySkus(`${sku} ${secondSku} ${sku} com.supercell.other.free:chronos:3-0:0`))
      .toEqual([sku, secondSku]);
  });
  test("handles escaped account data separately from offer matching", () => {
    expect(findDailySkus(`\\"sku\\":\\"${sku}\\"`)).toEqual([sku]);
  });
  test("does not accept incomplete or malformed SKUs", () => {
    expect(findDailySkus("com.supercell.laser.scid.specialoffertier0.free:chronos:x-0:0")).toEqual([]);
  });
});

describe("claim responses", () => {
  test("requires valid quota values", () => {
    expect(classifyClaim(200, [{ result: { quotaConsumed: 1, quotaLimit: 1 } }])).toBe("claimed");
    expect(classifyClaim(200, [{ result: {} }])).toBe("unknown");
    expect(classifyClaim(200, [{ result: { quotaConsumed: 0, quotaLimit: 1 } }])).toBe("unknown");
    expect(classifyClaim(200, [{ result: { quotaConsumed: 2, quotaLimit: 1 } }])).toBe("unknown");
  });
  test("does not equate ambiguous rejection with success", () => {
    expect(classifyClaim(400, {})).toBe("rejected");
    expect(classifyClaim(409, {})).toBe("rejected");
    expect(classifyClaim(200, [])).toBe("already-claimed");
    expect(classifyClaim(403, {})).toBe("unknown");
  });
});

describe("CLI flow", () => {
  test("status fetches but does not claim", async () => {
    const request = mock(async (url: string | URL | Request, options?: RequestInit) => {
      expect(url).toBe("https://store.supercell.com/en/brawlstars");
      expect(options?.headers).toMatchObject({
        "accept-language": "en-US,en;q=0.9",
        cookie: expect.stringContaining("NEXT_LOCALE=en"),
      });
      return page(sku);
    }) as unknown as typeof fetch;
    expect(await run("status", env, request)).toBe(0);
    expect(request).toHaveBeenCalledTimes(1);
  });
  test("claims each unique offer exactly once", async () => {
    let calls = 0;
    const request = mock(async (_url: string | URL | Request, options?: RequestInit) => {
      calls++;
      if (calls === 1) return page(`${sku} ${secondSku} ${sku}`);
      expect(options?.method).toBe("POST");
      return success();
    }) as unknown as typeof fetch;
    expect(await run("claim", env, request)).toBe(0);
    expect(request).toHaveBeenCalledTimes(3);
  });
  test("fails without a valid session or known offers", async () => {
    expect(await run("claim", {}, fetch)).toBe(2);
    const loggedOut = mock(async () => new Response(sku)) as unknown as typeof fetch;
    expect(await run("claim", env, loggedOut)).toBe(4);
    const noOffer = mock(async () => page("")) as unknown as typeof fetch;
    expect(await run("claim", env, noOffer)).toBe(5);
    expect(noOffer).toHaveBeenCalledTimes(1);
  });
  test("does not retry an uncertain POST", async () => {
    let calls = 0;
    const request = mock(async () => {
      calls++;
      if (calls === 1) return page(sku);
      throw new Error("secret-one");
    }) as unknown as typeof fetch;
    expect(await run("claim", env, request)).toBe(7);
    expect(request).toHaveBeenCalledTimes(2);
  });
  test("reports an empty claim response without failing the run", async () => {
    let calls = 0;
    const request = mock(async () => ++calls === 1 ? page(sku) : Response.json([])) as unknown as typeof fetch;
    expect(await run("claim", env, request)).toBe(0);
    expect(request).toHaveBeenCalledTimes(2);
  });
  test("distinguishes store failure, rejection, and uncertain claim response", async () => {
    const unavailable = mock(async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    expect(await run("status", env, unavailable)).toBe(3);
    for (const [status, code] of [[400, 6], [409, 6], [401, 7], [403, 7], [429, 7], [500, 7], [200, 7]] as const) {
      let calls = 0;
      const request = mock(async () => ++calls === 1
        ? page(sku) : new Response("unexpected", { status })) as unknown as typeof fetch;
      expect(await run("claim", env, request)).toBe(code);
      expect(request).toHaveBeenCalledTimes(2);
    }
  });
  test("continues after an uncertain claim and returns the first failure", async () => {
    let calls = 0;
    const request = mock(async () => {
      calls++;
      if (calls === 1) return page(`${sku} ${secondSku}`);
      return calls === 2 ? new Response("", { status: 409 }) : success();
    }) as unknown as typeof fetch;
    expect(await run("claim", env, request)).toBe(6);
    expect(request).toHaveBeenCalledTimes(3);
  });
});
