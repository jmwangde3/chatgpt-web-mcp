#!/usr/bin/env node
// Explicit live acceptance. This creates one synthetic conversation only with --send.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const provider = process.argv.includes('--gemini') ? 'gemini' : 'chatgpt';
const session_id = `live_acceptance_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
const request_id = randomUUID();
const marker = `WEB_FIRST_MCP_OK_${randomUUID().slice(0, 8)}`;
const serverEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  key === 'R345_TEST_ROOT' || /^(WEB_CHAT_|CHATGPT_WEB_|GEMINI_WEB_)/.test(key),
));
let client;

async function connect() {
  client = new Client({ name: 'web-first-live-acceptance', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../src/index.js', import.meta.url))],
    env: serverEnv,
    stderr: 'pipe',
  });
  transport.stderr?.on('data', chunk => process.stderr.write(chunk));
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name), ['chat_send', 'chat_result', 'chat_history', 'chat_doctor']);
}

async function call(name, args, timeout = 110_000) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout });
  const text = result.content?.filter(item => item.type === 'text').map(item => item.text).join('\n') || '{}';
  const value = JSON.parse(text);
  if (result.isError) throw new Error(`${name}: ${value.code || 'ERROR'}: ${value.error || text}`);
  return value;
}

try {
  await connect();
  if (!process.argv.includes('--send')) {
    console.log(JSON.stringify({ tools: ['chat_send', 'chat_result', 'chat_history', 'chat_doctor'], provider, note: 'Add --send to create one synthetic conversation.' }, null, 2));
  } else {
    const input = {
      provider,
      session_id,
      request_id,
      prompt: `Integration test only. Reply with this exact marker and nothing else: ${marker}`,
    };
    console.log(JSON.stringify({ synthetic_request: input }));
    const submitted = await call('chat_send', input);
    assert.equal(submitted.state, 'submitted', JSON.stringify(submitted.error));
    console.log(`Submitted ${submitted.task_id}; reconnecting MCP before reading.`);

    await client.close();
    await connect();
    const replay = await call('chat_send', input);
    assert.equal(replay.task_id, submitted.task_id);
    assert.equal(replay.replayed, true);

    const deadline = Date.now() + 20 * 60_000;
    let result;
    while (Date.now() < deadline) {
      const remainingMs = deadline - Date.now();
      if (remainingMs < 1_000) break;
      const observationMs = Math.min(90_000, remainingMs);
      result = await call('chat_result', { task_id: submitted.task_id, wait: true, timeoutMs: observationMs });
      if (result.state === 'completed') break;
      if (['failed', 'cancelled', 'abandoned'].includes(result.state)) throw new Error(`Task ended as ${result.state}: ${JSON.stringify(result.error)}`);
      if (result.state === 'uncertain' && !result.error?.retryable_observation) throw new Error(`Task needs manual recovery: ${JSON.stringify(result.error)}`);
    }
    assert.equal(result?.state, 'completed', `Live task exceeded 20-minute observation budget: ${submitted.task_id}`);
    assert.ok(result.response.text.includes(marker));
    const cached = await call('chat_result', { task_id: submitted.task_id, wait: false });
    assert.deepEqual(cached.response, result.response);
    console.log(`PASS ${provider}: four-tool surface, durable send, reconnect, idempotent replay, complete answer and cached result.`);
  }
} finally {
  await client?.close();
}
