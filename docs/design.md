# Design

Rune publishes agent-produced files so they remain accessible after the producing machine goes offline. The service returns stable public links, including HTML documents with limited interactivity and media that browsers can display directly.

## Product boundaries

- Public viewing needs no login. Anyone with a link can read its content; a random URL is not private access control.
- Each publication uses `https://<id>.<domain>/`. Replacement preserves the URL; deletion removes the publication.
- Publishing requires a credential. The instance owner provisions individually revocable users; each credential can mutate only its own publications.
- The server runs on Cloudflare Workers with a private R2 bucket. Source, derived previews, ownership, access records, and upload accounting live in R2.
- Uploaded HTML runs under a restrictive CSP sandbox on a per-publication origin. Credentials and administrative state stay separate from uploaded content.

The default is a small, manually administered service. Public signup, a dashboard, folders, search, a built-in editor, version history, an MCP server, and migration from other services are outside the current scope.

## Implementation contract

[The version-one contract](v1-contract.md) specifies routes, formats, ownership, sandbox behavior, cache validation, and resource controls. [Self-hosting](self-hosting.md) describes domain and bucket setup. [Operations](operations.md) covers recovery and limits.

New requirements should preserve URL stability and public viewing unless the task explicitly changes them. Authentication, HTML isolation, or resource-control changes need focused verification.
