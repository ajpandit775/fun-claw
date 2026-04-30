# Fun Claw — Troubleshooting

This page catalogues every Fun Claw error code with its message, cause, and fix. Per the error-handling contract in `.claude/CLAUDE.md`, every code thrown from source must appear here. Subsequent slices append their own codes.

Codes are namespaced by component:

- **FC-1xxx** — Docker (daemon unreachable, container failed to start, container OOM-killed)
- **FC-2xxx** — LLM provider (auth failure, rate limit, malformed response)
- **FC-3xxx** — MCP (server crashed, transport failure, malformed JSON-RPC)
- **FC-4xxx** — Skill (frontmatter invalid, name conflict, script execution failed)
- **FC-5xxx** — Filesystem (config unreadable, state file lock contention)
- **FC-6xxx** — Agent loop (max iterations, malformed tool call, subagent budget exceeded)

---

## FC-1001 — Docker daemon unreachable

**You will see this when:** Fun Claw tried to reach the Docker Engine API and got nothing back — either the daemon isn't running, the socket / named pipe isn't where dockerode expects it, or your user can't connect to it.

**Cause:** Fun Claw runs every tool inside a Docker container per ADR-001. No daemon means no sandbox means no agent.

**Fix:**

- macOS / Windows: open Docker Desktop and wait for it to report "Docker Desktop is running."
- Linux: start the daemon with `sudo systemctl start docker` (or your distro's equivalent), and ensure your user is in the `docker` group (`sudo usermod -aG docker "$USER"` and re-login).
- Verify reachability: `docker version` should return both client and server versions. If it doesn't, fix that first; Fun Claw can't fix daemon connectivity for you.
- WSL2: check that Docker Desktop's "Use the WSL 2 based engine" is enabled and your distro is selected under Resources → WSL Integration.

---

## FC-1004 — Docker daemon ping timed out

**You will see this when:** `funclaw doctor` connected to the Docker socket / named pipe but the daemon didn't respond to the version probe within 5 seconds. Distinct from FC-1001 (daemon unreachable: socket missing or refusing connections) — here the socket is reachable but the daemon itself is hung.

**Cause:** Docker Desktop or the docker daemon is in a wedged state — sometimes after a system sleep/wake cycle, after a heavy `docker pull` that exhausted resources, or because of an unrelated container monopolizing the daemon's event loop.

**Fix:**

- macOS / Windows: quit Docker Desktop fully (the menu-bar icon → Quit Docker Desktop), wait a few seconds, and reopen it. Wait for the "Docker Desktop is running" status before re-running `funclaw doctor`.
- Linux: `sudo systemctl restart docker` (or your distro's equivalent).
- If FC-1004 keeps recurring after restarts: check `docker ps` from a separate terminal — if it also hangs, the daemon has a deeper problem (often resource exhaustion). Free disk space and inspect Docker's own logs.

---

## FC-1010 — Privileged container rejected by policy

**You will see this when:** the runner was asked to create a container with `HostConfig.Privileged = true`. Fun Claw's policy refuses.

**Cause:** Privileged containers can do almost anything to the host kernel — mount the host filesystem, load kernel modules, escape namespaces. Sandbox escape is trivial. The policy hard-rejects.

**Fix:** Don't pass `Privileged: true`. There is no legitimate v1 use case in Fun Claw.

---

## FC-1011 — Host network mode rejected by policy

**You will see this when:** the runner was asked to create a container with `HostConfig.NetworkMode = "host"`, or with a missing / unrecognized `NetworkMode`.

**Cause:** Host network mode shares the host's network namespace with the container — the container can bind to host ports, snoop on host traffic, and reach services bound to localhost. The policy rejects everything except `bridge` (default isolated) and `none` (no network at all).

**Fix:** Set `networkMode = "bridge"` (default) or `networkMode = "none"` in your config. Run `funclaw init` to reset.

---

## FC-1012 — Host PID namespace rejected by policy

**You will see this when:** the runner was asked to create a container with `HostConfig.PidMode = "host"`.

**Cause:** Sharing the host's PID namespace lets the container see and signal every process on the host, defeating process isolation. Not a v1 use case.

**Fix:** Don't pass `PidMode: "host"`.

---

## FC-1013 — Forbidden volume mount

**You will see this when:** the container config tried to bind-mount `/var/run/docker.sock` or `/var/run/docker.sock.raw`. The policy refuses, in either the legacy `Binds` array or the structured `Mounts` array.

**Cause:** Mounting the Docker daemon socket inside the container gives that container the ability to spawn its own containers, mount the host filesystem, and otherwise act as Docker itself. The trust boundary collapses entirely.

**Fix:** Remove the docker.sock bind from your config. If you have a use case that needs it, that use case is incompatible with Fun Claw's threat model — file an issue and we can discuss whether `[v2-or-never]` makes sense.

---

## FC-1014 — Root user rejected by policy

**You will see this when:** the container config has `User = "0"`, `"root"`, an empty string, or no `User` field at all.

**Cause:** ADR-001 requires the container's primary user to be the locked sandbox uid (10001:10001). Running as root inside the sandbox magnifies the blast radius of any escape and isn't necessary for the agent's work.

**Fix:** Set `User: "10001:10001"` on the container config. The Fun Claw runner does this by default; if you're seeing this error you've probably written your own config layer that's bypassing the runner's defaults.

---

## FC-1015 — Capabilities not in approved set

**You will see this when:** the container config has `HostConfig.CapDrop` ≠ `["ALL"]` or has any non-empty `HostConfig.CapAdd`.

**Cause:** Linux capabilities are root-equivalent permissions split into named buckets. The locked profile drops every capability and adds none — anything else loosens the security boundary.

**Fix:** Set `CapDrop: ["ALL"]` and leave `CapAdd` empty (or undefined). If a tool genuinely needs a capability, that's a security review conversation, not a config tweak.

---

## FC-1016 — Writable rootfs rejected by policy

**You will see this when:** the container config has `HostConfig.ReadonlyRootfs ≠ true`.

**Cause:** A writable rootfs lets the container modify `/etc`, `/usr`, and other system directories in ways that confuse the audit trail. The locked profile makes the rootfs read-only and provides explicit writable mounts (`/workspace`, `/tmp` tmpfs) for the agent's actual work.

**Fix:** Set `ReadonlyRootfs: true`. Use a tmpfs mount on `/tmp` and a bind mount on `/workspace` for writable scratch space.

---

## FC-1018 — Writable `/skills` mount rejected by policy

**You will see this when:** the container config carries a bind mount whose target is `/skills` (or anything under `/skills/`) without `ReadOnly: true`. Should be impossible from the runner — Fun Claw always sets `ReadOnly: true` on skill mounts — so this fires only if a programmatic caller built a config object directly and got the flag wrong.

**Cause:** The `/skills` tree must be mounted read-only because the host is the only authoritative source for skill content. A writable mount would let the container modify the user's host skills directory without going through Fun Claw's parser, breaking the ADR-001 "the host loader is a pure parser" contract.

**Fix:** Set `ReadOnly: true` on every bind mount targeting `/skills` or a subdirectory. If you're using Fun Claw's `DockerRunner.createSession` with a `SkillMount[]` argument, the runner sets the flag for you — you should never see this code through normal usage.

---

## FC-1019 — Malformed `funclaw.*` container label

**You will see this when:** the policy validator inspected the container's `Labels` block and found that `funclaw.session` or `funclaw.subagent` carried a value that doesn't look like a UUID-shaped string (empty, whitespace, contains shell metacharacters, exceeds reasonable length). Should be impossible through normal usage — Fun Claw stamps these labels via `crypto.randomUUID()` — so this fires only when a programmatic caller built the container config by hand with mangled values.

**Cause:** The cleanup logic (`listOrphanedSessions`, `funclaw doctor --clean`) and the log-filtering UX assume both labels carry well-formed UUID strings. A label with whitespace or shell-meaningful chars could break grep workflows or — worst case — be misinterpreted by tooling that splits on whitespace.

**Fix:** Use `crypto.randomUUID()` to generate the label values. The runner does this automatically; if you're calling `DockerRunner.createSession` or `DockerRunner.spawnSubagentSession` you don't need to think about labels at all.

---

## FC-1020 — Container failed to create or start

**You will see this when:** the runner asked Docker to create or start a sandbox container and the daemon refused for a non-policy reason (e.g., the image isn't pulled, a name collision, the Linux kernel rejected a HostConfig field, the daemon ran out of resources).

**Cause:** Whatever Docker reported is in the `cause` field of the structured error. Common ones:

- `No such image` — the runtime image isn't pulled. Run `funclaw chat` (which pulls lazily) or `docker pull <image>` manually.
- `Conflict. The container name "..." is already in use` — leftover container from a crashed session. Run `funclaw doctor --clean` to remove orphaned containers; for one-off cleanup: `docker rm -f <name>`.
- `cannot allocate memory` / `no space left on device` — the host is out of resources. Free space or memory and try again.

**Fix:** Read the `cause` field in your log file (`<env-paths log dir>/funclaw.log`) for the specific Docker error. The message is the daemon's own reason, not Fun Claw's interpretation.

---

## FC-1021 — Container exec failed

**You will see this when:** a tool tried to exec a command inside a running session container and the exec setup itself failed (not the command's exit code — that's reported as the exit event).

**Cause:** The session's container terminated unexpectedly (OOM, signal), the daemon hit a transient issue, or the exec was cancelled mid-flight via AbortSignal / timeout.

**Fix:**

- If the message says "Exec cancelled" — the cancellation came from your AbortSignal or a `timeout_ms` expiry. Expected if you intended to cancel.
- If the message says "Cannot exec on a destroyed session" — the session was already torn down. Don't reuse a `SessionHandle` after `destroySession`.
- Otherwise: check the container's status via `docker ps -a` and the daemon logs.

---

## FC-1022 — Image pull failed

**You will see this when:** `ensureImage` couldn't pull the runtime image. Network failure, registry outage, image name typo, or auth required.

**Cause:** The pull stream errored or the daemon couldn't talk to the registry. Common ones:

- `pull access denied` / `unauthorized` — the image is private and your daemon isn't logged in. Run `docker login <registry>` first.
- `dial tcp: lookup <host>: no such host` — DNS / network failure. Check connectivity to the registry.
- `manifest unknown` — the image tag doesn't exist. Check spelling.

**Fix:** Confirm `docker pull <image>` works manually. If it does, retry `funclaw chat`. If it doesn't, the fix is at the Docker / network level, not in Fun Claw.

---

## FC-1023 — Container OOM-killed

**You will see this when:** the kernel killed the sandbox container's process for exceeding the memory limit (`HostConfig.Memory`). The exec event sequence terminates abruptly.

**Cause:** Either the agent issued a command that genuinely needed more memory, or the runaway process leaked. The default memory limit is 2 GiB.

**Fix:**

- Raise `memoryBytes` in your `DockerRunner` config if a legitimate workload needs more.
- For pathological agent behavior (e.g., loading a giant file into memory): the OOM kill is a feature, not a bug. The container terminates and Fun Claw recovers.

The default cap of 2 GiB is generous for typical agent work and protects the host from OOM-killing the agent itself.

---

## FC-1030 — `write_file` path traversal attempt rejected

**You will see this when:** the agent invoked the `write_file` tool with a path that contains `..` segments (either before or after normalization), or a path that normalized to something outside `/workspace`.

**Cause:** The path-traversal guard refuses any path whose normalized form contains a `..` segment OR starts with one — those are the patterns attackers use to escape sandboxed directories. Common cases the LLM might emit:

- `../etc/passwd` — outright traversal.
- `safe/../../../escape` — traversal hidden behind a safe prefix.
- The model trying to write somewhere "convenient" outside the workspace.

**Fix:** No user action needed in most cases — the agent loop converts this into a `tool_result` with `isError: true` so the LLM sees the rejection and adjusts. If you (a developer reading this) wrote a tool wrapper that called `resolveWriteFilePath` directly: keep paths relative to the workspace root with no `..` segments.

---

## FC-1031 — `write_file` absolute path rejected

**You will see this when:** the agent's `write_file` call provided an absolute path — leading `/` (POSIX) or a Windows drive letter like `C:\`.

**Cause:** `write_file` only writes inside `/workspace`. Absolute paths are refused at the boundary because they imply the LLM is trying to write somewhere outside the workspace. (For paths starting at the workspace root, just drop the leading slash: write `src/foo.ts`, not `/src/foo.ts`.)

**Fix:** Same as FC-1030 — the agent loop turns this into a structured tool error and the LLM retries with a relative path.

---

## FC-1032 — `write_file` invalid characters in path

**You will see this when:** the path contains a NUL byte, leading or trailing whitespace, or is empty after trimming.

**Cause:** These characters corrupt argv quoting on the way to the container's shell, or signal a programming bug upstream. NUL bytes specifically can truncate paths in C string handling and are never legal in POSIX paths.

**Fix:** No user action needed; the agent loop handles the structured error and the LLM tries again. If you're calling `resolveWriteFilePath` programmatically: trim whitespace and reject NUL bytes at your call site.

---

## FC-2001 — No API key for the configured provider

**You will see this when:** Fun Claw asked for a key (e.g., when the chat command starts up) and neither the standard environment variable nor the keyfile at `~/.funclaw/keys.json` had one.

**Cause:** The provider you selected during `funclaw init` (or via `FUNCLAW_PROVIDER`) needs a key. Fun Claw checks the standard env var first (`ANTHROPIC_API_KEY` for Anthropic, `OPENAI_API_KEY` for OpenAI and OpenAI-compatible, `GOOGLE_API_KEY` for Gemini), then falls back to `~/.funclaw/keys.json`. Both came up empty.

**Fix:** Pick one:

- **Set the env var.** For example: `export ANTHROPIC_API_KEY=sk-ant-...` in your shell profile, then start a new terminal session.
- **Use the keyfile.** Create `~/.funclaw/keys.json` with mode `0600` (POSIX) and the shape:
  ```json
  { "secrets": { "anthropic": "sk-ant-..." } }
  ```
  Then `chmod 0600 ~/.funclaw/keys.json` on macOS or Linux.

If you want to switch providers, run `funclaw init` again or set `FUNCLAW_PROVIDER`.

---

## FC-2002 — API key environment variable is set but empty

**You will see this when:** the env var (e.g., `ANTHROPIC_API_KEY`) exists in your environment but is set to an empty string.

**Cause:** Empty string and unset are different to Node. An empty value is treated as a deliberate "use no key," so Fun Claw declines to fall through to the keyfile silently.

**Fix:** Either set a non-empty value:

```sh
export ANTHROPIC_API_KEY=sk-ant-...
```

…or unset the variable so Fun Claw falls back to the keyfile:

```sh
unset ANTHROPIC_API_KEY
```

---

## FC-2003 — API keys cannot be set in `funclaw.config.toml`

**You will see this when:** your `funclaw.config.toml` (in your env-paths user config dir) or your project-level `funclaw.config.{json,js,cjs,mjs}` contains a `[secrets]` table.

**Cause:** Human-edited config files are version-controllable and shareable, which makes them a bad place for credentials. Fun Claw refuses to load configs that put keys in the wrong tier.

**Fix:** Move the keys out:

- Preferred: set them as environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`).
- Or: put them in `~/.funclaw/keys.json` with mode `0600` (POSIX) using the shape `{ "secrets": { "anthropic": "..." } }`.

Then remove the `[secrets]` table from your TOML config and rerun.

---

## FC-2004 — Provider rate limited the request

**You will see this when:** the provider returned HTTP 429 in response to a streaming request.

**Cause:** You exceeded the rate limit on your API key — too many requests per minute, or burst usage above your plan tier. The error message includes the retry-after window if the provider supplied one in the response headers.

**Fix:**

- Wait for the retry-after window before retrying. Fun Claw will not auto-retry; the agent loop surfaces the error to you.
- Reduce request frequency (slow the agent loop, or combine multiple short turns into one prompt where it makes sense).
- If you regularly hit limits, request a quota increase from the provider's console.

---

## FC-2005 — Provider is currently unavailable

**You will see this when:** the provider returned HTTP 500, 502, or 503 — its servers are having trouble.

**Cause:** Provider-side outage, deployment, or transient overload. Not your fault.

**Fix:**

- Wait a minute and retry.
- Check the provider's status page (`status.anthropic.com`, `status.openai.com`, `status.cloud.google.com`).
- Switch providers if you can't wait — Fun Claw supports four providers, and rerunning `funclaw init` (or editing your config) can flip you to any of them.

---

## FC-2006 — Provider returned a malformed response

**You will see this when:** the SDK's stream emitted something Fun Claw could not normalize — an unexpected shape, a JSON-parse failure during tool-use accumulation, or a truncated event stream.

**Cause:** Provider-side bug, a model version emitting an unexpected schema, network corruption, or (rarely) an adapter bug in Fun Claw. The structured error log includes the underlying SDK exception in `cause`.

**Fix:**

- Retry the request once. Transient corruption usually clears on retry.
- If it reproduces with the same prompt, check the log file (under env-paths' log directory — `~/.local/state/funclaw/log/funclaw.log` on Linux, `~/Library/Logs/funclaw/funclaw.log` on macOS, `%LOCALAPPDATA%\funclaw\Log\funclaw.log` on Windows) for the raw SDK error.
- If the cause looks like an adapter bug rather than a provider issue, file an issue against Fun Claw with the model name, provider, and the redacted cause excerpt.

---

## FC-2007 — Provider rejected the API key

**You will see this when:** the provider returned HTTP 401. The host had a key, sent it, and the provider declined it. (This is different from FC-2001, which is "no key found at all" before any request goes out.)

**Cause:** The key is invalid, expired, or correctly formed but lacks the scope or project access needed for the model you're calling. The error message includes which provider and which model so you know which credential to check.

**Fix:**

Two scenarios — try the first, then the second if it doesn't help:

1. **The key is wrong** (typo, copy-paste truncation, you regenerated it on the provider's console and didn't update your env or keyfile): generate a fresh key in the provider's console and replace the value in your env var or `~/.funclaw/keys.json`.
2. **The key is correct but lacks scope or project access.** Provider-specific:
   - **Anthropic** — if your organization uses workspace-scoped keys, confirm the key belongs to a workspace that has access to the model you're calling. Console → Workspaces → API keys.
   - **OpenAI** — if your organization uses project-scoped keys, confirm the key's project allows access to the model. Console → Projects → API keys → Project access.
   - **Gemini** — confirm the Generative Language API (or Vertex AI, depending on your configuration) is enabled in the GCP project the key belongs to. Console → APIs & Services → Library.

If neither fixes it, run `funclaw doctor` for connectivity and key-shape diagnostics.

---

## FC-2008 — `openai-compatible` provider needs an endpoint URL

**You will see this when:** `provider = "openai-compatible"` is set (in your TOML config, env var, or CLI flag) but `endpoint` is not.

**Cause:** The `openai-compatible` provider routes through the OpenAI SDK with a `baseURL` override. Together, Groq, OpenRouter, Ollama, and friends all expose an OpenAI-shaped API at their own URLs; Fun Claw needs to know which URL.

**Fix:** Set the endpoint. Pick one:

- Environment: `export FUNCLAW_ENDPOINT="https://api.together.xyz/v1"` (or your provider's URL).
- Config: add `endpoint = "https://..."` to `funclaw.config.toml`.

If you're not actually using an OpenAI-compatible provider, switch to `provider = "openai"` (or `anthropic` / `gemini`) — those don't need the endpoint set.

---

## FC-2009 — Unsupported provider value (defensive)

**You will see this when:** the runtime receives a `provider` value that isn't one of `anthropic`, `openai`, `gemini`, `openai-compatible`. Should be impossible because Zod validates the enum at config load time.

**Cause:** Almost certainly a corrupt config that bypassed Zod validation, or a programmatic caller passing a hand-built config object with a typo'd provider name.

**Fix:** Set `provider` to one of the four supported values. Run `funclaw doctor` to see what's currently active. If you see this without obvious cause, file an issue — it indicates Fun Claw's validation has a hole.

---

## FC-3001 — MCP server failed to spawn

**You will see this when:** Fun Claw tried to spawn an MCP server subprocess at chat startup and the operating system refused — `ENOENT` (command not found), `EACCES` (permission denied), `EPERM` (no execute permission). The chat session continues; the failed server's tools are simply not registered.

**Cause:** The `command` field in your `[mcp.<name>]` config doesn't resolve to an executable. Common reasons: typo in the command, the binary isn't on `PATH`, you wrote `npx my-server` but `npx` isn't installed, or the binary isn't marked executable on POSIX.

**Fix:** Try the command at a shell prompt to verify it works (`<command> <args>` should at least start running and print something to stdout, or accept stdin). Use an absolute path if the binary isn't on `PATH`. On POSIX, `chmod +x` if the file isn't executable.

---

## FC-3002 — MCP server initialization failed

**You will see this when:** The subprocess started, but the MCP `initialize` JSON-RPC handshake or the follow-up `tools/list` request did not complete cleanly. Fun Claw warns and continues without the server's tools.

**Cause:** The subprocess crashed during init (look for stack traces in its output), or it returned malformed JSON-RPC, or it returned valid JSON-RPC that doesn't satisfy the MCP `initialize` schema. Mismatched MCP SDK versions between Fun Claw and the server can cause this.

**Fix:** Run the MCP server directly from your shell with the same `command` + `args` and pipe a hand-built `initialize` request through it to see what it responds with. Check the server's GitHub issues for known compatibility bugs with `@modelcontextprotocol/sdk` ^1.29. If the server is your own code, set its log level higher to capture more detail at startup.

---

## FC-3003 — MCP server startup timed out

**You will see this when:** The MCP server didn't finish spawning, initializing, and returning its first `tools/list` response within the 5-second startup cap. Fun Claw gives up and continues without it.

**Cause:** The server is doing slow work at startup (downloading dependencies, scanning a large directory, opening a remote DB connection), or it's hung on a blocking syscall, or `npx -y <package>` is downloading the package for the first time over a slow connection.

**Fix:** If it's the `npx -y` first-run case, run `npx -y <package> --version` once outside Fun Claw to warm the npm cache; subsequent runs will be fast. If the server genuinely needs more than 5s to start, file an issue against the server (init should be cheap) — long startup work usually belongs in a lazy-init pattern triggered by the first tool call. The 5-second cap is locked at the SDK boundary; we don't expose it as a config option in v1.

---

## FC-3004 — MCP server crashed mid-session

**You will see this when:** An MCP server that had been running successfully exited unexpectedly during your chat session. Fun Claw logs the failure, unregisters that server's tools from the registry, and continues the session. Other MCP servers and built-in tools are unaffected.

**Cause:** Almost always a bug in the MCP server itself (segfault, unhandled exception, OOM kill on the host, etc.). Check the server's own logs if it writes any. Subprocess `signal=SIGKILL` typically means OOM-killed by the host kernel; subprocess `signal=SIGSEGV` is a hard crash.

**Fix:** Restart the chat session — the server will spawn fresh. If it crashes again under the same workload, file an issue against the server's repo with the workload and the OS / arch you're on. Fun Claw v1 does not auto-restart crashed MCP servers (auto-restart with backoff is a future-version consideration, not a v1 commitment).

---

## FC-3005 — MCP tool call timed out

**You will see this when:** A tool call to an MCP server didn't return within the 30-second per-call cap. The agent loop converts this into a `tool_result` with `isError: true` so the LLM can adapt — usually it'll retry with smaller arguments or pick a different approach.

**Cause:** The server-side operation took genuinely long (large file scan, network call without a timeout, expensive computation). Some servers will hold the connection open while doing work; the SDK provides progress notifications for cooperative servers, but we don't surface those in v1.

**Fix:** Server-side, chunk long-running operations or stream partial results so individual tool calls finish quickly. Fun Claw v1 does not expose a per-server timeout override; the 30-second default is the only knob. If a specific server consistently needs longer for legitimate operations, file an issue and we'll consider exposing the override.

---

## FC-3006 — MCP transport error

**You will see this when:** An unexpected error happened on the JSON-RPC transport between Fun Claw and an MCP server during a request — broken pipe, malformed message, send failure. The agent loop converts this into a `tool_result` with `isError: true` and continues.

**Cause:** Often the precursor to FC-3004 (the server crashes a fraction of a second after the broken pipe). Can also be a protocol-level bug: the server sent a JSON-RPC response we couldn't parse, or our request was rejected at the transport layer.

**Fix:** If it's followed by FC-3004 in the logs, treat this as a symptom of the crash. If it appears in isolation and reproduces, capture the request and the server's response (set `--trace` log level) and file an issue with the server, including the SDK version mismatch info if any.

---

## FC-3007 — MCP tool not available

**You will see this when:** The LLM tried to call an MCP tool whose underlying server has crashed or disconnected earlier in the session. The agent loop converts this into a `tool_result` with `isError: true`.

**Cause:** Race between Fun Claw's crash-handling unregister path and the LLM's next tool call (rare), or the LLM kept a tool name in context across a crash and tried it again before the registry update propagated.

**Fix:** No user action needed in most cases — the LLM sees the error and either picks a different tool or asks the user how to proceed. If you see this without a preceding FC-3004 in the same session, file an issue: it indicates the registry got out of sync with the actual client state.

---

## FC-4001 — `SKILL.md` not found in skill directory

**You will see this when:** Fun Claw walked into a directory that looked like a skill (it was a subdirectory of `bundled/`, your user skills dir, or `./.funclaw/skills/`) but couldn't find a `SKILL.md` file inside it. The chat session continues — the bad directory is just skipped.

**Cause:** A skill author forgot to commit the `SKILL.md` file, or the directory is a leftover (an editor's `.bak`, a `node_modules` for a script-helper, etc.) that shouldn't be there.

**Fix:** Either add the missing `SKILL.md` (with valid YAML frontmatter — see Flow 7 in REQUIREMENTS.md, or ask Fun Claw to write one for you), or delete the stray directory so the loader stops trying.

---

## FC-4002 — `SKILL.md` frontmatter is not valid YAML

**You will see this when:** the file exists but Fun Claw couldn't parse the YAML between the `---` markers — either the markers are missing entirely, the YAML between them has a syntax error, or the frontmatter parses to something other than an object (e.g. a list, a scalar).

**Cause:** Hand-edited YAML with a stray tab character, a missing colon, an unclosed quote, or a typo in the `---` delimiter (e.g. `--` or `————`). YAML 1.1 booleans like `Yes` / `No` / `On` / `Off` also don't parse — Fun Claw uses YAML's "core" schema by design (per STACK.md) which rejects them.

**Fix:** Open the SKILL.md, verify the file starts with `---` on its own line and the frontmatter ends with another `---` on its own line. The frontmatter between must be `key: value` pairs. If you mean the literal string `Yes`, quote it: `description: "Yes"`. If you have it, paste the file into an online YAML linter to find the exact column.

---

## FC-4003 — `SKILL.md` frontmatter failed schema validation

**You will see this when:** the YAML parsed cleanly but the resulting object doesn't satisfy Fun Claw's frontmatter schema — typically a missing `name` or `description`, a `description` longer than 200 characters, or a field with the wrong type.

**Cause:** The agentskills.io format requires `name` and `description` at minimum. Both must be non-empty strings. `version` is optional but if present must be a non-empty string (typically a semver like `1.0.0`). Unknown fields are preserved (forward compat) but the required fields are enforced.

**Fix:** Open the SKILL.md and check the frontmatter has at least:

```yaml
---
name: your-skill-name
description: One-line summary, 200 characters or fewer.
---
```

The error message includes the exact validation issue (e.g. `description: String must contain at most 200 character(s)`).

---

## FC-4004 — `SKILL.md` `name` doesn't match its directory

**You will see this when:** the frontmatter `name` field is, say, `git-helper` but the parent directory is named `git_helper` or `GitHelper`. The agentskills.io format requires these to agree so disk layout and the LLM-visible tool name (`skill__<name>`) stay in sync.

**Cause:** A skill was renamed in only one of the two places. Common when copying a skill from another agent and forgetting to update one or the other.

**Fix:** Pick one and rename the other to match. The frontmatter name and the directory name must be identical, character for character.

---

## FC-4006 — Skill `scripts/` directory is not readable

**You will see this when:** the skill itself loaded fine (the SKILL.md parsed, the markdown body is available to the agent) but the optional `scripts/` subdirectory exists and isn't listable. The skill body is still usable, but the agent can't invoke its scripts inside the sandbox.

**Cause:** Filesystem permissions on the `scripts/` directory don't allow Fun Claw's process to read it. Common after copying a skill from a tar archive that preserved restrictive modes.

**Fix:** On POSIX, `chmod -R u+rX <skill-dir>/scripts`. On Windows, check Properties → Security on the directory. If the directory should be empty, just delete it — the loader treats "no scripts directory" as fine.

---

## FC-4007 — Skill name contains forbidden characters

**You will see this when:** the frontmatter `name` is set to something that doesn't match the locked pattern `/^[a-z][a-z0-9_-]{0,63}$/`. Allowed: lowercase letters, digits, dash, underscore. Must start with a letter. 1–64 characters total.

**Cause:** The pattern is intentionally restrictive: it rules out path-traversal (`..`, `/`, `\`), Windows drive letters, whitespace, null bytes, and anything that would corrupt the `skill__<name>` tool name or the `/skills/<name>` mount target inside the sandbox.

**Fix:** Rename the skill (and its directory) to use only lowercase letters, digits, dashes, and underscores, starting with a letter. `git-helper` is fine; `Git Helper`, `git/helper`, and `1git` are not.

---

## FC-5001 — Keyfile permissions are unsafe (POSIX)

**You will see this when:** `~/.funclaw/keys.json` exists on Linux or macOS but its mode is something other than `0600`.

**Cause:** A keyfile that other local users can read is a credential leak waiting to happen. Fun Claw enforces `0600` (owner read/write only) on POSIX systems before reading the file.

**Fix:** Tighten the permissions:

```sh
chmod 0600 ~/.funclaw/keys.json
```

The error message includes the current mode (e.g., `644`) so you can confirm what changed.

> **Windows note:** Fun Claw does not enforce ACLs on Windows. It logs a one-time warning the first time it reads the keyfile and proceeds. Protect the file via the OS file ACL settings if Windows-native.

---

## FC-5002 — Keyfile expected but not found

**You will see this when:** an explicit keyfile path was passed (`getSecret(provider, { keyfilePath })`) and the file does not exist.

**Cause:** Fun Claw distinguishes "the default keyfile is absent, fall through to FC-2001" from "the caller explicitly pointed at this file and it's gone." The latter is FC-5002 because the caller's expectation was specific.

**Fix:** Create the file at the expected path:

```sh
mkdir -p "$(dirname /path/to/keys.json)"
echo '{ "secrets": { "anthropic": "sk-ant-..." } }' > /path/to/keys.json
chmod 0600 /path/to/keys.json   # POSIX only
```

…or update the caller to use a different path.

---

## FC-5003 — Keyfile is not readable

**You will see this when:** the keyfile exists but `fs.readFileSync` failed — typically a permissions problem (e.g., the file is owned by another user, or you're running under a constrained sandbox).

**Cause:** The Node process couldn't open the file for reading despite the file being present.

**Fix:** Check ownership and permissions:

```sh
ls -l ~/.funclaw/keys.json
```

If you own it but the mode is wrong: `chmod 0600 ~/.funclaw/keys.json`. If you don't own it: change ownership (`sudo chown $USER ~/.funclaw/keys.json`) or move it to a directory you own.

---

## FC-5004 — User or project config failed to load

**You will see this when:** `funclaw.config.toml` is not valid TOML, or your project config (`funclaw.config.json`, `funclaw.config.js`, etc.) doesn't match the expected schema.

**Cause:** Either a syntax error in TOML, or a field with the wrong type (e.g., `provider = "claude"` when only `anthropic`, `openai`, `gemini`, `openai-compatible` are accepted).

**Fix:** The error message includes which key failed and why. Common offenders:

- `provider` must be one of `anthropic`, `openai`, `gemini`, `openai-compatible`.
- `logLevel` must be one of `fatal`, `error`, `warn`, `info`, `debug`, `trace`.
- `networkMode` must be `bridge` or `none`.
- Unknown keys are rejected; check spelling.

---

## FC-6001 — Agent loop hit max iterations

**You will see this when:** the agent has run 25 consecutive tool-use turns in one chat without ever ending the turn naturally. Typically this means the LLM got stuck in a tool-call loop — calling tools, looking at output, calling more tools, never reaching a satisfying answer.

**Cause:** Either the task is genuinely hard and needs more iterations than the cap allows, or the LLM is misbehaving (calling tools without making progress).

**Fix:**

- **Most of the time:** restart the chat with a clearer or smaller prompt. "Find every TODO in this repo and prioritize them" might run away; "find TODOs in src/api/" is bounded.
- **If you trust the loop and the task is genuinely large:** the iteration cap is configurable in source (`AgentLoopOptions.maxIterations`). v1 doesn't expose this on the CLI; raising it is a code change.
- **If the LLM is repeatedly calling the same tool with the same input:** the prompt or the model is the problem, not the cap. Try a different model or rephrase.

The cap exists to protect against runaway costs and infinite loops. ADR-002 sets it at 25.

---

## FC-6002 — Tool handler threw an unexpected error

**You will see this when:** a registered tool's handler threw something other than a recoverable, structured error during execution. The agent loop caught the throw at the dispatch boundary and converted it to a `tool_result` with `isError: true` — the LLM sees the error and decides what to do next, but the underlying problem is still worth investigating.

**Cause:** Bug in the tool handler, an unexpected condition the handler didn't anticipate (filesystem permission, container exec failure, etc.), or a `FunClawError` from a deeper layer (e.g., `FC-1021` from the runner) that bubbled up through the handler.

**Fix:** Inspect the log file (env-paths' `funclaw/funclaw.log`) for the underlying cause. The visible message in the chat is intentionally short; the structured cause is logged with full context. If it reproduces with the same input, file an issue.

---

## FC-6003 — Tool name not registered

**You will see this when:** the LLM emitted a `tool_use` block with a `name` that isn't in the agent's tool registry for this session. The agent loop converts the unknown call into a `tool_result` with `isError: true` so the LLM can correct, but the underlying issue is usually a prompt or model problem.

**Cause:** The model hallucinated a tool name, or it called a tool from a different agent's vocabulary it picked up in training. Sometimes happens when a model is fine-tuned on examples from a tool ecosystem Fun Claw doesn't share.

**Fix:** No user action needed in most cases — the LLM sees the error and tries again with a real tool name. If it persists across many turns:

- Check that `funclaw chat` reports the right tool list at session start.
- Try a different model (some are more disciplined about sticking to the advertised tool set).
- File an issue with the chat transcript if the model keeps inventing the same nonexistent tool.

---

## FC-6004 — Tool already registered

**You will see this when:** code tries to register two tool definitions with the same `name` against a single `ToolRegistry`. The registry rejects the second registration so we don't silently shadow the original handler — that would let a later wiring step swap out (say) `execute_bash` for something different without anyone noticing.

**Cause:** Almost always a wiring mistake — two different code paths registering the same tool, or a built-in tool sharing a name with a tool brought in by an MCP server. The MCP namespacing rule is supposed to prevent the second case (MCP tools are prefixed with the server name), but a bug there could surface as FC-6004.

**Fix:** Check the stack trace in the log for the second `register()` call site. If it's a duplicate built-in registration, remove one. If it's a collision between a built-in tool and an MCP server, the MCP server's tool needs to be renamed or the namespacing fixed.

---

## FC-6005 — Provider requires an explicit model

**You will see this when:** you started `funclaw chat` with `provider = "openai-compatible"` but neither `defaultModel` (in your config) nor `FUNCLAW_MODEL` (in your environment) is set. Anthropic, OpenAI, and Gemini all have a sensible per-provider fallback model; the OpenAI-compatible case can't have one because every endpoint uses its own model namespace.

**Cause:** Your config picked the OpenAI-compatible provider — typically because you're pointing at a self-hosted vLLM, llama.cpp, LM Studio, or similar — but didn't tell Fun Claw which model to ask for.

**Fix:** Set `defaultModel` in your `funclaw.config.toml`, or export `FUNCLAW_MODEL` in your environment, with the model name your endpoint advertises (for example, `meta-llama/Llama-3.1-8B-Instruct` or `mistral-7b-instruct-v0.3`). Re-run `funclaw chat`.

---

## FC-6010 — `spawn_subagent` rejected at maximum depth

**You will see this when:** something tried to register or invoke `spawn_subagent` at a recursion depth where the next level would exceed ADR-003's hard cap (depth ≤ 3). In normal operation the chat command does not register `spawn_subagent` at depth 3 — this code is defense-in-depth for the case where a programmatic caller built a registry by hand.

**Cause:** Per ADR-003, recursion is capped at depth 3 (parent → child → grandchild → great-grandchild blocked). A pathological agent that tries to spawn unbounded layers of subagents hits this limit; deeply nested agent trees amplify token costs exponentially and obscure debugging.

**Fix:** No user action needed in normal usage — the agent loop converts this into a structured tool error that the LLM sees. If you're calling `buildSpawnSubagentHandler` directly: don't register the tool when `parentDepth === 3`. The chat command's wiring handles this automatically.

---

## FC-6011 — Subagent exceeded its input-token budget

**You will see this when:** a subagent accumulated more than 50,000 input tokens across its turns (or whatever override was passed to `spawn_subagent.max_tokens`). The subagent's loop is aborted and the parent receives a `tool_result` with `isError: true` describing the cap hit.

**Cause:** Per ADR-003, each subagent gets a 50K input-token budget so a single subagent can't burn unbounded context. Common reasons to hit this cap: the subagent's tool calls returned very large outputs that bloated subsequent turns; the subagent looped on a hard problem; the goal asked for analysis of a large input that didn't fit.

**Fix:** No user action needed at the chat level — the parent LLM sees the cap hit and decides whether to retry with a narrower goal, route around, or summarize. If you're authoring agent prompts and consistently hit this: narrow the subagent goal, pre-summarize large inputs before passing them in, or split the subtask across multiple subagents.

---

## FC-6012 — Subagent exceeded its wall-clock timeout

**You will see this when:** a subagent ran past its 300-second wall-clock timeout (or whatever override was passed to `spawn_subagent.timeout_ms`). The chained `AbortSignal` fires, the loop aborts, the container is destroyed.

**Cause:** Per ADR-003, the timeout exists so a subagent that hangs on a tool call (a runaway `execute_bash`, an MCP server that never responds) doesn't block the parent indefinitely.

**Fix:** Same as FC-6011 — the parent's LLM sees the structured error and adapts. If you find subagents legitimately need longer than 5 minutes, the goal is probably too broad: split it into smaller subtasks.

---

## FC-6013 — `spawn_subagent` goal exceeded length cap

**You will see this when:** the LLM passed a `goal` argument to `spawn_subagent` longer than 2,000 characters. The Zod schema rejects this at the dispatch boundary.

**Cause:** The 2,000-char cap is a guard against the parent dumping its entire context window into a single tool call. Goals should be focused subtask descriptions, not full conversation transcripts.

**Fix:** No user action needed — the agent loop converts the rejection into an `isError` tool result and the LLM trims the goal and retries. If you observe this consistently, the parent's prompting may be encouraging it to over-specify subagent goals; tighten the system prompt to ask for terse goals.

---

## FC-6014 — Subagent container creation failed

**You will see this when:** `spawn_subagent` invoked the runtime factory but the factory threw — most often because Docker rejected the container (resource exhaustion, daemon error, image gone) or the policy validator rejected the config (FC-1xxx codes wrapped as the cause).

**Cause:** The factory is what allocates a fresh ephemeral container for the subagent. Failures here happen at container creation time, before the subagent's loop ever starts. Inspect the `cause` field for the underlying FC-1xxx code.

**Fix:** Check Docker is healthy (`docker ps` from the host). If you're hitting resource limits: `docker system prune` to clear stopped containers, or raise the host's available memory. If the cause is FC-1xxx, follow that code's troubleshooting entry.

---

## FC-6015 — Subagent abort cascaded from parent

**You will see this when:** the user pressed Ctrl-C in the parent chat, or some higher-level cap fired in the parent loop. The parent's `AbortSignal` cascaded down to all live subagents, their loops aborted cleanly, and their containers were destroyed. The parent receives `tool_result` entries tagged FC-6015 — **this is informational, not an error in the subagent's behavior.**

**Cause:** Per ADR-003, parent abort cascades to subagents (but a subagent's own internal abort never cascades up to the parent). The cascade is the correct behavior; FC-6015 just lets the parent's LLM distinguish "I was cancelled by the user" from "I hit my own internal cap."

**Fix:** No fix needed — this is the expected outcome of Ctrl-C during a subagent-spawning turn. The parent's LLM will see all in-flight subagents return with FC-6015 and can decide whether to summarize what it has or wait for the user's next prompt.

---

## FC-9999 — Unexpected internal error

**You will see this when:** something unexpected went wrong inside Fun Claw and the failure didn't have a more specific error code. The CLI catches non-`FunClawError` throws at the top level and wraps them as `FC-9999` so the user sees a code rather than a raw stack trace.

**Cause:** Almost always a bug in Fun Claw. Possibilities include unanticipated provider response shapes, third-party SDK exceptions we haven't seen before, or genuine programming mistakes in the agent loop or wiring.

**Fix:** Check the log file for the full structured error including the original cause and stack trace. If reproducible, file an issue with:

- The redacted log excerpt (Pino's redaction will already have stripped any keys).
- A summary of what you were doing when it happened.
- Your provider, model, and Fun Claw version (`funclaw --version`).

`FC-9999` is the catchall — if a failure mode happens often enough to deserve its own code, that code should be added to one of FC-1xxx through FC-6xxx. Specific codes always beat the catchall when feasible.

---

## FC-5005 — Keyfile JSON is invalid or fails schema

**You will see this when:** `~/.funclaw/keys.json` is malformed JSON, or its shape doesn't match `{ "secrets": { "<provider>": "<string>" } }`.

**Cause:** Hand-edited or partially written keyfile.

**Fix:** Replace the contents with the canonical shape:

```json
{
  "secrets": {
    "anthropic": "sk-ant-...",
    "openai": "sk-..."
  }
}
```

Each provider entry is optional; include only the keys you have. Then `chmod 0600` on POSIX.
