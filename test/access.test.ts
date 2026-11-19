import { env, exports } from "cloudflare:workers";
import { beforeEach, expect, it, vi } from "vitest";
import app from "../src/index";
import { UPLOAD_BUDGET_KEY } from "../src/budget";

const worker = exports.default;
const owner = "test-token";
const headers = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });
const users = (method: string, path = "", token = owner, body?: unknown) => worker.fetch(`https://api.rune.page/users${path}`, {
  method, headers: headers(token), ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});

async function issue(id: string) {
  const result = await users("POST", "", owner, { id });
  expect(result.status).toBe(201);
  return (await result.json<{ token: string }>()).token;
}

async function publish(token: string) {
  const result = await worker.fetch("https://api.rune.page/uploads?filename=notes.txt", {
    method: "POST", headers: headers(token), body: "original",
  });
  expect(result.status).toBe(201);
  return result.json<{ id: string; url: string; etag: string }>();
}

beforeEach(async () => {
  await env.BUCKET.delete(["control/users/alice", "control/users/bob", UPLOAD_BUDGET_KEY]);
});

it("issues named credentials once, stores only hashes, and lists no credentials", async () => {
  const token = await issue("alice");
  expect(token).toMatch(/^rune_alice_[a-f0-9]{64}$/);
  const stored = await (await env.BUCKET.get("control/users/alice"))!.text();
  expect(stored).not.toContain(token);
  expect(JSON.parse(stored).tokenHash).toMatch(/^[a-f0-9]{64}$/);
  const listed = await users("GET");
  expect(listed.headers.get("cache-control")).toBe("no-store");
  expect(await listed.json()).toMatchObject({ users: [{ id: "alice" }] });
  expect(await (await users("GET")).text()).not.toContain("tokenHash");
  expect((await users("POST", "", owner, { id: "alice" })).status).toBe(409);
  await publish(token);
});

it("reserves all credential management for the owner", async () => {
  const alice = await issue("alice");
  for (const token of [alice, "invalid"]) {
    for (const [method, path, body] of [
      ["GET", "", undefined], ["POST", "", { id: "bob" }],
      ["POST", "/alice/token", undefined], ["DELETE", "/alice/token", undefined],
    ] as const) {
      expect((await users(method, path, token, body)).status).toBe(token === alice ? 403 : 401);
    }
  }
  for (const id of ["owner", "../owner", "ALICE", "", "a".repeat(49)]) {
    expect((await users("POST", "", owner, { id })).status).toBe(400);
  }
  expect((await users("POST", "/owner/token")).status).toBe(404);
  expect((await users("POST", "/bob/token")).status).toBe(404);
});

it("enforces ownership on inspection, replacement, and deletion while keeping viewing public", async () => {
  const alice = await issue("alice");
  const bob = await issue("bob");
  const original = await publish(alice);
  const ledger = await (await env.BUCKET.get(UPLOAD_BUDGET_KEY))!.text();
  for (const token of [bob, owner]) {
    for (const method of ["HEAD", "PUT", "DELETE"]) {
      const result = await worker.fetch(`https://api.rune.page/uploads/${original.id}?filename=other.txt`, {
        method, headers: headers(token), ...(method === "PUT" ? { body: "changed" } : {}),
      });
      expect(result.status).toBe(404);
    }
  }
  expect(await (await env.BUCKET.get(UPLOAD_BUDGET_KEY))!.text()).toBe(ledger);
  expect(await (await worker.fetch(original.url)).text()).toBe("original");
  expect((await worker.fetch(`https://api.rune.page/uploads/${original.id}`, { method: "HEAD", headers: headers(alice) })).status).toBe(200);
  const replaced = await worker.fetch(`https://api.rune.page/uploads/${original.id}?filename=updated.txt`, {
    method: "PUT", headers: { ...headers(alice), "if-match": original.etag }, body: "updated",
  });
  expect(replaced.status).toBe(200);
  expect(await replaced.json()).toMatchObject({ url: original.url });
  expect((await env.BUCKET.head(`uploads/${original.id}`))?.customMetadata?.ownerId).toBe("alice");
  expect(await (await worker.fetch(original.url)).text()).toBe("updated");
  expect((await worker.fetch(`https://api.rune.page/uploads/${original.id}`, { method: "DELETE", headers: headers(alice) })).status).toBe(204);
});

