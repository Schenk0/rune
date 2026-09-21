export const UPLOAD_BUDGET_KEY = "control/upload-budget";
const DAILY_BYTES = 1_000_000_000;
const DAILY_PUBLICATIONS = 100;

/** Reserve before storing bytes. Never refund: interrupted writes must still consume budget. */
export async function reserveUpload(
  bucket: { get(key: string): Promise<R2ObjectBody | null>; put(key: string, value: string, options: R2PutOptions): Promise<R2Object | null> },
  bytes: number,
  create: boolean,
): Promise<Response | undefined> {
  try {
    for (let attempt = 0; attempt < 8; attempt++) {
      const now = new Date();
      const day = now.toISOString().slice(0, 10);
      const current = await bucket.get(UPLOAD_BUDGET_KEY);
      const previous = current ? parseBudget(await current.json<unknown>()) : undefined;
      if (previous && previous.day > day) throw new Error("Budget clock moved backwards");
      const used = previous?.day === day ? previous : { bytes: 0, publications: 0 };
      const next = { day, bytes: used.bytes + bytes, publications: used.publications + Number(create), revision: crypto.randomUUID() };
      if (next.bytes > DAILY_BYTES || next.publications > DAILY_PUBLICATIONS) {
        const retry = Math.max(1, Math.ceil((Date.parse(`${day}T00:00:00Z`) + 86_400_000 - now.getTime()) / 1000));
        return failure("Daily upload budget exhausted", 429, retry);
      }
      // A unique revision keeps even zero-byte reservations safe from stale compare-and-swap writes.
      const saved = await bucket.put(UPLOAD_BUDGET_KEY, JSON.stringify(next), {
        onlyIf: current ? { etagMatches: current.etag } : { etagDoesNotMatch: "*" },
      });
      if (saved) return;
    }
  } catch {
    // Budget storage failures must never allow unaccounted uploads.
    return failure("Upload budget unavailable; try again later", 503, 60);
  }
  return failure("Upload budget busy; try again later", 503, 1);
}

function parseBudget(value: unknown) {
  if (typeof value !== "object" || value === null || !("day" in value) || !("bytes" in value) || !("publications" in value) ||
      typeof value.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.day) ||
      typeof value.bytes !== "number" || !Number.isSafeInteger(value.bytes) || value.bytes < 0 ||
      typeof value.publications !== "number" || !Number.isSafeInteger(value.publications) || value.publications < 0) {
    throw new Error("Invalid upload budget");
  }
  return { day: value.day, bytes: value.bytes, publications: value.publications };
}

function failure(error: string, status: number, retry: number): Response {
  return Response.json({ error }, { status, headers: { "cache-control": "no-store", "retry-after": String(retry) } });
}
