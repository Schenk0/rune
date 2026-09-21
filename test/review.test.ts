import { env, exports } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import app from "../src/index";
import { renderMarkdown } from "../src/markdown";
import { serveFile } from "../src/serving";
import { uploadId, parseUploadResult } from "../src/protocol";
import { UPLOAD_BUDGET_KEY } from "../src/budget";

const auth = { authorization: "Bearer test-token" };
const worker = exports.default;

async function publish(body: string, type = "text/plain", filename = "test.txt") {
  const response = await worker.fetch(`https://api.rune.page/uploads?filename=${filename}`, {
    method: "POST", headers: { ...auth, "content-type": type }, body,
  });
  expect(response.status).toBe(201);
  return response.json<{ id: string; url: string; etag: string }>();
}

it("allows only one concurrent replacement of the same revision", async () => {
  const original = await publish("same bytes");
  const results = await Promise.all(["a.txt", "b.txt"].map(filename => worker.fetch(`https://api.rune.page/uploads/${original.id}?filename=${filename}`, {
    method: "PUT", headers: { ...auth, "content-type": "text/plain", "if-match": original.etag }, body: "same bytes",
  })));
  expect(results.map(r => r.status).sort()).toEqual([200, 412]);
  const sources = await env.BUCKET.list({ prefix: `sources/uploads/${original.id}/` });
  expect(sources.objects).toHaveLength(1);
});

it("stores a safe GFM preview on publication and retains the source", async () => {
  const source = "# Report\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n- [x] Done\n\n<script>alert(1)</script>";
  const result = await publish(source, "text/markdown", "report.md");
  const metadata = await env.BUCKET.head(`uploads/${result.id}`);
  expect(metadata?.customMetadata?.previewKey).toBeTruthy();
  const response = await worker.fetch(result.url);
  const html = await response.text();
  expect(html).toContain("<table>");
  expect(html).toContain('type="checkbox"');
  expect(html).not.toContain("<script>alert");
  expect(await (await worker.fetch(`${result.url}raw`)).text()).toBe(source);
});

it.each(["a *b*\n\n".repeat(15000), "a *b*\n\n".repeat(2000), "x".repeat(65537)])("falls back before parsing large or construct-dense Markdown", async source => {
  expect(renderMarkdown(source)).toBeUndefined();
  const result = await publish(source, "text/markdown", "dense.md");
  const response = await worker.fetch(result.url);
  expect(response.headers.get("content-type")).toContain("text/plain");
  expect(await response.text()).toBe(source);
});

it("streams legacy Markdown as text without parsing it on public reads", async () => {
  await env.BUCKET.put("uploads/legacymark01", "# Legacy", { httpMetadata: { contentType: "text/markdown" } });
  const response = await serveFile(new Request("https://legacymark01.rune.page/"), env.BUCKET, "uploads/legacymark01");
  expect(response.headers.get("content-type")).toContain("text/plain");
  expect(await response.text()).toBe("# Legacy");
});

it.each([[undefined, 411], ["100000001", 413], ["invalid", 400]] as const)("rejects invalid upload length %s before writing", async (length, status) => {
  const put = vi.spyOn(env.BUCKET, "put");
  try {
    const headers = new Headers({ ...auth, "content-type": "text/plain" });
    if (length !== undefined) headers.set("content-length", length);
    const response = await app.fetch(new Request("https://api.rune.page/uploads?filename=test.txt", { method: "POST", headers, body: "x" }), env);
    expect(response.status).toBe(status);
    expect(put).not.toHaveBeenCalled();
  } finally { put.mockRestore(); }
});

it("throttles public reads before touching R2", async () => {
  const head = vi.spyOn(env.BUCKET, "head");
  try {
    const response = await app.fetch(new Request("https://abcdefghijkl.rune.page/"), { ...env, READ_LIMITER: { limit: async () => ({ success: false }) } });
    expect(response.status).toBe(429);
    expect(head).not.toHaveBeenCalled();
  } finally { head.mockRestore(); }
});

it("throttles authenticated writes before touching R2", async () => {
  const put = vi.spyOn(env.BUCKET, "put");
  try {
    const response = await app.fetch(new Request("https://api.rune.page/uploads?filename=test.txt", { method: "POST", headers: auth, body: "x" }), { ...env, WRITE_LIMITER: { limit: async () => ({ success: false }) } });
    expect(response.status).toBe(429);
    expect(put).not.toHaveBeenCalled();
  } finally { put.mockRestore(); }
});

it.each(["https://abcdefghijkl.rune.page/raw", "https://abcdefghijkl.rune.page/?x=1", "https://abcdefghijkl.rune.page/#x", "http://abcdefghijkl.rune.page/", "https://abcdefghijkl.rune.page.evil.example/", "https://user@abcdefghijkl.rune.page/"])("rejects ambiguous or foreign mutation URL %s", target => {
  expect(() => uploadId(target)).toThrow();
});

