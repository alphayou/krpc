# Conventions & Checklists (Agent Reference)

## Toolchain

- **Runtime & package manager**: Bun (`bun install`, `bun test`, `bun check`, `bun run`).
- **TypeScript 7**: `bun check` (mapped to `bun run typecheck`). Key `tsconfig.json` flags:
  - `strict: true`
  - `noUncheckedIndexedAccess: true`
  - `verbatimModuleSyntax: true` (always use `import type` for type-only imports)
  - `noImplicitOverride: true`
  - `noFallthroughCasesInSwitch: true`
- **Tests**: `bun test` / `bun run test:coverage` (`bunfig.toml` sets `root = "tests"`). Include `@ts-expect-error` negative assertions in `tests/types.test.ts` for type-level constraints.
- **Bundling**: `tsdown` ESM-only builds with `.d.mts` declarations, sourcemaps, and `treeshake: true` (`dist/`). Subpath entry points: `.` (`krpc`), `./http` (`krpc/http`), `./ws` (`krpc/ws`), `./bun` (`krpc/bun`), `./stream` (`krpc/stream`), `./stdio` (`krpc/stdio`), and `./port` (`krpc/port`).

## Formatting & Style

- Enforced by Prettier (`.prettierrc`) and Husky + `lint-staged`:
  - 2 spaces, no tabs
  - Single quotes
  - No semicolons
  - ES5 trailing commas
  - LF line endings
- All identifiers, comments, TSDoc, and documentation must be in concise, idiomatic English.
- **TSDoc on public API**: Every exported function, class, type, interface, and public field must have crisp, concise TSDoc for IDE hover and `.d.mts` consumers. Keep internal code self-documenting—avoid redundant inline comments explaining obvious logic.

## Documentation Boundary

- Top-level `docs/guide.md`, `docs/transports.md`, and `docs/protocol.md` are **strictly library-user-facing**. Keep them concise, example-first, and free of internal planning memos or roadmaps.
- Agent/maintainer notes belong under `docs/agents/`.

## File Safety & Git Hygiene

- Use `trash <path>` instead of `rm` when removing files.
- Follow Angular / Conventional Commits: `<type>(<scope>): <short summary>`.
  - Types: `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.
  - Scopes: `protocol`, `service`, `server`, `client`, `peer`, `http`, `ws`, `bun`, `stream`, `stdio`, `port`, `types`, `docs`.

## Verification & Publishing Checklist

Before handing off or publishing:

1. Run `bun run verify && bun run test:coverage && bun run build && bunx publint --strict`.
2. Verify `package.json` metadata (`description`, `license: "MPL-2.0"`, `author`, `keywords`, `repository`, `homepage`, `bugs`, `sideEffects: false`, `exports`, `publishConfig.access: "public"`).
3. Ensure `dist/` contains only expected ESM `.mjs` and `.d.mts` artifacts and zero runtime or peer dependencies in `package.json`.
