import { MARKDOWN_CONTENT_TYPES } from "./content";
import { MAX_MARKDOWN_BYTES, renderMarkdown } from "./markdown";

export class UploadBodyError extends Error {}

/** New publications are small CAS records; legacy objects remain readable in place. */
export function publicationMetadata(object: R2Object) {
  const record = object.customMetadata;
  const indirect = record?.format === "publication-v2";
  return {
    ...object,
    size: indirect ? Number(record.sourceSize) : object.size,
    sourceKey: indirect ? record.sourceKey! : object.key,
    sourceEtag: indirect ? record.sourceEtag! : object.etag,
    previewKey: indirect ? record.previewKey : undefined,
  };
}

export async function storePublication(
  bucket: R2Bucket,
  key: string,
  input: { body: ReadableStream; filename: string; contentType: string; size: number; ownerId: string },
  existing?: R2Object,
): Promise<R2Object | null> {
  const revision = crypto.randomUUID();
  const sourceKey = `sources/${key}/${revision}`;
  const previewKey = `previews/${key}/${revision}`;
  let committed = false;
  try {
    // FixedLengthStream enforces the declared length without buffering the upload.
    const bounded = new FixedLengthStream(input.size);
    const controller = new AbortController();
    let bodyFailed = false;
    let received = 0;
    const counted = input.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, output) {
        received += chunk.byteLength;
        if (received > input.size) {
          bodyFailed = true;
          throw new UploadBodyError("Body exceeds Content-Length");
        }
        output.enqueue(chunk);
      },
      flush() {
        if (received !== input.size) {
          bodyFailed = true;
          throw new UploadBodyError("Body is shorter than Content-Length");
        }
      },
    }));
    const transfer = counted.pipeTo(bounded.writable, { signal: controller.signal });
    const write = bucket.put(sourceKey, bounded.readable).catch(error => {
      controller.abort(error);
      throw error;
    });
    const [stored, transferred] = await Promise.allSettled([write, transfer]);
    if (bodyFailed) throw new UploadBodyError("Body does not match Content-Length");
    if (stored.status === "rejected") throw stored.reason;
    if (transferred.status === "rejected") throw transferred.reason;
    const source = stored.value;
    if (!source) throw new Error("Source storage failed");
    let preview: string | undefined;
    if (MARKDOWN_CONTENT_TYPES.has(input.contentType) && source.size <= MAX_MARKDOWN_BYTES) {
      const stored = await bucket.get(sourceKey);
      if (!stored) throw new Error("Source disappeared during publication");
      preview = renderMarkdown(await stored.text());
    }
    if (preview !== undefined) await bucket.put(previewKey, preview);
    const object = await bucket.put(key, revision, {
      httpMetadata: { contentType: input.contentType },
      customMetadata: {
        format: "publication-v2", filename: input.filename, ownerId: existing?.customMetadata?.ownerId ?? input.ownerId,
        sourceKey, sourceSize: String(source.size), sourceEtag: source.etag,
        ...(preview !== undefined ? { previewKey } : {}),
      },
      onlyIf: existing ? { etagMatches: existing.etag } : { etagDoesNotMatch: "*" },
    });
    committed = object !== null;
    if (committed && existing) await removeDerived(bucket, existing);
    return object;
  } finally {
    if (!committed) await bucket.delete([sourceKey, previewKey]);
  }
}

export async function removeDerived(bucket: R2Bucket, object: R2Object): Promise<void> {
  const metadata = publicationMetadata(object);
  if (metadata.sourceKey === object.key) return;
  // Cleanup failure must not turn an already committed write into an apparent failure.
  try {
    await bucket.delete([metadata.sourceKey, ...(metadata.previewKey ? [metadata.previewKey] : [])]);
  } catch {
    console.error("Publication cleanup failed", object.key);
  }
}
