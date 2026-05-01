# Changelog

All notable changes to Fun Claw will be documented in this file. The format is loosely [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and Fun Claw follows [SemVer](https://semver.org/).

## v0.1.x

### Added

- `docs/getting-started.md` — install, first run, sandbox model, per-shell env-var setup, keyfile handling, doctor verification, first chat walkthrough.
- `docs/faq.md` — 25 questions covering setup, providers, keys, sandbox model, observability, costs, and product philosophy. All Fun Claw-specific factual claims verified to source.
- `README.md` Documentation section linking to the new docs.

### Changed

- `README.md` Status section updated to reflect that getting-started and FAQ ship with v0.1.x, with troubleshooting, skill authoring, and MCP integration docs deferred to v0.2.0.

## v0.1.0 — 2026-04-30

First public release.

### What's in the box

- Plain-English chat interface to an autonomous AI agent.
- Provider support for Anthropic Claude, OpenAI, Google Gemini, and any OpenAI-compatible endpoint.
- Hardened Docker sandbox for all tool execution. Non-root, read-only rootfs, no privileged capabilities.
- Built-in tools: `execute_bash`, `write_file`, `spawn_subagent`.
- [agentskills.io](https://agentskills.io)-format skills loaded from `~/.funclaw/skills/`.
- Model Context Protocol (MCP) server support via stdio transport.
- CLI subcommands: `init`, `chat`, `doctor`, `skill`, `mcp`.
- Published runtime image at `ghcr.io/ajpandit775/fun-claw-runtime:0.1.0`.

### Known limitations

- Coverage floor for v0.1.0 is the realistic unit-suite minimum (75% core, 20-25% adapter packages). The 85/70 targets in our internal docs require testcontainers-node integration that's deferred to v0.2.0.
- The live MCP end-to-end smoke is currently a release-time manual step gated by the `RUN_LIVE_LLM_TESTS` environment variable. Linux CI integration of this smoke is deferred to v0.2.0.
- Documentation expanded in v0.1.x and v0.2.0; see those entries above.

See the [GitHub release](https://github.com/ajpandit775/fun-claw/releases/tag/v0.1.0) for the auto-generated commit-level changelog.
