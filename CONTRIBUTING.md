# Contributing to krpc

Thanks for your interest in contributing to `krpc`!

`krpc` is a type-safe, zero-dependency JSON-RPC 2.0 library built on pure Web Standard APIs. Keeping the runtime small, predictable, and spec-compliant is our top priority.

## Design Principles

Before opening a pull request, keep these core constraints in mind:

- **Zero runtime dependencies**: `src/` must not depend on third-party packages. Standard Schema v1 interfaces are inlined directly.
- **Pure Web Standard APIs**: `src/` must remain portable across Bun, Node.js, Deno, Cloudflare Workers, and browsers. Do not use Bun-only or Node-only APIs inside `src/`.
- **Strict JSON-RPC 2.0 compliance**: Wire behavior and error codes follow the [JSON-RPC 2.0 Specification](https://www.jsonrpc.org/specification). See [docs/protocol.md](./docs/protocol.md).
- **Type-level ergonomics**: Public APIs should infer cleanly under TypeScript 7 without forcing manual type annotations or casts.
- **English everywhere**: Code comments, JSDoc, commit messages, and documentation must be written in clear, concise English.

## Prerequisites

- [Bun](https://bun.sh) (used as the package manager, test runner, and TypeScript checker)

## Local Setup

```bash
git clone https://github.com/alphayou/krpc.git
cd krpc
bun install
```

## Project Layout

```text
krpc/
├── src/
│   ├── index.ts          # "krpc" entry point
│   ├── http.ts           # "krpc/http" entry point
│   ├── ws.ts             # "krpc/ws" entry point
│   ├── bun.ts            # "krpc/bun" entry point
│   ├── stream.ts         # "krpc/stream" entry point
│   ├── port.ts           # "krpc/port" entry point
│   ├── protocol/         # JSON-RPC 2.0 types, guards, errors, Standard Schema v1
│   ├── service/          # defineService, defineMethod, defineNotify, defineContext, hooks
│   ├── server/           # createServer (dispatch, hooks, batching, error sanitization)
│   ├── client/           # createClient, createProxy
│   ├── peer/             # createPeer (full-duplex client + server + push notifications)
│   └── transports/       # memory, batch, http, ws, bun, stream, port transports
├── tests/                # Unit, integration, and compile-time type tests
└── docs/                 # User guide, protocol reference, and transport guides
```

## Scripts

| Command                 | Purpose                                         |
| ----------------------- | ----------------------------------------------- |
| `bun run dev`           | Watch and rebuild bundles with `tsdown`         |
| `bun run build`         | Build production ESM bundles and `.d.mts` files |
| `bun run typecheck`     | Typecheck the project (`bun check`)             |
| `bun test`              | Run the test suite                              |
| `bun run test:watch`    | Run tests in watch mode                         |
| `bun run test:coverage` | Run tests with coverage reporting               |
| `bun run format`        | Format all supported files with Prettier        |
| `bun run format:check`  | Verify formatting without modifying files       |
| `bun run verify`        | Run format check, typecheck, and tests          |

## Code Style & Formatting

Formatting is enforced by Prettier (`.prettierrc`) and checked automatically via Husky + `lint-staged` on commit:

- 2 spaces indentation
- Single quotes
- No semicolons
- ES5 trailing commas
- LF line endings

The TypeScript configuration enables `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, and `noImplicitOverride`. Make sure `bun run typecheck` exits with zero errors.

## Testing

- Unit and integration tests live under `tests/`, mirroring `src/` (configured via `bunfig.toml`).
- Compile-time type tests live in `tests/types.test.ts` and should include both positive inference checks and negative `@ts-expect-error` assertions when adding or changing type-level behavior.
- Always run the full verification suite before pushing:

```bash
bun run format:check && bun run typecheck && bun run test:coverage && bun run build
```

## Commit Convention

We follow the [Conventional Commits](https://www.conventionalcommits.org/) (Angular) specification:

```text
<type>(<scope>): <short summary>
```

Common types:

- `feat` — new user-facing capability or API
- `fix` — bug fix or spec compliance fix
- `docs` — documentation changes
- `refactor` — internal restructuring without behavior change
- `perf` — performance improvement
- `test` — adding or updating tests
- `build` — build system or bundle configuration
- `ci` — GitHub Actions or CI changes
- `chore` — routine maintenance

Common scopes: `protocol`, `service`, `server`, `client`, `peer`, `http`, `ws`, `bun`, `stream`, `port`, `types`, `docs`.

Examples:

```text
feat(ws): buffer frames sent while WebSocket is CONNECTING
fix(protocol): reject fractional numeric request ids
docs(transports): add custom BroadcastChannel transport guide
```

## Pull Requests

1. Fork the repository and create a branch from `main`.
2. Keep pull requests focused on a single concern.
3. Add or update tests and docs for any behavioral or API change.
4. Ensure all CI checks pass (`format:check`, `typecheck`, `test:coverage`, `build`).

## License

By contributing to `krpc`, you agree that your contributions will be licensed under the [Mozilla Public License 2.0](./LICENSE).
