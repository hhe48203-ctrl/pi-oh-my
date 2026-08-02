# Repository Guidelines

## Project Structure & Module Organization

This Bun/TypeScript repository bundles extensions for the Pi coding agent. Root `index.ts` registers the bundle. Features live under `packages/<feature>/`; most expose `index.ts`, `package.json`, and an adjacent `index.test.ts`. Shared rendering is in `packages/tool-render.ts`, subagent helpers in `packages/subagent/`, and benchmarks in `scripts/`. Keep feature code and tests together.

## Build, Test, and Development Commands

- `bun install` installs dependencies from `bun.lock`.
- `bun test` runs the complete Vitest suite once.
- `bun run test:watch` reruns tests while files change.
- `bun run bench:subagents --iterations=1 --prompt="Reply exactly: OK"` measures subagent startup behavior.
- `pi install "$PWD"` installs the full bundle locally; restart Pi or run `/reload` after changes.

There is no separate build step: Pi loads the TypeScript entry points directly.

## Coding Style & Naming Conventions

Use ESM TypeScript with explicit `.ts` extensions for local imports. Follow the existing source style: tabs, semicolons, double quotes, and trailing commas in multiline constructs. Use `camelCase` for functions and variables, `PascalCase` for types and interfaces, `UPPER_SNAKE_CASE` for constants, and kebab-case package directories. Keep logic simple, explicit, and easy to read. Prefer Node built-ins and existing helpers over new dependencies or speculative abstractions. No formatter or linter is configured, so match nearby code.

## Testing Guidelines

Vitest discovers `packages/**/*.test.ts` in the Node environment. Place tests beside the implementation and name them `<module>.test.ts`. Add focused regression coverage for bug fixes, especially tool input validation, lifecycle behavior, and filesystem effects. Use temporary directories for file-mutating tests and clean them in `afterEach`. No coverage threshold is enforced; prioritize observable behavior and failure paths. Run `bun test` before submitting.

## Commit & Integration Guidelines

Use Conventional Commits: `fix: ...`, `feat(scope): ...`, `refactor: ...`, and `docs: ...`. Keep one logical change per commit and write imperative subjects. After the full test suite passes, fast-forward completed work into `main` and push `main` directly. Do not commit generated output, logs, coverage, `.pi/`, `node_modules/`, or local `progress.md`.

## Development Notes

Record every repository change in local `progress.md`; it is ignored and must never be staged or committed. Use `pi` freely for end-to-end testing and inspect local logs when diagnosing behavior. The local API key is already configured; never print or commit credentials. Change architecture only when a simpler local change cannot solve the current requirement.
