#!/usr/bin/env node
// Explicit opt-in Gemini acceptance using only the four Web-First MCP tools.
// No prompt is sent unless --send or --upload is supplied.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const sendEnabled = process.argv.includes('--send');
const uploadEnabled = process.argv.includes('--upload');
const client = new Client({ name: 'gemini-web-first-acceptance', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL('../src/index.js', import.meta.url))],
  stderr: 'pipe',
});
transport.stderr?.on('data', chunk => process.stderr.write(chunk));

async function call(name, args = {}, timeout = 110_000) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout });
  const body = result.content?.filter(item => item.type === 'text').map(item => item.text).join('\n') || '{}';
  const value = JSON.parse(body);
  if (result.isError) throw new Error(`${name}: ${value.code || 'ERROR'}: ${value.error || body}`);
  return value;
}

async function sendAndWait({ prompt, session_id, files = [] }) {
  const submitted = await call('chat_send', {
    provider: 'gemini',
    session_id,
    request_id: randomUUID(),
    prompt,
    files,
  });
  if (!submitted.task_id) throw new Error(`chat_send returned no task_id: ${JSON.stringify(submitted)}`);
  if (['failed', 'cancelled', 'abandoned'].includes(submitted.state)) {
    throw new Error(`Gemini task ended during submission (${submitted.state}): ${JSON.stringify(submitted.error)}`);
  }

  const deadline = Date.now() + 20 * 60_000;
  let latest = submitted;
  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    if (remainingMs < 1_000) break;
    latest = await call('chat_result', {
      task_id: submitted.task_id,
      wait: true,
      timeoutMs: Math.min(90_000, remainingMs),
    });
    if (latest.state === 'completed') return latest;
    if (['failed', 'cancelled', 'abandoned'].includes(latest.state)) {
      throw new Error(`Gemini task ended as ${latest.state}: ${JSON.stringify(latest.error)}`);
    }
    if (latest.state === 'uncertain' && latest.error?.retryable_observation !== true) {
      throw new Error(`Gemini task needs manual recovery; no resend was attempted: ${JSON.stringify(latest)}`);
    }
  }
  throw new Error(`Gemini task exceeded the 20-minute observation budget. Preserve task_id=${submitted.task_id}; it was not cancelled or resent. Latest: ${JSON.stringify(latest)}`);
}

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name), ['chat_send', 'chat_result', 'chat_history', 'chat_doctor']);

  if (!sendEnabled && !uploadEnabled) {
    const doctor = await call('chat_doctor', { provider: 'gemini' });
    console.log(JSON.stringify({ doctor, note: 'Local diagnostics only; this does not verify Gemini sign-in. Add --send or --upload for explicit live acceptance.' }, null, 2));
  }

  if (sendEnabled) {
    const session_id = `gemini_acceptance_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    const marker = `GEMINI_WEB_FIRST_OK_${randomUUID().slice(0, 8)}`;
    const first = await sendAndWait({
      session_id,
      prompt: `Software integration test only. Remember this marker and reply with only it: ${marker}`,
    });
    assert.match(first.response?.text || '', new RegExp(marker));
    const second = await sendAndWait({
      session_id,
      prompt: 'What exact marker did I ask you to remember in the previous message? Reply with only that marker.',
    });
    assert.match(second.response?.text || '', new RegExp(marker));
    console.log('PASS: Gemini Web-First send, durable task recovery, and same-session follow-up context.');
  }

  if (uploadEnabled) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-web-first-acceptance-'));
    const file = path.join(directory, 'gemini-acceptance.txt');
    const marker = `GEMINI_FILE_OK_${randomUUID().slice(0, 8)}`;
    let completed = false;
    try {
      await fs.writeFile(file, `${marker}\n`, 'utf8');
      const result = await sendAndWait({
        session_id: `gemini_upload_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
        prompt: 'Read the attached text file and reply with only the exact marker written inside it.',
        files: [file],
      });
      assert.match(result.response?.text || '', new RegExp(marker));
      completed = true;
      console.log('PASS: Gemini Web-First explicit file upload and file-content response.');
    } finally {
      if (completed) await fs.rm(directory, { recursive: true, force: true });
      else console.error(`Preserved temporary upload evidence for manual recovery: ${file}`);
    }
  }
} finally {
  await client.close();
}
