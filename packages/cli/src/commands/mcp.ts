// `funclaw mcp` — placeholder for an MCP-server management subcommand.
//
// MCP integration itself is fully wired into `funclaw chat` (servers
// declared in `[mcp.<name>]` TOML tables auto-spawn at chat-start
// time, see `docs/troubleshooting.md` FC-3xxx for failure modes).
// The standalone `funclaw mcp add / list / remove` subcommand for
// editing the config from the CLI was deferred from v1 — TOML is
// human-edited and the doctor command verifies the result.
//
// `[v2-or-never: funclaw mcp add/list/remove subcommands —
// editing config from the CLI; defer until users want it badly
// enough to file an issue.]`

import type { Command } from "commander";

export function registerMcp(program: Command): void {
  const mcp = program.command("mcp").description("manage Model Context Protocol servers");

  mcp
    .command("list")
    .description("list configured MCP servers")
    .action(() => {
      process.stdout.write(
        "MCP servers are configured under `[mcp.<name>]` tables in your funclaw.config.toml.\n" +
          "Run `funclaw doctor` to verify the current configuration parses.\n" +
          "(A standalone `funclaw mcp add/list/remove` editor is deferred to a future release.)\n",
      );
    });

  // No default action so `funclaw mcp` prints help.
}
