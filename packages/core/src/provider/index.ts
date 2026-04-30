// Fun Claw — provider factory.
//
// `createProvider(config, options?)` is the single construction point
// the CLI / agent loop uses. It switches on `config.provider`, calls
// `getSecret` to resolve the API key, and returns the matching adapter
// instance behind the `LLMProvider` interface.
//
// `openai-compatible` is dispatched to the OpenAI adapter with a
// `baseURL` override read from `config.endpoint`. STACK.md "LLM
// providers" calls this out — the OpenAI SDK with `baseURL` is the
// broader provider-compatible surface (Together, Groq, OpenRouter,
// Ollama).
//
// New error codes:
//   - FC-2008 — `openai-compatible` selected without `config.endpoint`.
//   - FC-2009 — defensive guard: unsupported provider value at runtime
//               (TypeScript's exhaustiveness check makes this
//               unreachable in well-typed code, but the runtime still
//               needs a code if a malformed config ever reaches here).
//
// Reference docs:
//   - .claude/CLAUDE.md (FC-2xxx scoping rule, error code addition policy)
//   - STACK.md "LLM providers" (the four locked providers and SDKs)

import { type GetSecretOptions, getSecret, type Provider } from "../config.js";
import { funClawError } from "../errors.js";
import type { LLMProvider } from "../provider.js";
import { AnthropicProvider } from "./anthropic.js";
import { GeminiProvider } from "./gemini.js";
import { OpenAIProvider } from "./openai.js";

/**
 * Subset of the resolved config that `createProvider` consumes. The
 * agent loop / CLI passes this from a fully-validated `UserConfig`.
 */
export interface CreateProviderInput {
  provider: Provider;
  /**
   * Provider endpoint URL. Required when `provider ===
   * "openai-compatible"`; ignored for the others (the underlying SDKs
   * accept a baseURL override, but Fun Claw doesn't expose it for the
   * stock providers in v1 — flag a `[v2-or-never]` if a user genuinely
   * needs it).
   */
  endpoint?: string;
}

export { AnthropicProvider, GeminiProvider, OpenAIProvider };

/**
 * Build the right `LLMProvider` instance for `config.provider`. Resolves
 * the API key via `getSecret` (env first, then keyfile) and constructs
 * the matching adapter.
 */
export function createProvider(
  config: CreateProviderInput,
  options: GetSecretOptions = {},
): LLMProvider {
  const provider = config.provider;
  const apiKey = getSecret(provider, options);

  switch (provider) {
    case "anthropic":
      return new AnthropicProvider({ apiKey });

    case "openai":
      return new OpenAIProvider({ apiKey, name: "openai" });

    case "gemini":
      return new GeminiProvider({ apiKey });

    case "openai-compatible": {
      if (config.endpoint === undefined || config.endpoint === "") {
        throw funClawError({
          code: "FC-2008",
          message:
            "Provider 'openai-compatible' requires an endpoint URL. " +
            'Set FUNCLAW_ENDPOINT in your environment, or `endpoint = "https://..."` in your config.',
          data: { provider },
        });
      }
      return new OpenAIProvider({
        apiKey,
        baseURL: config.endpoint,
        name: "openai-compatible",
      });
    }

    default: {
      // TypeScript exhaustiveness: every member of the Provider enum is
      // handled above, so this branch is unreachable in well-typed code.
      // The defensive throw exists for malformed runtime input that
      // bypasses the type system (e.g., a hand-written JSON config that
      // somehow escaped Zod validation).
      const exhaustive: never = provider;
      throw funClawError({
        code: "FC-2009",
        message: `Unsupported provider value: ${String(exhaustive)}.`,
        data: { provider: exhaustive },
      });
    }
  }
}
