// Vitest tests for `resolveWriteFilePath` — the path-traversal guard
// at the heart of `write_file`.
//
// The bulk of the file is a fast-check property test that fuzzes a
// wide space of malicious paths and asserts the validator either
// rejects them with the right FC-1xxx code or normalizes them to a
// safe path inside `/workspace`. Per CLAUDE.md "How to test":
// "Property-based tests for parsers ... use fast-check with at least
// 1,000 random runs per property." We keep that 1,000 cap explicit so
// the suite runtime stays predictable.

import { isFunClawError } from "@funclaw/core";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ExecOptions, ExecStreamEvent, SessionHandle } from "../runner.js";
import { parseWriteFileInput, resolveWriteFilePath, runWriteFile } from "../tools/write-file.js";

// ---------------------------------------------------------------------------
// Hand-crafted cases (the "obvious" ones the LLM is most likely to emit)
// ---------------------------------------------------------------------------

describe("resolveWriteFilePath — happy paths", () => {
  it.each([
    ["foo.txt", "/workspace/foo.txt"],
    ["src/app.ts", "/workspace/src/app.ts"],
    ["./relative.md", "/workspace/relative.md"],
    ["a/b/c/d.txt", "/workspace/a/b/c/d.txt"],
    ["a//b//c", "/workspace/a/b/c"],
  ])("%s → %s", (input, expected) => {
    expect(resolveWriteFilePath(input)).toBe(expected);
  });

  it("normalizes backslashes (Windows-style) to forward slashes", () => {
    // The validator coerces `\` to `/` so a model echoing a Windows
    // path style still lands inside /workspace.
    expect(resolveWriteFilePath("src\\app.ts")).toBe("/workspace/src/app.ts");
  });
});

describe("resolveWriteFilePath — FC-1030 (path traversal)", () => {
  it.each([
    "../etc/passwd",
    "..",
    "../foo",
    "a/../b/../../escape",
    "./..",
  ])("%s → FC-1030", (badPath) => {
    let caught: unknown;
    try {
      resolveWriteFilePath(badPath);
    } catch (e) {
      caught = e;
    }
    expect(isFunClawError(caught)).toBe(true);
    if (isFunClawError(caught)) {
      expect(caught.code).toBe("FC-1030");
    }
  });
});

describe("resolveWriteFilePath — FC-1031 (absolute paths)", () => {
  it.each([
    "/etc/passwd",
    "/",
    "/workspace/foo.txt",
    "/var/run/docker.sock",
  ])("%s → FC-1031", (badPath) => {
    let caught: unknown;
    try {
      resolveWriteFilePath(badPath);
    } catch (e) {
      caught = e;
    }
    expect(isFunClawError(caught)).toBe(true);
    if (isFunClawError(caught)) {
      expect(caught.code).toBe("FC-1031");
    }
  });

  it.each([
    "C:\\Windows\\System32",
    "c:/Users/foo",
    "D:\\\\test",
  ])("Windows drive letter %s → FC-1031", (badPath) => {
    let caught: unknown;
    try {
      resolveWriteFilePath(badPath);
    } catch (e) {
      caught = e;
    }
    expect(isFunClawError(caught)).toBe(true);
    if (isFunClawError(caught)) {
      expect(caught.code).toBe("FC-1031");
    }
  });
});

describe("resolveWriteFilePath — FC-1032 (invalid characters)", () => {
  it("empty string → FC-1032", () => {
    let caught: unknown;
    try {
      resolveWriteFilePath("");
    } catch (e) {
      caught = e;
    }
    expect(isFunClawError(caught)).toBe(true);
    if (isFunClawError(caught)) {
      expect(caught.code).toBe("FC-1032");
    }
  });

  it.each([" foo.txt", "foo.txt ", "\tfoo.txt"])("whitespace-padded %s → FC-1032", (badPath) => {
    let caught: unknown;
    try {
      resolveWriteFilePath(badPath);
    } catch (e) {
      caught = e;
    }
    expect(isFunClawError(caught)).toBe(true);
    if (isFunClawError(caught)) {
      expect(caught.code).toBe("FC-1032");
    }
  });

  it("NUL byte → FC-1032", () => {
    let caught: unknown;
    try {
      resolveWriteFilePath("foo\0.txt");
    } catch (e) {
      caught = e;
    }
    expect(isFunClawError(caught)).toBe(true);
    if (isFunClawError(caught)) {
      expect(caught.code).toBe("FC-1032");
    }
  });
});

// ---------------------------------------------------------------------------
// Property-based fuzz: any output must either throw FC-103x OR be a
// path that starts with "/workspace/" (never escapes the workspace).
// ---------------------------------------------------------------------------

describe("resolveWriteFilePath — fast-check property", () => {
  it("output never escapes /workspace and rejections always carry FC-103x codes", () => {
    fc.assert(
      fc.property(
        // Build paths from a permissive character set that includes
        // many of the troublesome chars: dots, slashes, drive
        // letters, NUL, whitespace. The arb is broad on purpose —
        // we want fast-check to find weird combinations.
        fc.string({
          unit: fc.constantFrom(
            "a",
            "b",
            "c",
            "x",
            "1",
            ".",
            "..",
            "/",
            "\\",
            "C:",
            "D:\\",
            "\0",
            " ",
            "\t",
            "_",
            "-",
          ),
          minLength: 0,
          maxLength: 8,
        }),
        (rawPath) => {
          let result: string | undefined;
          let errCode: string | undefined;
          try {
            result = resolveWriteFilePath(rawPath);
          } catch (e) {
            if (isFunClawError(e)) {
              errCode = e.code;
            } else {
              // The validator is supposed to throw ONLY FunClawErrors.
              // If anything else gets through, the property fails.
              throw e;
            }
          }
          // Either we got a /workspace-prefixed path, OR a FC-103x
          // rejection — never anything else.
          if (result !== undefined) {
            // The success case: path must be inside /workspace.
            expect(result.startsWith("/workspace/") || result === "/workspace").toBe(true);
            // And it must not contain `..` segments.
            expect(result.split("/").includes("..")).toBe(false);
          } else {
            expect(errCode).toMatch(/^FC-103[012]$/);
          }
        },
      ),
      { numRuns: 1000 },
    );
  });
});

