# Contributing

Open an issue for a bug or a proposed change. Keep fixes focused and discuss larger product changes before implementing them. Read [the design](docs/design.md) and [HTTP/security contract](docs/v1-contract.md) when changing publication behavior.

Use the Node.js and pnpm versions specified in `package.json`. Install with `pnpm install --frozen-lockfile`, copy `.dev.vars.example` to `.dev.vars`, and run `pnpm dev` for local development. Run `pnpm check` before submitting a pull request. Add tests for meaningful behavior changes, especially ownership, URL stability, public serving, and HTML isolation.

Use local R2 storage and test credentials. Keep credentials, live publication URLs, account records, and personal documents out of commits and PR descriptions. Report security issues privately as described in [SECURITY.md](SECURITY.md).

Contributions are provided under the repository's MIT license. Dependencies keep their own licenses; run `pnpm licenses list --prod` when changing runtime dependencies.
