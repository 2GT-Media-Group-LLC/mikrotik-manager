import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AuthPayload } from '../../middleware/auth';
import type { McpAuth } from './settings';
import { REVIEW_INSTRUCTIONS, REVIEW_TOOLS, runReviewTool, type Input } from './tools';

export { reviewScope } from './tools';

/** An MCP server offering the review tools to one caller, for one request. */
export function createReviewServer(user: AuthPayload, ip: string, auth: McpAuth = 'oauth'): McpServer {
  const server = new McpServer({ name: 'mikrotik-manager', version: '1.0.0' }, { instructions: REVIEW_INSTRUCTIONS });
  for (const tool of REVIEW_TOOLS) {
    server.registerTool(tool.name, {
      description: tool.description, inputSchema: z.object(tool.shape).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      ...(auth === 'oauth' ? { _meta: { securitySchemes: [{ type: 'oauth2', scopes: ['mcp:read'] }] } } : {}),
    }, async (raw) => {
      const outcome = await runReviewTool(tool, user, ip, raw as Input, { path: '/api/mcp', entity: 'mcp' });
      if (!outcome.ok) return { isError: true, content: [{ type: 'text' as const, text: outcome.error }] };
      return { content: [{ type: 'text' as const, text: JSON.stringify(outcome.output) }], structuredContent: outcome.output };
    });
  }
  return server;
}
