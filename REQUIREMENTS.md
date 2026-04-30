# Fun Claw — Requirements

## What this is

Fun Claw is a command-line autonomous AI agent that runs on your computer. It takes a goal in plain English, plans how to achieve it, and uses tools (running shell commands, reading and writing files, calling external services) to do the work. It runs all tool execution inside a Docker container so it cannot accidentally damage the host machine.

Fun Claw is one of many "Claws" in the 2026 ecosystem (OpenClaw, Hermes, NanoClaw, IronClaw, NanoBot, ZeroClaw, PicoClaw, NullClaw, TinyClaw). Fun Claw's positioning is "the easy Claw" — sensible defaults from across the ecosystem in one Apache 2.0 codebase. It does not try to be the best Claw on any single axis.

## Who uses it

**Primary user: developers who want to try a Claw with sensible defaults.** They have heard of AI agents, they want to use one, but they find the existing landscape confusing — too many similarly-named projects, security concerns about plugin marketplaces, hardware requirements for some Claws. They want a working agent they can install in five minutes, run safely, and read the source of if they want to.

**Secondary user: small teams adopting an AI agent for shared work.** A team of 2-10 developers who want one canonical Claw with safe defaults, where the team can author skills together, and where the underlying source is auditable.

**Out of scope as users:** enterprise users with regulated-industry compliance needs (they need a Trust Product, not Fun Claw), edge/IoT users (they need ZeroClaw/PicoClaw/NullClaw), users who want a personal AI agent that learns and remembers across sessions (they need Hermes).

## Core flows

**Flow 1: First install and setup.**
1. User installs Fun Claw via `npm install -g funclaw` or `npx funclaw`.
2. User runs `funclaw init` for the first-run wizard.
3. Wizard checks Docker is installed and running. If not, prints clear install instructions and exits with non-zero code.
4. Wizard prompts for LLM provider choice (Anthropic, OpenAI, Gemini, OpenAI-compatible).
5. Wizard prompts for API key (or detects existing environment variable).
6. Wizard pulls the runtime sandbox Docker image (one-time, ~2GB compressed).
7. Wizard writes config to OS-correct location (XDG on Linux, Library on macOS, AppData on Windows).
8. Wizard prints success message and points user to `funclaw chat`.

**Flow 2: Have a conversation with the agent.**
1. User runs `funclaw chat`.
2. Fun Claw starts a session, creates a sandbox Docker container, connects to the configured LLM provider.
3. User types a prompt.
4. Agent loop: send to LLM, receive response, if the response contains tool calls execute them in parallel inside the container, send results back to LLM, repeat until LLM is done.
5. Output streams to terminal as the LLM generates it.
6. User can continue conversation, interrupt with Ctrl-C, or exit cleanly.
7. On exit, Fun Claw tears down the sandbox container.

**Flow 3: Use a skill.**
1. User authors a skill: a directory containing `SKILL.md` with YAML frontmatter (name, description) and optional bundled scripts in `scripts/`, references in `references/`.
2. User places the skill in one of the resolution paths: `./skills/`, `./.funclaw/skills/`, or `~/.funclaw/skills/`.
3. User runs `funclaw chat`. At session start, Fun Claw reads frontmatter from every available skill and injects a compact `name: description` index into the system prompt.
4. During conversation, the LLM may decide to use a skill. It calls `read_skill(name)` to load the body, then `run_skill_script(name, script, args)` to execute the bundled script inside the sandbox container.
5. Skill output flows back to the LLM as a tool result.

**Flow 4: Use an MCP server.**
1. User configures an MCP server in `~/.funclaw/config.toml` (filesystem access, GitHub access, etc.).
2. On `funclaw chat`, Fun Claw spawns the MCP server as a subprocess (stdio) or connects over HTTP.
3. The MCP server's tools become available to the agent, namespaced as `mcp__<server>__<tool>`.
4. The LLM can call these tools alongside built-in tools and skill scripts.

**Flow 5: Spawn a subagent.**
1. During a conversation, the agent decides a sub-task should run in isolation (e.g., research a topic in parallel while continuing the main task).
2. Agent calls the `spawn_subagent(prompt, system?, tools?)` built-in tool.
3. Fun Claw creates a fresh sandbox container for the subagent, runs the same agent loop with a separate context window, returns the subagent's final answer to the parent as a tool result.
4. Subagent budgets: max depth 3, max concurrent subagents per parent 5, max input tokens 50,000, max iterations 15, wall-clock timeout 300s.

**Flow 6: Diagnose problems.**
1. User runs `funclaw doctor`.
2. Doctor checks Docker reachability, Node version, configured LLM endpoints, MCP server reachability, skill resolution paths, config file readability and permissions, orphan containers from previous crashes, log directory disk space.
3. Doctor prints a clear summary and exit code 0 (healthy) or non-zero (problem found).
4. `funclaw doctor --clean` removes orphan containers and stale temp directories.

**Flow 7: Have the agent write a skill for you.**
1. User notices they keep doing the same multi-step thing in conversation (e.g., "fetch the latest commits from these 5 repos and summarize").
2. User says to Fun Claw: "make this a skill so I don't have to explain it every time."
3. The agent uses its built-in file-write tools to create a skill directory in `~/.funclaw/skills/<name>/` containing `SKILL.md` (with proper frontmatter) and any helper scripts in `scripts/`.
4. The agent confirms what it wrote and where.
5. On the next session, the skill is loaded automatically and the user can invoke it by name or by description.
6. This is the dominant pattern for getting skills into Fun Claw. Users do NOT typically write skills by hand. They ask the agent to write them.

