// Vitest tests for the FC-3xxx error helpers.
//
// Each helper produces an `Error & FunClawError` with the expected
// code, message shape, and data. The tests assert on those three
// fields per helper.

import { isFunClawError } from "@funclaw/core";
import { describe, expect, it } from "vitest";
import {
  mcpCallTimeoutError,
  mcpCrashError,
  mcpInitError,
  mcpSpawnError,
  mcpStartupTimeoutError,
  mcpToolUnavailableError,
  mcpTransportError,
} from "../errors.js";

describe("FC-3xxx error helpers — code + shape", () => {
  it("FC-3001 mcpSpawnError carries serverName + command in data", () => {
    const err = mcpSpawnError({
      serverName: "filesystem",
      command: "missing-bin",
      cause: new Error("ENOENT"),
    });
    expect(isFunClawError(err)).toBe(true);
    expect(err.code).toBe("FC-3001");
    expect(err.data).toMatchObject({ serverName: "filesystem", command: "missing-bin" });
    expect(err.message).toContain("missing-bin");
  });

  it("FC-3002 mcpInitError surfaces serverName", () => {
    const err = mcpInitError({ serverName: "github", cause: new Error("bad json") });
    expect(err.code).toBe("FC-3002");
    expect(err.data).toMatchObject({ serverName: "github" });
    expect(err.message).toContain("github");
  });

  it("FC-3003 mcpStartupTimeoutError includes the timeout value", () => {
    const err = mcpStartupTimeoutError({ serverName: "filesystem", timeoutMs: 5000 });
    expect(err.code).toBe("FC-3003");
    expect(err.data).toMatchObject({ serverName: "filesystem", timeoutMs: 5000 });
    expect(err.message).toContain("5000ms");
  });

  it("FC-3004 mcpCrashError formats the reason / exitCode / signal", () => {
    const withSignal = mcpCrashError({
      serverName: "fs",
      reason: "transport-error",
      signal: "SIGSEGV",
    });
    expect(withSignal.code).toBe("FC-3004");
    expect(withSignal.message).toContain("signal=SIGSEGV");

    const withExitCode = mcpCrashError({
      serverName: "fs",
      reason: "subprocess-exit",
      exitCode: 137,
    });
    expect(withExitCode.message).toContain("exit code 137");
    expect(withExitCode.data).toMatchObject({ exitCode: 137 });

    const reasonOnly = mcpCrashError({ serverName: "fs", reason: "transport-close" });
    expect(reasonOnly.message).toContain("transport-close");
  });

  it("FC-3005 mcpCallTimeoutError surfaces serverName + toolName + timeoutMs", () => {
    const err = mcpCallTimeoutError({
      serverName: "fs",
      toolName: "read_file",
      timeoutMs: 30_000,
    });
    expect(err.code).toBe("FC-3005");
    expect(err.message).toContain("read_file");
    expect(err.message).toContain("30000ms");
    expect(err.data).toMatchObject({ toolName: "read_file" });
  });

  it("FC-3006 mcpTransportError captures the detail string", () => {
    const err = mcpTransportError({
      serverName: "fs",
      detail: "broken pipe writing message",
      cause: new Error("EPIPE"),
    });
    expect(err.code).toBe("FC-3006");
    expect(err.message).toContain("broken pipe");
  });

  it("FC-3007 mcpToolUnavailableError surfaces serverName + toolName", () => {
    const err = mcpToolUnavailableError({ serverName: "fs", toolName: "read_file" });
    expect(err.code).toBe("FC-3007");
    expect(err.message).toContain("read_file");
    expect(err.message).toContain("fs");
  });
});

describe("FC-3xxx helpers — return runtime is Error & FunClawError", () => {
  it("instances pass instanceof Error and isFunClawError", () => {
    const cases = [
      mcpSpawnError({ serverName: "x", command: "y", cause: new Error() }),
      mcpInitError({ serverName: "x", cause: new Error() }),
      mcpStartupTimeoutError({ serverName: "x", timeoutMs: 1 }),
      mcpCrashError({ serverName: "x", reason: "transport-close" }),
      mcpCallTimeoutError({ serverName: "x", toolName: "y", timeoutMs: 1 }),
      mcpTransportError({ serverName: "x", detail: "z" }),
      mcpToolUnavailableError({ serverName: "x", toolName: "y" }),
    ];
    for (const err of cases) {
      expect(err).toBeInstanceOf(Error);
      expect(isFunClawError(err)).toBe(true);
      expect(typeof err.message).toBe("string");
      expect(err.message.length).toBeGreaterThan(0);
    }
  });
});
