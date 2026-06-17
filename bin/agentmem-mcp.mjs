#!/usr/bin/env node
// agentmem MCP server entry point (SOU-23).
//
// Connects the McpServer (lib/mcp.mjs) to stdio, the standard MCP transport.
// Register this binary in your host's MCP config:
//
//   Claude Code (~/.claude.json under "mcpServers"):
//     "agentmem": { "command": "node", "args": ["/path/to/bin/agentmem-mcp.mjs"] }
//
//   Cowork (analogous block in its MCP settings).
//
// Environment:
//   AGENTMEM_HOME — override the store location (default: lib/paths.mjs).
//
// stdout is reserved for the MCP protocol; anything diagnostic must go to
// stderr (this file uses process.stderr.write directly).

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "../lib/mcp.mjs";

async function main() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Note: do not write to stdout here — that channel is owned by MCP.
  process.stderr.write("[agentmem-mcp] connected via stdio\n");
}

main().catch((err) => {
  process.stderr.write(`[agentmem-mcp] fatal: ${err?.stack || err?.message || err}\n`);
  process.exit(1);
});
