#!/usr/bin/env node

import { readFile, open, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { contentTypeForFilename } from "./content.js";
import { htmlPublicationUrl, saveHtmlPublicationUrl } from "./html-publication.js";
import { MAX_UPLOAD_BYTES, parseUploadResult, uploadId, type UploadResult } from "./protocol.js";

const args = process.argv.slice(2);
const json = removeFlag(args, "--json");
const command = args[0] === "publish" || args[0] === "replace" || args[0] === "delete" || args[0] === "users"
  ? args.shift()
  : "publish";

try {
  if (command === "users") {
    await manageAccess(args);
  } else if (command === "publish" && args.length === 1) {
    const path = args[0]!;
    const result = await publish(path);
    await reportUpload(result, path);
  } else if (command === "replace" && (args.length === 1 || args.length === 2)) {
    const path = args.at(-1)!;
    const target = args.length === 2 ? args[0]! : await htmlPublicationUrl(path);
    const result = await replace(target, path);
    await reportUpload(result, path);
  } else if (command === "delete" && args.length === 1) {
    await remove(args[0]!);
    process.stdout.write("Deleted\n");
  } else {
    usage();
    process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

async function publish(path: string): Promise<UploadResult> {
  return upload("POST", "/uploads", path);
}

async function replace(target: string, path: string): Promise<UploadResult> {
  const id = uploadId(target, publicOrigin());
  const current = await fetch(`${apiUrl()}/uploads/${id}`, {
    method: "HEAD",
    headers: await authHeaders(),
    signal: AbortSignal.timeout(30_000),
    redirect: "error",
  });
  if (!current.ok) {
    throw new Error(`Could not read current upload: ${current.status} ${current.statusText}`);
  }
  const etag = current.headers.get("etag");
  if (!etag) throw new Error("Rune API did not return a revision validator");
  return upload("PUT", `/uploads/${id}`, path, etag);
}

async function reportUpload(result: UploadResult, path: string): Promise<void> {
  print(result, json);
  try {
    await saveHtmlPublicationUrl(path, result.url);
  } catch (error) {
    // The upload already succeeded. A local write failure must not invite a duplicate publish.
    process.stderr.write(`Upload succeeded, but could not save rune-url in local HTML: ${error instanceof Error ? error.message : String(error)}\nUse rune replace ${result.url} <file> to update this publication.\n`);
  }
}

async function remove(target: string): Promise<void> {
  const response = await fetch(`${apiUrl()}/uploads/${uploadId(target, publicOrigin())}`, {
    method: "DELETE",
    headers: await authHeaders(),
    signal: AbortSignal.timeout(30_000),
    redirect: "error",
  });
  await expectSuccess(response);
}

async function upload(
  method: "POST" | "PUT",
  pathname: string,
  path: string,
  etag?: string,
): Promise<UploadResult> {
  const filename = basename(path);
  const file = await open(path, "r");
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_UPLOAD_BYTES) throw new Error("Expected a file no larger than 100 MB");
    const url = new URL(pathname, `${apiUrl()}/`);
    url.searchParams.set("filename", filename);

    const headers = await authHeaders();
    headers.set("content-type", contentTypeForFilename(filename));
    headers.set("content-length", String(info.size));
    if (etag) headers.set("if-match", etag);

    const init = {
      method, headers, body: file.readableWebStream(), duplex: "half" as const,
      signal: AbortSignal.timeout(120_000), redirect: "error" as const,
    };
    const response = await fetch(url, init);
    await expectSuccess(response);
    return parseUploadResult(await response.json(), publicOrigin());
  } finally {
    await file.close();
  }
}

async function expectSuccess(response: Response): Promise<void> {
  if (response.ok) {
    return;
  }

  const body = await response.text();
  throw new Error(`Rune API returned ${response.status}: ${body}`);
}

/** Credential files are created exclusively with owner-only permissions; tokens never go to stdout. */
async function manageAccess(values: string[]): Promise<void> {
  const [action, id, flag, tokenPath] = values;
  if (action === "list" && values.length === 1) {
    const users: ReturnType<typeof parseUserSummary>[] = [];
    let cursor: string | undefined;
    do {
      const url = new URL("/users", apiUrl());
      if (cursor) url.searchParams.set("cursor", cursor);
      const result = await fetch(url, { headers: await authHeaders(), signal: AbortSignal.timeout(30_000), redirect: "error" });
      await expectSuccess(result);
      const page: unknown = await result.json();
      if (typeof page !== "object" || page === null || !("users" in page) || !Array.isArray(page.users) ||
          ("cursor" in page && typeof page.cursor !== "string")) throw new Error("Invalid user listing");
      users.push(...page.users.map(parseUserSummary));
      const next = "cursor" in page && typeof page.cursor === "string" ? page.cursor : undefined;
      if (next && next === cursor) throw new Error("Rune API repeated a listing cursor");
      cursor = next;
    } while (cursor);
    process.stdout.write(json ? `${JSON.stringify(users)}\n` : users.map(user => `${user.id}\t${user.revokedAt ? "revoked" : "active"}\t${user.createdAt}\n`).join(""));
    return;
  }
  if (!id || !/^[a-z][a-z0-9-]{0,47}$/.test(id) || id === "owner") {
    throw new Error("Expected a user ID starting with a lowercase letter, followed by lowercase letters, digits, or hyphens, at most 48 characters; owner is reserved");
  }
  if (action === "revoke" && values.length === 2) {
    const result = await fetch(`${apiUrl()}/users/${id}/token`, {
      method: "DELETE", headers: await authHeaders(), signal: AbortSignal.timeout(30_000), redirect: "error",
    });
    await expectSuccess(result);
    process.stdout.write(`Revoked access for ${id}\n`);
    return;
  }
  if ((action !== "create" && action !== "rotate") || values.length !== 4 || flag !== "--token-file" || !tokenPath) {
    throw new Error("Use rune users create|rotate <user-id> --token-file <new-file>, rune users revoke <user-id>, or rune users list");
  }
  const file = await open(tokenPath, "wx", 0o600);
  let saved = false;
  try {
    const headers = await authHeaders();
    headers.set("content-type", "application/json");
    const result = await fetch(`${apiUrl()}${action === "create" ? "/users" : `/users/${id}/token`}`, {
      method: "POST", headers, ...(action === "create" ? { body: JSON.stringify({ id }) } : {}),
      signal: AbortSignal.timeout(30_000), redirect: "error",
    });
    await expectSuccess(result);
    const issued: unknown = await result.json();
    if (typeof issued !== "object" || issued === null || !("token" in issued) || typeof issued.token !== "string" ||
        !new RegExp(`^rune_${id}_[a-f0-9]{64}$`).test(issued.token) || !("user" in issued) ||
        parseUserSummary(issued.user).id !== id) throw new Error("Invalid token response; rotate this user's token to recover");
    await file.writeFile(`${issued.token}\n`, "utf8");
    saved = true;
    process.stdout.write(`Saved token for ${id} to ${tokenPath}. Send it privately.\n`);
  } catch (error) {
    process.stderr.write(`If the request reached Rune, access may have changed. Use a new token file and rotate ${id} to recover.\n`);
    throw error;
  } finally {
    await file.close();
    if (!saved) await unlink(tokenPath);
  }
}

function parseUserSummary(value: unknown) {
  if (typeof value !== "object" || value === null || !("id" in value) || typeof value.id !== "string" ||
      !("createdAt" in value) || typeof value.createdAt !== "string" || !("updatedAt" in value) || typeof value.updatedAt !== "string" ||
      ("revokedAt" in value && typeof value.revokedAt !== "string")) throw new Error("Invalid user response");
  return { id: value.id, createdAt: value.createdAt, updatedAt: value.updatedAt,
    ...("revokedAt" in value && typeof value.revokedAt === "string" ? { revokedAt: value.revokedAt } : {}) };
}

async function authHeaders(): Promise<Headers> {
  const token = process.env.RUNE_TOKEN ?? await readTokenFile();
  return new Headers({ authorization: `Bearer ${token}` });
}

async function readTokenFile(): Promise<string> {
  const path = process.env.RUNE_TOKEN_FILE ?? join(homedir(), ".config", "rune", "token");
  try {
    const token = (await readFile(path, "utf8")).trim();
    if (token) {
      return token;
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
  throw new Error(`Set RUNE_TOKEN or create ${path}`);
}

function apiUrl(): string {
  return (process.env.RUNE_API_URL ?? "https://api.rune.page").replace(/\/$/u, "");
}

function publicOrigin(): string {
  if (process.env.RUNE_PUBLIC_ORIGIN) return process.env.RUNE_PUBLIC_ORIGIN;
  const api = new URL(apiUrl());
  if (["localhost", "127.0.0.1"].includes(api.hostname)) return `${api.protocol}//localhost${api.port ? `:${api.port}` : ""}`;
  return "https://rune.page";
}

function removeFlag(values: string[], flag: string): boolean {
  const index = values.indexOf(flag);
  if (index === -1) {
    return false;
  }
  values.splice(index, 1);
  return true;
}

function print(result: UploadResult, asJson: boolean): void {
  process.stdout.write(`${asJson ? JSON.stringify(result) : result.url}\n`);
}

function usage(): void {
  process.stderr.write(`Usage:
  rune <file>
  rune publish <file> [--json]
  rune replace <html-file> [--json]
  rune replace <id-or-url> <file> [--json]
  rune delete <id-or-url>
  rune users create <user-id> --token-file <new-file>
  rune users list [--json]
  rune users rotate <user-id> --token-file <new-file>
  rune users revoke <user-id>
`);
}
