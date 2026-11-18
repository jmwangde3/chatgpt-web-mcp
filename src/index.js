#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync } from 'node:fs';
import { createRuntime } from './core/runtime.js';
import { registerWebFirstTools } from './core/tools.js';

const runtime = createRuntime();
const { kernel } = runtime;
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const server = new McpServer({ name: 'web-chat', version }, {
  instructions: [
    'This MCP intentionally exposes exactly four tools: chat_send, chat_result, chat_history and chat_doctor.',
    'Web-First: use chat_send before local agents make substantive decisions about requirements, research, architecture, design, technical choices, root causes or implementation plans. Local agents gather minimum necessary facts, execute the returned specification and verify it.',
    'chat_send defaults to the ChatGPT provider; use Gemini only when explicitly requested. Reuse one stable session_id per project and use a new request_id for each new logical request.',
    'chat_result defaults to wait=true with a 90-second observation slice. A timeout is not task failure or cancellation. If a slice ends with retryable_observation=true, another slice may resume the same task_id within the 20-minute agent budget; never resend uncertain work.',
    'The total automatic observation budget is an agent-side limit of 20 minutes per logical task. Reaching it stops waiting only; it does not cancel or release the browser task.',
    'Provider-specific lifecycle, cancellation, task listing and maintenance are intentionally not MCP tools; use the documented CLI commands when needed. Model discovery and selection are intentionally not provided through MCP or a generic CLI replacement.',
    'Never upload an entire workspace, credentials, cookies, tokens or unrelated private data. Send only the minimum context and explicitly authorized files.',
    'Browser sessions remain open and provider rate limits are shared. Never route user data to another provider without authorization.',
  ].join(' '),
});

registerWebFirstTools(server, kernel);

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  await runtime.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.stdin.on('end', shutdown);
process.stdin.on('close', shutdown);
await server.connect(new StdioServerTransport());
server.server.onclose = shutdown;
console.error('web-chat-mcp ready');
