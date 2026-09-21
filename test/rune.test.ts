import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const worker = exports.default;
const auth = { authorization: "Bearer test-token" };

describe("Rune", () => {
  it("uses filenames as viewer tab titles without adding visible labels", async () => {
    for (const type of ["image/png", "audio/wav", "video/mp4", "application/zip"]) {
      const upload = await create("A & B <draft>.png", "contents", type);
      const html = await (await worker.fetch(upload.url)).text();
      expect(html).toContain("<title>A &amp; B &lt;draft&gt;.png</title>");
      expect(html.split("<body>")[1]).not.toContain("draft");
    }
  });

  it("uses the first real Markdown heading with a filename fallback", async () => {
    for (const [source, title] of [
      ["## First *heading* & [link](https://example.com)\n\n# Later", "First heading &amp; link"],
      ["Setext heading\n===\n\nParagraph", "Setext heading"],
      ["~~~\n# Not a heading\n~~~\n\n# Real heading", "Real heading"],
      ["# &lt;/title&gt;&lt;script&gt;bad()&lt;/script&gt;", "&lt;/title&gt;&lt;script&gt;bad()&lt;/script&gt;"],
      ["Just a paragraph", "notes.md"],
    ]) {
      const upload = await create("notes.md", source!, "text/markdown");
      const html = await (await worker.fetch(upload.url)).text();
      expect(html).toContain(`<title>${title}</title>`);
      expect(await (await worker.fetch(new URL("/raw", upload.url))).text()).toBe(source);
    }
  });

  it("preserves HTML titles and supplies missing or empty titles", async () => {
    for (const [source, title] of [
      ["<!doctype html><html><head><title>Original &amp; title</title></head><body>Hello</body></html>", "Original &amp; title"],
      ["<html><head></head><body>Hello</body></html>", "page &amp; notes.html"],
      ["<html><head><title></title></head><body>Hello</body></html>", "page &amp; notes.html"],
      ["<h1>Hello</h1>", "page &amp; notes.html"],
    ]) {
      const upload = await create("page & notes.html", source!, "text/html");
      const response = await worker.fetch(upload.url);
      const html = await response.text();
      expect(html).toContain(`<title>${title}</title>`);
      expect(html.match(/<title>/g)).toHaveLength(1);
      expect(response.headers.get("etag")).toContain("viewer-6");
      expect(await (await worker.fetch(new URL("/raw", upload.url))).text()).toBe(source);
    }
  });

  it("serves the S2 favicon without upload credentials on every Rune host", async () => {
    for (const host of ["api.rune.page", "abcdefghijkl.rune.page"]) {
      const response = await worker.fetch(`https://${host}/favicon.ico`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/x-icon");
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect([...bytes.slice(0, 8)]).toEqual([0, 0, 1, 0, 1, 0, 64, 64]);
      expect([...bytes.slice(22, 26)]).toEqual([137, 80, 78, 71]);
      const head = await worker.fetch(`https://${host}/favicon.ico`, { method: "HEAD" });
      expect(head.headers.get("content-length")).toBe(String(bytes.length));
      expect(await head.text()).toBe("");
    }
    expect((await worker.fetch("https://abcdefghijkl.example.com/favicon.ico")).status).toBe(404);
  });

  it("brands HTML and fragments while retaining raw bytes, sandboxing and representation caching", async () => {
    for (const source of [
      '<!doctype html><html><head><link rel="SHORTCUT ICON" href="old.ico"><title>Original</title></head><body>Hello</body></html>',
      "<body>Hello</body>",
      "<h1>Hello</h1>",
    ]) {
      const upload = await create("page.html", source, "text/html");
      const response = await worker.fetch(upload.url, { headers: { range: "bytes=0-2", "if-none-match": upload.etag } });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-length")).toBeNull();
      expect(response.headers.get("accept-ranges")).toBeNull();
      expect(response.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
      const html = await response.text();
      expect(html.match(/rel="icon"/g)).toHaveLength(1);
      expect(html).toContain("data:image/png;base64,");
      expect(html).not.toContain("old.ico");
      expect(html).toContain("Hello");
      expect(await (await worker.fetch(new URL("/raw", upload.url))).text()).toBe(source);
      const cached = await worker.fetch(upload.url, { headers: { "if-none-match": response.headers.get("etag")! } });
      expect(cached.status).toBe(304);
      const head = await worker.fetch(upload.url, { method: "HEAD" });
      expect(head.headers.get("etag")).toBe(response.headers.get("etag"));
      expect(head.headers.get("content-length")).toBeNull();
    }
  });

  it("includes S2 in every generated viewer", async () => {
    for (const type of ["image/png", "audio/wav", "video/mp4", "text/markdown", "application/zip"]) {
      const upload = await create("file", "contents", type);
      const html = await (await worker.fetch(upload.url)).text();
      expect(html).toContain('rel="icon" type="image/png" href="data:image/png;base64,');
    }
  });

  it("rejects unauthenticated mutations", async () => {
    const response = await worker.fetch("https://api.rune.page/uploads", {
      method: "POST",
      body: "secret",
    });

    expect(response.status).toBe(401);
  });

  it("publishes a file at a public stable URL", async () => {
    const upload = await create("hello.txt", "hello", "text/plain");
    expect(upload.id).toMatch(/^[a-z0-9]{12}$/);
    const response = await worker.fetch(upload.url);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("hello");
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("etag")).toBe(upload.etag);
    expect(response.headers.get("cache-control")).toContain("must-revalidate");
  });

  it("replaces content without changing the public URL", async () => {
    const upload = await create("before.txt", "before", "text/plain");
    const replacement = await worker.fetch(
      `https://api.rune.page/uploads/${upload.id}?filename=after.txt`,
      {
        method: "PUT",
        headers: {
          ...auth,
          "content-type": "text/plain",
          "if-match": upload.etag,
        },
        body: "after",
      },
    );
    const result = await json<UploadResult>(replacement);

    expect(replacement.status).toBe(200);
    expect(result.url).toBe(upload.url);
    expect(await (await worker.fetch(upload.url)).text()).toBe("after");
  });

  it("rejects replacement with a stale ETag", async () => {
    const upload = await create("file.txt", "first", "text/plain");
    const response = await worker.fetch(
      `https://api.rune.page/uploads/${upload.id}?filename=file.txt`,
      {
        method: "PUT",
        headers: { ...auth, "content-type": "text/plain", "if-match": '"stale"' },
        body: "second",
      },
    );

    expect(response.status).toBe(412);
    expect(await (await worker.fetch(upload.url)).text()).toBe("first");
  });

  it("exposes the current ETag only to authenticated clients", async () => {
    const upload = await create("file.txt", "first", "text/plain");
    const denied = await worker.fetch(`https://api.rune.page/uploads/${upload.id}`, {
      method: "HEAD",
    });
    const response = await worker.fetch(`https://api.rune.page/uploads/${upload.id}`, {
      method: "HEAD",
      headers: auth,
    });

    expect(denied.status).toBe(401);
    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe(upload.etag);
  });

  it("sets the isolation policy for interactive HTML", async () => {
    const upload = await create("page.html", "<script>document.body.textContent='ok'</script>", "text/html");
    const response = await worker.fetch(upload.url);
    const policy = response.headers.get("content-security-policy");

    expect(policy).toContain("sandbox allow-scripts");
    expect(policy).toContain("connect-src 'none'");
    expect(policy).not.toContain("allow-same-origin");
  });

  it("renders Markdown without enabling embedded HTML", async () => {
    const upload = await create("notes.md", "# Hello\n\n<script>alert(1)</script>", "text/markdown");
    const response = await worker.fetch(upload.url);
    const html = await response.text();

    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(html).toContain("<h1>Hello</h1>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("supports byte ranges for media", async () => {
    const upload = await create("clip.mp4", "0123456789", "video/mp4");
    const response = await worker.fetch(new URL("/raw", upload.url), {
      headers: { range: "bytes=2-5" },
    });

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe("2345");
  });

  it("shows audio in a viewer that permits its media resource", async () => {
    const upload = await create("tone.wav", "audio", "audio/wav");
    const response = await worker.fetch(upload.url);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("content-security-policy")).toContain("media-src 'self'");
    expect(response.headers.get("content-security-policy")).not.toContain("sandbox");
    expect(await response.text()).toContain('<audio controls');
    const raw = await worker.fetch(new URL("/raw", upload.url));
    expect(raw.headers.get("content-type")).toBe("audio/wav");
    expect(raw.headers.get("content-security-policy")).toContain("media-src 'self'");
  });

  it("displays data files without attachment responses or HTML execution", async () => {
    for (const type of ["application/json", "text/csv", "application/xml"]) {
      const upload = await create("data.txt", "<script>bad()</script>", type);
      const response = await worker.fetch(upload.url);
      expect(response.headers.get("content-disposition")).toMatch(/^inline/);
      expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(await response.text()).toBe("<script>bad()</script>");
    }
  });

  it("centers images without visible filename chrome and keeps SVG assets sandboxed", async () => {
    const source = '<svg xmlns="http://www.w3.org/2000/svg"><script>bad()</script></svg>';
    const upload = await create("picture.svg", source, "image/svg+xml");
    const view = await worker.fetch(upload.url);
    const html = await view.text();
    expect(html).toContain('<img src="/raw?v=');
    expect(html).not.toContain("<header>");
    expect(html).toContain("<title>picture.svg</title>");
    expect(html.split("<body>")[1]).not.toContain("picture.svg");
    const raw = await worker.fetch(new URL("/raw", upload.url));
    expect(raw.headers.get("content-type")).toBe("image/svg+xml");
    expect(raw.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(await raw.text()).toBe(source);
    expect(view.headers.get("etag")).not.toBe(raw.headers.get("etag"));
  });

  it("shows a bounded binary preview without initiating a download", async () => {
    const upload = await create("archive.zip", "x".repeat(10000), "application/zip");
    for (const pathname of ["/", "/raw"]) {
      const response = await worker.fetch(new URL(pathname, upload.url));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(response.headers.get("content-disposition")).toMatch(/^inline/);
      const html = await response.text();
      expect(html).toContain("Showing 4,096 bytes");
      expect(html).toContain("00000ff0");
      expect(html).not.toContain("00001000");
    }
  });

  it("keeps HEAD headers consistent with GET for each representation", async () => {
    for (const [filename, type] of [["text.txt", "text/plain"], ["notes.md", "text/markdown"], ["audio.wav", "audio/wav"], ["image.svg", "image/svg+xml"], ["unknown.bin", "application/octet-stream"]]) {
      const upload = await create(filename!, "contents", type!);
      for (const pathname of ["/", "/raw"]) {
        const target = new URL(pathname, upload.url);
        const get = await worker.fetch(target);
        const head = await worker.fetch(target, { method: "HEAD" });
        for (const header of ["content-type", "etag", "content-security-policy", "content-disposition"]) {
          expect(head.headers.get(header)).toBe(get.headers.get(header));
        }
        expect(await head.text()).toBe("");
        await get.arrayBuffer();
      }
    }
  });

  it("ignores ranges on rendered Markdown and reports correct raw HEAD metadata", async () => {
    const upload = await create("notes.md", "# Complete document\n\nLast paragraph", "text/markdown");
    const rendered = await worker.fetch(upload.url, { headers: { range: "bytes=0-3" } });
    expect(rendered.status).toBe(200);
    expect(await rendered.text()).toContain("Last paragraph");
    const raw = await worker.fetch(new URL("/raw", upload.url), { method: "HEAD" });
    expect(raw.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  });

  it("returns 416 for unsatisfiable ranges and honors If-Range", async () => {
    const upload = await create("clip.mp4", "0123456789", "video/mp4");
    const raw = new URL("/raw", upload.url);
    const invalid = await worker.fetch(raw, { headers: { range: "bytes=999-" } });
    expect(invalid.status).toBe(416);
    expect(invalid.headers.get("content-range")).toBe("bytes */10");
    const stale = await worker.fetch(raw, { headers: { range: "bytes=0-2", "if-range": '"stale"' } });
    expect(stale.status).toBe(200);
    expect((await stale.arrayBuffer()).byteLength).toBe(10);
  });

  it("does not serve IDs from unrelated hosts", async () => {
    const upload = await create("private.txt", "hidden", "text/plain");
    const response = await worker.fetch(`https://${upload.id}.example.com/`);

    expect(response.status).toBe(404);
  });

  it("keeps existing long IDs readable and mutable", async () => {
    const id = "0123456789abcdef0123456789abcdef";
    await env.BUCKET.put(`uploads/${id}`, "old file", { httpMetadata: { contentType: "text/plain" } });
    const response = await worker.fetch(`https://${id}.rune.page/`);
    expect(await response.text()).toBe("old file");
    const replacement = await worker.fetch(`https://api.rune.page/uploads/${id}?filename=old.txt`, {
      method: "PUT", headers: { ...auth, "content-type": "text/plain" }, body: "updated",
    });
    expect(replacement.status).toBe(200);
    expect(await (await worker.fetch(`https://${id}.rune.page/`)).text()).toBe("updated");
    expect((await worker.fetch(`https://api.rune.page/uploads/${id}`, { method: "DELETE", headers: auth })).status).toBe(204);
  });

  it("revalidates public responses with ETags", async () => {
    const upload = await create("cached.txt", "cached", "text/plain");
    const response = await worker.fetch(upload.url, {
      headers: { "if-none-match": upload.etag },
    });

    expect(response.status).toBe(304);
    expect(response.headers.get("etag")).toBe(upload.etag);
  });

  it("deletes an upload", async () => {
    const upload = await create("temporary.txt", "bye", "text/plain");
    const deleted = await worker.fetch(`https://api.rune.page/uploads/${upload.id}`, {
      method: "DELETE",
      headers: auth,
    });

    expect(deleted.status).toBe(204);
    expect((await worker.fetch(upload.url)).status).toBe(404);
  });
});

type UploadResult = {
  id: string;
  url: string;
  etag: string;
};

async function create(filename: string, body: string, contentType: string): Promise<UploadResult> {
  const response = await worker.fetch(
    `https://api.rune.page/uploads?filename=${encodeURIComponent(filename)}`,
    {
      method: "POST",
      headers: { ...auth, "content-type": contentType },
      body,
    },
  );
  expect(response.status).toBe(201);
  return json<UploadResult>(response);
}

async function json<T>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}
