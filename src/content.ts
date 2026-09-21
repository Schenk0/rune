export const HTML_CONTENT_TYPE = "text/html";
// Keep existing UUID-derived links valid while issuing shorter IDs for new uploads.
export const UPLOAD_ID_PATTERN = /^(?:[a-z0-9]{12}|[a-f0-9]{32})$/;
export const MARKDOWN_CONTENT_TYPES = new Set(["text/markdown", "text/x-markdown"]);

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".aac": "audio/aac",
  ".avif": "image/avif",
  ".css": "text/css",
  ".csv": "text/csv",
  ".flac": "audio/flac",
  ".gif": "image/gif",
  ".htm": HTML_CONTENT_TYPE,
  ".html": HTML_CONTENT_TYPE,
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".m4a": "audio/mp4",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".ogg": "audio/ogg",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".xml": "application/xml",
  ".zip": "application/zip"
};

export function baseContentType(value: string | null): string {
  return value?.split(";", 1)[0]?.trim().toLowerCase() || "application/octet-stream";
}

export function contentTypeForFilename(filename: string): string {
  const dot = filename.lastIndexOf(".");
  const extension = dot === -1 ? "" : filename.slice(dot).toLowerCase();
  return MIME_TYPES[extension] ?? "application/octet-stream";
}
