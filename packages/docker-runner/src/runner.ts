// Fun Claw — Docker container runner.
//
// Wraps dockerode to manage per-session sandbox containers. Every
// container created here passes through `policy.ts.validateContainerConfig`
// before reaching dockerode — the policy is the trust-boundary
// enforcement and there is no bypass path.
//
// Lifecycle (one container per `funclaw chat` session):
//   1. `ensureImage()` — checks the image is present, pulls if missing,
//      reports progress via an optional callback.
//   2. `createSession(uuid)` — creates a container labeled
//      `funclaw.session=<uuid>`, validates via policy, starts it, runs
//      a one-time `--user 0:0` setup exec to populate /etc/passwd and
//      chown /workspace, returns a `SessionHandle`.
//   3. `SessionHandle.exec(argv, opts)` — async-iterable streaming exec
//      as the sandbox user (uid 10001). Yields stdout/stderr deltas
//      and a final exit event.
//   4. `destroySession(handle)` — stops + removes the container,
//      idempotent.
//   5. `listOrphanedSessions(activeIds)` — finds containers carrying the
//      session label whose UUID isn't in `activeIds`. The `funclaw
//      doctor` command consumes this with the active list from `state.json`.
//
// Reference docs:
//   - .claude/CLAUDE.md "Key rules" (the hardening list).
//   - docs/adr/ADR-001-trust-boundaries.md (the trust boundary this
//     module enforces).
//   - STACK.md "Docker" (dockerode is the only Docker access path).
//   - REQUIREMENTS.md Flow 2 chat (uses one container per session).

import * as path from "node:path";
import { Writable } from "node:stream";
import { funClawError } from "@funclaw/core";
import Docker from "dockerode";
import {
  type ApprovedContainerConfig,
  SANDBOX_GID,
  SANDBOX_UID,
  SANDBOX_USER_STRING,
  validateContainerConfig,
} from "./policy.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Per CLAUDE.md "Cross-platform from v1": container-internal paths are
// always POSIX. Use path.posix.join for any in-container path
// composition; never the platform-aware path.join.
const posixJoin = path.posix.join;

const DEFAULT_MEMORY_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB
const DEFAULT_NANO_CPUS = 2_000_000_000; // 2 cores
const DEFAULT_PIDS_LIMIT = 256;
const DEFAULT_TMPFS_BYTES = 1024 * 1024 * 1024; // 1 GiB
const SESSION_LABEL_KEY = "funclaw.session";
/** Per ADR-003: every subagent container carries this additional
 *  label alongside `funclaw.session`. Cleanup logic
 *  (`listOrphanedSessions`, `funclaw doctor --clean`) filters by
 *  `funclaw.session`; subagent containers surface in the same list
 *  with a non-undefined `subagentId` field. */
const SUBAGENT_LABEL_KEY = "funclaw.subagent";
const STOP_TIMEOUT_SECONDS = 5;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Resolved configuration for a `DockerRunner` instance. */
export interface DockerRunnerConfig {
  /** OCI image reference (e.g. `ubuntu:24.04`). */
  image: string;
  /** Host directory bind-mounted to `/workspace` (read-write). */
  workingDir: string;
  /** Docker network mode. Per policy, only `bridge` and `none` allowed. */
  networkMode: "bridge" | "none";
  /** Optional resource overrides; sensible defaults applied if omitted. */
  memoryBytes?: number;
  nanoCpus?: number;
  pidsLimit?: number;
  tmpfsTmpBytes?: number;
}

/**
 * One mount entry for the `/skills` tree, supplied to `createSession`.
 * Each loaded skill maps to exactly one entry; the runner constructs
 * a read-only bind mount at `/skills/<name>`. Per-skill mounts (not
 * a copied tree) avoid host-side copies and the Windows
 * symlink-permission gap.
 */
export interface SkillMount {
  /** Skill name. Becomes the mount target's last segment:
   *  `/skills/<name>`. Must already have been validated against the
   *  skill-name regex in `@funclaw/skills` — the runner does NOT
   *  re-validate (single-source-of-truth rule for that regex). */
  name: string;
  /** Absolute host path to the skill's directory. Mounted read-only. */
  hostPath: string;
}

