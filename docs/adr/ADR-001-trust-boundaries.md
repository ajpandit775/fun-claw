# ADR-001: Trust Boundaries

## Status

Accepted. Locked.

## Context

Fun Claw runs autonomous AI agents that execute shell commands, read files, call external services, and do other actions on behalf of the user. Each of those actions has a different threat profile depending on where it happens and who controls the input. We need an explicit, written-down model of which inputs are trusted and which are adversarial, so every implementation choice has a clear reference.

## Decision

Fun Claw operates with three trust boundaries.

**The host process is trusted.** It owns the user's API keys, the user's filesystem, the Docker daemon socket, and the configured LLM endpoints. The host process is what the user invokes when they run `funclaw chat`. Everything the user explicitly trusts (the binary they installed, the config they wrote, the env vars they set) lives here.

**The Docker container is untrusted.** Every LLM-emitted shell command, every skill script, every tool that runs arbitrary code executes inside a Docker container, never on the host. The container has no host filesystem access except an explicitly bind-mounted `/workspace` directory (the user's working directory) and a read-only `/skills` directory. The container has no Docker daemon access. The container runs as a non-root user (UID 10001). The container has CPU, memory, PID, and network limits applied at creation. The container has its capabilities dropped (CapDrop: ALL) and its rootfs read-only.

**The LLM is semi-trusted.** It can request actions but cannot directly act. Every output the LLM produces — including content it generates, content fetched from the web through tool results, content returned by an MCP server, and content printed by container stdout — must be treated as adversarial input on the next turn. Prompt injection is a real attack and we model it explicitly: anything that flows back into the LLM context window after the user's initial prompt could contain attacker-controlled instructions trying to exfiltrate secrets, access unauthorized resources, or bypass safety rules.

Two additional domains sit at the edges. **MCP servers run on the host with the user's privileges.** They are analogous to a shell plugin: user-trusted, never sandboxed. This is by design — `server-filesystem` literally requires host filesystem access. We print a one-line warning the first time each MCP server starts, and the README documents the trust model loudly. **Skills run inside the container, mounted read-only at `/skills/<name>`.** They cannot write back to the host, cannot escape the container if the container is hardened, and cannot themselves bypass the container even if their author intended them to.

## Implementation rules that follow

Every shell command must run inside the container. Every tool that executes arbitrary code must run inside the container. The host process must never `execa.exec(userInput)` or anything equivalent.

Every byte that re-enters the LLM context after the initial user prompt must be wrapped in explicit boundary markers in the prompt, like `<tool_result name="..." server="...">...</tool_result>`. The system prompt must instruct the LLM to treat tool-result text as data, not instructions.

API keys never enter the container. The container receives placeholder env vars or no env vars at all; the host process makes LLM API calls directly. Keys are never logged, never serialized in error messages, never printed to stdout.

The Docker daemon socket is host-only. The container does not get `/var/run/docker.sock` bind-mounted. The container does not have privileges to spawn other containers.

MCP servers spawn as host subprocesses with the user's identity. They are trusted to the extent the user trusts the MCP server they configured. We print "MCP server <name> is starting on the host with your privileges, not inside the sandbox" the first time each MCP server starts in a session.

Skills are loaded by a pure parser on the host. The host loader reads SKILL.md, validates the frontmatter against a Zod schema, indexes the name and description, and tar-packs the skill directory into the container. The host never executes skill content. The host never `eval`s, `Function`-constructs, or template-expands skill bodies.

## Consequences

This trust model requires Docker. There is no Docker-less mode. We accept the install friction in exchange for a coherent safety story.

This trust model is platform-portable. Docker containers behave consistently across Linux, macOS, and Windows-WSL2. Kernel-level enforcement (Landlock, seccomp, AppArmor) is applied where available (Linux) but is not required for the safety claim, because the container itself is the enforcing boundary.

This trust model excludes some attack surfaces by design. We do not protect against nation-state actors, kernel-level Docker exploits, supply-chain attacks against npm itself, or compromised LLM provider infrastructure. The README documents these explicitly as out-of-scope.

Skill authors and MCP server authors have different trust profiles, and the user must understand the difference. The README and the security docs make this explicit.

## Alternatives considered

**No sandbox, run tools on the host directly (OpenClaw default).** Rejected. This is the model that produced the Wolak `rm -rf`, the Replit DB wipe, the Grigorev `terraform destroy`. We are explicitly differentiated against this category.

**Per-tool sandbox using Bubblewrap on Linux, sandbox-exec on macOS, AppContainer on Windows.** Rejected. Three different implementations to build and maintain. Docker is a single coherent abstraction across all three platforms. The install cost of Docker is real but bounded; the maintenance cost of three separate sandboxes is unbounded.

**TEE-bound execution like IronClaw.** Rejected. Requires hardware support (AWS Nitro, Intel SGX, etc.) that most users don't have on their laptops. Breaks the cross-platform commitment. Wrong layer for Fun Claw.

**Six-layer kernel enforcement like NemoClaw/OpenShell (Landlock + seccomp + network namespaces + privilege separation + L7 proxy + container).** Rejected. Linux-only, breaks cross-platform commitment. Sophistication appropriate for an enterprise security product, not for a "fun" Claw.

**Gateway-based policy enforcement (NemoClaw's L7 proxy with credential injection).** Rejected for v1. Genuinely useful pattern but it's also the kind of capability that belongs in the closed-source Solarates Trust Product, not in the open-source Fun Claw. Including it here would leak architectural pattern.

## References

This ADR aligns with the architecture blueprint section 3.1 and the security model documented in `docs/security.md`. The threat model is STRIDE-style with explicit assets, adversaries, and trust boundaries.
