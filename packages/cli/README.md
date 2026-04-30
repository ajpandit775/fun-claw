# Fun Claw

A small, sandboxed, autonomous AI agent CLI. **The easy Claw.**

Fun Claw takes a goal in plain English, plans how to achieve it, and uses tools (running shell commands, reading and writing files, calling external services) to do the work — all inside a Docker sandbox so it can't accidentally damage your host. Sensible defaults in one Apache 2.0 codebase, written in TypeScript on Node 22 LTS.

## Status

This is **v0.1.0** — the first public release. The features are real and tested. The full getting-started guide and FAQ arrive in the next release.

## Install

```sh
npm install -g fun-claw
```

After install, the command is `funclaw` (no hyphen).

You'll need:

- **Node 22 LTS** or newer.
- **Docker** running on your machine (Docker Desktop on macOS / Windows; Docker Engine on Linux). Fun Claw runs every tool inside a container — Docker is not optional.
- An API key for at least one of: **Anthropic Claude**, **OpenAI**, **Google Gemini**, or any **OpenAI-compatible** endpoint (Together, Groq, OpenRouter, Ollama, …).

## Quick start

```sh
funclaw init     # one-time setup wizard: provider choice, model, API key
funclaw doctor   # verify your environment (Docker, provider auth, runtime image)
funclaw chat     # start a conversation
```

Inside the chat, type goals in plain English. Fun Claw decides which tools to call, runs them in a sandboxed container, and streams the results back. `Ctrl-C` once interrupts the current turn; twice exits cleanly.

## What's in the box

- **Built-in tools:** `execute_bash` (run shell commands inside the sandbox), `write_file` (write files into the sandbox `/workspace`), `spawn_subagent` (delegate a sub-task to an isolated nested agent).
- **MCP support:** point Fun Claw at any [Model Context Protocol](https://modelcontextprotocol.io) server via your config file. Filesystem, GitHub, Postgres, and the rest of the ecosystem just work.
- **Skills:** drop a SKILL.md (the [agentskills.io](https://agentskills.io) standard format used by OpenClaw, Claude Code, etc.) into `~/.funclaw/skills/` and Fun Claw picks it up. A skill is a markdown file with brief frontmatter and instructions; the agent invokes it via a tool call when relevant. Or just ask Fun Claw to write a skill for you — that's how most users end up authoring skills.

## Security model

The sandbox is the boundary. Tool execution runs inside a Docker container with:

- A non-root user (`uid 10001`).
- A read-only root filesystem with a writable `/workspace` and `/tmp`.
- Network mode is `bridge` by default (isolated network namespace, internet access). Configurable to `none` for fully offline sandbox.
- No bind-mounted Docker socket. No `--privileged`. No `--pid=host`. No `--network=host`.

What the sandbox does **not** protect against:

- **MCP servers run on your host**, not in the container. They have your user's permissions. Only configure MCP servers you trust.
- **Skills you install have access to the sandbox workspace.** Container isolation limits the blast radius, but a malicious skill can still do damage inside `/workspace`. Fun Claw does not include a malware scanner or skill curation. Trust your sources.
- **API keys are read from the host** (env vars or `~/.funclaw/keys.json`) and passed to the LLM provider over HTTPS. They never enter the container.

## What Fun Claw does NOT do

This is a deliberately small project. The following are **not** in v1, by design:

- No telemetry. No crash reporting. No auto-update. No update notifier.
- No persistent cross-session memory (use Hermes if you need that).
- No skill marketplace / registry / signature scanner.
- No web UI / IDE plugin / browser extension.
- No headless API mode.
- No kernel-level sandboxing beyond Docker (use NemoClaw for that).
- No CLA. Inbound = outbound contribution model.

## License

[Apache 2.0](./LICENSE).

## Issues

Bugs and feature requests: <https://github.com/ajpandit775/fun-claw/issues>.
