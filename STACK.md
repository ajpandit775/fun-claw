# Fun Claw — Tech Stack

All decisions below are locked. Do not propose alternatives unless an item below is impossible. If you must deviate, flag it explicitly with `[v2-or-never]` and a one-line rationale.

## Runtime and language

- **Language:** TypeScript 5.x in strict mode.
- **Runtime:** Node.js 22 LTS (active LTS through 2027-04-30). CI also tests Node 24 LTS.
- **Module format:** CommonJS output. Reason: Node SEA in Node 22 only supports CJS. Source files use ESM imports; tsup compiles to CJS.

## Package management

- **Package manager:** pnpm 10.x, pinned via Corepack. Root `package.json` declares `"packageManager": "pnpm@10.x.y"`.
- **Workspace:** pnpm workspace with five packages (see `REQUIREMENTS.md` for layout). Internal deps declared as `"@funclaw/core": "workspace:*"`.
- **Lockfile:** `pnpm-lock.yaml`, committed.
- **Forbidden:** npm, yarn (classic or berry), bun. Do not propose them.
- **Lifecycle scripts:** `npm install --ignore-scripts` policy with explicit allow-list for known-good scripts.

## Build

- **Bundler:** tsup 8.x (wraps esbuild).
- **Build target:** Node 22, CommonJS only, dual platform (linux+darwin+win32).
- **Externalize:** `dockerode`, `@modelcontextprotocol/sdk`, all `@anthropic-ai/sdk`, `openai`, `@google/genai`. These ride along as runtime deps.
- **Type emission:** `dts: true` for downstream consumers; declarations validated with `@arethetypeswrong/cli` in CI.
- **Forbidden:** webpack, rollup directly, parcel.

## Testing

- **Framework:** Vitest 4.1.x.
- **Property-based:** fast-check.
- **HTTP mocking:** MSW (`msw/node`) for unit-layer fetch interception.
- **Recorded fixtures:** nock, integration layer only.
- **Real Docker testing:** testcontainers-node, Linux runners only.
- **Coverage tool:** Vitest's built-in `v8` coverage. Targets: 85% on `src/core/**`, 70% on `src/adapters/**`.
- **Forbidden:** Jest, Mocha, Tape.

## Lint and format

- **Tool:** Biome 2.x (single tool replacing ESLint and Prettier).
- **Config:** `biome.json` at root with workspace-aware overrides.
- **Forbidden:** ESLint, Prettier, dprint. Do not introduce.

## Logging

- **Library:** pino 9.x for structured JSON logging.
- **Pretty printing:** pino-pretty 11.x for TTY output.
- **Default level:** `info`. Flags: `--debug` (`debug`), `--trace` (`trace`), `--quiet` (`warn`).
- **Redaction paths:** `apiKey`, `api_key`, `Authorization`, `authorization`, `token`, `Bearer\s+\S+`, `*.apiKey`, `*.token`, all `env.ANTHROPIC_API_KEY`, `env.OPENAI_API_KEY`, `env.GOOGLE_API_KEY`, `env.GITHUB_TOKEN`, `env.AWS_*`. With `remove: true`.
- **Forbidden:** winston, bunyan, console.log in library code.

## Configuration