/** Information about an orphaned session container. */
export interface OrphanedSessionInfo {
  containerId: string;
  /** The `funclaw.session` label value — root session UUID. Both
   *  root and subagent containers carry the SAME root session UUID
   *  here per ADR-003 (subagent containers stamp
   *  `funclaw.session=<root-uuid>` + `funclaw.subagent=<sub-uuid>`).
   *  Cleanup logic groups by this. */
  sessionId: string;
  /** When set, this container is a subagent container, and the value
   *  is the subagent UUID stamped in the `funclaw.subagent` label.
   *  When undefined, the container is a root session container. */
  subagentId?: string;
  state: string;
  created: number;
}

/** Options for `SessionHandle.exec`. */
export interface ExecOptions {
  /** Working directory inside the container. Defaults to `/workspace`. */
  cwd?: string;
  /** Cancellation signal; aborting stops the container. */
  abortSignal?: AbortSignal;
  /** Wall-clock timeout in milliseconds; expiry stops the container. */
  timeoutMs?: number;
  /**
   * Optional stdin payload. When provided, the exec is created with
   * `AttachStdin: true` and the payload is written to the hijacked
   * stream after start. The stream is half-closed after the write so
   * the child sees EOF on stdin and can complete commands like
   * `cat > /workspace/foo.txt`.
   *
   * Strings are encoded as UTF-8. Buffers are written verbatim — use
   * Buffer for binary content (e.g. `write_file` with
   * `encoding: "binary"`).
   *
   * Callers that omit stdin keep the default `stdin: false` behavior.
   */
  stdin?: string | Buffer;
}

/** Discriminated union of streaming exec events. */
export type ExecStreamEvent =
  | { type: "stdout"; data: Buffer }
  | { type: "stderr"; data: Buffer }
  | { type: "exit"; code: number };

/** Optional dependency injection for tests / smokes. */
export interface DockerRunnerDeps {
  /** Inject a pre-configured dockerode instance (e.g. with custom
   *  socketPath). Defaults to `new Docker()` which auto-detects the
   *  Unix socket on POSIX and the named pipe on Windows. */
  docker?: Docker;
}

// ---------------------------------------------------------------------------
// DockerRunner
// ---------------------------------------------------------------------------

export class DockerRunner {
  private readonly docker: Docker;
  private readonly resolved: Required<DockerRunnerConfig>;

  constructor(config: DockerRunnerConfig, deps: DockerRunnerDeps = {}) {
    this.resolved = {
      image: config.image,
      workingDir: config.workingDir,
      networkMode: config.networkMode,
      memoryBytes: config.memoryBytes ?? DEFAULT_MEMORY_BYTES,
      nanoCpus: config.nanoCpus ?? DEFAULT_NANO_CPUS,
      pidsLimit: config.pidsLimit ?? DEFAULT_PIDS_LIMIT,
      tmpfsTmpBytes: config.tmpfsTmpBytes ?? DEFAULT_TMPFS_BYTES,
    };
    // dockerode auto-detects the Unix socket on POSIX and the named
    // pipe `\\.\pipe\docker_engine` on Windows native. Verified
    // working through Slices 5/6/7/8/9 smokes against Docker Desktop
    // 29.4.1 on Windows; see `docs/cross-platform.md` for the
    // platform notes.
    this.docker = deps.docker ?? new Docker();
  }

