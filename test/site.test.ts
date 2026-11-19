import { env, exports } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import app from "../src/index";

const worker = exports.default;

it("serves the selected landing page without credentials or storage access", async () => {
  const head = vi.spyOn(env.BUCKET, "head");
  const get = vi.spyOn(env.BUCKET, "get");
  try {
    const response = await app.fetch(new Request("https://rune.page/"), env);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("Public file links for agents");
    expect(html).toContain('href="/llms.txt"');
    expect(html).toContain("curl --fail-with-body");
    expect(html).toContain('rel="icon"');
    expect(html).not.toContain("<!--logo-->");
    expect(html).not.toContain("<script");
    expect(head).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  } finally { head.mockRestore(); get.mockRestore(); }
});

it("serves complete agent instructions as plain text", async () => {
  const response = await worker.fetch("https://rune.page/llms.txt");
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/plain");
  const text = await response.text();
  for (const required of ["Content-Length", "If-Match", "100,000,000", "1,000,000,000", "not idempotent", "owner-provided bearer token"]) expect(text).toContain(required);
});

it.each(["/", "/llms.txt?source=agent", "/favicon.ico"])("redirects www%s to the canonical host", async path => {
  const response = await worker.fetch(`https://www.rune.page${path}`, { redirect: "manual" });
  expect(response.status).toBe(308);
  expect(response.headers.get("location")).toBe(`https://rune.page${path}`);
});

it.each(["/", "/llms.txt", "/favicon.ico"])("supports HEAD at %s", async path => {
  const response = await worker.fetch(`https://rune.page${path}`, { method: "HEAD" });
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("");
});

it("does not expose uploads through the landing host or documentation through publication hosts", async () => {
  expect((await worker.fetch("https://rune.page/uploads", { method: "POST", body: "x" })).status).toBe(405);
  expect((await worker.fetch("https://rune.page/missing")).status).toBe(404);
  expect((await worker.fetch("https://api.rune.page/uploads")).status).toBe(401);
  expect((await worker.fetch("https://abcdefghijkl.rune.page/llms.txt")).status).toBe(404);
});

it("serves the local homepage while preserving local API authentication", async () => {
  const local = { ...env, API_HOST: "localhost", PUBLIC_DOMAIN: "localhost", PUBLIC_ORIGIN: "http://localhost:8787" } as const;
  expect((await app.fetch(new Request("http://localhost:8787/"), local)).status).toBe(200);
  expect((await app.fetch(new Request("http://localhost:8787/uploads"), local)).status).toBe(401);
  const homepage = await (await app.fetch(new Request("http://localhost:8787/"), local)).text();
  expect(homepage).toContain('href="http://localhost:8787/"');
  expect(homepage).toContain("http://localhost:8787/uploads");
  const instructions = await (await app.fetch(new Request("http://localhost:8787/llms.txt"), local)).text();
  expect(instructions).toContain("http://localhost:8787/uploads");
  expect(instructions).toContain("http://<id>.localhost:8787/");
  expect(instructions).not.toContain("rune.page");
});
