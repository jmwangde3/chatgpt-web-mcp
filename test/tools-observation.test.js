import test from 'node:test';
import assert from 'node:assert/strict';
import { registerWebFirstTools } from '../src/core/tools.js';

function setup() {
  const handlers = new Map();
  const calls = [];
  const kernel = {
    providers: new Map([['chatgpt', {}], ['gemini', {}]]),
    run: async (provider, fn, options) => {
      calls.push({ provider, options });
      return fn({ listHistory: async input => ({ items: [{ id: 'history-1' }], scope: 'session', complete: false, input }) });
    },
  };
  registerWebFirstTools({ registerTool: (name, config, handler) => handlers.set(name, { config, handler }) }, kernel);
  return { handlers, calls };
}

test('chat_history reads the requested ChatGPT session without navigation or mutation', async () => {
  const { handlers, calls } = setup();
  const tool = handlers.get('chat_history');
  const input = tool.config.inputSchema.parse({ session_id: 'study', query: 'paper', limit: 10 });
  const result = await tool.handler(input, {});
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.scope, 'session');
  assert.equal(body.complete, false);
  assert.deepEqual(body.input, { query: 'paper', limit: 10 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, 'chatgpt');
  assert.equal(calls[0].options.readOnly, true);
  assert.equal(calls[0].options.sessionId, 'study');
  assert.equal(calls[0].options.conversationChanged, undefined);
});

test('chat_history can explicitly read Gemini without exposing provider-specific tools', async () => {
  const { handlers, calls } = setup();
  const tool = handlers.get('chat_history');
  const input = tool.config.inputSchema.parse({ provider: 'gemini', session_id: 'gemini-study' });
  await tool.handler(input, {});
  assert.equal(calls[0].provider, 'gemini');
  assert.equal(calls[0].options.readOnly, true);
  assert.equal(calls[0].options.sessionId, 'gemini-study');
});
