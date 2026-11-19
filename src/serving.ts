import { baseContentType, MARKDOWN_CONTENT_TYPES } from "./content";
import { addPageMetadata, FAVICON_LINK } from "./favicon";
import { publicationMetadata } from "./storage";

const IMAGES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/svg+xml"]);
const MEDIA = new Set(["audio/aac", "audio/flac", "audio/mp4", "audio/mpeg", "audio/ogg", "audio/wav", "video/mp4", "video/quicktime", "video/webm"]);
const PREVIEW_BYTES = 4096;
const VIEW_POLICY = "default-src 'none'; base-uri 'none'; form-action 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; object-src 'none'";
const HTML_POLICY = "default-src 'none'; base-uri 'none'; connect-src 'none'; font-src data:; form-action 'none'; frame-src 'none'; img-src data: blob:; media-src data: blob:; object-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox";

/** Public representation and asset requests share metadata, conditions and range handling. */
export async function serveFile(request: Request, bucket: R2Bucket, key: string, ctx?: Pick<ExecutionContext, "waitUntil">): Promise<Response> {
  const url = new URL(request.url);
  const missKey = new Request(`${url.origin}/__cache/missing`);
  if (ctx && await caches.default.match(missKey)) return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
  const publication = await bucket.head(key);
  if (!publication) {
    if (ctx) ctx.waitUntil(caches.default.put(missKey, new Response("Not found", { status: 404, headers: { "cache-control": "public, max-age=5" } })));
    return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
  }
  const metadata = publicationMetadata(publication);
  const type = baseContentType(metadata.httpMetadata?.contentType ?? null);
  const filename = metadata.customMetadata?.filename ?? "file";
  const isText = !IMAGES.has(type) && (type.startsWith("text/") || ["application/json", "application/xml", "application/javascript"].includes(type) || type.endsWith("+json") || type.endsWith("+xml"));
  const image = IMAGES.has(type);
  const media = MEDIA.has(type);
  const markdown = MARKDOWN_CONTENT_TYPES.has(type) && Boolean(metadata.previewKey);
  const binary = !isText && !image && !media && type !== "application/pdf";
  const viewer = binary || (url.pathname === "/" && (image || media || markdown));
  const activeHtml = type === "text/html" && url.pathname === "/";
  const transformed = viewer || activeHtml;
  // Template changes must invalidate rendered responses even when the source file is unchanged.
  const etag = transformed ? `"${metadata.version}-viewer-7"` : metadata.httpEtag;
  const headers = new Headers({
    "cache-control": "public, max-age=0, must-revalidate",
    etag,
    "last-modified": metadata.uploaded.toUTCString(),
    "permissions-policy": "camera=(), geolocation=(), microphone=()",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "content-disposition": disposition(metadata.customMetadata?.filename ?? "file"),
  });
  headers.set("content-type", viewer || activeHtml ? "text/html; charset=utf-8" : isText ? "text/plain; charset=utf-8" : type);
  headers.set("content-security-policy", viewer ? VIEW_POLICY : activeHtml ? HTML_POLICY : media ? "default-src 'none'; media-src 'self'" : type === "application/pdf" ? "default-src 'none'; object-src 'self'" : "default-src 'none'; sandbox");

  if (!transformed && (isText || type === "application/pdf")) {
    headers.set("content-security-policy", `${headers.get("content-security-policy")}; img-src ${url.origin}/favicon.ico`);
  }
  if (transformed) headers.delete("last-modified");
  const condition = conditionalStatus(request.headers, etag, metadata.uploaded, !transformed);
  if (condition) return new Response(null, { status: condition, headers });
  if (!transformed) {
    headers.set("content-length", String(metadata.size));
    headers.set("accept-ranges", "bytes");
  }
  if (request.method === "HEAD") return new Response(null, { headers });

  // Always validate the current record first. Immutable cache entries cannot hide replacements/deletes.
  const cacheKey = new Request(`${url.origin}/__cache/viewer-7/${encodeURIComponent(metadata.version)}${url.pathname}`);
  const cacheable = Boolean(ctx) && !request.headers.has("range") && metadata.size <= 1024 * 1024;
  if (cacheable) {
    const cached = await caches.default.match(cacheKey);
    if (cached) return new Response(cached.body, { headers });
  }
  const finish = (response: Response): Response => {
    if (cacheable && ctx && response.status === 200) {
      const cached = response.clone();
      cached.headers.set("cache-control", "public, max-age=86400");
      ctx.waitUntil(caches.default.put(cacheKey, cached));
    }
    return response;
  };

  // Generated viewers reference /raw; ranges apply to the stored bytes, never transformed HTML.
  let range: { offset: number; length: number } | undefined;
  if (!transformed && request.headers.has("range") && permitsRange(request.headers.get("if-range"), etag, metadata.uploaded)) {
    const parsed = parseRange(request.headers.get("range")!, metadata.size);
    if (parsed === false) {
      headers.delete("content-length");
      headers.set("content-range", `bytes */${metadata.size}`);
      return new Response(null, { status: 416, headers });
    }
    range = parsed;
  }
  // Images and media need only a generated shell. Do not read their bodies into Worker memory.
  if (viewer && (image || media)) {
    const source = `/raw?v=${encodeURIComponent(metadata.version)}`;
    const element = image
      ? `<img src="${source}" alt="">`
      : type.startsWith("video/")
        ? `<video controls playsinline preload="metadata" src="${source}"></video>`
        : `<audio controls preload="metadata" src="${source}"></audio>`;
    return finish(new Response(page(`<main class="stage">${element}</main>`, escapeHtml(filename)), { headers }));
  }
  const renderedMarkdown = viewer && markdown;
  const object = await bucket.get(renderedMarkdown ? metadata.previewKey! : metadata.sourceKey, {
    onlyIf: renderedMarkdown ? undefined : { etagMatches: metadata.sourceEtag },
    range: binary && metadata.size > PREVIEW_BYTES ? { offset: 0, length: PREVIEW_BYTES } : range,
  });
  if (!object) return new Response("File changed; reload to view the latest version.", { status: 409, headers: { "cache-control": "no-store" } });
  if (!("body" in object)) return new Response("File changed; reload to view the latest version.", { status: 409, headers: { "cache-control": "no-store" } });
  if (viewer) {
    const content = binary
      ? `<p>${escapeHtml(type)} · ${metadata.size.toLocaleString("en-US")} bytes</p><p>No browser preview is available for this format. Showing ${Math.min(metadata.size, PREVIEW_BYTES).toLocaleString("en-US")} bytes as hexadecimal.</p><pre>${hexPreview(new Uint8Array(await object.arrayBuffer()))}</pre>`
      : await object.text();
    // micromark produces escaped HTML. Strip formatting, retaining its entity escaping for <title>.
    const heading = binary ? undefined : /<h([1-6])>([\s\S]*?)<\/h\1>/.exec(content)?.[2];
    const title = heading?.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim() || escapeHtml(filename);
    return finish(new Response(page(`<main class="document">${content}</main>`, title), { headers }));
  }
  if (range) {
    headers.set("content-range", `bytes ${range.offset}-${range.offset + range.length - 1}/${metadata.size}`);
    headers.set("content-length", String(range.length));
  }
  const response = new Response(object.body, { status: range ? 206 : 200, headers });
  return finish(activeHtml ? addPageMetadata(response, filename) : response);
}

