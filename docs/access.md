# Publishing access

Noah manually provisions each user. There is no public signup. Each user can publish files and replace or delete their own publications. Viewing published links remains public.

The existing owner token in `~/.config/rune/token` manages access. Keep it private. Send a user only their individually issued token. Management commands use `RUNE_TOKEN` or the normal token file, so run them with the owner credential.

## Provision a user

From this repository:

```sh
pnpm build
mkdir -p ~/.config/rune/issued
./dist/cli.js users create alice --token-file ~/.config/rune/issued/alice.token
./dist/cli.js users list
```

The command creates the token file with permissions `0600` and refuses to overwrite an existing file. It prints the file location, never the token. Send the file's contents privately to that user. Rune stores only the token's hash and cannot retrieve the original token later.

Choose a user ID for one specific person, starting with a lowercase letter and containing only lowercase letters, digits, or hyphens, at most 48 characters. `owner` is reserved. Treat IDs as permanent identities; do not rotate an existing person's ID for a different person, because the new token would manage the original person's publications.

## Rotate or revoke access

```sh
./dist/cli.js users rotate alice --token-file ~/.config/rune/issued/alice-rotated.token
./dist/cli.js users revoke alice
./dist/cli.js users list --json
```

Rotation invalidates the old token. Revocation blocks subsequent authenticated requests without deleting files or breaking public links. Requests already authorized can finish. Rotating a revoked user's token explicitly reactivates that user, including access to their existing publications. The owner credential cannot edit another user's publications.

Token issuance is not automatically retried. If a request fails after reaching Rune, the token may have changed. Rotate the same user into a new file to recover. Access updates can also return `409` on a concurrent change or `503` during storage contention; inspect the current state before retrying.

## Recipient setup

The recipient saves the issued token at `~/.config/rune/token`, with permissions `0600`, or configures `RUNE_TOKEN`. They can use the CLI if installed, or the HTTP API without access to this private repository:

```sh
curl --fail-with-body \
  'https://api.rune.page/uploads?filename=report.html' \
  -H "Authorization: Bearer $(cat ~/.config/rune/token)" \
  -H 'Content-Type: text/html' \
  --data-binary @report.html
```

Point their agent at `https://rune.page/llms.txt` for publishing and replacement instructions. Each user has the same file-format support and shares the project-wide limits of 100 new-publication reservations and 1 GB of source uploads per UTC day. There is no per-user quota or expiry.

## Storage and recovery

Access records are private objects under `control/users/` in the same R2 bucket as publications. Do not delete or restore old access records: deleting loses the user identity, and restoring can reinstate an older credential. A revoked record is retained deliberately. The Worker secret remains the recovery authority for issuing or revoking user credentials.

Existing publications without an owner field belong to the original owner. They do not need to be rewritten. New and replaced publications store the stable user ID in private metadata. User ownership does not change the public URL.
