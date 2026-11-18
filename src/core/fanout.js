import path from 'node:path';
import { createHash } from 'node:crypto';
import { acquireLock, readState, writeState, WebUIError } from '../shared/persistent-browser.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const terminal = new Set(['completed', 'failed', 'cancelled', 'abandoned']);
const groupId = /^fanout:[a-f0-9]{64}$/;

export class Fanout {
  constructor(kernel) { this.kernel = kernel; }

  file(id) {
    if (!groupId.test(id)) throw new WebUIError('INVALID_FANOUT', 'Invalid fan-out task ID.');
    return path.join(this.kernel.directory, 'fanout', id.slice(7) + '.json');
  }

  validate(record, id) {
    if (record.version !== 1 || record.task_id !== id || !/^[a-f0-9]{64}$/.test(record.fingerprint) ||
        !Array.isArray(record.providers) || record.providers.length !== 2 || new Set(record.providers).size !== 2) {
      throw new WebUIError('INVALID_FANOUT', 'Fan-out task not found or damaged.');
    }
    for (const provider of record.providers) this.kernel.provider(provider);
    return record;
  }

  childRequest(record, provider) { return `${record.task_id}:${provider}`; }

  async send(input, { signal } = {}) {
    const { providers, request_id, prompt, files = [], session_id } = input;
    if (!Array.isArray(providers) || providers.length !== 2 || new Set(providers).size !== 2) {
      throw new WebUIError('INVALID_TARGETS', 'Specify two distinct providers.');
    }
    providers.forEach(provider => this.kernel.provider(provider));
    if (input.provider !== undefined || input.model !== undefined || input.thinking_level !== undefined ||
        input.answer_tier !== undefined || input.web_search || input.existing_draft) {
      throw new WebUIError('INVALID_TARGET_OPTIONS', 'Fan-out uses provider defaults and cannot reuse an existing draft or broadcast single-provider settings.');
    }
    if (typeof request_id !== 'string' || !request_id.trim() || request_id.length > 128 ||
        typeof prompt !== 'string' || !prompt.trim() || !Array.isArray(files) || files.length > 10 ||
        files.some(file => typeof file !== 'string' || !path.isAbsolute(file))) {
      throw new WebUIError('INVALID_FANOUT', 'Provide a request_id, prompt, and at most ten absolute file paths.');
    }
    const ordered = [...providers].sort();
    const id = `fanout:${hash(request_id)}`;
    const file = this.file(id);
    const fingerprint = hash({ providers: ordered, prompt, files, session_id });
    await this.kernel.verifyStorage(file);
    const unlock = await acquireLock(file + '.lock', { signal, operation: 'fanout-journal' });
    let record;
    try {
      signal?.throwIfAborted();
      record = await readState(file);
      if (!Object.keys(record).length) {
        record = { version: 1, task_id: id, fingerprint, providers: ordered, created_at: Date.now() };
        await writeState(file, record);
      }
      this.validate(record, id);
      if (record.fingerprint !== fingerprint) throw new WebUIError('IDEMPOTENCY_CONFLICT', 'Fan-out request_id already used with different input.');
    } finally { await unlock(); }
    return this.map(record, async provider => {
      const requestId = this.childRequest(record, provider);
      const existing = await this.kernel.findRequest(provider, requestId);
      if (existing || signal?.aborted) return existing;
      return this.kernel.send({
        provider, prompt, files, request_id: requestId, session_id: session_id ?? `fanout_${id.slice(7,55)}`,
      }, { signal });
    });
  }

  async result(id, { signal, wait = true, timeoutMs = 90_000, refresh, conversation_url } = {}) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000 || refresh || conversation_url !== undefined) {
      throw new WebUIError('INVALID_FANOUT_OPTIONS', 'Use a 1000..300000 ms budget; refresh or conversation_url requires a child task ID.');
    }
    const deadline = Date.now() + timeoutMs;
    const file = this.file(id);
    await this.kernel.verifyStorage(file, false);
    const record = this.validate(await readState(file), id);
    return this.map(record, async provider => {
      const task = await this.kernel.findRequest(provider, this.childRequest(record, provider));
      if (!task || terminal.has(task.state) || signal?.aborted) return task;
      const remaining = deadline - Date.now();
      if (remaining < 1000) return { ...task, timed_out: true };
      return this.kernel.result(task.task_id, { wait, timeoutMs: remaining, signal });
    });
  }

  async map(record, resolve) {
    const results = await Promise.allSettled(record.providers.map(resolve));
    const providers = results.map((result, index) => {
      const provider = record.providers[index];
      if (result.status === 'rejected') return { provider, state: 'unavailable', error: { code: result.reason?.code || 'FANOUT_CHILD_ERROR' } };
      return result.value ? { ...result.value, provider } : { provider, state: 'queued' };
    });
    return {
      task_id: record.task_id, created_at: record.created_at, providers,
      complete: providers.every(child => terminal.has(child.state)),
      all_succeeded: providers.every(child => child.state === 'completed'),
      timed_out: providers.some(child => child.timed_out),
      next_action: 'Read this task_id to observe. To resume unstarted targets, replay chat_send with the exact original request and request_id.',
    };
  }
}
