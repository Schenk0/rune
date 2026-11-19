# Rune version-one contract

Rune stores one file per publication. The publication ID remains stable when its file is replaced.

## Hosts

The hosts below describe rune.page. Self-hosted instances set their own hosts through `API_HOST`, `PUBLIC_DOMAIN`, and `PUBLIC_ORIGIN`; see [self-hosting](self-hosting.md).

- `rune.page` serves the static landing page and `/llms.txt` agent instructions without upload credentials or R2 access. `www.rune.page` redirects to the canonical host, preserving the path and query. Both support GET and HEAD.
- `api.rune.page` accepts authenticated mutations.
- `<id>.rune.page` serves public files.
- New IDs use 12 random lowercase letters and digits, about 62 bits of entropy. DNS is case-insensitive, so uppercase would not add uniqueness. Existing 32-character hexadecimal IDs remain valid. Conditional creation prevents an ID collision from overwriting a file.

The R2 bucket stays private. Every public read passes through the Worker.

## Authentication

Authenticated requests use `Authorization: Bearer <token>`. The original Worker secret `UPLOAD_TOKEN` remains the owner credential, configured as `RUNE_TOKEN` on the owner's clients. It alone can provision and manage users. User credentials are manually issued, random 256-bit tokens, stored only as SHA-256 hashes in private R2 records at `control/users/<user-id>`. Authentication checks the record on each request; rotation or revocation blocks the old token on subsequent requests. Requests already authorized can finish.

Each publication records an `ownerId`. A credential can inspect, replace, or delete only its own publications, including the owner credential. Publications without an `ownerId` belong to the original owner, so existing files and URLs need no migration. The owner credential manages access, but does not override another user's publication ownership.

User IDs are stable, lowercase identifiers, at most 48 characters, beginning with a letter and containing letters, digits, or hyphens. `owner` is reserved. Revoked users retain their IDs and publications. Explicit rotation reactivates that same user and restores access to their publications; creating the same ID again is rejected.

Public reads require no authentication. Rune does not expose an upload listing.

### Owner-only access management

- `GET /users` lists user IDs, creation/update times, and optional revocation times. It never returns tokens or hashes. A truncated page includes a `cursor`; pass it as `?cursor=...` for the next page. The original owner is not a provisioned user and is omitted.
- `POST /users` with JSON `{ "id": "alice" }` provisions a user and returns HTTP `201` with `{ user, token }`. The token is returned once. Duplicate IDs return `409`.
- `POST /users/<id>/token` rotates a token, returning HTTP `200` with `{ user, token }`. It invalidates the previous token and reactivates revoked users.
- `DELETE /users/<id>/token` revokes access and returns `204`. Public links remain available. No publication is deleted.

All management responses use `Cache-Control: no-store`. User credentials receive `403` on these endpoints; invalid credentials receive `401`. Concurrent access changes use conditional writes and return `409` on conflict. Storage or record-validation failures fail closed with `503`. Token issuance is not idempotent; if a success response is lost, rotate the user's token to recover. There is no token retrieval endpoint. See [access management](access.md) for the owner workflow.

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
- HTML renders with inline styles and scripts inside a CSP sandbox without same-origin storage, network fetches, forms, frames, external assets, or sandbox download permission. New-tab links and popups are permitted; their destinations do not inherit Rune's sandbox restrictions. This is isolation, not a guarantee against every possible top-level navigation.
- HTML viewing with `?iframes=1` opts into local frames: `frame-src 'self' data: blob:` and sandbox `allow-same-origin`. This enables parent/srcdoc DOM access and publication-origin storage. Each publication has its own origin. External frames, network fetches, forms, downloads, and top navigation remain restricted. The opt-in has a distinct viewer ETag; `/raw` and non-HTML responses keep their original policies.
- Markdown renders once during authenticated publication, with GFM tables and task lists. Embedded HTML is escaped. Rendering accepts at most 64 KiB and 2,048 non-letter/non-number/non-space characters, including newlines, with a 512 KiB output cap. Larger or denser inputs and parser errors fall back to plain text. These conservative guards reduce parser exposure, not prove a universal memory bound. Public reads never parse Markdown. Legacy Markdown stays plain text until republished.
- Plain text, JSON, CSV, XML, and other text formats display as text. PDF uses the browser's native viewer where supported.
- Unsupported binary formats, including ZIP, display their type, size, and a hexadecimal preview of at most 4 KiB. Rune never requests an attachment download; browser settings and format support can still affect native PDF or media handling.
- `/raw` serves original image, media, and PDF bytes, or plain text source for text formats. Unsupported binary formats still show the bounded preview.
- Single byte ranges apply to original bytes. Unsatisfiable ranges return `416`; stale `If-Range` values return the full response. Rendered viewers ignore range requests.

## Resource controls

- Public reads are limited to 240 requests per minute per client IP, before R2 access. Authenticated mutations share 30 requests per minute, before publication or access-record writes. Rejections return `429` and `Retry-After: 60`. Cloudflare rate limits are approximate and per location, not a global request or billing budget.
- User-token authentication attempts are limited to 240 per minute per client IP before reading credential records. Authenticated mutation throttling happens after credential lookup, before publication or access-record writes. Access management consumes the shared mutation rate limit, but not the daily upload budget.
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
rune replace report.html
rune replace https://<id>.rune.page/ report.html
rune delete https://<id>.rune.page/
```

The default publish output is only the public URL, which makes it suitable for agents. Add `--json` to create and replace commands for the full API response.

After a successful HTML upload, the CLI saves the stable URL in the local file's `<meta name="rune-url" content="...">` tag. `rune replace <html-file>` reads that tag and fetches the current API ETag before uploading. It rejects missing or ambiguous tags and URLs outside the configured public origin before making an API request. The explicit target form works for all formats and updates the local HTML tag to the returned URL.

Publishing always creates a new publication, even for HTML with an existing tag. The CLI updates the local tag after success, without an extra upload; the hosted copy may not contain that annotation until the next content update. Existing correct tags are left untouched. Tags are read from the document head, preserving the rest of the source when inserting or changing them. No separate metadata file, saved ID, or saved ETag is needed. Non-HTML files remain unchanged.

If saving the local HTML tag fails after a successful upload, the CLI still prints the successful result and exits successfully, with a warning to use the returned URL for explicit replacement. Upload failures never modify the local file.

## Deferred

Rune has manually provisioned users, with no public signup, login UI, public directory, dashboard, folders, search, editor, version history, or MCP server. It does not extract archives or convert office documents; those formats show a byte preview.

Create requests are not idempotent. A lost success response can leave an undiscovered publication; the CLI does not automatically retry. A total-storage cap, reconciliation of abandoned objects, and per-user upload budgets remain follow-up work. All users share the existing global upload budget.
