# AGENTS.md

`krpc` is a type-safe, zero-dependency JSON-RPC 2.0 library for TypeScript built on pure Web Standard APIs.

## Toolchain (Bun-first)

- Use `bun install`, `bun run <script>`, `bunx <pkg>`, `bun test`, and `bun check` instead of `npm`, `node`, `jest`, `vitest`, or `tsc`.
- Quick commands:
  - `bun run verify` — format check, typecheck, and tests
  - `bun run test:coverage` — test suite with coverage (`tests/`)
  - `bun run build` — build ESM + `.d.mts` bundles via `tsdown`
  - `bun run format` — format files with Prettier

## Core Rules

- **KISS**: Keep code, APIs, tests, and docs minimal, transparent, and readable (antfu-style clarity). Avoid unnecessary abstractions or wrappers.
- **Zero-dep Web Standard `src/`**: `src/` must have zero runtime dependencies and use only ESNext / Web Standard APIs (no Bun-only or Node-only APIs). `tests/` may use `bun:test` and `Bun.serve`.
- **English only**: Write all code comments, JSDoc, docs, and commits in crisp English.
- **Safe deletion**: Use `trash` instead of `rm` when deleting files.

## Reference Index

Read on demand — do not duplicate these docs here:

- **Agent reference**:
  - [docs/agents/architecture.md](./docs/agents/architecture.md) — module map, boundaries, and type-level invariants
  - [docs/agents/conventions.md](./docs/agents/conventions.md) — toolchain, formatting, testing, commit, and publish checklist
- **User documentation** (keep strictly consumer-facing):
  - [docs/guide.md](./docs/guide.md) — API usage guide
  - [docs/transports.md](./docs/transports.md) — built-in and custom transports
  - [docs/protocol.md](./docs/protocol.md) — JSON-RPC 2.0 compliance reference
  - [examples/](./examples/) — runnable end-to-end examples
  - [CONTRIBUTING.md](./CONTRIBUTING.md) — contributor workflow
