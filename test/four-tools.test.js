import test from 'node:test';
import assert from 'node:assert/strict';
import { registerWebFirstTools } from '../src/core/tools.js';

function register(kernel) {
  const tools = new Map();
  const server = {
    registerTool(name, config, handler) {
      tools.set(name, { config, handler });
    },
  };
  registerWebFirstTools(server, kernel);
  return tools;
}

function fakeKernel() {
  const calls = {};
  return {
    calls,
    providers: new Map([['chatgpt', {}], ['gemini', {}]]),
    async send(input, options) { calls.send = { input, options }; return { task_id: 'chatgpt:00000000-0000-4000-8000-000000000001' }; },
    async result(taskId, options) { calls.result = { taskId, options }; return { task_id: taskId, state: 'running' }; },
    async run(provider, fn, options) {
      calls.run = { provider, options };
      return fn({ listHistory: async input => ({ items: [], scope: 'session', complete: false, input }) });
    },
  };
}

const expectedNames = ['chat_send', 'chat_result', 'chat_history', 'chat_doctor'];

test('MCP registration exposes exactly four tools and no legacy compatibility surface', () => {
  const tools = register(fakeKernel());
  assert.deepEqual([...tools.keys()], expectedNames);
  for (const removed of ['chat_status', 'chat_new', 'chat_models', 'chat_select_model', 'chat_cancel', 'chat_retry', 'chat_tasks', 'chat_abandon', 'chat_archive', 'chat_compare', 'chat_providers', 'chatgpt_send_message', 'gemini_send_message']) {
    assert.equal(tools.has(removed), false, `${removed} must not be registered`);
  }
});

test('chat_send defaults provider to ChatGPT and retains explicit Gemini selection', async () => {
  const kernel = fakeKernel();
  const tools = register(kernel);
  const send = tools.get('chat_send');
  const defaults = send.config.inputSchema.parse({ request_id: 'r1', prompt: 'design this' });
  assert.equal(defaults.provider, 'chatgpt');
  assert.deepEqual(defaults.files, []);
  assert.equal(defaults.web_search, false);
  assert.equal(defaults.existing_draft, false);
  await send.handler(defaults, {});
  assert.equal(kernel.calls.send.input.provider, 'chatgpt');

  const gemini = send.config.inputSchema.parse({ provider: 'gemini', request_id: 'r2', prompt: 'explicit Gemini request' });
  assert.equal(gemini.provider, 'gemini');
});

test('chat_result defaults to one 90-second blocking observation', () => {
  const tools = register(fakeKernel());
  const parsed = tools.get('chat_result').config.inputSchema.parse({ task_id: 'chatgpt:00000000-0000-4000-8000-000000000001' });
  assert.equal(parsed.wait, true);
  assert.equal(parsed.timeoutMs, 90_000);
  assert.equal(parsed.refresh, false);
});

test('chat_history defaults to ChatGPT and is read-only', async () => {
  const kernel = fakeKernel();
  const tools = register(kernel);
  const parsed = tools.get('chat_history').config.inputSchema.parse({});
  assert.equal(parsed.provider, 'chatgpt');
  assert.equal(parsed.limit, 20);
  await tools.get('chat_history').handler(parsed, {});
  assert.equal(kernel.calls.run.provider, 'chatgpt');
  assert.equal(kernel.calls.run.options.readOnly, true);
});

test('all four tools reject undeclared arguments', () => {
  const tools = register(fakeKernel());
  assert.throws(() => tools.get('chat_send').config.inputSchema.parse({ request_id: 'r', prompt: 'x', legacy: true }));
  assert.throws(() => tools.get('chat_result').config.inputSchema.parse({ task_id: 'x', timeout_ms: 90000 }));
  assert.throws(() => tools.get('chat_history').config.inputSchema.parse({ legacy: true }));
  assert.throws(() => tools.get('chat_doctor').config.inputSchema.parse({ legacy: true }));
});
