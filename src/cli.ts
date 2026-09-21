#!/usr/bin/env node

import { readFile, open } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { contentTypeForFilename } from "./content.js";
import { MAX_UPLOAD_BYTES, parseUploadResult, uploadId, type UploadResult } from "./protocol.js";

const args = process.argv.slice(2);
const json = removeFlag(args, "--json");
const command = args[0] === "publish" || args[0] === "replace" || args[0] === "delete"
  ? args.shift()
  : "publish";

try {
  if (command === "publish" && args.length === 1) {
    print(await publish(args[0]!), json);
  } else if (command === "replace" && args.length === 2) {
    print(await replace(args[0]!, args[1]!), json);
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
  rune replace <id-or-url> <file> [--json]
  rune delete <id-or-url>
`);
}
