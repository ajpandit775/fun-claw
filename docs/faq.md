# FAQ

Quick answers to questions people will actually ask. Each Q&A is scannable on its own; you don't need to read in order. If your specific issue has an `FC-xxxx` code attached, jump to the troubleshooting doc — it maps every code to its cause and fix.

## Setup and installation

### Does Fun Claw work without Docker?

No. Every tool call runs inside a Docker container — the container is the security boundary, not a deployment detail. No Docker, no Fun Claw. If you can't run Docker on your machine, the agent has no sandbox to execute shell commands or write files in, and Fun Claw refuses to start the chat.

### How do I update Fun Claw?

```sh
npm install -g fun-claw@latest
```

That fetches the newest published version. The runtime Docker image is versioned to match the CLI — after upgrading, edit the `runtimeImage = "..."` line in your config to point at the new tag (e.g. `ghcr.io/ajpandit775/fun-claw-runtime:0.2.0` for v0.2.0), then run `funclaw doctor --pull-image` to pull it. Re-running `funclaw init` and accepting the new default also works.

### How do I uninstall Fun Claw?

```sh
npm uninstall -g fun-claw
```

That removes the `funclaw` binary. Three things stay behind on your machine:

- Your config file at `~/.config/funclaw-nodejs/config.toml` (or the OS equivalent — see [getting-started.md](getting-started.md))
- Your keyfile at `~/.funclaw/keys.json` (the API key especially — delete this if you're cleaning up)
- The runtime Docker image; remove with `docker rmi ghcr.io/ajpandit775/fun-claw-runtime:0.1.0`

Delete each manually if you want a clean slate.

## Providers and models

### Why does my model say it can't use tools?

The agent loop relies on tool-calling, an LLM capability some smaller / older models lack. Most current frontier models support it (Claude 3.5+, GPT-4o family, Gemini 2.5+, Llama 3.2 onward for Ollama). If your model doesn't, the agent can still chat with you but it won't actually execute commands or write files — it'll just describe what it would have done. Switch to a model that handles tools.

### Can I use Ollama or other OpenAI-compatible local servers?

Yes. Pick `openai-compatible` during `funclaw init` and point it at the local endpoint:

- Ollama: `http://localhost:11434/v1`
- LM Studio: `http://localhost:1234/v1`
- vllm, llama.cpp, etc.: whatever URL they expose

The model name has to match one your local server actually has loaded. For Ollama, `ollama list` shows what's pulled.

### Can I use multiple providers?

One provider per config file. Switch via `funclaw init` (re-runs the wizard), by editing the `provider = "..."` line in your TOML config, or by setting `FUNCLAW_PROVIDER` in your shell for a one-session override. Env vars take precedence over the TOML.

## Keys and secrets

### Where do my API keys live?

Two places, your choice:

- **Environment variables** — `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`. Read fresh every Fun Claw run. (`openai-compatible` reads `OPENAI_API_KEY` too.)
- **Keyfile** at `~/.funclaw/keys.json`. Same path on every OS. The init wizard offers to pre-create it.

Env vars take precedence over the keyfile when both are set. The keyfile is fine for everyday use; env vars are useful for CI or when you want a key set only for one shell.

### Can I have keys for multiple providers at once?

Yes. The keyfile holds all of them:

```json
{
  "secrets": {
    "anthropic": "sk-ant-...",
    "openai": "sk-...",
    "gemini": "AI..."
  }
}
```

Fun Claw reads only the one matching your configured provider. Switching providers makes Fun Claw read the corresponding key automatically.

### What if I leak my API key?

Rotate it on the provider's console immediately. Then update Fun Claw's copy — re-export the new value if you use env vars, or edit `~/.funclaw/keys.json` if you use the keyfile. The provider's billing console will show what the leaked key was used for. The keyfile's mode-`0600` (Linux/macOS) or recommended ACL hardening (Windows) limits the exposure to your own user account on a non-shared machine, but rotation is the safe response either way.

### Why does Fun Claw warn about my keyfile permissions?

You're seeing `FC-5001` because the keyfile's mode is something other than `0600` on Linux/macOS. Run:

```sh
chmod 0600 ~/.funclaw/keys.json
```

Fun Claw rejects the keyfile (rather than reading and using it) when permissions are looser, because a 0644 keyfile means other local users can read your API key. The init wizard creates the file with the right permissions; this only fires if something later changed them.

## The sandbox

### Can the sandboxed agent access the internet?

Yes, by default. The container's network mode is `bridge` (Docker's default isolated network namespace, with NAT to the outside). The agent can `curl`, `npm install`, `git clone`, `pip install`, anything that needs network.

To lock it down, set `networkMode = "none"` in your config TOML. With network disabled, the agent can still write files and run local commands, but anything that touches the network fails. Useful for fully offline runs or stricter sandboxing.

### What's actually inside the sandbox?

The runtime image bakes in: Node 22 LTS, Python 3 (with pip and venv), git, curl, jq, `build-essential` (gcc, g++, make), pnpm via Corepack, unzip, ca-certificates. Everything you'd want for general scripting and small project work. If you need additional tools, use a custom image (next question).

### Can I use my own Docker image?

