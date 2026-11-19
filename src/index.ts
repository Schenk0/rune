import { baseContentType, UPLOAD_ID_PATTERN } from "./content";
import { serveFile } from "./serving";
import { faviconResponse } from "./favicon";
import { MAX_UPLOAD_BYTES, type UploadResult } from "./protocol";
import { removeDerived, storePublication, UploadBodyError } from "./storage";
import { reserveUpload } from "./budget";
import { serveSite } from "./site";
import { authenticate, manageUsers, OWNER_ID, type Identity } from "./access";

const OBJECT_PREFIX = "uploads/";

export default {
  async fetch(request, env, ctx?: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const siteHost = url.hostname === env.PUBLIC_DOMAIN || url.hostname === `www.${env.PUBLIC_DOMAIN}`;
    // Local development shares localhost with the API; preserve its API paths.
    if (siteHost && !(url.hostname === env.API_HOST && /^\/(uploads|users)(\/|$)/.test(url.pathname))) {
      return serveSite(request, env.PUBLIC_ORIGIN);
    }

    if (url.pathname === "/favicon.ico" && (url.hostname === env.API_HOST || uploadIdFromHost(url.hostname, env.PUBLIC_DOMAIN))) {
      return request.method === "GET" || request.method === "HEAD"
        ? faviconResponse(request)
        : methodNotAllowed("GET, HEAD");
    }

    if (url.hostname === env.API_HOST) {
      try {
        return await handleApi(request, env, url);
      } catch (error) {
        if (error instanceof UploadBodyError) return jsonError(error.message, 400);
        throw error;
      }
    }

    return handlePublic(request, env, url, ctx);
  },
} satisfies ExportedHandler<Env>;

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  const identity = await authenticate(request, env);
  if (identity instanceof Response) return identity;
  if (["POST", "PUT", "DELETE"].includes(request.method) &&
      !(await env.WRITE_LIMITER.limit({ key: "mutations" })).success) return rateLimited();

  if (url.pathname === "/users" || url.pathname.startsWith("/users/")) {
    return manageUsers(request, env, url, identity);
  }

  if (request.method === "POST" && url.pathname === "/uploads") {
    return createUpload(request, env, url, identity);
  }

  const id = /^\/uploads\/([^/]+)$/.exec(url.pathname)?.[1];
  if (!id || !UPLOAD_ID_PATTERN.test(id)) {
    return jsonError("Not found", 404);
  }

  if (request.method === "PUT") {
    return replaceUpload(request, env, url, id, identity);
  }
  if (request.method === "HEAD") {
    return inspectUpload(env, id, identity);
  }
  if (request.method === "DELETE") {
    return deleteUpload(env, id, identity);
  }

  return methodNotAllowed("HEAD, PUT, DELETE");
}

async function createUpload(request: Request, env: Env, url: URL, identity: Identity): Promise<Response> {
  const input = uploadInput(request, url);
  if (input instanceof Response) {
    return input;
  }

  const id = newUploadId();
  const exhausted = await reserveUpload(env.BUCKET, input.size, true);
  if (exhausted) return exhausted;
  const object = await storePublication(env.BUCKET, objectKey(id), { ...input, ownerId: identity.id });

  if (!object) {
    return jsonError("Could not allocate upload ID", 503);
  }

  return uploadResponse({
    id,
    url: publicUrl(id, env.PUBLIC_ORIGIN),
    etag: object.httpEtag,
  }, 201);
}

async function replaceUpload(
  request: Request,
  env: Env,
  url: URL,
  id: string,
  identity: Identity,
): Promise<Response> {
  const existing = await env.BUCKET.head(objectKey(id));
  if (!existing || !ownsPublication(existing, identity)) {
    return jsonError("Upload not found", 404);
  }

  const ifMatch = request.headers.get("if-match");
  if (ifMatch && ifMatch !== "*" && ifMatch !== existing.httpEtag) {
    return jsonError("Upload has changed", 412);
  }

  const input = uploadInput(request, url);
  if (input instanceof Response) {
    return input;
  }

  const exhausted = await reserveUpload(env.BUCKET, input.size, false);
  if (exhausted) return exhausted;
  const object = await storePublication(env.BUCKET, objectKey(id), { ...input, ownerId: identity.id }, existing);

  if (!object) {
    return jsonError("Upload has changed", 412);
  }

  return uploadResponse({
    id,
    url: publicUrl(id, env.PUBLIC_ORIGIN),
    etag: object.httpEtag,
  });
}

