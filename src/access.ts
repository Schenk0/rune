const USER_PREFIX = "control/users/";
export const OWNER_ID = "owner";
export const USER_ID_PATTERN = /^[a-z][a-z0-9-]{0,47}$/;

export type Identity = { id: string; admin: boolean };
type User = { id: string; tokenHash: string; createdAt: string; updatedAt: string; revokedAt?: string };

/** The original secret remains the owner credential. User credentials are independently revocable. */
export async function authenticate(request: Request, env: Env): Promise<Identity | Response> {
  const authorization = request.headers.get("authorization");
  if (env.UPLOAD_TOKEN && authorization === `Bearer ${env.UPLOAD_TOKEN}`) return { id: OWNER_ID, admin: true };
  const match = /^Bearer (rune_([a-z][a-z0-9-]{0,47})_[a-f0-9]{64})$/.exec(authorization ?? "");
  if (!match || match[2] === OWNER_ID) return response({ error: "Unauthorized" }, 401);
  // Bound unauthenticated credential lookups before accessing R2.
  if (!(await env.READ_LIMITER.limit({ key: `auth:${request.headers.get("cf-connecting-ip") ?? "unknown"}` })).success) {
    return response({ error: "Too many authentication attempts" }, 429, { "retry-after": "60" });
  }
  try {
    const record = await env.BUCKET.get(`${USER_PREFIX}${match[2]}`);
    const user = record ? parseUser(await record.json<unknown>()) : undefined;
    if (!user || user.id !== match[2] || user.revokedAt || user.tokenHash !== await hashToken(match[1]!)) {
      return response({ error: "Unauthorized" }, 401);
    }
    return { id: user.id, admin: false };
  } catch {
    return response({ error: "Access records unavailable; try again later" }, 503, { "retry-after": "60" });
  }
}

/** Only the owner credential may issue, inspect, rotate, or revoke publishing access. */
export async function manageUsers(request: Request, env: Env, url: URL, identity: Identity): Promise<Response> {
  if (!identity.admin) return response({ error: "Owner credential required" }, 403);
  try {
    if (url.pathname === "/users") {
      if (request.method === "GET") {
        const page = await env.BUCKET.list({ prefix: USER_PREFIX, cursor: url.searchParams.get("cursor") ?? undefined });
        const users = await Promise.all(page.objects.map(async object => {
          const stored = await env.BUCKET.get(object.key);
          if (!stored) throw new Error("Access record disappeared");
          return publicUser(parseUser(await stored.json<unknown>()));
        }));
        return response({ users, ...(page.truncated ? { cursor: page.cursor } : {}) });
      }
      if (request.method !== "POST") return response({ error: "Method not allowed" }, 405, { allow: "GET, POST" });
      let input: unknown;
      try { input = await request.json(); }
      catch { return response({ error: "Expected a JSON user ID" }, 400); }
      if (typeof input !== "object" || input === null || !("id" in input) || typeof input.id !== "string" ||
          !USER_ID_PATTERN.test(input.id) || input.id === OWNER_ID) {
        return response({ error: "User ID must start with a lowercase letter and contain at most 48 lowercase letters, digits, or hyphens; owner is reserved" }, 400);
      }
      return await issueToken(env.BUCKET, input.id);
    }
    const id = /^\/users\/([a-z][a-z0-9-]{0,47})\/token$/.exec(url.pathname)?.[1];
    if (!id || id === OWNER_ID) return response({ error: "Not found" }, 404);
    if (request.method !== "POST" && request.method !== "DELETE") {
      return response({ error: "Method not allowed" }, 405, { allow: "POST, DELETE" });
    }
    const current = await env.BUCKET.get(`${USER_PREFIX}${id}`);
    if (!current) return response({ error: "User not found" }, 404);
    const user = parseUser(await current.json<unknown>());
    if (user.id !== id) throw new Error("Mismatched access record");
    if (request.method === "POST") return await issueToken(env.BUCKET, id, { object: current, user });
    if (!user.revokedAt) {
      const now = new Date().toISOString();
      const saved = await env.BUCKET.put(`${USER_PREFIX}${id}`, JSON.stringify({ ...user, revokedAt: now, updatedAt: now }), {
        onlyIf: { etagMatches: current.etag },
      });
      if (!saved) return response({ error: "Access changed; inspect users and retry" }, 409);
    }
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  } catch {
    return response({ error: "Access records unavailable; try again later" }, 503, { "retry-after": "60" });
  }
}

async function issueToken(bucket: R2Bucket, id: string, current?: { object: R2Object; user: User }): Promise<Response> {
  const secret = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("");
  const token = `rune_${id}_${secret}`;
  const now = new Date().toISOString();
  const user: User = { id, tokenHash: await hashToken(token), createdAt: current?.user.createdAt ?? now, updatedAt: now };
  const saved = await bucket.put(`${USER_PREFIX}${id}`, JSON.stringify(user), {
    onlyIf: current ? { etagMatches: current.object.etag } : { etagDoesNotMatch: "*" },
  });
  if (!saved) return response({ error: "User already exists or access changed; inspect users before rotating" }, 409);
  return response({ user: publicUser(user), token }, current ? 200 : 201);
}

function publicUser({ tokenHash: _, ...user }: User) {
  return user;
}

function parseUser(value: unknown): User {
  if (typeof value !== "object" || value === null || !("id" in value) || typeof value.id !== "string" ||
      !USER_ID_PATTERN.test(value.id) || value.id === OWNER_ID ||
      !("tokenHash" in value) || typeof value.tokenHash !== "string" || !/^[a-f0-9]{64}$/.test(value.tokenHash) ||
      !("createdAt" in value) || typeof value.createdAt !== "string" ||
      !("updatedAt" in value) || typeof value.updatedAt !== "string" ||
      ("revokedAt" in value && typeof value.revokedAt !== "string")) throw new Error("Invalid access record");
  return { id: value.id, tokenHash: value.tokenHash, createdAt: value.createdAt, updatedAt: value.updatedAt,
    ...("revokedAt" in value && typeof value.revokedAt === "string" ? { revokedAt: value.revokedAt } : {}) };
}

async function hashToken(token: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}

function response(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
}