it("validates full API response URLs and accepts configured local URLs", () => {
  expect(() => parseUploadResult({ id: "abcdefghijkl", url: "abcdefghijkl", etag: '"revision"' }, "https://rune.page")).toThrow();
  expect(uploadId("http://abcdefghijkl.localhost:8787/", "http://localhost:8787")).toBe("abcdefghijkl");
});

it("caches bodies without hiding replacement or deletion", async () => {
  const original = await publish("before");
  const key = `uploads/${original.id}`;
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } };
  const read = () => serveFile(new Request(original.url), env.BUCKET, key, ctx);
  expect(await (await read()).text()).toBe("before");
  await Promise.all(pending);
  const get = vi.spyOn(env.BUCKET, "get");
  try {
    const cached = await read();
    expect(await cached.text()).toBe("before");
    expect(cached.headers.get("cache-control")).toContain("must-revalidate");
    expect(get).not.toHaveBeenCalled();
  } finally { get.mockRestore(); }
  const replacement = await worker.fetch(`https://api.rune.page/uploads/${original.id}?filename=changed.txt`, {
    method: "PUT", headers: { ...auth, "content-type": "text/plain", "if-match": original.etag }, body: "after",
  });
  expect(replacement.status).toBe(200);
  expect(await (await read()).text()).toBe("after");
  await Promise.all(pending);
  await worker.fetch(`https://api.rune.page/uploads/${original.id}`, { method: "DELETE", headers: auth });
  expect((await read()).status).toBe(404);
  await Promise.all(pending);
});

it("briefly caches repeated misses without touching R2 again", async () => {
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } };
  const request = new Request("https://missing00001.rune.page/");
  expect((await serveFile(request, env.BUCKET, "uploads/missing00001", ctx)).status).toBe(404);
  await Promise.all(pending);
  const head = vi.spyOn(env.BUCKET, "head");
  try {
    expect((await serveFile(request, env.BUCKET, "uploads/missing00001", ctx)).status).toBe(404);
    expect(head).not.toHaveBeenCalled();
  } finally { head.mockRestore(); }
});

it.each(["1", "10"])("rejects a body whose length differs from %s", async length => {
  const before = await env.BUCKET.list();
  const response = await app.fetch(new Request("https://api.rune.page/uploads?filename=length.txt", {
    method: "POST", headers: { ...auth, "content-type": "text/plain", "content-length": length }, body: "five!",
  }), env);
  expect(response.status).toBe(400);
  const after = await env.BUCKET.list();
  // The failed request keeps its budget reservation, but must leave no publication data.
  expect(after.objects.map(o => o.key).filter(key => key !== UPLOAD_BUDGET_KEY)).toEqual(before.objects.map(o => o.key).filter(key => key !== UPLOAD_BUDGET_KEY));
});

it("invalidates viewers and mutation validators after metadata-only replacement", async () => {
  const created = await worker.fetch("https://api.rune.page/uploads?filename=old.png", {
    method: "POST", headers: { ...auth, "content-type": "image/png" }, body: "identical",
  });
  const original = await created.json<{ id: string; url: string; etag: string }>();
  const first = await worker.fetch(original.url);
  const oldTag = first.headers.get("etag")!;
  await first.text();
  const replacement = await worker.fetch(`https://api.rune.page/uploads/${original.id}?filename=new.mp4`, {
    method: "PUT", headers: { ...auth, "content-type": "video/mp4", "if-match": original.etag }, body: "identical",
  });
  expect(replacement.status).toBe(200);
  const updated = await replacement.json<{ etag: string }>();
  expect(updated.etag).not.toBe(original.etag);
  const view = await worker.fetch(original.url, { headers: { "if-none-match": oldTag } });
  expect(view.status).toBe(200);
  expect(await view.text()).toContain("<video");
  const stale = await worker.fetch(`https://api.rune.page/uploads/${original.id}?filename=stale.png`, {
    method: "PUT", headers: { ...auth, "content-type": "image/png", "if-match": original.etag }, body: "identical",
  });
  expect(stale.status).toBe(412);
});

it("returns a clickable local publication URL", async () => {
  const response = await app.fetch(new Request("http://localhost:8787/uploads?filename=local.txt", {
    method: "POST", headers: { ...auth, "content-type": "text/plain", "content-length": "5" }, body: "local",
  }), { ...env, API_HOST: "localhost", PUBLIC_DOMAIN: "localhost", PUBLIC_ORIGIN: "http://localhost:8787" });
  expect(response.status).toBe(201);
  const result = await response.json<{ url: string }>();
  expect(result.url).toMatch(/^http:\/\/[a-z0-9]{12}\.localhost:8787\/$/);
});