async function deleteUpload(env: Env, id: string, identity: Identity): Promise<Response> {
  const key = objectKey(id);
  const existing = await env.BUCKET.head(key);
  if (!existing || !ownsPublication(existing, identity)) {
    return jsonError("Upload not found", 404);
  }

  await env.BUCKET.delete(key);
  await removeDerived(env.BUCKET, existing);
  return new Response(null, { status: 204 });
}

async function inspectUpload(env: Env, id: string, identity: Identity): Promise<Response> {
  const object = await env.BUCKET.head(objectKey(id));
  if (!object || !ownsPublication(object, identity)) {
    return jsonError("Upload not found", 404);
  }

  return new Response(null, {
    headers: {
      "cache-control": "no-store",
      etag: object.httpEtag,
    },
  });
}

async function handlePublic(request: Request, env: Env, url: URL, ctx?: ExecutionContext): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed("GET, HEAD");
  const id = uploadIdFromHost(url.hostname, env.PUBLIC_DOMAIN);
  if (!id || (url.pathname !== "/" && url.pathname !== "/raw")) return new Response("Not found", { status: 404 });
  if (!(await env.READ_LIMITER.limit({ key: request.headers.get("cf-connecting-ip") ?? "unknown" })).success) return rateLimited();
  return serveFile(request, env.BUCKET, objectKey(id), ctx);
}

function rateLimited(): Response {
  return new Response("Too many requests", { status: 429, headers: { "retry-after": "60", "cache-control": "no-store" } });
}

function uploadInput(
  request: Request,
  url: URL,
): { body: ReadableStream; contentType: string; filename: string; size: number } | Response {
  if (!request.body) {
    return jsonError("Request body is required", 400);
  }

  const filename = url.searchParams.get("filename")?.normalize("NFC");
  if (!filename || !isValidFilename(filename)) {
    return jsonError("A valid filename query parameter is required", 400);
  }
  const length = request.headers.get("content-length");
  if (length === null) return jsonError("Content-Length is required", 411);
  const size = Number(length);
  if (!/^\d+$/.test(length) || !Number.isSafeInteger(size)) return jsonError("Invalid Content-Length", 400);
  if (size > MAX_UPLOAD_BYTES) return jsonError("Files must be no larger than 100 MB", 413);

  return {
    body: request.body,
    contentType: baseContentType(request.headers.get("content-type")),
    filename,
    size,
  };
}

function ownsPublication(object: R2Object, identity: Identity): boolean {
  return (object.customMetadata?.ownerId ?? OWNER_ID) === identity.id;
}

function uploadIdFromHost(hostname: string, publicDomain: string): string | null {
  const suffix = `.${publicDomain}`;
  if (!hostname.endsWith(suffix)) {
    return null;
  }
  const id = hostname.slice(0, -suffix.length);
  return UPLOAD_ID_PATTERN.test(id) ? id : null;
}

function newUploadId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  while (id.length < 12) {
    for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
      // Rejection sampling avoids bias: 252 is divisible by 36.
      if (byte < 252) id += alphabet[byte % alphabet.length];
      if (id.length === 12) break;
    }
  }
  return id;
}

function isValidFilename(filename: string): boolean {
  return (
    filename.length <= 255 &&
    !filename.startsWith(".") &&
    !/[\\/\u0000-\u001f\u007f]/u.test(filename)
  );
}

function objectKey(id: string): string {
  return `${OBJECT_PREFIX}${id}`;
}

function publicUrl(id: string, publicOrigin: string): string {
  const url = new URL(publicOrigin);
  url.hostname = `${id}.${url.hostname}`;
  return url.href;
}

function uploadResponse(result: UploadResult, status = 200): Response {
  return Response.json(result, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function methodNotAllowed(allow: string): Response {
  return new Response("Method not allowed", {
    status: 405,
    headers: { allow },
  });
}