Yes. Set the `runtimeImage = "..."` field in your config TOML to any OCI image reference. The image needs to satisfy a few constraints — non-root by default, an agent uid that can write to `/workspace` and `/tmp`, common shell utilities (`bash`, `sh`, `cat`, `mkdir`, `base64` for the `write_file` tool's encoding step). The base `ghcr.io/ajpandit775/fun-claw-runtime` image is the easiest starting point; fork its Dockerfile (in `packages/runtime-image/Dockerfile`) and add what you need.

### What's blocked in the sandbox?

The container is locked down per these rules:

- Non-root user (uid `10001`)
- Read-only root filesystem (writes only to `/workspace` and `/tmp`)
- All Linux capabilities dropped (`CapDrop: ["ALL"]`)
- Bridge or none network mode only — no host network access
- No host PID namespace
- No Docker socket bind mount, no `--privileged`
- Memory, CPU, and process-count limits

Anything that requires root, raw socket access, kernel modules, or container escape isn't available. The agent can do typical user-shell things — write code, install language packages, run tests, hit APIs. It can't reboot the host or peek at your other Docker containers.

### What happens to files the agent creates? Can I share files into the sandbox?

`/workspace` inside the container is bind-mounted from the host directory you picked during `funclaw init`. The mount is bidirectional in real time — files the agent writes there persist on your host filesystem after the chat ends (they're normal files on disk), and files you drop into the host workspace before or during a chat show up at `/workspace/<filename>` inside the sandbox.

Files written to `/tmp` (or anywhere outside `/workspace`) live only as long as the container does. The container shuts down at chat end, taking those files with it.

## Logs and observability

### How do I see what the agent is actually doing?

Three views, increasing detail:

- The chat TUI shows tool calls inline as small bordered boxes — the default surface.
- `funclaw chat --debug` turns on debug-level logging. Useful when you want to see config-loading details or provider stream events.
- `funclaw chat --trace` turns it up further. Rarely what you want — every tool call's full input/output and every LLM streaming chunk gets logged.

All log output goes to a file in your OS's data directory (e.g. `~/.local/share/funclaw-nodejs/logs/funclaw.log` on Linux). The TUI itself stays clean of log noise.

### How do I stop a runaway agent?

Press `Ctrl-C` once — that aborts the current turn cleanly. The agent stops mid-stream, the in-flight tool call gets interrupted, the chat returns to the prompt for your next instruction. Press `Ctrl-C` a second time to exit Fun Claw entirely.

If the chat itself is misbehaving (frozen TUI, runaway log spam), `Ctrl-C` twice always exits.

### What's `funclaw doctor` for?

Health check for your Fun Claw setup. It runs five checks:

1. Docker daemon is reachable.
2. Your API key works (one-token ping against the configured provider).
3. The runtime image is pulled.
4. Your config file parses cleanly.
5. No orphaned containers from prior sessions are sitting around.

Five green checks means you're ready to chat. Failures print an `FC-xxxx` code; the troubleshooting doc maps each code to a fix. Two flags worth knowing: `--clean` removes orphaned containers, `--pull-image` pulls the configured runtime image.

## Costs and limits

### How much does it cost to run?

Fun Claw is free (Apache 2.0). What you pay for is your LLM provider's API usage — every chat turn calls the provider's API and they bill you per token.

Token usage scales with: how long your conversation gets (the entire history goes back on every turn), how chatty your model is, and how many tool calls happen per turn. A short 5-10 turn chat with a small model (Claude Haiku, GPT-4o-mini, Gemini Flash) typically lands in the fraction-of-a-cent range. Larger models (Sonnet, Opus, GPT-5) cost noticeably more per token — usually an order of magnitude or more, but the exact ratio shifts as providers reprice. Check your provider's pricing page if it matters.

### Does Fun Claw have spend limits?

Not at the Fun Claw level. Use your provider's billing console — Anthropic, OpenAI, and Google all support monthly caps. Fun Claw will keep making requests until the provider returns a rate-limit (`FC-2004`) or quota-exceeded error.

### What happens if my provider runs out of quota mid-chat?

The provider returns an error, Fun Claw surfaces an `FC-200x` code, and the chat status bar shows "rate-limited" or "provider unavailable." Type a new prompt to retry, or top up your account first. The chat session stays alive; the agent's just waiting for the next request to succeed.

## Skills and MCP

### How do I write a skill?

See [skill-authoring.md](skill-authoring.md) — that's the dedicated guide. The short version: a `SKILL.md` file with YAML frontmatter (`name`, `description`, `version`) and a markdown body of instructions, dropped into your skills directory. Or have Fun Claw draft one for you from a description.

### How do I plug in an MCP server?

See [mcp-integration.md](mcp-integration.md). The short version: add an `[mcp.<name>]` section to your config TOML with the command to spawn the server. Fun Claw starts it on each chat session and namespaces its tools as `mcp__<name>__<tool>`.

## About Fun Claw

### Is Fun Claw safe to use on production code?

The sandbox protects your host filesystem (the agent can only write host-persistent files to `/workspace`) and limits what it can do at the OS level. That's a real boundary.

But: the agent's tool calls happen INSIDE the workspace, against the files you mounted there. If you point Fun Claw at your production-code working directory and tell it to "fix the auth bug," it'll happily edit those files. The sandbox doesn't help against an agent doing exactly what you asked.

Practical advice: point Fun Claw at a fresh working copy (a feature branch or a scratch checkout) rather than your main working tree. Review every change before committing. The sandbox is for protecting the rest of your filesystem, not for protecting the workspace from itself.

### Why isn't there a GUI?

CLI-first by design. Fun Claw is a small, sandbox-focused agent for people who already live in a terminal. A GUI version would be a separate product (different audience, different design tradeoffs, much bigger surface area). Fun Claw stays a CLI.
