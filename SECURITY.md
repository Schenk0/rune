# Security

Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/Schenk0/rune/security/advisories/new) once enabled for this repository. If that option is unavailable, use the maintainer's contact information on their [GitHub profile](https://github.com/Schenk0). Do not post credentials, exploit details, or private publication content in a public issue. Reports are handled on a best-effort basis with no guaranteed response time.

Only the current default branch is maintained. There is no long-term support policy for older versions.

## Deployment boundaries

- Published content is public and has no expiry. URLs are shareable links, not authentication. Do not upload secrets or personal content you do not intend to share.
- Keep R2 private. Serve uploads through the Worker and use a dedicated publication domain, separate from applications that carry sensitive cookies.
- Owner and user credentials grant publishing access. The owner credential also manages user access. Rotate or revoke a credential if exposed; deleting it from Git alone is insufficient.
- Uploaded HTML can run inline JavaScript. Default sandboxing blocks same-origin storage, fetches, and forms. `?iframes=1` deliberately enables local frames, parent/child DOM access, and publication-origin storage. This is a broader policy and is not a general-purpose browser security boundary.
- Public-read traffic and accumulated storage can cost money. Global ingestion budgets are not billing caps, and Rune provides no automatic content backup.

Run `pnpm check` and review the [security contract](docs/v1-contract.md) when changing serving or authentication. Sandbox header tests do not replace browser security review.
