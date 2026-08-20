# Pho Agent

Reusable, headless harness primitives for Pi-based products.

Pho Agent owns product-neutral protocol values, Pi session/runtime lifecycle, reviewed feature modules, and deterministic harness evaluation. It does not depend on Pho Code, Electron, React, workspace/Git product policy, or a renderer.

## Packages

- `@pho-agent/protocol` — opaque scope/session/run contracts, JSON safety, errors, and reusable Plan, skills, and GitHub MCP values.
- `@pho-agent/runtime` — pinned Pi services, session lifecycle, feature composition, Plan/ask-user/todo, skills, context-prompt hook, and reviewed GitHub MCP lifecycle.
- `@pho-agent/evals` — versioned fixtures, append-only result records, deterministic scoring, fingerprints, and cohort separation.

## Development

```bash
bun install
bun run typecheck
bun run lint
bun test
```

The runtime pins Pi SDK `0.84.1`. Consumers should include `packages/*` from this repository in their workspace and depend on the required `@pho-agent/*` packages with `workspace:*`. When consumed as a Git submodule, the parent repository owns the exact gitlink revision.

Pho Agent provides harness mechanics, not product policy. Consumers retain their own identity mapping, data roots, resource selection, credential/UI policy, filesystem authority, and application-specific tools.
