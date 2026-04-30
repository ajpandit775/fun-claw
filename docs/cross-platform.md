# Cross-platform notes

Fun Claw runs on Linux, macOS, and Windows from v1 (per the
`REQUIREMENTS.md` "Supported platforms" section). Most things just
work. This page covers the handful of platform-specific quirks where
behavior differs in ways users might notice — paths, signals,
permissions, subprocess invocation. For specific error codes and
their fixes, see `docs/troubleshooting.md`.

---

## OS-correct paths

Fun Claw uses `env-paths` to resolve config / data / log directories
to the OS-correct location. The directory name is `funclaw-nodejs`
(the `-nodejs` suffix is `env-paths` v3's convention for Node-tool
data, distinguishing Fun Claw's directory from anything a future
non-Node Fun Claw release might use).

| Platform   | Config                                                  | User skills                                                      | Logs                                                  |
| ---------- | ------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------- |
| Linux      | `$XDG_CONFIG_HOME/funclaw-nodejs/config.toml`           | `$XDG_DATA_HOME/funclaw-nodejs/skills/`                          | `$XDG_STATE_HOME/funclaw-nodejs/log/funclaw.log`      |
| macOS      | `~/Library/Application Support/funclaw-nodejs/Config/`  | `~/Library/Application Support/funclaw-nodejs/Data/skills/`      | `~/Library/Logs/funclaw-nodejs/funclaw.log`           |
| Windows    | `%APPDATA%\funclaw-nodejs\Config\config.toml`           | `%LOCALAPPDATA%\funclaw-nodejs\Data\skills\`                     | `%LOCALAPPDATA%\funclaw-nodejs\Log\funclaw.log`       |

The keyfile is the exception — it lives at `~/.funclaw/keys.json`
(POSIX) / `%USERPROFILE%\.funclaw\keys.json` (Windows) by spec, NOT
under `env-paths`. Per `REQUIREMENTS.md` "Authentication": "API key
sources: env vars first, then `~/.funclaw/keys.json` (chmod 0600
enforced on POSIX systems)." The dotfile location is part of the
public spec.

If you don't know where Fun Claw thinks your config lives, run
`funclaw doctor` — Check 4 prints the resolved config path on every
run (pass or fail).

---

## Signals (Ctrl-C and friends)

`SIGINT` (Ctrl-C in the terminal) works on all three platforms. Fun
Claw's chat TUI uses a double-tap policy: first Ctrl-C aborts the
current turn (cancels the in-flight LLM stream and any tool
executions); a second Ctrl-C within ~2 seconds exits the chat.

`SIGTERM` works on Linux and macOS — sending SIGTERM to a Fun Claw
process produces the same clean shutdown as Ctrl-C. **On Windows
native, SIGTERM is not a real signal at the OS level** (Node converts
most kill signals to plain process termination). Windows users who
need to force-kill Fun Claw should:

- Try Ctrl-C in the terminal first.
- If that doesn't work, close the terminal window.
- As a last resort, find the `node` process in Task Manager and end
  it. Fun Claw's container labels (`funclaw.session=<uuid>`) make
  cleanup easy afterwards: re-run `funclaw doctor --clean` to remove
  any orphaned sandbox containers.

---

## Docker socket / named pipe

`dockerode` (Fun Claw's Docker client) auto-detects the right
transport:

- **Linux / macOS / WSL2:** the Unix socket at
  `/var/run/docker.sock`.
- **Windows native:** the named pipe `\\.\pipe\docker_engine`.

You don't need to configure anything — if Docker Desktop or the
docker daemon is running and your user can talk to it, Fun Claw will
connect. `funclaw doctor` Check 1 verifies the connection and prints
the server version on success. See `troubleshooting.md` FC-1001
(daemon unreachable) and FC-1004 (daemon ping timeout) for failure
modes.

### Bind mount source paths on Windows

When Fun Claw mounts the host's working directory into the sandbox
container, the bind source is a Windows path like `C:\Users\you\proj`
or `C:/Users/you/proj`. Docker Desktop accepts both forms. The
runner passes through whatever Node's `path.resolve()` produced for
the configured `workingDir`. If you've configured the working
directory by hand and Docker rejects the bind, try forward slashes.

The container side of the bind is always POSIX (`/workspace`,
`/skills/<name>`) — that's a hard rule per CLAUDE.md "Cross-platform"
and is enforced via `path.posix.join` at every mount construction
site.

---

## Keyfile permissions

The keyfile (`~/.funclaw/keys.json`) is enforced at `chmod 0600` on
POSIX systems — Fun Claw refuses to read it if anyone other than
the owner has read access (FC-5001). **On Windows, file modes are
mostly ignored** (Windows uses ACLs, a separate permission model).
Fun Claw prints a one-time warning per process when reading a
keyfile on Windows and proceeds without enforcing.

Windows users who care about keyfile confidentiality should manage
the ACL via:

1. Right-click `keys.json` → Properties → Security tab.
2. Edit → Remove all entries except your user.
3. Apply.

This is a manual step Fun Claw doesn't automate; ACL management on
Windows is a deeper rabbit hole than v1 wants to descend into. The
container isolation is the primary security boundary regardless of
keyfile mode — Fun Claw never copies the keyfile into the sandbox
container.

---

## Subprocess invocation (init wizard)

The `funclaw init` wizard offers to open the keyfile in your editor.
The platform paths:

- `$VISUAL` / `$EDITOR` if set — used as-is.
- macOS fallback: `open <path>` (uses the file's default Mac
  application).
- Linux fallback: `xdg-open <path>`.
- Windows fallback: `cmd /c start "" <path>` (uses the file's default
  Windows handler).

The `start` cmd builtin requires an empty `""` window-title argument
when the path contains spaces — the wizard supplies it.

---

## MCP server subprocess spawning on Windows

The MCP SDK's `StdioClientTransport` uses `cross-spawn` to launch
MCP server subprocesses (e.g. `npx -y @modelcontextprotocol/server-filesystem`).
On POSIX, `cross-spawn` calls `child_process.spawn` directly. **On
Windows, `cross-spawn` shells the command through `cmd.exe /c`** —
this is what makes argv quoting work safely with paths containing
spaces, but it changes the failure mode for "command not found":

- POSIX: missing command → ENOENT at spawn → FC-3001 (spawn failure).
- Windows: `cmd.exe` runs fine, prints "is not recognized" to stderr,
  exits non-zero → the JSON-RPC handshake fails → FC-3002 (init
  handshake failure).

The user-visible outcome is the same: chat continues without that
server's tools and a clear FC-3xxx code is logged. The
`smoke-mcp-client.cjs` smoke accepts FC-3001 / FC-3002 / FC-3003 as
the valid bail paths for that reason.

---

## Bind mount permissions on Linux native

On Docker Desktop (macOS / Windows), the VM layer translates uids
transparently — the sandbox user (uid 10001 inside the container)
can write to the bind-mounted `/workspace` regardless of who owns
the host directory.

**On Linux native**, if the host `workingDir` is owned by a uid the
container's root can't reach (rare, but possible with restrictive
ACLs), the container's setup script silently fails to chown
`/workspace` to uid 10001. The agent then can't write to its
workspace and surfaces vague "permission denied" errors when running
shell commands.

If you're on Linux native and seeing permission-denied errors from
the agent: check that `chmod o+rwX <workingDir>` (or chown to your
user) clears them. The Slice 11 published runtime image
(`ghcr.io/funclaw/runtime:0.x-noble`) uses userns-remap to fix this
properly; until then, host-side permissions are the workaround.

---

## Where to look first

If something's not working on your platform, the order to check:

1. `funclaw doctor` — five-check diagnostic that surfaces the most
   common failures with FC codes pointing at this doc and
   `troubleshooting.md`.
2. `funclaw doctor --json` — structured output if you're scripting.
3. Platform-specific entries here.
4. The matching FC code in `troubleshooting.md`.
5. Open an issue with `funclaw doctor --json` output attached.