  /**
   * Ensure the runtime image exists locally; pull it if not. Daemon
   * unreachable surfaces as FC-1001; pull failures surface as FC-1022.
   */
  async ensureImage(opts: { onProgress?: (status: string) => void } = {}): Promise<void> {
    try {
      await this.docker.getImage(this.resolved.image).inspect();
      opts.onProgress?.(`Image ${this.resolved.image} already present locally.`);
      return;
    } catch (err) {
      if (isDockerDaemonUnreachable(err)) {
        throw daemonUnreachableError(err);
      }
      if (!isImageNotFound(err)) {
        throw funClawError({
          code: "FC-1022",
          message: `Failed to inspect image ${this.resolved.image}: ${errorMessage(err)}`,
          cause: err,
          data: { image: this.resolved.image },
        });
      }
      // Image not found locally → pull below.
    }

    let pullStream: NodeJS.ReadableStream;
    try {
      pullStream = (await this.docker.pull(this.resolved.image)) as NodeJS.ReadableStream;
    } catch (err) {
      if (isDockerDaemonUnreachable(err)) {
        throw daemonUnreachableError(err);
      }
      throw funClawError({
        code: "FC-1022",
        message: `Failed to pull image ${this.resolved.image}: ${errorMessage(err)}`,
        cause: err,
        data: { image: this.resolved.image },
      });
    }

    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(
        pullStream,
        (err) => (err ? reject(err) : resolve()),
        (event) => {
          const status = (event as { status?: string }).status;
          if (typeof status === "string" && status.length > 0) {
            opts.onProgress?.(status);
          }
        },
      );
    }).catch((err) => {
      throw funClawError({
        code: "FC-1022",
        message: `Image pull failed mid-stream for ${this.resolved.image}: ${errorMessage(err)}`,
        cause: err,
        data: { image: this.resolved.image },
      });
    });
  }

  /**
   * Create and start a sandbox container labeled with `sessionUuid`,
   * run the one-time setup exec, and return a `SessionHandle` for
   * subsequent commands. Throws FC-1001 / FC-1020 / FC-1xxx policy
   * codes on the documented failure modes.
   *
   * `skillsMounts` is the resolved set of skills the chat command
   * discovered at session-start time. Each entry becomes a read-only
   * bind mount at `/skills/<name>`. Empty array means no `/skills`
   * directory exists in the container.
   */
  async createSession(
    sessionUuid: string,
    skillsMounts: readonly SkillMount[] = [],
  ): Promise<SessionHandle> {
    const spec = this.buildContainerConfig(sessionUuid, skillsMounts);
    const validated = validateContainerConfig(spec);
    return this.startContainerAndSetup(validated, sessionUuid);
  }

  /**
   * Per ADR-003: spawn a fresh ephemeral container for a subagent.
   * The container carries TWO labels:
   *   - `funclaw.session=<rootSessionUuid>` (same root UUID as the
   *     parent session — cleanup logic groups by this).
   *   - `funclaw.subagent=<subagentUuid>` (the subagent's own UUID,
   *     used for log filtering and identifying which subagent's
   *     container is which).
   *
   * Skills mounts are inherited from the parent (passed in by the
   * spawn_subagent factory). `/workspace` and `/tmp` are fresh —
   * the subagent does NOT see the parent's working files (per
   * ADR-003: "It does not see the parent's `/workspace` mount unless
   * the spawn tool is configured to share it"; v1 keeps each
   * subagent's `/workspace` isolated).
   *
   * Returns a `SessionHandle` bound to the subagent's container.
   * Cleanup is the caller's responsibility (the spawn_subagent
   * handler runs `cleanup()` in a `finally` block — see the
   * `SubagentRuntimeFactoryResult` contract in
   * `@funclaw/core/tools/spawn-subagent`).
   */
  async spawnSubagentSession(
    rootSessionUuid: string,
    subagentUuid: string,
    skillsMounts: readonly SkillMount[] = [],
  ): Promise<SessionHandle> {
    const spec = this.buildContainerConfig(rootSessionUuid, skillsMounts, subagentUuid);
    const validated = validateContainerConfig(spec);
    // The handle's `sessionUuid` field carries the SUBAGENT's UUID
    // (not the root) so log lines tagging exec output identify which
    // subagent ran which command. The container's
    // `funclaw.session=<rootUuid>` label is what cleanup matches on.
    return this.startContainerAndSetup(validated, subagentUuid);
  }

  /**
   * Internal: start a validated container, run the one-time setup
   * exec, return a SessionHandle. Shared by `createSession` and
   * `spawnSubagentSession`. The label-application happened during
   * `buildContainerConfig`; here we just bring up the container.
   */
  private async startContainerAndSetup(
    validated: ApprovedContainerConfig,
    handleUuid: string,
  ): Promise<SessionHandle> {
    let container: Docker.Container;
    try {
      // The cast to ContainerCreateOptions is safe — validated is a
      // structural subset that dockerode accepts unchanged.
      container = await this.docker.createContainer(validated as Docker.ContainerCreateOptions);
    } catch (err) {
      if (isDockerDaemonUnreachable(err)) {
        throw daemonUnreachableError(err);
      }
      throw funClawError({
        code: "FC-1020",
        message: `Container failed to create: ${errorMessage(err)}`,
        cause: err,
        data: { handleUuid, image: this.resolved.image },
      });
    }

    try {
      await container.start();
    } catch (err) {
      if (isDockerDaemonUnreachable(err)) {
        throw daemonUnreachableError(err);
      }
      // Best-effort cleanup of the half-created container.
      await safeRemove(container);
      throw funClawError({
        code: "FC-1020",
        message: `Container failed to start: ${errorMessage(err)}`,
        cause: err,
        data: { handleUuid, image: this.resolved.image },
      });
    }

    try {
      await this.runSetup(container);
    } catch (err) {
      await safeRemove(container);
      throw err;
    }

    return new SessionHandle(container, handleUuid, this.docker);
  }

  /** Stop and remove the session container. Idempotent. */
  async destroySession(handle: SessionHandle): Promise<void> {
    await handle.destroy();
  }

  /**
   * Find containers carrying the `funclaw.session` label whose UUID is
   * not in `activeSessionIds`. The `funclaw doctor` command consumes
   * this with the active list read from `state.json`.
   */
  async listOrphanedSessions(
    activeSessionIds: readonly string[] = [],
  ): Promise<OrphanedSessionInfo[]> {
    let containers: Docker.ContainerInfo[];
    try {
      containers = await this.docker.listContainers({
        all: true,
        filters: { label: [SESSION_LABEL_KEY] },
      });
    } catch (err) {
      if (isDockerDaemonUnreachable(err)) {
        throw daemonUnreachableError(err);
      }
      throw funClawError({
        code: "FC-1020",
        message: `Failed to list session containers: ${errorMessage(err)}`,
        cause: err,
      });
    }

    const active = new Set(activeSessionIds);
    const orphans: OrphanedSessionInfo[] = [];
    for (const c of containers) {
      const labels = c.Labels ?? {};
      const sessionId = labels[SESSION_LABEL_KEY];
      if (sessionId === undefined) continue;
      if (active.has(sessionId)) continue;
      // Surface subagent containers with their subagent UUID
      // populated. Cleanup callers (e.g. `funclaw doctor`) decide
      // whether to display them grouped under the root session.
      const subagentId = labels[SUBAGENT_LABEL_KEY];
      orphans.push({
        containerId: c.Id,
        sessionId,
        ...(subagentId !== undefined ? { subagentId } : {}),
        state: c.State,
        created: c.Created,
      });
    }
    return orphans;
  }

  // -------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------

  private buildContainerConfig(
    sessionUuid: string,
    skillsMounts: readonly SkillMount[],
    subagentUuid?: string,
  ): Docker.ContainerCreateOptions {
    // Per-skill read-only bind mounts at `/skills/<name>`. Each
    // loaded skill becomes its own Mount entry. Docker auto-creates
    // the `/skills/` parent directory under the read-only rootfs on
    // first mount. Empty `skillsMounts` array means no `/skills`
    // directory at all (clean degenerate case).
    //
    // The mount target uses path.posix.join because the in-container
    // path is always POSIX regardless of the host OS — per the
    // CLAUDE.md "Cross-platform" rule: "Never path.join for paths
    // passed to Docker (always path.posix)."
    const mounts: Docker.MountSettings[] = [
      {
        // Docker Desktop on Windows accepts both `C:\Users\...` and
        // forward-slash bind sources; the runner passes through
        // whatever `workingDir` resolved to (typically a Windows
        // path from Node's path.resolve). Verified against Docker
        // Desktop 29.4.1; see `docs/cross-platform.md`.
        Type: "bind",
        Source: this.resolved.workingDir,
        Target: "/workspace",
      },
      ...skillsMounts.map((m) => ({
        Type: "bind" as const,
        Source: m.hostPath,
        Target: posixJoin("/skills", m.name),
        ReadOnly: true,
      })),
    ];

    // Subagent containers carry an extra label for cleanup and
    // log-filtering visibility. Both root and subagent containers
    // share the same `funclaw.session=<rootUuid>` value so cleanup
    // groups them naturally.
    const labels: Record<string, string> = { [SESSION_LABEL_KEY]: sessionUuid };
    if (subagentUuid !== undefined) {
      labels[SUBAGENT_LABEL_KEY] = subagentUuid;
    }

    return {
      Image: this.resolved.image,
      User: SANDBOX_USER_STRING,
      Cmd: ["sleep", "infinity"],
      Labels: labels,
      WorkingDir: "/workspace",
      HostConfig: {
        NetworkMode: this.resolved.networkMode,
        ReadonlyRootfs: true,
        CapDrop: ["ALL"],
        Memory: this.resolved.memoryBytes,
        NanoCpus: this.resolved.nanoCpus,
        PidsLimit: this.resolved.pidsLimit,
        Tmpfs: { "/tmp": `rw,size=${this.resolved.tmpfsTmpBytes}` },
        RestartPolicy: { Name: "no" },
        Mounts: mounts,
      },
    } as unknown as Docker.ContainerCreateOptions;
    // The cast is necessary because dockerode's
    // ContainerCreateOptions.HostConfig.Mounts and CapDrop types are
    // looser than ApprovedContainerConfig requires. The validator
    // narrows on the way out of buildContainerConfig.
  }

  /**
   * One-time per-session setup: create the agent user in /etc/passwd
   * and chown /workspace so uid 10001 can write. Runs as root via the
   * `--user 0:0` exec override; this is the ONLY privilege escalation
   * surface in the runner and it runs a hardcoded command, not anything
   * derived from user input. The public `SessionHandle.exec` always
   * runs as uid 10001.
   */
  private async runSetup(container: Docker.Container): Promise<void> {
    // `useradd` and `chown` both pipe to `|| true` so a missing tool or
    // an already-existing user / pre-chowned dir doesn't fail setup.
    // The published runtime image pre-bakes the user and pre-creates
    // /workspace owned by uid 10001, so this script is a no-op when
    // running against fun-claw-runtime — it's a fallback bridge for
    // configurations that point at a generic base image.
    const setupScript =
      `useradd -u ${SANDBOX_UID} -g 0 -m -s /bin/bash agent 2>/dev/null || true; ` +
      `chown -R ${SANDBOX_UID}:${SANDBOX_GID} /workspace 2>/dev/null || true`;

    let exec: Docker.Exec;
    try {
      exec = await container.exec({
        Cmd: ["sh", "-c", setupScript],
        User: "0:0",
        AttachStdout: true,
        AttachStderr: true,
      });
    } catch (err) {
      throw funClawError({
        code: "FC-1020",
        message: `Container setup exec creation failed: ${errorMessage(err)}`,
        cause: err,
      });
    }

    const stream = (await exec.start({ hijack: true, stdin: false })) as NodeJS.ReadableStream;
    await new Promise<void>((resolve, reject) => {
      stream.on("end", () => resolve());
      stream.on("error", reject);
      stream.resume(); // discard setup output; we don't surface it
    });

    const inspect = await exec.inspect();
    if (inspect.ExitCode !== 0) {
      throw funClawError({
        code: "FC-1020",
        message: `Container setup script exited with code ${inspect.ExitCode}.`,
        data: { exitCode: inspect.ExitCode },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// SessionHandle
// ---------------------------------------------------------------------------

export class SessionHandle {
  /** Human-readable session UUID stamped on the container's
   *  `funclaw.session` label. */
  readonly sessionUuid: string;
  private readonly container: Docker.Container;
  private readonly docker: Docker;
  private destroyed = false;

  constructor(container: Docker.Container, sessionUuid: string, docker: Docker) {
    this.container = container;
    this.sessionUuid = sessionUuid;
    this.docker = docker;
  }

  /** Container ID for diagnostic logging. */
  get containerId(): string {
    return this.container.id;
  }

  /**
   * Stream a command inside the container as the sandbox user
   * (uid 10001). Yields stdout/stderr deltas as they arrive, then a
   * final `{ type: "exit", code }`. Aborting via `opts.abortSignal` or
   * letting `opts.timeoutMs` elapse stops the container, which kills
   * the exec.
   */
  async *exec(argv: readonly string[], opts: ExecOptions = {}): AsyncIterable<ExecStreamEvent> {
    if (this.destroyed) {
      throw funClawError({
        code: "FC-1021",
        message: "Cannot exec on a destroyed session.",
        data: { sessionUuid: this.sessionUuid },
      });
    }

    const wantsStdin = opts.stdin !== undefined;
    let exec: Docker.Exec;
    try {
      exec = await this.container.exec({
        Cmd: [...argv],
        User: SANDBOX_USER_STRING,
        WorkingDir: opts.cwd ?? "/workspace",
        AttachStdout: true,
        AttachStderr: true,
        AttachStdin: wantsStdin,
      });
    } catch (err) {
      if (isDockerDaemonUnreachable(err)) {
        throw daemonUnreachableError(err);
      }
      throw funClawError({
        code: "FC-1021",
        message: `Container exec creation failed: ${errorMessage(err)}`,
        cause: err,
        data: { sessionUuid: this.sessionUuid },
      });
    }

    // When stdin is requested, dockerode's hijacked stream is a
    // duplex socket — we write the payload to it then end() the
    // writable half so the child sees EOF and commands like
    // `cat > /workspace/foo.txt` complete. The readable half
    // continues feeding the demux below.
    //
    // **Critical ordering**: the stdin write+end MUST happen AFTER
    // the demux + 'end'/'error' listeners are wired up below.
    // Otherwise a fast-completing exec can fire the readable 'end'
    // event before our listener attaches, and the loop sees
    // `streamEnded=true` with no buffered output, calls inspect()
    // before the child has fully exited, and yields exit code -1.
    // The flush is deferred via the `flushStdin` closure invoked
    // after the listener setup.
    const stream = (await exec.start({
      hijack: true,
      stdin: wantsStdin,
    })) as NodeJS.ReadableStream;
    const flushStdin = (): void => {
      if (!wantsStdin || opts.stdin === undefined) return;
      const writable = stream as unknown as NodeJS.WritableStream;
      const payload = typeof opts.stdin === "string" ? Buffer.from(opts.stdin, "utf8") : opts.stdin;
      writable.write(payload);
      writable.end();
    };

    // Cancellation: aborting the signal or hitting the timeout stops
    // the container, which terminates the exec. Future revisits could
    // adopt finer-grained `docker exec --signal` style termination.
    let timeoutHandle: NodeJS.Timeout | undefined;
    const cancel = (reason: string): void => {
      // Best-effort container stop; do not await so we don't deadlock
      // the generator's wakeup loop.
      this.container.stop({ t: 0 }).catch(() => {
        /* swallow — container may already be stopped */
      });
      const err = funClawError({
        code: "FC-1021",
        message: `Exec cancelled: ${reason}`,
        data: { sessionUuid: this.sessionUuid, reason },
      });
      reject(err);
    };
    if (opts.abortSignal !== undefined) {
      if (opts.abortSignal.aborted) cancel("AbortSignal already fired");
      else opts.abortSignal.addEventListener("abort", () => cancel("AbortSignal"), { once: true });
    }
    if (opts.timeoutMs !== undefined && opts.timeoutMs > 0) {
      timeoutHandle = setTimeout(() => cancel(`timeout after ${opts.timeoutMs}ms`), opts.timeoutMs);
    }

    // Demux dockerode's multiplexed stream into an event queue. The
    // queue feeds the generator via a wakeup promise pattern — events
    // arrive on the demux callbacks, the generator pulls from the queue
    // and waits when empty.
    const queue: ExecStreamEvent[] = [];
    let streamEnded = false;
    let streamError: Error | null = null;
    let waker: (() => void) | null = null;
    const wake = (): void => {
      if (waker !== null) {
        const w = waker;
        waker = null;
        w();
      }
    };

    const stdoutSink = new Writable({
      write(chunk: Buffer, _enc, cb) {
        queue.push({ type: "stdout", data: Buffer.from(chunk) });
        wake();
        cb();
      },
    });
    const stderrSink = new Writable({
      write(chunk: Buffer, _enc, cb) {
        queue.push({ type: "stderr", data: Buffer.from(chunk) });
        wake();
        cb();
      },
    });
    this.docker.modem.demuxStream(stream, stdoutSink, stderrSink);

    let reject!: (err: Error) => void;
    const cancelPromise = new Promise<never>((_resolve, rej) => {
      reject = rej;
    });

    stream.on("end", () => {
      streamEnded = true;
      wake();
    });
    stream.on("error", (err) => {
      streamError = err;
      streamEnded = true;
      wake();
    });

    // Now that the demux + 'end'/'error' listeners are wired, flush
    // any pending stdin payload. The child sees the bytes, then EOF,
    // then exits cleanly; the readable side delivers stdout/stderr
    // through the demux above before firing 'end'.
    flushStdin();

    try {
      while (true) {
        if (streamError !== null) throw streamError;
        if (queue.length > 0) {
          // queue.shift() is safe under noUncheckedIndexedAccess because
          // we just checked length > 0.
          const next = queue.shift() as ExecStreamEvent;
          yield next;
          continue;
        }
        if (streamEnded) break;
        await Promise.race([
          new Promise<void>((resolve) => {
            waker = resolve;
          }),
          cancelPromise,
        ]);
      }

      // Drain any final buffered events.
      while (queue.length > 0) {
        yield queue.shift() as ExecStreamEvent;
      }

      // Inspect for exit code and yield the terminal event.
      //
      // Known dockerode quirk: when the hijacked stream's 'end' event
      // fires, the daemon's internal exec state may not have updated
      // yet — `inspect.ExitCode` can briefly be `null` for a few ms
      // after the child terminates. Poll a small number of times with
      // short delays before falling back to -1. In practice ExitCode
      // is populated within 1–2 polls on Docker Desktop; the cap is a
      // safety net.
      let inspect = await exec.inspect();
      let pollAttempt = 0;
      while (inspect.ExitCode === null && pollAttempt < 10 && inspect.Running !== true) {
        await new Promise<void>((r) => setTimeout(r, 25));
        inspect = await exec.inspect();
        pollAttempt += 1;
      }
      // If Running is still true after the poll loop, the exec really
      // is running — yield -1. If ExitCode is still null but Running
      // is false, dockerode never settled; also yield -1 so the
      // caller sees an "unknown" rather than an incorrect 0.
      yield { type: "exit", code: inspect.ExitCode ?? -1 };
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }
  }

  /** Stop and remove this session's container. Idempotent. */
  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    try {
      await this.container.stop({ t: STOP_TIMEOUT_SECONDS });
    } catch {
      /* may already be stopped */
    }
    try {
      await this.container.remove({ force: true });
    } catch {
      /* may already be removed */
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isDockerDaemonUnreachable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  if (code === "ENOENT" || code === "ECONNREFUSED" || code === "EACCES") {
    return true;
  }
  const msg = err.message ?? "";
  return (
    msg.includes("connect ENOENT") ||
    msg.includes("connect ECONNREFUSED") ||
    msg.includes("connect EACCES") ||
    msg.includes("docker_engine")
  );
}

function isImageNotFound(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const statusCode = (err as { statusCode?: unknown }).statusCode;
  if (statusCode === 404) return true;
  const msg = err.message ?? "";
  return msg.includes("No such image") || msg.includes("not found");
}

function daemonUnreachableError(cause: unknown): Error {
  return funClawError({
    code: "FC-1001",
    message:
      "Docker daemon unreachable. Ensure Docker Desktop is running (macOS / Windows) " +
      "or that the docker daemon is started and accessible (Linux).",
    cause,
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function safeRemove(container: Docker.Container): Promise<void> {
  try {
    await container.remove({ force: true });
  } catch {
    /* ignore */
  }
}

// Re-export types from policy so consumers can build against a single
// import path.
export type { ApprovedContainerConfig };
