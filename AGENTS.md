# Pho Agent contributor rules

- Keep dependency direction `consumer -> @pho-agent/* -> Pi`; never import a consumer product package.
- `@pho-agent/protocol` must remain JSON-safe and may not import Node or Pi.
- `@pho-agent/runtime` may import Node, Pi, and reviewed transport SDKs, but not Electron, React, renderer packages, Git/workspace product policy, or consumer data-root policy.
- `@pho-agent/evals` owns fixtures, schemas, fingerprints, and scoring. Keep evaluation cohorts and recorded results append-only after they are frozen.
- Construct Pi services only behind the runtime feature API and lifecycle seams. Do not reproduce Pi's agent loop, resource loader, or JSONL persistence.
- Preserve existing persisted custom-entry names and public tool names unless the owning consumer supplies and verifies a migration.
- Add focused tests for lifecycle, protocol bounds, and feature behavior. Run `bun run typecheck`, `bun run lint`, and `bun test` before publishing a revision.
