#!/usr/bin/env node

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const transport = new StdioClientTransport({
  command: process.execPath,
  env: { ...process.env },
  args: [fileURLToPath(new URL('../src/index.js', import.meta.url))],
  stderr: 'pipe',
});
transport.stderr?.on('data', chunk => process.stderr.write(chunk));

const client = new Client({ name: 'chatgpt-web-mcp-smoke', version: '1.0.0' });
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = tools.map(tool => tool.name);
  const expected = ['chat_send', 'chat_result', 'chat_history', 'chat_doctor'];
  console.log(`tools=${tools.length}`);
  console.log(names.join('\n'));
  assert.deepEqual(names, expected, 'MCP must expose exactly the four Web-First tools in stable order');

  const send = tools.find(tool => tool.name === 'chat_send');
  assert.equal(send.inputSchema.properties.provider.default, 'chatgpt');
  const result = tools.find(tool => tool.name === 'chat_result');
  assert.equal(result.inputSchema.properties.wait.default, true);
  assert.equal(result.inputSchema.properties.timeoutMs.default, 90_000);
  assert.equal(result.inputSchema.properties.timeoutMs.maximum, 300_000);

  const doctor = await client.callTool({ name: 'chat_doctor', arguments: {} });
  assert.equal(doctor.isError, undefined);
  assert.equal(JSON.parse(doctor.content[0].text).scope, 'local_only');
  console.log('PASS: exact four-tool surface, ChatGPT default, 90-second wait defaults, and local doctor.');
} finally {
  await client.close();
}
