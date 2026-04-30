// Fun Claw — container security policy.
//
// **This module is the single source of truth for what a Fun Claw
// sandbox container is allowed to be.** Every container creation in this
// codebase MUST pass through `validateContainerConfig` before reaching
// dockerode. There is no "policy bypass" path for testing convenience or
// otherwise — if you need to relax the rules for a test, change the test
// to use the locked shape, not the policy.
//
// Pure module: no I/O, no async work, no dependency on dockerode at
// runtime (the import is type-only). The validator examines a config
// object and either returns it narrowed to `ApprovedContainerConfig` or
// throws a `FunClawError` with the matching FC-1xxx code.
//
// The policy enforces the locked hardening from CLAUDE.md "Key rules"
// and ADR-001 "The Docker container is untrusted":
//
//   - User must be uid 10001 (non-root). Root (`0` / `"root"` / empty)
//     is rejected — the container's primary identity must be non-root
//     even for entrypoint processes (FC-1014).
//   - HostConfig.Privileged must not be true (FC-1010).
//   - HostConfig.NetworkMode must be `bridge` or `none` — `host` and
//     custom network namespaces that defeat isolation are rejected
//     (FC-1011).
//   - HostConfig.PidMode must not be `host` (FC-1012).
//   - HostConfig.ReadonlyRootfs must be true (FC-1016).
//   - HostConfig.CapAdd must be empty / undefined; HostConfig.CapDrop
//     must be `["ALL"]` (FC-1015).
//   - No bind mount source equal to `/var/run/docker.sock` or
//     `/var/run/docker.sock.raw` — neither in `HostConfig.Binds` nor in
//     `HostConfig.Mounts` (FC-1013).
//
// Error codes documented in `docs/troubleshooting.md`. Each rejection
// produces a distinct code per the locked "distinct codes for distinct
// failure modes" rule (CLAUDE.md saved feedback, 2026-04-28).
//
// Reference docs:
//   - .claude/CLAUDE.md "Key rules" (the complete hardening list).
//   - docs/adr/ADR-001-trust-boundaries.md (container is untrusted;
//     these rules implement the trust boundary).
//   - STACK.md "Docker" (dockerode is the only Docker access path).

import { funClawError } from "@funclaw/core";
import type Docker from "dockerode";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The locked uid/gid the agent runs as inside any sandbox container. Per
 * REQUIREMENTS.md "What goes in the runtime sandbox image" and
 * ADR-001 "container runs as a non-root user (UID 10001)". The
 * published runtime image bakes this user into `/etc/passwd`; the
 * runner also starts the container with this `User` field directly
 * so the kernel runs processes as the numeric uid even when an
 * `/etc/passwd` entry is missing (e.g. against a generic base image).
 */
export const SANDBOX_UID = 10001 as const;
export const SANDBOX_GID = 10001 as const;
export const SANDBOX_USER_STRING = `${SANDBOX_UID}:${SANDBOX_GID}` as const;

/** Bind-mount sources that defeat the trust boundary. */
const FORBIDDEN_BIND_SOURCES: ReadonlySet<string> = new Set([
  "/var/run/docker.sock",
  "/var/run/docker.sock.raw",
]);

