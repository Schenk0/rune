import { UPLOAD_ID_PATTERN } from "./content.js";

export const MAX_UPLOAD_BYTES = 100_000_000;

export type UploadResult = { id: string; url: string; etag: string };

export function uploadId(target: string, publicOrigin = "https://rune.page"): string {
  if (UPLOAD_ID_PATTERN.test(target)) return target;
  const url = new URL(target);
  const origin = new URL(publicOrigin);
  const suffix = `.${origin.hostname}`;
  const id = url.hostname.endsWith(suffix) ? url.hostname.slice(0, -suffix.length) : "";
  if (!UPLOAD_ID_PATTERN.test(id) || url.protocol !== origin.protocol || url.port !== origin.port ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Expected a Rune upload ID or root URL on the configured public origin");
  }
  return id;
}

export function parseUploadResult(value: unknown, publicOrigin: string): UploadResult {
  if (typeof value !== "object" || value === null || !("id" in value) || !("url" in value) || !("etag" in value) ||
      typeof value.id !== "string" || typeof value.url !== "string" || typeof value.etag !== "string" ||
      !value.url.includes("://") || !/^"[^"\r\n]+"$/.test(value.etag) || uploadId(value.url, publicOrigin) !== value.id) {
    throw new Error("Invalid Rune API response");
  }
  return { id: value.id, url: value.url, etag: value.etag };
}
