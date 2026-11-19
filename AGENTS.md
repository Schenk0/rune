# Rune

Before changing publication behavior, read `docs/design.md` and `docs/v1-contract.md` for product boundaries and the HTTP/security contract. Read `docs/self-hosting.md` before changing deployment configuration.

Noah owns this project. Keep solutions simple and match ceremony to the task.

## Implementation

- Prefer TypeScript and inferred types. Avoid `any` and casting-only wrappers.
- Use pnpm if JavaScript tooling is introduced. Add frameworks and dependencies only when they solve an actual requirement.
- Keep abstractions small. Focus tests on meaningful behavior, especially public serving, authenticated mutations, URL stability, and HTML isolation.
- Keep comments and documentation consistent with the implementation.
- Use a single agent for ordinary tasks. Reserve delegation for breadth or independent review, and state file ownership before parallel edits.

## Design

- Default to text and Markdown for ordinary answers. Use inline HTML only for compact conversational visuals that materially improve understanding. Publish standalone reports, media, calculators, complex diagrams, and all UI mocks through Rune; return a link and brief summary. Provide both inline rendering and publication only when asked, and honor explicit format requests.
- Implement routine UI edits directly. Create UI mocks when requested or when substantially different design directions need a decision.
- Noah prefers very dark gray backgrounds, white primary text, dense information, minimal copy, and little decorative card or pill chrome. Avoid em dashes and light-gray subtitle lines above sections.
- Avoid continuously repainting animations such as pulse, shimmer, blur, and spinners.

## External changes

- Public viewing is intentional. Uploads and administrative changes require authentication, as specified in `docs/v1-contract.md`.
- Never touch production, live databases, or daily-driver build/preview channels without explicit authorization. Name the target before an authorized operation.
- Repository work does not authorize deployment, DNS changes, publication of private material, or migration from other publishing services.
- Be careful with destructive actions that Noah has not requested.

## Pull requests

If Noah asks for GitHub delivery, use a real PR rather than a draft and rebase onto the latest `main` before opening it. Keep the title and description simple, follow established repository conventions, and end the description with the model and harness used. Sign PR comments with `This is Noah's agent. (model)`, replacing `model` with the actual model name. Merge only when the request authorizes it; otherwise report and ask.