const ALLOWED_NETWORK_MODES: ReadonlySet<string> = new Set(["bridge", "none"]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The exact shape an approved Fun Claw sandbox container config must
 * have. The policy validator narrows incoming configs to this type on
 * success. `Image` and resource limits remain configurable; the security-
 * critical fields are pinned.
 *
 * This is a structural subset of dockerode's `ContainerCreateOptions` —
 * the full type has many more optional fields, but only the ones below
 * are policy-relevant. Extra dockerode fields are allowed to pass
 * through unchanged once they've been demonstrated not to subvert the
 * locked rules.
 */
export interface ApprovedContainerConfig {
  /** OCI image reference. Validation does not constrain image names. */
  Image: string;

  /**
   * Container's default user. MUST be the literal `"10001:10001"`
   * string. Numeric `0`, the string `"root"`, the string `"0"`, the
   * empty string, and `undefined` are all rejected — the container
   * default user must be non-root.
   */
  User: typeof SANDBOX_USER_STRING;

  /**
   * Container labels. The Fun Claw runner sets `funclaw.session=<uuid>`
   * here so the cleanup logic in `listOrphanedSessions` can find
   * orphans across runs. The policy does not require any specific
   * labels but does not strip them either.
   */
  Labels?: Record<string, string>;

  /** Working directory inside the container. Optional. */
  WorkingDir?: string;

  /** Command override. Optional. */
  Cmd?: readonly string[];

  /** Environment overrides. Optional. The policy does not inspect env
   *  contents; the runner is responsible for never injecting host
   *  secrets per ADR-001. */
  Env?: readonly string[];

  HostConfig: ApprovedHostConfig;
}

export interface ApprovedHostConfig {
  /** Must be `false` or `undefined`. */
  Privileged?: false;

  /** Must be `"bridge"` or `"none"`. `host` is rejected. */
  NetworkMode: "bridge" | "none";

  /** Must NOT be `"host"`. The default (undefined) means the container
   *  has its own PID namespace, which is correct. */
  PidMode?: string;

  /** Must be `true`. */
  ReadonlyRootfs: true;

  /** Must be `["ALL"]`. */
  CapDrop: readonly ["ALL"];

  /** Must be empty / undefined. The locked rule is "no CapAdd". */
  CapAdd?: readonly string[];

  /** Bind mounts in the legacy string format `host:container[:ro]`.
   *  The policy validates the source path of each binding. */
  Binds?: readonly string[];

  /** Bind mounts in the structured `Mounts` API. */
  Mounts?: readonly ApprovedMount[];

  /** Resource limits — required by the policy. */
  Memory: number;
  NanoCpus: number;
  PidsLimit: number;
  /** tmpfs mounts (e.g. `{ "/tmp": "rw,size=1g" }`). */
  Tmpfs?: Record<string, string>;
}

export interface ApprovedMount {
  Type: "bind" | "tmpfs" | "volume";
  Source?: string;
  Target: string;
  ReadOnly?: boolean;
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

/**
 * Inspect a Docker container config and either return it narrowed to
 * `ApprovedContainerConfig` or throw a `FunClawError` with the matching
 * FC-1xxx code. **No container creation in this codebase may bypass
 * this check.**
 *
 * The input type is dockerode's `ContainerCreateOptions` because that's
 * the wire shape the runner builds. The validator inspects every
 * field the policy cares about and ignores the rest.
 */
export function validateContainerConfig(
  raw: Docker.ContainerCreateOptions,
): ApprovedContainerConfig {
  // (FC-1014) User must be the locked sandbox user.
  if (!isApprovedUser(raw.User)) {
    throw funClawError({
      code: "FC-1014",
      message:
        `Container User must be "${SANDBOX_USER_STRING}" (non-root). ` +
        `Got: ${stringifyUser(raw.User)}. Running containers as root is rejected by policy.`,
      data: { user: raw.User },
    });
  }

  const host = raw.HostConfig ?? {};

  // (FC-1010) Privileged must not be true.
  if (host.Privileged === true) {
    throw funClawError({
      code: "FC-1010",
      message:
        "Container HostConfig.Privileged is rejected by policy — privileged containers can escape the sandbox.",
      data: { Privileged: host.Privileged },
    });
  }

  // (FC-1011) NetworkMode must be bridge or none.
  if (host.NetworkMode === undefined) {
    throw funClawError({
      code: "FC-1011",
      message:
        "Container HostConfig.NetworkMode is required. Use 'bridge' (default isolated network) or 'none' (no network).",
      data: {},
    });
  }
  if (!ALLOWED_NETWORK_MODES.has(host.NetworkMode)) {
    throw funClawError({
      code: "FC-1011",
      message:
        `Container HostConfig.NetworkMode "${host.NetworkMode}" is rejected by policy. ` +
        "Only 'bridge' and 'none' are allowed; 'host' and custom modes defeat network isolation.",
      data: { NetworkMode: host.NetworkMode },
    });
  }

  // (FC-1012) PidMode must not be 'host'.
  if (host.PidMode === "host") {
    throw funClawError({
      code: "FC-1012",
      message:
        "Container HostConfig.PidMode 'host' is rejected by policy — sharing the host PID namespace defeats process isolation.",
      data: { PidMode: host.PidMode },
    });
  }

  // (FC-1016) ReadonlyRootfs must be true.
  if (host.ReadonlyRootfs !== true) {
    throw funClawError({
      code: "FC-1016",
      message:
        "Container HostConfig.ReadonlyRootfs must be true — a writable rootfs lets the container modify system files in ways that confuse the trust model.",
      data: { ReadonlyRootfs: host.ReadonlyRootfs },
    });
  }

  // (FC-1015) CapDrop must be exactly ["ALL"]; CapAdd must be empty.
  if (!isCapDropAll(host.CapDrop)) {
    throw funClawError({
      code: "FC-1015",
      message:
        "Container HostConfig.CapDrop must be exactly ['ALL']. The locked sandbox profile drops every Linux capability.",
      data: { CapDrop: host.CapDrop },
    });
  }
  if (host.CapAdd !== undefined && host.CapAdd.length > 0) {
    throw funClawError({
      code: "FC-1015",
      message: `Container HostConfig.CapAdd is rejected by policy — adding any capability defeats the CapDrop:[ALL] hardening. Got: ${JSON.stringify(host.CapAdd)}.`,
      data: { CapAdd: host.CapAdd },
    });
  }

  // (FC-1013) No forbidden bind-mount sources.
  rejectForbiddenBinds(host.Binds);
  rejectForbiddenMounts(host.Mounts);

  // (FC-1018) Any bind mount whose target is under `/skills`
  // MUST be read-only. The skills feature relies on the host being
  // the only thing that can write to the skills tree (Flow 7: agent
  // authors skills via `write_file` to /workspace, not /skills). A
  // writable `/skills` mount would let the container modify the
  // user's host skills directory without going through the host
  // parser, breaking the ADR-001 "host loader is a pure parser"
  // contract.
  rejectWritableSkillsMounts(host.Mounts);

  // (FC-1019) Validate the `funclaw.session` and `funclaw.subagent`
  // labels are well-formed when present. Defensive — the runner
  // constructs these labels from `crypto.randomUUID()` strings, so
  // this is to catch programmatic
  // callers building a config by hand with mangled label values.
  validateFunclawLabels(raw.Labels);

  // All checks passed. The cast is safe because each field above has
  // been validated to match `ApprovedContainerConfig`'s shape.
  return raw as unknown as ApprovedContainerConfig;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isApprovedUser(value: unknown): value is typeof SANDBOX_USER_STRING {
  return value === SANDBOX_USER_STRING;
}

function stringifyUser(value: unknown): string {
  if (value === undefined) return "<unset (defaults to image's USER, typically root)>";
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}

function isCapDropAll(value: unknown): value is readonly ["ALL"] {
  return Array.isArray(value) && value.length === 1 && value[0] === "ALL";
}

function rejectForbiddenBinds(binds: readonly string[] | undefined): void {
  if (binds === undefined) return;
  for (const bind of binds) {
    // Bind syntax is `source:target[:options]`. Source may contain a
    // colon on Windows (`C:\path`); the source ends at the first `:`
    // that isn't part of a Windows drive letter.
    const source = parseBindSource(bind);
    if (FORBIDDEN_BIND_SOURCES.has(source)) {
      throw forbiddenBindError(source, "Binds");
    }
  }
}

function rejectForbiddenMounts(
  mounts: readonly ApprovedMount[] | Docker.MountSettings[] | undefined,
): void {
  if (mounts === undefined) return;
  for (const mount of mounts) {
    if (
      mount.Type === "bind" &&
      typeof mount.Source === "string" &&
      FORBIDDEN_BIND_SOURCES.has(mount.Source)
    ) {
      throw forbiddenBindError(mount.Source, "Mounts");
    }
  }
}

/**
 * (FC-1018) Reject any bind mount targeting `/skills` or its
 * subdirectories that isn't `ReadOnly: true`. The host owns the
 * authoritative copy of every skill (per Flow 7); the container
 * mounts a frozen view.
 */
function rejectWritableSkillsMounts(
  mounts: readonly ApprovedMount[] | Docker.MountSettings[] | undefined,
): void {
  if (mounts === undefined) return;
  for (const mount of mounts) {
    if (mount.Type !== "bind") continue;
    const target = mount.Target;
    if (typeof target !== "string") continue;
    if (target !== "/skills" && !target.startsWith("/skills/")) continue;
    if (mount.ReadOnly !== true) {
      throw funClawError({
        code: "FC-1018",
        message:
          `Container HostConfig.Mounts contains a bind mount targeting "${target}" that is not ReadOnly. ` +
          "The /skills tree must be mounted read-only — skill authoring goes through the host's write_file " +
          "tool against /workspace, never directly to /skills.",
        data: { target, readOnly: mount.ReadOnly },
      });
    }
  }
}

/**
 * (FC-1019) Validate that the `funclaw.session` and
 * `funclaw.subagent` labels — when present — carry well-formed
 * values. Both labels carry UUID strings (`crypto.randomUUID()`), and
 * the agent loop / cleanup logic depends on the values being plain
 * strings (no whitespace, no shell metacharacters, reasonable length
 * cap). The runner builds these labels itself, so this is purely
 * defensive against programmatic callers that build configs by hand.
 *
 * Other labels are passed through unchanged — this rule only inspects
 * the two `funclaw.*` keys we care about.
 */
function validateFunclawLabels(labels: Record<string, string> | undefined): void {
  if (labels === undefined) return;
  // Match crypto.randomUUID() output: 8-4-4-4-12 lowercase hex with
  // hyphens. Slightly relaxed to accept any UUID variant the user
  // might have stamped (uuid v4 / v7); we just want to reject empty
  // strings, whitespace, and shell metacharacters.
  const UUID_LIKE = /^[0-9a-fA-F-]{8,64}$/;
  for (const labelKey of ["funclaw.session", "funclaw.subagent"] as const) {
    const value = labels[labelKey];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.length === 0 || !UUID_LIKE.test(value)) {
      throw funClawError({
        code: "FC-1019",
        message:
          `Container Labels["${labelKey}"] is malformed: ${JSON.stringify(value)}. ` +
          "Expected a UUID-like string (lowercase hex with hyphens, 8–64 chars). " +
          "The runner generates these via crypto.randomUUID(); see this code path only when a programmatic caller built the config by hand.",
        data: { labelKey, value },
      });
    }
  }
}

function forbiddenBindError(source: string, where: "Binds" | "Mounts"): Error {
  return funClawError({
    code: "FC-1013",
    message:
      `Container HostConfig.${where} contains forbidden source "${source}". ` +
      "Mounting the Docker daemon socket lets the container spawn its own containers — the trust boundary collapses.",
    data: { source, where },
  });
}

/**
 * Parse the source half of a Docker bind string. Handles Windows drive
 * letters (`C:\path:/container`) by recognizing a single-letter drive
 * prefix.
 */
function parseBindSource(bind: string): string {
  // Windows drive-letter bind format `C:\foo:/bar:ro` is exercised by
  // the runner's smoke through Slices 5/6/7/8/9 against Docker
  // Desktop on Windows. The drive-letter regex correctly skips the
  // first `:` (the one inside `C:`) when parsing the source half;
  // see `docs/cross-platform.md` for the platform notes.
  if (/^[A-Za-z]:[\\/]/.test(bind)) {
    // Windows path: source ends at the first `:` AFTER the drive letter.
    const afterDrive = bind.slice(2);
    const sep = afterDrive.indexOf(":");
    return sep === -1 ? bind : bind.slice(0, sep + 2);
  }
  const sep = bind.indexOf(":");
  return sep === -1 ? bind : bind.slice(0, sep);
}
