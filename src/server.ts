#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createSculptServer } from "./index.js";

try {
  const server = await createSculptServer();
  await server.connect(new StdioServerTransport());
} catch (error) {
  process.stderr.write(
    `threenative-sculpt-mcp failed to start: ${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exitCode = 1;
}

