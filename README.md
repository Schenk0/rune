# Rune

Rune publishes files produced by agents at stable public URLs. It supports HTML, Markdown, images, audio, video, PDF, and text. Replace a publication without changing its link.

The server is a TypeScript Cloudflare Worker backed by a private R2 bucket. Each publication has its own hostname. Viewing is public; publishing, replacement, deletion, and user management require credentials.

## Local development

Use Node.js 22 or later and the pnpm version in `package.json`.

```sh
pnpm install --frozen-lockfile
cp .dev.vars.example .dev.vars
pnpm dev
```

Choose a local development token in `.dev.vars`. The tracked Wrangler configuration uses local storage, localhost URLs, and no public routes.

```sh
export RUNE_TOKEN='replace-with-your-local-development-token'
curl --fail-with-body \
  -H "Authorization: Bearer $RUNE_TOKEN" \
  -H 'Content-Type: text/plain' \
  --data-binary @notes.txt \
  'http://localhost:8787/uploads?filename=notes.txt'
```

Set `RUNE_TOKEN` to the same value as `UPLOAD_TOKEN` in `.dev.vars`. Open the returned `http://<id>.localhost:8787/` URL. If changing the local port, update `PUBLIC_ORIGIN` in the local Wrangler environment too.

Run typechecking, Worker tests, and CLI subprocess tests with `pnpm check`.

## CLI

```sh
pnpm build
export RUNE_API_URL='http://localhost:8787'
./dist/cli.js publish report.html
./dist/cli.js replace report.html
```

The CLI saves a publication's URL in a `rune-url` meta tag in the local HTML file. Preserve the tag when editing to replace the same link. For other formats, use `./dist/cli.js replace <url> <file>`.

Credentials come from `RUNE_TOKEN`, `RUNE_TOKEN_FILE`, or `~/.config/rune/token`. Keep credential files private with permissions `0600`. The CLI defaults to `https://api.rune.page`; set `RUNE_API_URL` for your own instance. `RUNE_PUBLIC_ORIGIN` overrides the inferred public origin when the API and publication domains differ from the usual `api.<domain>` layout.

## Host your own instance

Follow [self-hosting](docs/self-hosting.md) to configure your domain, private bucket, and owner credential. Source availability does not grant publishing access to the hosted instance at rune.page. Self-hosting incurs your own Cloudflare and domain costs.

Read the [design](docs/design.md), [HTTP and security contract](docs/v1-contract.md), [access management](docs/access.md), and [operations](docs/operations.md). Agent instructions are available at `/llms.txt` on each instance.

Rune has no public signup, dashboard, or per-user quota. All users share daily upload budgets. Files do not expire automatically, and there is no built-in backup of uploaded content. See [security](SECURITY.md) and [contributing](CONTRIBUTING.md).

## License

[MIT](LICENSE). Dependencies retain their own licenses. The repository remains marked `private` in `package.json` to prevent accidental npm publication.