**Flow 8: Use an existing OpenClaw or other agentskills.io-format skill.**
1. User finds a skill written for OpenClaw, Claude Code, or any other agent that uses the agentskills.io standard format. This includes most skills in OpenClaw's ecosystem.
2. User copies the skill directory (containing `SKILL.md` and any scripts) into `~/.funclaw/skills/`.
3. Fun Claw loads it on the next session start. The skill works because the format is open and standard.
4. Caveat: the user is responsible for trusting the skill's source. Fun Claw does not include a malware scanner or skill verification system in v1. Container isolation limits blast radius if a skill is malicious, but does not prevent the skill from doing harmful things within the workspace mount.

## Non-functional requirements

**Performance.** Time-to-first-token after `funclaw chat` should be under 5 seconds (mostly LLM provider latency). Tool call dispatch overhead should be under 200ms on Linux/macOS, under 1s on Windows Docker Desktop. Agent loop should support 10,000+ turn conversations without memory leaks.

**Authentication.** API keys come from environment variables first (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`), with fallback to `~/.funclaw/keys.json` enforced at chmod 0600 on POSIX systems. Keys are never logged. Pino redaction covers all known key patterns.

**Deployment target.** Distributed via npm as the primary path (`npm install -g funclaw`, `npx funclaw`). Single-file binaries (Node SEA) attached to GitHub Releases as a preview path. Docker image at `ghcr.io/funclaw/funclaw` for users who prefer fully containerized execution.

**Supported platforms.** Linux x64 and ARM64, macOS x64 and ARM64, Windows 11 + WSL2 (recommended), Windows 11 native (supported but not recommended). All four cross-platform targets are required from v1.

**Telemetry, crash reporting, auto-update.** None. Zero in v1. This is a public commitment in the README.

## Hard constraints

- Must use Apache 2.0 license. No CLA. Inbound = outbound contribution model.
- Must use TypeScript on Node.js 22 LTS.
- Must use Docker as the sandbox. Docker is a hard requirement, not optional.
- Must use pnpm as the package manager. Pinned via Corepack.
- Must use Biome for linting and formatting (no ESLint, no Prettier).
- Must use Vitest for testing (no Jest).
- Must use the official Model Context Protocol TypeScript SDK (`@modelcontextprotocol/sdk`).
- Must support Anthropic, OpenAI, Gemini, and OpenAI-compatible providers from v1.
- Must support agentskills.io standard skill format from v1.
- Must work on Linux + macOS + Windows + WSL2 from v1.
- Must have zero native (node-gyp) dependencies. Pure JavaScript only. CI fails the build if any `.node` files appear in the dist output.
- Must pin every third-party GitHub Action by full 40-character SHA, never by tag.
- Must redact secrets from all log output. Pino redact paths cover known key patterns.
- Must not include any code, naming, or documentation that overlaps with the closed-source Solarates Trust Product. No mention of Misawite, Kalyani, TBIR, Three-Layer Verification, or attestation primitives anywhere in this codebase.

## Out of scope (deliberately, do not build)

These were considered and explicitly cut. If a feature in this list seems useful during the build, flag it as `[v2-or-never]` and route it elsewhere. Do not silently add it.

- Persistent cross-session memory. Hermes does this; Fun Claw does not.
- Self-improving skills loop (autonomous skill creation/editing). Hermes does this.
- ClawHub registry support, malware scanner, signed-skill curation. Big maintenance burden, wrong product.
- Plugin interfaces, memory backend abstractions, learning-loop hooks. Designing extension points is a five-meeting decision; we are shipping a Claw.
- Multi-platform messaging gateway (Telegram, Discord, Slack, WhatsApp). Hermes does this.
- Trust attestation, signing, receipts, hardware enclaves, TEE binding. Wrong layer; IronClaw lives there. The Solarates Trust Product is also separate from Fun Claw.
- RL training export, evolutionary skill optimization (DSPy/GEPA). Research-lab toys.
- Theory-of-mind user modeling (Honcho, Plastic Labs). Out of scope.
- Telemetry of any kind, opt-in or opt-out.
- Crash reporting (Sentry, etc.).
- Auto-update, update notifier.
- CLA / DCO requirement.
- Homebrew tap, Scoop bucket, winget manifest, AUR, .deb, .rpm. Deferred to v1.1+.
- Code signing for SEA binaries. Out of scope for v1.
- Web UI, browser extension, IDE plugin. Fun Claw is CLI only.
- Headless API mode for use as a service. CLI only in v1.
- Tor support, dark-web research capabilities (OnionClaw direction).
- Kernel-level security layers like Landlock, seccomp, OPA policies (NemoClaw/OpenShell direction). Linux-specific, breaks cross-platform commitment.

## Success criteria for v1.0.0

- A new user can go from `npm install -g funclaw` to a working agent conversation in under 10 minutes on a clean macOS, Linux, or Windows-WSL2 machine.
- All built-in tools execute inside the Docker sandbox. Zero tool execution paths bypass the sandbox.
- The codebase is under 10,000 lines of TypeScript, excluding tests.
- Test coverage is 85%+ on core modules, 70%+ on adapter modules.
- CI passes on Linux, macOS, Windows for Node 22 and Node 24.
- The project ships in 16-21 days of focused work using Claude Code.
