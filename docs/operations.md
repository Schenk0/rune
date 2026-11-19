# Operations

## Deploy and recover

Run `pnpm check` before deployment. Use your ignored `wrangler.deploy.jsonc` for deployment and secrets; see [self-hosting](self-hosting.md). Deployments are manual. There is no scheduled uptime workflow or automatic deployment.

Keep an independent private copy of deployment configuration and credentials. Git protects source, not uploaded files. Rune does not back up R2 automatically. Publication deletion is permanent.

The private R2 accounting object `control/upload-budget` must not be deleted or restored to an older revision while uploads are enabled; doing so resets daily containment. Private `control/users/` records contain credential hashes and revocation state. Restoring an old record can reinstate an old credential. Preserve revoked records so identities cannot be reused. See [access management](access.md).

Existing publications without an owner field belong to the original owner without migration. Replacements preserve publication URLs and ownership.

## Cost limits

Global daily budgets allow 100 new-publication reservations and 1,000,000,000 uploaded source bytes per UTC day. Replacements consume bytes. Failed uploads retain reservations and deletion does not refund them. These limits constrain ingestion, not accumulated storage or public reads. Uploaded files have no automatic expiry.

Configure billing alerts in your own Cloudflare account. Alerts warn about spend; they do not stop it. Check current platform limits and pricing for your plan. Rune has no total-storage cap or per-user budget.

## Optional edge filtering

An instance owner can block unknown paths at Cloudflare's edge before they invoke the Worker. Allow `/`, `/raw`, `/favicon.ico`, `/llms.txt`, and Cloudflare's own paths such as `/robots.txt` and `/cdn-cgi/`. On the API host, also allow `/uploads`, `/uploads/…`, `/users`, and `/users/…`. Add new routes to your edge rule before deploying them.

The Worker still validates credentials, ownership, methods, paths, and upload limits. Edge rules are separate account configuration and are not provisioned by this repository. Test publish, inspect, replace, read, and delete when changing a rule. Disable the edge rule to roll it back.

Cloudflare client-integrity checks can reject Python urllib's default User-Agent with HTTP 403 / error 1010 before Rune receives a request. A descriptive `User-Agent: Rune/1.0` avoids this known client-signature issue. An edge rejection is not necessarily an invalid upload token.

## HTML isolation

For a local browser sandbox check, publish `test/fixtures/sandbox.html` to your local instance. Inline scripts should run; fetch and storage should report blocked. Remote frames and form submission should be rejected.

`?iframes=1` opts HTML viewers into same-publication, srcdoc, data, and blob frames with parent/child DOM access. It also enables publication-origin storage. External frames, fetches, forms, and sandbox downloads remain restricted. Raw responses and non-HTML viewers keep their original policies. The iframe mode uses a separate viewer ETag. These checks supplement header tests; they are not a browser security audit.
