#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createSculptServer } from "./index.js";

try {
  const server = await createSculptServer();
  await server.connect(new StdioServerTransport(undefined, undefined, { maxBufferSize: 256 * 1024 * 1024 }));
} catch (error) {
  process.stderr.write(
    `threenative-sculpt-mcp failed to start: ${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exitCode = 1;
}
