// Vitest tests for the container security policy.
//
// The policy is the single source of truth for what a Fun Claw
// sandbox container is allowed to be. Each FC-1xxx code in
// `validateContainerConfig` gets a test exercising both the rejection
// path AND the smallest-possible passing config to confirm the rule
// doesn't fire spuriously.
//
// Per the Slice 5 saved-feedback rule, there is no policy bypass —
// these tests exercise the policy by building synthetic configs and
// feeding them to `validateContainerConfig` directly. No Docker is
// touched.

import { randomUUID } from "node:crypto";
import { isFunClawError } from "@funclaw/core";
import type Docker from "dockerode";
import { describe, expect, it } from "vitest";
import { SANDBOX_USER_STRING, validateContainerConfig } from "../policy.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/**
 * Build a base config that satisfies every rule. Tests mutate this to
 * exercise each rejection path. Mutations are local to the test —
 * the helper returns a fresh object each call.
 *
 * Slice 9: the `funclaw.session` label uses a real UUID via
 * `randomUUID()` (FC-1019 expects UUID-shaped strings; using a
 * placeholder like `"test"` would trip the validator on the happy
 * path).
 */
function baseConfig(): Docker.ContainerCreateOptions {
  return {
    Image: "ubuntu:24.04",
    User: SANDBOX_USER_STRING,
    Cmd: ["sleep", "infinity"],
    Labels: { "funclaw.session": randomUUID() },
    WorkingDir: "/workspace",
    HostConfig: {
      NetworkMode: "bridge",
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      Memory: 2 * 1024 * 1024 * 1024,
      NanoCpus: 2_000_000_000,
      PidsLimit: 256,
      Tmpfs: { "/tmp": "rw,size=1g" },
      Mounts: [{ Type: "bind", Source: "/host/workspace", Target: "/workspace" }],
    },
  } as Docker.ContainerCreateOptions;
}

