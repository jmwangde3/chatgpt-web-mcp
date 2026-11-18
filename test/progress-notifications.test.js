import test from 'node:test';
import assert from 'node:assert/strict';
import { registerWebFirstTools } from '../src/core/tools.js';

function resultHandler(kernel) {
  const handlers = new Map();
  registerWebFirstTools({
    registerTool(name, _config, handler) { handlers.set(name, handler); },
  }, kernel);
  return handlers.get('chat_result');
}

function mockKernel() {
  return {
    providers: new Map([['chatgpt', {}], ['gemini', {}]]),
    async result(taskId, options) {
      options.onProgress?.({ phase: 'thinking', response_chars: 0 }, { task_id: taskId, created_at: Date.now() - 1000 });
      options.onProgress?.({ phase: 'streaming', response_chars: 24 }, { task_id: taskId, created_at: Date.now() - 1000 });
      return { task_id: taskId, state: 'running', timed_out: true };
    },
  };
}

test('chat_result emits monotonic status-only progress when the caller supplies a token', async () => {
  const handler = resultHandler(mockKernel());
  const notifications = [];
  const response = await handler({ task_id: 'chatgpt:00000000-0000-4000-8000-000000000001', wait: true, timeoutMs: 90000 }, {
    _meta: { progressToken: 'progress-1' },
    sendNotification: async notification => notifications.push(notification),
  });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(JSON.parse(response.content[0].text).timed_out, true);
  assert.equal(notifications.length, 2);
  assert.deepEqual(notifications.map(item => item.method), ['notifications/progress', 'notifications/progress']);
  assert.deepEqual(notifications.map(item => item.params.progress), [1, 2]);
  assert.ok(notifications.every(item => item.params.progressToken === 'progress-1'));
  assert.ok(notifications.every(item => !('total' in item.params)));
  assert.match(notifications[0].params.message, /phase=thinking/);
  assert.match(notifications[1].params.message, /phase=streaming/);
  assert.ok(notifications.every(item => !item.params.message.includes('partial answer')));
});

test('chat_result works normally when no progress token is supplied', async () => {
  const handler = resultHandler(mockKernel());
  let notificationCount = 0;
  const response = await handler({ task_id: 'chatgpt:00000000-0000-4000-8000-000000000002' }, {
    sendNotification: async () => { notificationCount += 1; },
  });
  assert.equal(JSON.parse(response.content[0].text).state, 'running');
  assert.equal(notificationCount, 0);
});

test('progress notification failures never fail chat_result', async () => {
  const handler = resultHandler(mockKernel());
  const response = await handler({ task_id: 'chatgpt:00000000-0000-4000-8000-000000000003' }, {
    _meta: { progressToken: 7 },
    sendNotification: async () => { throw new Error('client disconnected'); },
  });
  assert.equal(JSON.parse(response.content[0].text).timed_out, true);
});

test('asynchronous progress writes preserve monotonically increasing sequence order', async () => {
  const handler = resultHandler(mockKernel());
  const notifications = [];
  await handler({ task_id: 'chatgpt:00000000-0000-4000-8000-000000000004' }, {
    _meta: { progressToken: 'progress-order' },
    sendNotification: async notification => {
      if (notification.params.progress === 1) await new Promise(resolve => setTimeout(resolve, 25));
      notifications.push(notification.params.progress);
    },
  });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.deepEqual(notifications, [1, 2]);
});
