# Getting started

Fun Claw runs a small autonomous agent in your terminal. You give it a goal in plain English, and it figures out which commands to run, which files to write, and when to call your LLM provider — Anthropic Claude, OpenAI, Google Gemini, or any OpenAI-compatible endpoint like Ollama or Together. Every command and file write happens inside a Docker sandbox, so the agent can't accidentally redecorate your hard drive.

## Before you install

Three things on the host machine, in this order:

**Node 22 LTS or newer.** Fun Claw is a Node CLI; older Node versions won't run it.

```sh
node --version
```

You should see `v22.x.y` or higher. If you don't have Node, grab it from <https://nodejs.org>.

**Docker, running.** Fun Claw spawns a fresh container for every chat session. On macOS and Windows that means Docker Desktop is open and signed in. On Linux it means the Docker daemon is running and your user is in the `docker` group.

```sh
docker ps
```

If that prints a header line and exits cleanly (even with no containers listed), you're good. If it prints `Cannot connect to the Docker daemon`, start Docker first.

**An API key — or Ollama.** Fun Claw needs to talk to *some* LLM. Three popular options:

- **Anthropic Claude.** Get a key at <https://console.anthropic.com>. Picks `claude-haiku-4-5` as a sensible default during init.
- **OpenAI.** Get a key at <https://platform.openai.com/api-keys>. Defaults to `gpt-4o-mini`.
- **Google Gemini.** Get a key at <https://aistudio.google.com/apikey>. Defaults to `gemini-2.5-flash`.

If you'd rather run everything locally without paying anyone:

- **Ollama**, the OpenAI-compatible local server. Install from <https://ollama.com>, then `ollama pull llama3.2` (or any model that handles tool-calling — Llama 3.2 onward is fine, smaller models often aren't). Pick `openai-compatible` during init and point it at `http://localhost:11434/v1`.

## Install

```sh
npm install -g fun-claw
```

That puts a `funclaw` command on your `PATH` (no hyphen — the npm package is `fun-claw`, the binary is `funclaw`). Verify:

```sh
funclaw --version
```

Should print `0.1.0` (or whichever version you installed).

## First-run setup

```sh
funclaw init
```

The wizard walks you through five questions (six if you pick `openai-compatible` — that path adds an endpoint URL). Defaults are usually right; press Enter to accept them.

**Which LLM provider should Fun Claw use?** Pick `anthropic`, `openai`, `gemini`, or `openai-compatible` (the catch-all for Ollama, Together, Groq, OpenRouter, and the rest of the OpenAI-API-compatible ecosystem).

**Which model should Fun Claw use?** A sensible default is pre-filled per provider. You can change it later by editing the config file.

**Endpoint URL for the OpenAI-compatible provider** (only asked if you picked `openai-compatible`). For Ollama: `http://localhost:11434/v1`. For Together: `https://api.together.xyz/v1`. Look up the equivalent in your provider's docs.

**Where should Fun Claw work from?** This is the directory the agent gets as its workspace — the host folder that gets bind-mounted to `/workspace` inside the sandbox. Default is your current working directory. Pick a folder you don't mind the agent writing to.

**Which Docker image should the sandbox use?** Default is `ghcr.io/ajpandit775/fun-claw-runtime:0.1.0`, the published runtime image with Node 22, Python 3.12, git, curl, jq, and pnpm pre-installed. Stick with the default unless you have a specific reason not to.

**How chatty should Fun Claw be in its logs?** `info` is fine. `debug` and `trace` are for when something's wrong and you want to read the tea leaves.

After the questions, the wizard writes a TOML config file. Where it lands depends on your OS (it'll print the exact path when it's done):