function conditionalStatus(headers: Headers, etag: string, uploaded: Date, useDates = true): 304 | 412 | undefined {
  const matches = (value: string, weak: boolean) => value.split(",").some(part => part.trim() === "*" || (weak ? part.trim().replace(/^W\//, "") : part.trim()) === etag);
  const ifMatch = headers.get("if-match");
  if (ifMatch && !matches(ifMatch, false)) return 412;
  const modified = Date.parse(uploaded.toUTCString());
  const unmodifiedSince = headers.get("if-unmodified-since");
  if (useDates && !ifMatch && unmodifiedSince && modified > Date.parse(unmodifiedSince)) return 412;
  const ifNoneMatch = headers.get("if-none-match");
  if (ifNoneMatch) return matches(ifNoneMatch, true) ? 304 : undefined;
  const modifiedSince = headers.get("if-modified-since");
  if (useDates && modifiedSince && modified <= Date.parse(modifiedSince)) return 304;
}

function permitsRange(ifRange: string | null, etag: string, uploaded: Date): boolean {
  return !ifRange || ifRange === etag || Date.parse(ifRange) >= Date.parse(uploaded.toUTCString());
}

/** Ignore malformed/multiple ranges; reject valid but unsatisfiable single byte ranges. */
function parseRange(value: string, size: number): { offset: number; length: number } | false | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return undefined;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix)) return undefined;
    if (!suffix || !size) return false;
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }
  const offset = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(end)) return undefined;
  if (offset >= size || end < offset) return false;
  return { offset, length: Math.min(end, size - 1) - offset + 1 };
}

function page(content: string, escapedTitle: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapedTitle}</title>${FAVICON_LINK}<style>
  :root{color-scheme:dark;font-family:ui-sans-serif,system-ui,sans-serif;background:#111;color:#f5f5f5}*{box-sizing:border-box}body{margin:0}.stage{display:flex;align-items:center;justify-content:center;min-height:100svh;padding:24px}.stage img,.stage video{display:block;max-width:100%;max-height:calc(100svh - 48px);object-fit:contain}.stage audio{width:min(520px,100%)}.document{max-width:800px;margin:40px auto 64px;padding:0 24px;line-height:1.65;overflow-wrap:anywhere}.document img{max-width:100%}pre{overflow:auto;white-space:pre;padding:16px;background:#1b1b1b;font-size:14px}a{color:#9bf}hr{border:0;border-top:1px solid #333}
  </style></head><body>${content}</body></html>`;
}

function hexPreview(bytes: Uint8Array): string {
  const lines: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 16) {
    const row = bytes.slice(offset, offset + 16);
    const hex = Array.from(row, byte => byte.toString(16).padStart(2, "0")).join(" ").padEnd(47);
    const text = Array.from(row, byte => byte >= 32 && byte < 127 ? String.fromCharCode(byte) : ".").join("");
    lines.push(`${offset.toString(16).padStart(8, "0")}  ${hex}  ${escapeHtml(text)}`);
  }
  return lines.join("\n");
}

function disposition(filename: string): string {
  const encoded = encodeURIComponent(filename).replace(/['()*]/gu, character => `%${character.codePointAt(0)!.toString(16).toUpperCase()}`);
  return `inline; filename*=UTF-8''${encoded}`;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
