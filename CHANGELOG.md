# Changelog

All notable changes to Fun Claw will be documented in this file. The format is loosely [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and Fun Claw follows [SemVer](https://semver.org/).

## v0.1.0 — 2026-04-30

First public release. Fun Claw can take a goal in plain English, plan tool calls against the configured LLM provider (Anthropic Claude / OpenAI / Google Gemini / any OpenAI-compatible endpoint), and execute those tool calls inside a hardened Docker sandbox. Built-in tools are `execute_bash`, `write_file`, and `spawn_subagent`; agentskills.io-format skills and Model Context Protocol (MCP) servers are first-class. The CLI ships with `init`, `chat`, `doctor`, `skill`, and `mcp` subcommands. The published runtime sandbox image lives at `ghcr.io/ajpandit775/fun-claw-runtime:0.1.0`.

Deferred to subsequent releases: testcontainers-node integration to wire the project-root smoke scripts into the unit-test runner, raising the coverage thresholds back to the 85% / 70% targets recorded in `CLAUDE.md` (the v0.1.0 floor is 75/60-ish core, 20-25 adapter — what the unit suite alone can sustain), the live MCP end-to-end smoke (gated by `RUN_LIVE_LLM_TESTS` and currently a release-time manual step), and full documentation polish (the proper getting-started guide and FAQ). See the GitHub release at <https://github.com/ajpandit775/fun-claw/releases/tag/v0.1.0> for the auto-generated commit-level changelog.
