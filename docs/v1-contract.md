# Rune version-one contract

Rune stores one file per publication. The publication ID remains stable when its file is replaced.

## Hosts

- `rune.page` serves the static landing page and `/llms.txt` agent instructions without upload credentials or R2 access. `www.rune.page` redirects to the canonical host, preserving the path and query. Both support GET and HEAD.
- `api.rune.page` accepts authenticated mutations.
- `<id>.rune.page` serves public files.
- New IDs use 12 random lowercase letters and digits, about 62 bits of entropy. DNS is case-insensitive, so uppercase would not add uniqueness. Existing 32-character hexadecimal IDs remain valid. Conditional creation prevents an ID collision from overwriting a file.

The R2 bucket stays private. Every public read passes through the Worker.

## Authentication

Mutation requests use `Authorization: Bearer <token>`. The token is stored as the Worker secret `UPLOAD_TOKEN` and as `RUNE_TOKEN` on clients.

Public reads require no authentication. Rune does not expose an upload listing.

## API

### Create

`POST /uploads?filename=<name>` sends the file as the request body. `Content-Type` records the file type. `Content-Length` is required and must match the streamed body. Files over 100,000,000 bytes return `413`; missing lengths return `411`.

The response has status `201`:

```json
{
  "id": "abcdefghijkl",
  "url": "https://abcdefghijkl.rune.page/",
  "etag": "\"...\""
}
```

### Replace

`PUT /uploads/<id>?filename=<name>` replaces the file and keeps its public URL. Clients should send the current ETag in `If-Match`. Rune returns `412` if the publication changed after the client read it.

`HEAD /uploads/<id>` returns the current ETag for authenticated clients.

Each replacement gets a new revision, including filename-only and content-type-only changes. New publications store immutable source/preview objects behind a small, conditionally written revision record. This makes concurrent replacement checks cover metadata as well as bytes. Legacy objects remain readable. Superseded objects are removed after a successful commit; interrupted writes can leave orphaned objects requiring maintenance.

### Delete

`DELETE /uploads/<id>` permanently removes the publication.

## Public reads

`GET https://<id>.rune.page/` displays the current file in the browser. `HEAD` returns the same representation headers. Responses use ETags and require cache revalidation so replacements appear at the same URL. Rendered viewers have distinct ETags from their source bytes.

- Images are centered on a dark background and fit the viewport without changing their proportions. No filenames, headers, or decorative controls appear around the content.
- Tab titles preserve an uploaded HTML document's title, using its filename if the title is missing or empty. Rendered Markdown uses its first heading without inline formatting, falling back to the filename. Other generated viewers use the filename, with no Rune suffix. Plain-text, PDF and raw responses retain browser-controlled titles.
- The S2 mark is the favicon for generated viewers and hosted HTML. HTML is streamed through a rewriter to replace existing icon links, without changing stored source bytes. Every upload hostname also serves a shared `/favicon.ico` fallback. Plain-text and native PDF tabs depend on browser favicon support; their content is not wrapped or rewritten.
- Audio and video use native browser controls in the same content-only layout, without autoplay. The generated viewer permits its own image and media resources. Uploaded HTML retains a separate, restrictive policy.
- HTML renders with inline styles and scripts inside a CSP sandbox without same-origin storage, network fetches, forms, frames, external assets, or sandbox download permission. This is isolation, not a guarantee against every possible top-level navigation.
- Markdown renders once during authenticated publication, with GFM tables and task lists. Embedded HTML is escaped. Rendering accepts at most 64 KiB and 2,048 non-letter/non-number/non-space characters, including newlines, with a 512 KiB output cap. Larger or denser inputs and parser errors fall back to plain text. These conservative guards reduce parser exposure, not prove a universal memory bound. Public reads never parse Markdown. Legacy Markdown stays plain text until republished.
- Plain text, JSON, CSV, XML, and other text formats display as text. PDF uses the browser's native viewer where supported.
- Unsupported binary formats, including ZIP, display their type, size, and a hexadecimal preview of at most 4 KiB. Rune never requests an attachment download; browser settings and format support can still affect native PDF or media handling.
- `/raw` serves original image, media, and PDF bytes, or plain text source for text formats. Unsupported binary formats still show the bounded preview.
- Single byte ranges apply to original bytes. Unsatisfiable ranges return `416`; stale `If-Range` values return the full response. Rendered viewers ignore range requests.

