import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { registerChatGPTTools } from '../src/providers/chatgpt-tools.js';

const schemas = new Map();
registerChatGPTTools({ registerTool: (name, { inputSchema }) => schemas.set(name, inputSchema) }, {}, {});
const files = count => Array.from({ length: count }, (_, i) => `C:/unused/file-${i}.txt`);

for (const name of ['chatgpt_upload_files', 'chatgpt_send_message', 'chatgpt_route_new_chat']) {
  test(`${name} accepts ten files and rejects eleven at input validation`, () => {
    const schema = schemas.get(name);
    const input = name === 'chatgpt_upload_files' ? {} : { prompt: 'unused' };
    assert.equal(schema.safeParse({ ...input, files: files(10) }).success, true);
    const result = schema.safeParse({ ...input, files: files(11) });
    assert.equal(result.success, false);
    assert.ok(result.error.issues.some(issue => issue.code === 'too_big' && issue.maximum === 10 && issue.path.join('.') === 'files'));
    assert.equal(schema.safeParse({ prompt: 'unused', files: [''] }).success, false);
    if (name === 'chatgpt_upload_files') {
      assert.equal(schema.safeParse({ files: [] }).success, false);
      assert.equal(schema.safeParse({}).success, false);
    } else {
      assert.deepEqual(schema.parse({ prompt: 'unused' }).files, []);
      assert.equal(schema.safeParse({ prompt: 'unused', files: [] }).success, true);
    }
  });
}