- **Library:** cosmiconfig 9.x for config discovery.
- **Configuration files:** `.json`, `.js`, `.cjs`, `.mjs` supported via cosmiconfig. TypeScript config files are deferred to v2; use `.mjs` with type imports if type-checked config is desired.
- **OS-correct paths:** env-paths 3.x. Linux: `$XDG_CONFIG_HOME/funclaw/`. macOS: `~/Library/Application Support/funclaw/`. Windows: `%APPDATA%\funclaw\Config\`.
- **TOML parser:** smol-toml ^1. Smaller, faster, and actively maintained relative to `@iarna/toml`. Forbidden: `@iarna/toml` (legacy, slow).
- **Format:** TOML for human-edited config, JSON for machine state.
- **Validation:** Zod 4.x schemas with `.strict()`.
- **Precedence:** CLI flags > env vars (`FUNCLAW_*`) > project config > user config > built-in defaults.

## LLM providers

- **Anthropic:** `@anthropic-ai/sdk` ^0.90. Use `messages.stream()` for streaming.
- **OpenAI + compatible:** `openai` ^5. Drives Together, Groq, OpenRouter, Ollama via `baseURL` override.
- **Google Gemini:** `@google/genai` ^1.48. The new unified SDK.
- **Forbidden:** `@google/generative-ai` (EOL November 30, 2025). Vercel AI SDK (`ai`). LangChain.js. These wrap providers in ways that hide useful provider-specific features.

## HTTP, streaming, schemas

- **HTTP client:** Native `fetch` (Node 22 ships undici). No axios, no got.
- **SSE parsing:** `eventsource-parser` ^3 with `EventSourceParserStream`.
- **Schema validation:** Zod ^4. Already a peer dep of MCP SDK.
- **YAML parser:** `yaml` (eemeli) ^2 with `maxAliasCount: 100` (do not raise) and `schema: 'core'` (rejects YAML 1.1 `No`/`Yes` boolean traps). Forbidden: `js-yaml` (legacy, billion-laughs vulnerable in default config).

## CLI and TUI

- **CLI parser:** commander ^14. Async actions, subcommands, paired with Zod for validation.
- **First-run wizard:** @clack/prompts ^1.2. Type-inferring, beautiful CLI prompts. Stable 1.x line. (Note: earlier 0.x line is no longer current; do not pin to ^0.10.)
- **Chat REPL:** ink ^5 with ink-text-input for streaming chat UI.
- **React (for ink only):** react ^18.3, react-dom ^18.3. **Do NOT use React 19 with ink 5.x** — known incompatibility (`Cannot read properties of undefined (reading 'ReactCurrentOwner')`). Wait for ink 6.x stable for React 19 support, which is post-v1. The agent loop, provider code, and everything else are React-version-agnostic; this constraint applies only to the CLI TUI package.
- **Forbidden:** yargs, minimist, inquirer (heavier alternatives).

## Async primitives

- **Concurrency cap:** p-limit ^6.
- **Retry:** p-retry ^6.
- **Timeout:** p-timeout ^6.
- **Forbidden:** rxjs (overkill), bottleneck (heavier than p-limit).

## Subprocess

- **Library:** execa ^9. Cross-platform argv quoting, AbortSignal cancellation.
- **Forbidden:** raw `child_process.exec` with strings. Always use `spawn` with argv arrays. Semgrep rule blocks the alternative.

## Docker

- **Library:** dockerode (latest). Native named-pipe support on Windows, structured errors, container `exec` first-class.
- **Forbidden:** spawning the docker CLI as a subprocess. Use the Docker Engine API directly via dockerode.

## MCP

- **SDK:** `@modelcontextprotocol/sdk` v1 track, ^1.29. Stable; v2 still pre-alpha as of April 2026.
- **Transports:** Streamable HTTP (default for remote), stdio (default for local), SSE (deprecated but supported during 2025-2026 transport churn).

## File operations

- **Locking:** proper-lockfile ^4. Pure JS, NTFS-correct, works over 9p and APFS. Forbidden: `flock` (Unix only).
- **Atomic writes:** temp file + rename pattern, with proper-lockfile advisory lock around the operation.

## CI/CD

- **Provider:** GitHub Actions.
- **Matrix:** `ubuntu-24.04`, `macos-14`, `windows-2022` × Node 22 + Node 24. Linux-only for integration tests with Docker.
- **Action pinning:** every third-party Action pinned by full 40-character SHA. Tag-pinning is forbidden after the March 2026 Trivy supply-chain incident.
- **Dependabot:** enabled with `package-ecosystem: github-actions` and grouped PRs to keep SHAs current.
- **Release tool:** Changesets (`@changesets/cli` + `changesets/action`).
- **Publish:** `npm publish --provenance` from a GitHub-hosted Ubuntu runner with `id-token: write` permission.
- **Security scanning:** pnpm audit, OSV-Scanner v2, Semgrep with `p/typescript p/owasp-top-ten p/nodejs`, gitleaks, GitHub CodeQL with `security-extended`, Trivy on the runtime Docker image.

## Distribution

- **Primary:** npm (`npm install -g funclaw`, `npx funclaw`). `engines.node: ">=22"`.
- **Secondary (preview):** Node SEA single-file binaries for darwin-x64, darwin-arm64, linux-x64, linux-arm64, win32-x64. Marked experimental in the README.
- **Tertiary:** Docker image at `ghcr.io/funclaw/funclaw`. Multi-arch via Buildx.
- **Deferred to v1.1+:** Homebrew tap, Scoop bucket, winget manifest. Out of scope: AUR, .deb, .rpm.

## Auth and secrets

- **API key sources:** env vars first, then `~/.funclaw/keys.json` (chmod 0600 enforced on POSIX). Forbidden: hardcoding keys, including keys in version control, including keys in error messages or logs.
- **Code signing for binaries:** out of scope for v1.

## What goes in the runtime sandbox image

- **Base:** `ubuntu:24.04`.
- **Packages:** Node 22, Python 3.12, curl, git, jq, ripgrep, build-essential, tini.
- **PID 1:** tini (correct signal forwarding inside container).
- **User:** non-root `agent` user, UID 10001, GID 10001.
- **Image registry:** `ghcr.io/funclaw/runtime:0.x-noble`.
- **Pull policy:** on first run via dockerode `createImage` with `followProgress`. Never bundle into npm package.

## Forbidden anywhere in the codebase

- Native (node-gyp) dependencies. Audit all transitive deps; reject anything requiring Visual Studio Build Tools, Python on PATH, or `windows-build-tools`. Pure-JS substitutes only: `bcryptjs` not `bcrypt`, `@napi-rs/keyring` not `keytar`, Node 22 built-in `node:sqlite` not `better-sqlite3`. CI fails build if `.node` files appear in `dist/`.
- `console.log` in library code. Use the pino logger.
- `child_process.exec(string)`. Use `execa` with argv arrays or `spawn(argv[])`.
- `--shell` in spawn options.
- `eval`, `new Function(string)`, `vm.runInNewContext` with untrusted input.
- Mounting `/var/run/docker.sock` into any container Fun Claw spawns.
- `--privileged`, `--pid=host`, `--network=host` in any container Fun Claw spawns. Defensive check refuses to honor user config that contains these.
- Telemetry of any kind.