- **Linux:** `~/.config/funclaw-nodejs/config.toml` (or `$XDG_CONFIG_HOME/funclaw-nodejs/config.toml` if you've set that env var).
- **macOS:** `~/Library/Application Support/funclaw-nodejs/Config/config.toml`.
- **Windows:** `%APPDATA%\funclaw-nodejs\Config\config.toml`.

You can edit that file later with any text editor if you want to switch provider, change the model, or move the workspace — re-running `funclaw init` is fine but not required.

## Setting your API key

The wizard explains this at the end of the run. Here are the concrete commands per shell. Replace the placeholder with your real key, and pick the env var that matches your provider (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GOOGLE_API_KEY` — `openai-compatible` reads `OPENAI_API_KEY` too).

**Bash / Zsh** (macOS, Linux, Git Bash on Windows):

```sh
export ANTHROPIC_API_KEY="sk-ant-..."
```

That sets it for the current terminal session only. To persist across new terminals, add the line to `~/.bashrc`, `~/.zshrc`, or `~/.profile` — whichever your shell sources at login — then open a new terminal.

**PowerShell** (Windows, native):

```powershell
$env:ANTHROPIC_API_KEY = "sk-ant-..."
```

`$env:` only sets it for the current PowerShell window. To persist across new windows:

```powershell
[Environment]::SetEnvironmentVariable("ANTHROPIC_API_KEY", "sk-ant-...", "User")
```

That writes the variable to your Windows user profile. Close and reopen PowerShell for it to take effect.

**Or use the keyfile.** The wizard offers to pre-create a `~/.funclaw/keys.json` template (on Windows that's `C:\Users\<you>\.funclaw\keys.json` — hidden-dot directories on Windows look odd but they work fine) and open it in your editor. Paste your key into the right slot (the `"secrets"` field), save, and Fun Claw finds it automatically.

On Linux and macOS the keyfile must be mode `0600` (owner read/write only). The wizard creates it that way and Fun Claw enforces it on every read — if the permissions drift, you'll get an `FC-5001` error with a one-line `chmod 0600` fix to run. On Windows there's no POSIX-mode equivalent, so Fun Claw prints a one-time warning recommending OS-level ACL hardening and reads the file regardless. The standard place to set those ACLs on Windows is right-click the keyfile → Properties → Security.

## Verify with `funclaw doctor`

```sh
funclaw doctor
```

The doctor runs five checks: Docker daemon reachable, your API key works (one-token ping), runtime image is pulled, config file parses, and no orphaned containers from prior sessions are sitting around. Five green checks means you're ready to chat.

The first time `funclaw doctor` runs, it pulls the runtime image from GHCR (around 220 MB compressed). That takes ~30 seconds on a typical home connection and only happens once — the image is cached locally after that. If you skip `funclaw doctor` and go straight to `funclaw chat`, the same pull happens before the first session opens.

If something fails, the doctor prints an `FC-xxxx` error code; the troubleshooting doc maps each code to the cause and fix. There's also `funclaw doctor --clean` to remove orphaned containers, and `funclaw doctor --pull-image` to re-pull the runtime image (useful when a new Fun Claw version ships).

## Your first chat

```sh
funclaw chat
```

You'll see a prompt at the bottom of your terminal. Try something small and concrete:

```
> Write a hello-world Python script and run it.
```

The agent will:

1. Call its `write_file` tool, putting `hello.py` (or `hello_world.py`, depending on the model's mood) at `/workspace/hello.py` inside the sandbox.
2. Call `execute_bash` with `python3 hello.py`.
3. See `Hello, World!` come back from stdout.
4. Tell you what it did, in plain English.

The exact phrasing varies by provider and model, but the shape is consistent: the agent reasons about the goal, calls a tool, reads the result, decides whether to call another tool or wrap up. You'll see the tool calls inline as they happen — small rounded-border boxes showing the tool name, the input as JSON, and the output below it. A small status glyph next to the name shows where each call is: a hollow circle while it waits, a spinner while it runs, a check when it finishes, an X if it errors.

Press `Ctrl-C` once to interrupt the current turn (handy if the agent has gone down a long tangent — the status bar prints `aborted — press enter on a new prompt to continue, or Ctrl-C again to exit`). Press `Ctrl-C` a second time to exit cleanly.

## What just happened

The agent ran inside a fresh Docker container. The container is non-root (uid `10001`), runs with a read-only root filesystem, has `/workspace` bind-mounted to the host directory you picked during `funclaw init`, and gets a writable `/tmp` tmpfs. When the chat ends, Fun Claw stops and removes the container — the only thing left behind on the host is whatever ended up in your workspace folder.

So `hello.py` from the example above is sitting in your host workspace right now. You can `cat` it, edit it, delete it, commit it. The sandbox is what protected the rest of your filesystem; once a file lands in `/workspace`, it's a normal file on disk.

If a session was killed mid-run and a container is still around, `funclaw doctor` lists any orphans and `funclaw doctor --clean` removes them.

## Where to go next

A few related docs in this same folder:

- **FAQ** — answers to the questions people actually ask. ("Does Fun Claw work without Docker?" "Why doesn't my model handle tool calls?" "Where do my keys go?")
- **Troubleshooting** — what to do when something looks wrong. Maps `FC-xxxx` error codes to causes and fixes.
- **Skill authoring** — how to write a `SKILL.md` so the agent picks up reusable instructions for tasks you care about. (Or have Fun Claw draft one for you — the SKILL.md format is small enough that the agent can write a working one from a description.)
- **MCP integration** — connecting Fun Claw to Model Context Protocol servers so the agent can use external tools (filesystem servers, GitHub, Postgres, anything that speaks MCP).

Or just go play. Ask Fun Claw to write a small project, refactor a script, summarize the contents of a directory, draft a `README` for an existing repo. The interesting failure modes show up faster than the success cases — that's normal, and `funclaw doctor` plus the troubleshooting doc are the right recovery path when they do.