it("keeps legacy publications owned by the original owner without rewriting their URLs", async () => {
  const alice = await issue("alice");
  const id = "legacyowner1";
  await env.BUCKET.put(`uploads/${id}`, "legacy", { httpMetadata: { contentType: "text/plain" } });
  for (const method of ["HEAD", "PUT", "DELETE"]) {
    const result = await worker.fetch(`https://api.rune.page/uploads/${id}?filename=legacy.txt`, {
      method, headers: headers(alice), ...(method === "PUT" ? { body: "changed" } : {}),
    });
    expect(result.status).toBe(404);
  }
  const result = await worker.fetch(`https://api.rune.page/uploads/${id}?filename=legacy.txt`, {
    method: "PUT", headers: headers(owner), body: "updated",
  });
  expect(result.status).toBe(200);
  expect((await env.BUCKET.head(`uploads/${id}`))?.customMetadata?.ownerId).toBe("owner");
  expect(await (await worker.fetch(`https://${id}.rune.page/`)).text()).toBe("updated");
  const own = await publish(owner);
  expect((await worker.fetch(`https://api.rune.page/uploads/${own.id}`, { method: "DELETE", headers: headers(alice) })).status).toBe(404);
});

it("rotates and revokes immediately, preserving public links and user ownership", async () => {
  const first = await issue("alice");
  const original = await publish(first);
  const rotated = await users("POST", "/alice/token");
  expect(rotated.status).toBe(200);
  const second = (await rotated.json<{ token: string }>()).token;
  expect(second).not.toBe(first);
  const inspect = (token: string) => worker.fetch(`https://api.rune.page/uploads/${original.id}`, { method: "HEAD", headers: headers(token) });
  expect((await inspect(first)).status).toBe(401);
  expect((await inspect(second)).status).toBe(200);
  expect((await users("DELETE", "/alice/token")).status).toBe(204);
  expect((await inspect(second)).status).toBe(401);
  expect(await (await worker.fetch(original.url)).text()).toBe("original");
  expect(await (await users("GET")).json()).toMatchObject({ users: [{ id: "alice", revokedAt: expect.any(String) }] });
  expect((await users("POST", "", owner, { id: "alice" })).status).toBe(409);
  const reactivated = await users("POST", "/alice/token");
  const third = (await reactivated.json<{ token: string }>()).token;
  expect((await inspect(second)).status).toBe(401);
  expect((await inspect(third)).status).toBe(200);
});

it("does not lose concurrent provisioning, rotation, or revocation updates", async () => {
  const created = await Promise.all([users("POST", "", owner, { id: "alice" }), users("POST", "", owner, { id: "alice" })]);
  expect(created.map(result => result.status).sort()).toEqual([201, 409]);
  const read = env.BUCKET.get.bind(env.BUCKET);
  for (const method of ["POST", "DELETE"]) {
    const get = vi.spyOn(env.BUCKET, "get").mockImplementationOnce(async () => {
      const snapshot = await read("control/users/alice");
      // Commit another administrator's update after this request reads its revision.
      await env.BUCKET.put("control/users/alice", JSON.stringify({
        id: "alice", tokenHash: crypto.randomUUID().replaceAll("-", "").repeat(2),
        createdAt: "2026-10-21T10:00:00.000Z", updatedAt: "2026-10-21T11:00:00.000Z",
      }));
      return snapshot;
    });
    try {
      const result = await app.fetch(new Request("https://api.rune.page/users/alice/token", { method, headers: headers(owner) }), env);
      expect(result.status).toBe(409);
    } finally { get.mockRestore(); }
  }
});

it("fails closed on corrupt or unavailable records and throttles guesses before R2", async () => {
  const token = await issue("alice");
  await env.BUCKET.put("control/users/alice", "{}");
  expect((await users("GET", "", token)).status).toBe(503);
  const get = vi.spyOn(env.BUCKET, "get");
  try {
    const result = await app.fetch(new Request("https://api.rune.page/uploads", { headers: headers(token) }), {
      ...env, READ_LIMITER: { limit: async () => ({ success: false }) },
    });
    expect(result.status).toBe(429);
    expect(get).not.toHaveBeenCalled();
    get.mockRejectedValueOnce(new Error("unavailable"));
    expect((await app.fetch(new Request("https://api.rune.page/uploads", { headers: headers(token) }), env)).status).toBe(503);
  } finally { get.mockRestore(); }
});

it("supports provisioning on the shared local API and site host", async () => {
  const result = await app.fetch(new Request("http://localhost:8787/users", {
    method: "POST", headers: headers(owner), body: JSON.stringify({ id: "alice" }),
  }), { ...env, API_HOST: "localhost", PUBLIC_DOMAIN: "localhost", PUBLIC_ORIGIN: "http://localhost:8787" });
  expect(result.status).toBe(201);
});