// ---------------------------------------------------------------------------
// runWriteFile — body coverage with a fake SessionHandle
// ---------------------------------------------------------------------------

/**
 * Build a fake SessionHandle whose exec yields a fixed event
 * sequence. The handler captures the argv it was called with so
 * tests can assert the script shape (`mkdir -p ... && echo ... |
 * base64 -d > ...`).
 */
function fakeSessionHandle(opts: {
  events: ExecStreamEvent[];
  capturedArgv?: string[][];
  capturedOpts?: ExecOptions[];
}): SessionHandle {
  const fake = {
    sessionUuid: "fake-uuid",
    containerId: "fake-container",
    exec(argv: readonly string[], execOpts: ExecOptions = {}): AsyncIterable<ExecStreamEvent> {
      opts.capturedArgv?.push([...argv]);
      opts.capturedOpts?.push(execOpts);
      return (async function* () {
        for (const e of opts.events) yield e;
      })();
    },
    destroy: async () => {},
  };
  return fake as unknown as SessionHandle;
}

describe("runWriteFile — happy path", () => {
  it("issues a base64-via-shell script and reports byte count on success", async () => {
    const capturedArgv: string[][] = [];
    const session = fakeSessionHandle({
      events: [
        { type: "stdout", data: Buffer.from("") },
        { type: "exit", code: 0 },
      ],
      capturedArgv,
    });
    const input = parseWriteFileInput({
      path: "subdir/hello.txt",
      content: "hello world",
    });
    const result = await runWriteFile(session, input, "tu_1");
    expect(result.isError).toBeUndefined();
    expect(result.toolUseId).toBe("tu_1");
    expect(String(result.content)).toContain("/workspace/subdir/hello.txt");
    expect(String(result.content)).toContain("11 byte(s)");
    // Verify the shell script shape: bash -c "mkdir -p ... && echo '<b64>' | base64 -d > ..."
    expect(capturedArgv).toHaveLength(1);
    const argv = capturedArgv[0] as string[];
    expect(argv[0]).toBe("bash");
    expect(argv[1]).toBe("-c");
    const script = argv[2] ?? "";
    expect(script).toContain("mkdir -p");
    expect(script).toContain("base64 -d");
    expect(script).toContain("/workspace/subdir/hello.txt");
    // Confirm base64-encoded content (locked workaround per Slice 8 saved feedback).
    const expectedBase64 = Buffer.from("hello world", "utf8").toString("base64");
    expect(script).toContain(`echo '${expectedBase64}'`);
  });

  it("decodes binary content via base64 input encoding", async () => {
    const session = fakeSessionHandle({
      events: [{ type: "exit", code: 0 }],
    });
    // Binary input: "hello world" base64-encoded.
    const b64 = Buffer.from("hello world", "utf8").toString("base64");
    const input = parseWriteFileInput({
      path: "binary.dat",
      content: b64,
      encoding: "binary",
    });
    const result = await runWriteFile(session, input, "tu_bin");
    expect(result.isError).toBeUndefined();
    expect(String(result.content)).toContain("11 byte(s)");
    expect(String(result.content)).toContain("encoding: binary");
  });

  it("returns isError when the shell exits non-zero", async () => {
    const session = fakeSessionHandle({
      events: [
        { type: "stderr", data: Buffer.from("Permission denied") },
        { type: "exit", code: 1 },
      ],
    });
    const input = parseWriteFileInput({
      path: "denied.txt",
      content: "data",
    });
    const result = await runWriteFile(session, input, "tu_fail");
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("write_file failed");
    expect(String(result.content)).toContain("exit 1");
    expect(String(result.content)).toContain("Permission denied");
  });

  it("threads abortSignal through to session.exec", async () => {
    const capturedOpts: ExecOptions[] = [];
    const session = fakeSessionHandle({
      events: [{ type: "exit", code: 0 }],
      capturedOpts,
    });
    const ac = new AbortController();
    const input = parseWriteFileInput({ path: "x.txt", content: "y" });
    await runWriteFile(session, input, "tu_abort", { abortSignal: ac.signal });
    expect(capturedOpts).toHaveLength(1);
    expect(capturedOpts[0]?.abortSignal).toBe(ac.signal);
  });

  it("rejects path traversal at the resolveWriteFilePath boundary BEFORE issuing the exec", async () => {
    const capturedArgv: string[][] = [];
    const session = fakeSessionHandle({
      events: [{ type: "exit", code: 0 }],
      capturedArgv,
    });
    let caught: unknown;
    try {
      const input = parseWriteFileInput({ path: "../escape", content: "x" });
      await runWriteFile(session, input, "tu_bad");
    } catch (e) {
      caught = e;
    }
    expect(isFunClawError(caught)).toBe(true);
    if (isFunClawError(caught)) {
      expect(caught.code).toBe("FC-1030");
    }
    // Critical: no exec was issued for a rejected path — the path
    // validator runs BEFORE any container interaction.
    expect(capturedArgv).toHaveLength(0);
  });
});