## Resource controls

- Public reads are limited to 240 requests per minute per client IP. Authenticated mutations share 30 requests per minute. Rejections return `429` and `Retry-After: 60` before R2 access. Cloudflare rate limits are approximate and per location, not a global request or billing budget.
- Responses for files up to 1 MiB are cached internally by revision and renderer version for up to a day. Every successful lookup still checks the current R2 record first, so replacement and deletion are not hidden by cached bodies. Ranges bypass this cache. Browsers must revalidate.
- Missing IDs are cached for five seconds. A guessed ID subsequently allocated during that window can take up to five seconds to appear. Random new misses still reach R2.
- Workers Free supplies the CPU ceiling. Custom CPU limits require Workers Paid, so Rune does not configure one. CPU exhaustion can terminate publication before a Markdown fallback is possible; its budget reservation remains charged.
- Uploads are streamed with a 100 MB limit. A shared, durable R2 ledger limits each UTC day to 100 new-publication reservations and 1,000,000,000 uploaded source bytes. Replacements count their full size against bytes, but do not consume new-publication slots. Limits are project-wide, not per credential or Cloudflare location.
- Budget is reserved atomically before storing file data. Over-budget uploads return `429` with `Retry-After` until midnight UTC. Accounting failures or sustained contention return `503`, never an unaccounted upload. Failed or interrupted uploads keep their reservations; deletion does not refund budget. Invalid requests rejected before reservation are not charged.
- Counters reset on the first reservation of a new UTC day. Existing links never expire, and reads and deletion do not consume the daily upload budget. This bounds daily ingestion, not total accumulated storage or public-read bills. No total-storage cap is configured. Account alerts and any WAF rules require a separate account-level check before deployment.

Accounting lives at the private R2 key `control/upload-budget`, initialized by the first upload after deployment. Do not remove or restore an older copy of this object while uploads are enabled: doing so resets protection. Each uncontended reservation adds one R2 GET and one conditional PUT; conflicts retry at most eight times. Conditional writes use [R2's ETag preconditions](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#conditional-operations).

R2 [limits concurrent writes to one key to one per second](https://developers.cloudflare.com/r2/platform/limits/). Upload bursts can therefore receive `503` even below the daily quota; wait for `Retry-After` before trying again. Local concurrency tests verify accounting, not this production throughput limit. If burst publishing becomes necessary, move the counter to a Durable Object rather than sharding a global budget.

## CLI

The CLI reads `RUNE_TOKEN`, then falls back to `~/.config/rune/token`. `RUNE_API_URL` overrides the production API. `RUNE_PUBLIC_ORIGIN` configures accepted public URLs for other deployments; localhost API URLs infer the local scheme and port. The Worker uses `PUBLIC_ORIGIN` when returning links.

Replacement and deletion accept a bare ID or an exact root URL on the configured public origin, without credentials, query strings, or fragments. Uploads stream from disk after a size check, with a two-minute timeout; inspection and deletion have 30-second timeouts. API success responses are validated before printing a URL.

```sh
rune report.html
rune replace https://<id>.rune.page/ report.html
rune delete https://<id>.rune.page/
```

The default publish output is only the public URL, which makes it suitable for agents. Add `--json` to create and replace commands for the full API response.

## Deferred

Rune version one has no account system, public directory, dashboard, folders, search, editor, version history, or MCP server. It does not extract archives or convert office documents; those formats show a byte preview.

Create requests are not idempotent. A lost success response can leave an undiscovered publication; the CLI does not automatically retry. Credentials still grant project-wide mutation access. A total-storage cap, reconciliation of abandoned objects, and separately revocable credentials remain follow-up work.
