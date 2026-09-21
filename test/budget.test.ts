import { env, exports } from "cloudflare:workers";
import { beforeEach, expect, it, vi } from "vitest";
import { reserveUpload, UPLOAD_BUDGET_KEY } from "../src/budget";

const auth = { authorization: "Bearer test-token", "content-type": "text/plain" };
const worker = exports.default;
const day = () => new Date().toISOString().slice(0, 10);
const seed = (bytes: number, publications: number, date = day()) => env.BUCKET.put(UPLOAD_BUDGET_KEY, JSON.stringify({ day: date, bytes, publications }));
async function ledger() {
  return (await env.BUCKET.get(UPLOAD_BUDGET_KEY))!.json<{ day: string; bytes: number; publications: number }>();
}
const create = () => worker.fetch("https://api.rune.page/uploads?filename=budget.txt", { method: "POST", headers: auth, body: "test" });

beforeEach(async () => { await env.BUCKET.delete(UPLOAD_BUDGET_KEY); });

it("atomically initializes the budget under concurrent first uploads", async () => {
  const results = await Promise.all(Array.from({ length: 5 }, () => reserveUpload(env.BUCKET, 10, true)));
  expect(results.every(r => r === undefined)).toBe(true);
  expect(await ledger()).toMatchObject({ bytes: 50, publications: 5 });
});

it("allows exactly the final publication slot under concurrent reservations", async () => {
  await seed(0, 99);
  const results = await Promise.all(Array.from({ length: 8 }, () => reserveUpload(env.BUCKET, 1, true)));
  expect(results.filter(r => r === undefined)).toHaveLength(1);
  expect(results.filter(r => r?.status === 429)).toHaveLength(7);
  expect(await ledger()).toMatchObject({ bytes: 1, publications: 100 });
});

it("allows the exact byte limit without a concurrent overshoot", async () => {
  await seed(900_000_000, 0);
  const results = await Promise.all(Array.from({ length: 5 }, () => reserveUpload(env.BUCKET, 100_000_000, false)));
  expect(results.filter(r => r === undefined)).toHaveLength(1);
  expect(results.filter(r => r?.status === 429)).toHaveLength(4);
  expect(await ledger()).toMatchObject({ bytes: 1_000_000_000, publications: 0 });
});

it("rejects excess creates before storing publication data", async () => {
  await seed(0, 100);
  const before = await env.BUCKET.list();
  const response = await create();
  expect(response.status).toBe(429);
  expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
  expect(Number(response.headers.get("retry-after"))).toBeLessThanOrEqual(86400);
  expect((await env.BUCKET.list()).objects.map(o => o.key)).toEqual(before.objects.map(o => o.key));
});

it("charges replacements in full without consuming a new-publication slot", async () => {
  const created = await create();
  const upload = await created.json<{ id: string; url: string; etag: string }>();
  await seed(999_999_996, 100);
  const replace = () => worker.fetch(`https://api.rune.page/uploads/${upload.id}?filename=budget.txt`, { method: "PUT", headers: auth, body: "next" });
  expect((await replace()).status).toBe(200);
  expect(await ledger()).toMatchObject({ bytes: 1_000_000_000, publications: 100 });
  expect((await replace()).status).toBe(429);
  expect(await (await worker.fetch(upload.url)).text()).toBe("next");
  expect((await worker.fetch(`https://api.rune.page/uploads/${upload.id}`, { method: "DELETE", headers: auth })).status).toBe(204);
  expect(await ledger()).toMatchObject({ bytes: 1_000_000_000, publications: 100 });
});

it("resets yesterday's counters on the first UTC-day reservation", async () => {
  await seed(1_000_000_000, 100, new Date(Date.now() - 86400000).toISOString().slice(0, 10));
  expect(await reserveUpload(env.BUCKET, 5, true)).toBeUndefined();
  expect(await ledger()).toMatchObject({ day: day(), bytes: 5, publications: 1 });
});

it("keeps reservations after the publication write fails", async () => {
  // A request stream length mismatch fails after reservation, without large test bodies.
  const { default: app } = await import("../src/index");
  const response = await app.fetch(new Request("https://api.rune.page/uploads?filename=failed.txt", {
    method: "POST", headers: { ...auth, "content-length": "2" }, body: "longer",
  }), env);
  expect(response.status).toBe(400);
  expect(await ledger()).toMatchObject({ bytes: 2, publications: 1 });
});

it("does not charge unauthenticated or invalid requests", async () => {
  expect((await worker.fetch("https://api.rune.page/uploads?filename=a.txt", { method: "POST", body: "x" })).status).toBe(401);
  expect((await worker.fetch("https://api.rune.page/uploads", { method: "POST", headers: auth, body: "x" })).status).toBe(400);
  expect(await env.BUCKET.head(UPLOAD_BUDGET_KEY)).toBeNull();
});

it("fails closed on corrupt or unavailable accounting", async () => {
  await env.BUCKET.put(UPLOAD_BUDGET_KEY, "{}");
  expect((await create()).status).toBe(503);
  const get = vi.spyOn(env.BUCKET, "get").mockRejectedValueOnce(new Error("unavailable"));
  try { expect((await reserveUpload(env.BUCKET, 1, true))?.status).toBe(503); }
  finally { get.mockRestore(); }
});

it("bounds contention retries and fails closed", async () => {
  const put = vi.fn(async () => null);
  const bucket = { get: env.BUCKET.get.bind(env.BUCKET), put };
  expect((await reserveUpload(bucket, 1, true))?.status).toBe(503);
  expect(put).toHaveBeenCalledTimes(8);
});
