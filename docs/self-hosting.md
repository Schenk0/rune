# Self-hosting

You need a Cloudflare account with Workers and R2, and a dedicated domain or zone managed by Cloudflare. Use a domain that does not carry other applications' cookies or private content. Public uploads run scripts, and iframe mode permits same-origin access within one publication.

The tracked `wrangler.jsonc` includes the hosted rune.page deployment and a separate local environment. `pnpm dev` selects the local environment and has no production routes. For your own instance, use `wrangler.deploy.example.jsonc` as a template instead of deploying Rune's top-level configuration.

## Configure your instance

1. Install dependencies with `pnpm install --frozen-lockfile` and run `pnpm check`.
2. Copy `wrangler.deploy.example.jsonc` to `wrangler.deploy.jsonc`. This filename is ignored by Git. Choose a unique Worker name and R2 bucket name. Replace all `example.com` values with your own dedicated domain.
3. Set `API_HOST` to `api.<domain>`, `PUBLIC_DOMAIN` to `<domain>`, and `PUBLIC_ORIGIN` to `https://<domain>`. Keep upload IDs immediately below the domain, so a wildcard certificate covers them. Keep the binding names `BUCKET`, `READ_LIMITER`, and `WRITE_LIMITER` unchanged. Choose unused numeric rate-limit namespace IDs in your account if the example IDs are already in use.
4. Sign in with `pnpm exec wrangler login`, then create your private bucket with `pnpm exec wrangler r2 bucket create <your-bucket-name>`. Do not enable public bucket access or add a direct bucket domain.
5. In Cloudflare DNS, create proxied apex and wildcard records for `<domain>` and `*.<domain>`. A Worker-only zone can use `AAAA` records with the reserved value `100::`. The wildcard covers the API host and all publication hosts. Confirm that TLS is active for the apex and first-level subdomains.
6. The template has Worker routes for `<domain>/*` and `*.<domain>/*`. Use wildcard routes, not a wildcard Worker Custom Domain. Ensure another Worker is not already handling these routes.
7. Generate a long random owner token locally. Store a private client copy with permissions `0600`, then set the Worker secret with `pnpm exec wrangler secret put UPLOAD_TOKEN --config wrangler.deploy.jsonc`. Enter the token at Wrangler's prompt, never in source or a command argument. If Wrangler asks to create the configured Worker for the secret, verify its name before accepting.
8. Deploy with `pnpm exec wrangler deploy --config wrangler.deploy.jsonc`. This changes the Worker, bucket binding, and routes in your account. Check the target account, Worker, bucket, and domain before running it.

Cloudflare setup references: [Worker routes](https://developers.cloudflare.com/workers/configuration/routing/routes/), [DNS records for Workers](https://developers.cloudflare.com/dns/manage-dns-records/how-to/create-dns-records/#originless-setups), [R2 bindings](https://developers.cloudflare.com/r2/api/workers/workers-api-usage/), and [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/).

The homepage and `/llms.txt` use your configured public and API origins. The `www` hostname redirects to `PUBLIC_ORIGIN`. The server does not provision DNS, TLS, billing alerts, WAF rules, or backups for you.

## Configure clients and verify

Set `RUNE_API_URL=https://api.<domain>` and save the owner credential at `~/.config/rune/token` with permissions `0600`, or set `RUNE_TOKEN_FILE` to its location. If your API uses a different hostname layout, also set `RUNE_PUBLIC_ORIGIN=https://<domain>`.

Run `pnpm build`. Publish a disposable text file with `./dist/cli.js publish <file>`, open the returned URL without credentials, replace it at the same URL, then delete it. Confirm that an unauthenticated request to an API mutation returns `401`. Verify HTML sandbox behavior with `test/fixtures/sandbox.html` before accepting untrusted content.

Use [access management](access.md) to provision other users. Share their individual tokens privately; the owner token manages every user's access. User quotas are global, so provision only users you trust with the shared budget.

Check your account's current [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [R2 pricing](https://developers.cloudflare.com/r2/pricing/). Ingestion limits do not cap storage or public-read costs. Rune has no automatic expiry or content backup.
