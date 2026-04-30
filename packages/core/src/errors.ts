// Fun Claw error factory.
//
// `FunClawError` (the canonical shape) is defined as an interface in
// `types.ts` per the Slice 1 "pure types only" rule. This file provides
// the runtime-side counterpart: a factory function `funClawError` that
// builds a real `Error` instance with the FunClawError fields attached,
// so the throw site has a useful stack trace AND consumers can read
// `.code` / `.data` for structured handling.
//
// Usage:
//
//   import { funClawError } from "./errors.js";
//
//   throw funClawError({
//     code: "FC-5001",
//     message: "Keyfile permissions are unsafe; chmod 0600 ~/.funclaw/keys.json",
//     data: { path, currentMode: "644", expectedMode: "600" },
//   });
//
// At a catch site, narrow with the `isFunClawError` type guard. Catchers
// that just want the code can do a property check.

import type { FunClawError, FunClawErrorCode } from "./types.js";

export interface FunClawErrorInit {
  code: FunClawErrorCode;
  message: string;
  cause?: unknown;
  data?: object;
}

/**
 * Build a thrown-friendly FunClawError. The returned value is both an
 * `Error` (proper stack trace, instanceof Error true) and a FunClawError
 * (`.code`, `.data` populated).
 */
export function funClawError(init: FunClawErrorInit): Error & FunClawError {
  const err = new Error(init.message, { cause: init.cause }) as Error & FunClawError;
  err.name = "FunClawError";
  err.code = init.code;
  if (init.data !== undefined) err.data = init.data;
  return err;
}

/**
 * Type guard for FunClawError. Use at catch sites that need to inspect
 * `.code`. Anything else thrown — provider SDK errors, Node `Error`
 * instances, plain values — is treated as opaque.
 */
export function isFunClawError(value: unknown): value is Error & FunClawError {
  if (!(value instanceof Error)) return false;
  const code = (value as { code?: unknown }).code;
  return typeof code === "string" && code.startsWith("FC-");
}
