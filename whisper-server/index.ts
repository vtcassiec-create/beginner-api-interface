import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { resolveConfig } from './config.js';
import { VaultManager } from './vault/VaultManager.js';
import { createReadNoteTool } from './tools/readNote.js';
import { createWriteNoteTool } from './tools/writeNote.js';
import { createAppendNoteTool } from './tools/appendNote.js';
import { createDeleteNoteTool } from './tools/deleteNote.js';
import { createListNotesTool } from './tools/listNotes.js';
import { createSearchNotesTool } from './tools/searchNotes.js';
import { createGetBacklinksTool } from './tools/getBacklinks.js';
import { createDailyNoteTool } from './tools/createDailyNote.js';

const PORT = parseInt(process.env.PORT || '3000', 10);
const URL_SECRET = process.env.AUTH_TOKEN;

if (!URL_SECRET) {
  console.error('FATAL: AUTH_TOKEN required.');
  process.exit(1);
}

function buildServer(vault: VaultManager): McpServer {
  const server = new McpServer({
    name: 'obsidian-mcp-server',
    version: '1.0.0',
  });

  const tools = [
    createReadNoteTool(vault),
    createWriteNoteTool(vault),
    createAppendNoteTool(vault),
    createDeleteNoteTool(vault),
    createListNotesTool(vault),
    createSearchNotesTool(vault),
    createGetBacklinksTool(vault),
    createDailyNoteTool(vault),
  ];

  for (const tool of tools) {
    server.tool(tool.name, tool.description, tool.inputSchema.shape, async (input: Record<string, unknown>) => {
      try {
        const text = await tool.handler(input as never);
        return { content: [{ type: 'text' as const, text }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    });
  }

  return server;
}

async function main(): Promise<void> {
  const config = resolveConfig();
  const vault = new VaultManager(config.vaultPath);

  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', vault: config.vaultPath });
  });

  // ---- Legacy HTTP+SSE transport (unchanged — claude.ai uses this) ----
  const sseServer = buildServer(vault);
  let transport: SSEServerTransport | null = null;

  app.get(`/sse-${URL_SECRET}`, async (_req, res) => {
    transport = new SSEServerTransport(`/messages-${URL_SECRET}`, res);
    await sseServer.connect(transport);
  });

  app.post(`/messages-${URL_SECRET}`, async (req, res) => {
    if (!transport) {
      res.status(400).json({ error: 'No active SSE connection' });
      return;
    }
    await transport.handlePostMessage(req, res, req.body);
  });

  // ---- Modern Streamable HTTP transport (stateless — Petrichor uses this) ----
  app.post(`/mcp-${URL_SECRET}`, async (req, res) => {
    const server = buildServer(vault);
    const httpTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on('close', () => {
      httpTransport.close();
      server.close();
    });
    try {
      await server.connect(httpTransport);
      await httpTransport.handleRequest(req, res, req.body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[obsidian-mcp] streamable error: ${message}`);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  app.get(`/mcp-${URL_SECRET}`, (_req, res) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed.' },
      id: null,
    });
  });

  app.delete(`/mcp-${URL_SECRET}`, (_req, res) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed.' },
      id: null,
    });
  });

  app.listen(PORT, () => {
    console.error(`[obsidian-mcp] Server listening on port ${PORT}`);
    console.error(`[obsidian-mcp] Vault: ${config.vaultPath}`);
  });
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[obsidian-mcp] Fatal error: ${message}`);
  process.exit(1);
});