function expectRejection(config: Docker.ContainerCreateOptions, expectedCode: string): void {
  let caught: unknown;
  try {
    validateContainerConfig(config);
  } catch (e) {
    caught = e;
  }
  expect(isFunClawError(caught)).toBe(true);
  if (isFunClawError(caught)) {
    expect(caught.code).toBe(expectedCode);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("validateContainerConfig — happy path", () => {
  it("accepts a minimal compliant config", () => {
    const c = baseConfig();
    const validated = validateContainerConfig(c);
    expect(validated.User).toBe(SANDBOX_USER_STRING);
    expect(validated.HostConfig.NetworkMode).toBe("bridge");
  });

  it("accepts NetworkMode 'none' as well as 'bridge'", () => {
    const c = baseConfig();
    if (c.HostConfig !== undefined) c.HostConfig.NetworkMode = "none";
    const validated = validateContainerConfig(c);
    expect(validated.HostConfig.NetworkMode).toBe("none");
  });

  it("accepts a read-only /skills mount alongside /workspace", () => {
    const c = baseConfig();
    if (c.HostConfig !== undefined) {
      c.HostConfig.Mounts = [
        { Type: "bind", Source: "/host/workspace", Target: "/workspace" },
        { Type: "bind", Source: "/host/skills/git", Target: "/skills/git", ReadOnly: true },
      ];
    }
    expect(() => validateContainerConfig(c)).not.toThrow();
  });
});

describe("validateContainerConfig — User (FC-1014)", () => {
  it("rejects User: undefined", () => {
    const c = baseConfig();
    // dockerode's User type is string | undefined; the policy
    // tightens it to the locked SANDBOX_USER_STRING. Setting
    // undefined here is a runtime violation the policy must catch.
    c.User = undefined;
    expectRejection(c, "FC-1014");
  });

  it("rejects User: 'root'", () => {
    const c = baseConfig();
    // dockerode's types are loose; the policy is what tightens them.
    c.User = "root";
    expectRejection(c, "FC-1014");
  });

  it("rejects User: '0'", () => {
    const c = baseConfig();
    // dockerode's types are loose; the policy is what tightens them.
    c.User = "0";
    expectRejection(c, "FC-1014");
  });

  it("rejects User: '0:0'", () => {
    const c = baseConfig();
    // dockerode's types are loose; the policy is what tightens them.
    c.User = "0:0";
    expectRejection(c, "FC-1014");
  });
});

describe("validateContainerConfig — Privileged / NetworkMode / PidMode", () => {
  it("FC-1010 rejects HostConfig.Privileged: true", () => {
    const c = baseConfig();
    if (c.HostConfig !== undefined) c.HostConfig.Privileged = true;
    expectRejection(c, "FC-1010");
  });

  it("FC-1011 rejects NetworkMode: 'host'", () => {
    const c = baseConfig();
    // dockerode's types are loose; the policy is what tightens them.
    if (c.HostConfig !== undefined) c.HostConfig.NetworkMode = "host";
    expectRejection(c, "FC-1011");
  });

  it("FC-1011 rejects custom NetworkMode strings", () => {
    const c = baseConfig();
    // dockerode's types are loose; the policy is what tightens them.
    if (c.HostConfig !== undefined) c.HostConfig.NetworkMode = "container:other";
    expectRejection(c, "FC-1011");
  });

  it("FC-1011 rejects undefined NetworkMode", () => {
    const c = baseConfig();
    if (c.HostConfig !== undefined) {
      // biome-ignore lint/performance/noDelete: required for the test
      delete c.HostConfig.NetworkMode;
    }
    expectRejection(c, "FC-1011");
  });

  it("FC-1012 rejects PidMode: 'host'", () => {
    const c = baseConfig();
    if (c.HostConfig !== undefined) c.HostConfig.PidMode = "host";
    expectRejection(c, "FC-1012");
  });
});

describe("validateContainerConfig — ReadonlyRootfs / Capabilities", () => {
  it("FC-1016 rejects ReadonlyRootfs: false", () => {
    const c = baseConfig();
    if (c.HostConfig !== undefined) c.HostConfig.ReadonlyRootfs = false;
    expectRejection(c, "FC-1016");
  });

  it("FC-1016 rejects undefined ReadonlyRootfs", () => {
    const c = baseConfig();
    if (c.HostConfig !== undefined) {
      // biome-ignore lint/performance/noDelete: required for the test
      delete c.HostConfig.ReadonlyRootfs;
    }
    expectRejection(c, "FC-1016");
  });

  it("FC-1015 rejects CapDrop missing 'ALL'", () => {
    const c = baseConfig();
    if (c.HostConfig !== undefined) c.HostConfig.CapDrop = ["NET_ADMIN"];
    expectRejection(c, "FC-1015");
  });

  it("FC-1015 rejects non-empty CapAdd", () => {
    const c = baseConfig();
    if (c.HostConfig !== undefined) c.HostConfig.CapAdd = ["NET_ADMIN"];
    expectRejection(c, "FC-1015");
  });
});

describe("validateContainerConfig — Forbidden mounts (FC-1013)", () => {
  it("rejects /var/run/docker.sock in HostConfig.Binds", () => {
    const c = baseConfig();
    if (c.HostConfig !== undefined) {
      c.HostConfig.Binds = ["/var/run/docker.sock:/var/run/docker.sock"];
    }
    expectRejection(c, "FC-1013");
  });

  it("rejects /var/run/docker.sock.raw in HostConfig.Binds", () => {
    const c = baseConfig();
    if (c.HostConfig !== undefined) {
      c.HostConfig.Binds = ["/var/run/docker.sock.raw:/var/run/docker.sock.raw"];
    }
    expectRejection(c, "FC-1013");
  });

  it("rejects /var/run/docker.sock in HostConfig.Mounts", () => {
    const c = baseConfig();
    if (c.HostConfig !== undefined) {
      c.HostConfig.Mounts = [
        { Type: "bind", Source: "/host/workspace", Target: "/workspace" },
        { Type: "bind", Source: "/var/run/docker.sock", Target: "/var/run/docker.sock" },
      ];
    }
    expectRejection(c, "FC-1013");
  });
});

describe("validateContainerConfig — /skills mount must be ReadOnly (FC-1018)", () => {
  it("rejects a writable bind targeting /skills", () => {
    const c = baseConfig();
    if (c.HostConfig !== undefined) {
      c.HostConfig.Mounts = [
        { Type: "bind", Source: "/host/workspace", Target: "/workspace" },
        // ReadOnly omitted → falsy → rejection.
        { Type: "bind", Source: "/host/skills", Target: "/skills" },
      ];
    }
    expectRejection(c, "FC-1018");
  });

  it("rejects a writable bind targeting /skills/<name>", () => {
    const c = baseConfig();
    if (c.HostConfig !== undefined) {
      c.HostConfig.Mounts = [
        { Type: "bind", Source: "/host/workspace", Target: "/workspace" },
        {
          Type: "bind",
          Source: "/host/skills/git",
          Target: "/skills/git",
          ReadOnly: false,
        },
      ];
    }
    expectRejection(c, "FC-1018");
  });

  it("accepts a read-only bind targeting /skills/<name>", () => {
    const c = baseConfig();
    if (c.HostConfig !== undefined) {
      c.HostConfig.Mounts = [
        { Type: "bind", Source: "/host/workspace", Target: "/workspace" },
        {
          Type: "bind",
          Source: "/host/skills/git",
          Target: "/skills/git",
          ReadOnly: true,
        },
      ];
    }
    expect(() => validateContainerConfig(c)).not.toThrow();
  });

  it("does not touch non-/skills mounts that happen to be writable", () => {
    const c = baseConfig();
    if (c.HostConfig !== undefined) {
      c.HostConfig.Mounts = [
        // /workspace is writable by design — no FC-1018 rejection.
        { Type: "bind", Source: "/host/workspace", Target: "/workspace" },
      ];
    }
    expect(() => validateContainerConfig(c)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Slice 9: funclaw.subagent label validation (FC-1019)
// ---------------------------------------------------------------------------

describe("validateContainerConfig — funclaw.* label validation (FC-1019)", () => {
  it("accepts a valid funclaw.subagent label alongside funclaw.session", () => {
    const c = baseConfig();
    if (c.Labels !== undefined) {
      c.Labels["funclaw.subagent"] = randomUUID();
    }
    expect(() => validateContainerConfig(c)).not.toThrow();
  });

  it("rejects empty funclaw.session value", () => {
    const c = baseConfig();
    if (c.Labels !== undefined) {
      c.Labels["funclaw.session"] = "";
    }
    expectRejection(c, "FC-1019");
  });

  it("rejects funclaw.subagent value containing whitespace", () => {
    const c = baseConfig();
    if (c.Labels !== undefined) {
      c.Labels["funclaw.subagent"] = "abc def";
    }
    expectRejection(c, "FC-1019");
  });

  it("rejects funclaw.session value with shell metacharacters", () => {
    const c = baseConfig();
    if (c.Labels !== undefined) {
      c.Labels["funclaw.session"] = "abc;rm -rf";
    }
    expectRejection(c, "FC-1019");
  });

  it("rejects funclaw.subagent value over 64 chars", () => {
    const c = baseConfig();
    if (c.Labels !== undefined) {
      c.Labels["funclaw.subagent"] = "a".repeat(65);
    }
    expectRejection(c, "FC-1019");
  });

  it("ignores OTHER labels — only funclaw.* keys are inspected", () => {
    const c = baseConfig();
    if (c.Labels !== undefined) {
      // A user-set unrelated label can have any value; the policy
      // doesn't constrain it.
      c.Labels["my-custom-label"] = "anything goes here including spaces";
    }
    expect(() => validateContainerConfig(c)).not.toThrow();
  });
});
