import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireLock, readState, writeState, WebUIError } from '../shared/persistent-browser.js';
import { safeControlDiagnostics } from '../shared/browser-diagnostics.js';
import { recoveryFor } from './recovery.js';
import { updateTaskProgress, nextPollDelayMs } from './progress.js';
import { validateSessionId } from '../shared/sessions.js';
import { textHash, matchesUserPrompt } from '../shared/user-message-identity.js';
import { verifyDataPaths } from '../shared/data-security.js';

export { textHash };
const fingerprint = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const terminal = new Set(['completed', 'cancelled', 'failed', 'abandoned']);
export function canonicalURL(value) { const u = new URL(value); return u.origin + u.pathname.replace(/\/$/, ''); }
export function taskView(task) {
  const { baseline, targetUserMessageId, promptHash, requestHash, fingerprint, progressHash, ...publicFields } = task;
  const progress = {
    ...(publicFields.progress || {
      phase: ['preparing', 'submitting'].includes(task.state) ? 'waiting_for_ack' : 'waiting',
      response_chars: typeof task.response?.text === 'string' ? Array.from(task.response.text).length : 0,
      last_progress_at: task.submitted_at ?? task.updated_at ?? task.created_at ?? null,
      no_progress_ms: null,
    }),
    ...(terminal.has(task.state) ? { phase: task.state } : {}),
  };
  return { ...publicFields, progress, recovery: recoveryFor(task) };
}

export function validateJournal(raw, id) {
  const state = raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length === 0 ? { version: 1, active: null, tasks: {} } : raw;
  if (!state || ![1, 2].includes(state.version) || !state.tasks || typeof state.tasks !== 'object' || Array.isArray(state.tasks) ||
      (state.active !== null && (typeof state.active !== 'string' || !state.tasks[state.active] || terminal.has(state.tasks[state.active].state))) ||
      Object.entries(state.tasks).some(([key, task]) => !task || task.task_id !== key || task.provider !== id ||
        !['preparing', 'submitting', 'submitted', 'running', 'uncertain', ...terminal].includes(task.state) ||
        (state.version === 1 && task.session_id !== undefined) ||
        (!terminal.has(task.state) && !task.session_id && state.active !== key))) throw new WebUIError('INVALID_JOURNAL', 'Unsupported or damaged task journal; nothing was sent.');
  const scopes = new Set();
  for (const task of Object.values(state.tasks)) {
    try { validateSessionId(task.session_id); } catch { throw new WebUIError('INVALID_JOURNAL', 'Invalid task session.'); }
    if (!terminal.has(task.state)) {
      const scope = task.session_id || '';
      if (scopes.has(scope)) throw new WebUIError('INVALID_JOURNAL', 'Multiple active tasks share one session.');
      scopes.add(scope);
    }
  }
  if (state.active && state.tasks[state.active].session_id) throw new WebUIError('INVALID_JOURNAL', 'Invalid legacy active task.');
  return state;
}

const activeIn = (state, sessionId) => Object.values(state.tasks).find(t => !terminal.has(t.state) && t.session_id === sessionId);
const releaseTask = (state, task) => { if (state.active === task.task_id) state.active = null; };
const strictIdentity = adapter => adapter.id === 'chatgpt' && adapter.messageIdentityVersion === 1;
function requireIdentityTarget(task) {
  if (task.messageIdentityVersion !== 1 || !task.targetUserMessageId) {
    throw new WebUIError('LEGACY_IDENTITY_UNVERIFIED', 'No persisted stable user identity is available; tracking remains reserved.');
  }
}
function verifyTaskIdentity(task, observed, { confirming = false, adapter } = {}) {
  const target = confirming ? observed.userMessageId : task.targetUserMessageId;
  const baselineURL = canonicalURL(task.baseline.url);
  const expected = task.conversation_url || (!adapter.isRoot(baselineURL) ? baselineURL : null);
  if (typeof target !== 'string' || !target.trim() || target === task.baseline.userMessageId
    || (task.targetUserMessageId && task.targetUserMessageId !== target)
    || observed.userMessageId !== target
    || (expected && canonicalURL(observed.url) !== canonicalURL(expected))
    || !matchesUserPrompt(task.promptHash, observed.lastUser, observed.identityCandidates)) {
    throw new WebUIError('SEND_UNCONFIRMED', 'Stable user identity or full prompt does not match; tracking remains reserved.');
  }
}
function controlIdentity(task, observed, adapter) {
  return { url: observed.url, userCount: observed.userCount, promptHash: task.promptHash,
    ...(strictIdentity(adapter) ? { messageIdentityVersion: 1, userMessageId: task.targetUserMessageId,
      targetUserMessageId: task.targetUserMessageId, managedTaskId: task.task_id } : {}) };
}

// Aging is advisory only; it never changes occupancy or persisted state.
function taskAge(task, now) {
  const since = task.state === 'submitted' ? task.submitted_at ?? task.updated_at ?? task.created_at : task.updated_at ?? task.created_at;
  const age_ms = Number.isFinite(since) ? Math.max(0, now - since) : null;
  const age_classification = task.state === 'submitted' && age_ms > 20000 ? 'NEEDS_RECONCILIATION'
    : task.state === 'uncertain' && age_ms > 600000 ? 'NEEDS_USER_REVIEW' : null;
  return { age_ms, age_classification };
}

export function journalStatistics(journal, { now = Date.now() } = {}) {
  const tasks = Object.values(journal.tasks);
  const active = tasks.filter(task => !terminal.has(task.state));
  const state_counts = {};
  for (const task of tasks) state_counts[task.state] = (state_counts[task.state] || 0) + 1;
  const oldest = active.filter(task => Number.isFinite(task.created_at)).sort((a, b) => a.created_at - b.created_at)[0];
  return {
    total_count: tasks.length, state_counts, active_count: active.length,
    blocking_count: tasks.filter(task => task.blocking === true).length,
    blocking_flag_mismatch_count: tasks.filter(task => task.blocking !== !terminal.has(task.state)).length,
    active_session_count: new Set(active.map(task => task.session_id || '')).size,
    oldest_active_task: oldest ? { state: oldest.state, created_at: oldest.created_at } : null,
    oldest_active_age_ms: oldest ? Math.max(0, now - oldest.created_at) : null,
    oldest_active_state: oldest?.state ?? null,
  };
}

// Journal and brief UI operations are serialized per provider. Generation and
// task occupancy are isolated by session; result waits release the lock.
export class TaskKernel {
  constructor(providers, { directory = process.env.WEB_CHAT_DATA_DIR || path.join(os.homedir(), '.web-chat-mcp'), verifyStoragePaths = verifyDataPaths, progressStallMs = 120000, controlBusyRetryMs = 5000 } = {}) {
    this.providers = new Map(providers.map((provider) => [provider.id, provider]));
    this.directory = path.resolve(directory);
    this.sessions = new Map();
    this.verifyStoragePaths = verifyStoragePaths;
    if (!Number.isFinite(progressStallMs) || progressStallMs < 1 || !Number.isFinite(controlBusyRetryMs) || controlBusyRetryMs < 1) throw new TypeError('Progress and CONTROL_BUSY retry intervals must be positive finite numbers.');
    this.progressStallMs = progressStallMs;
    this.controlBusyRetryMs = controlBusyRetryMs;
  }
  adapter(id, sessionId) {
    const provider = this.provider(id);
    validateSessionId(sessionId);
    if (!sessionId) return provider;
    if (!provider.forSession) throw new WebUIError('SESSIONS_UNSUPPORTED', 'This provider does not support isolated sessions.');
    const key = `${id}:${sessionId}`;
    if (!this.sessions.has(key)) this.sessions.set(key, provider.forSession(sessionId));
    return this.sessions.get(key);
  }
  provider(id) {
    const provider = this.providers.get(id);
    if (!provider || !/^[a-z][a-z0-9_-]*$/.test(id)) throw new WebUIError('UNKNOWN_PROVIDER', 'Unknown chat provider. Call chat_providers.');
    return provider;
  }
  taskProvider(taskId) {
    if (!/^[a-z][a-z0-9_-]*:[0-9a-f-]{36}$/.test(taskId)) throw new WebUIError('INVALID_TASK', 'Invalid task_id.');
    const id = taskId.split(':')[0]; this.provider(id); return id;
  }
  async readSnapshot(id) {
    this.provider(id);
    const file = path.join(this.directory, id, 'tasks.json');
    if (await fs.lstat(path.dirname(file)).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) await this.verifyStorage(file, false);
    return validateJournal(await readState(file), id);
  }
  async verifyStorage(file, allowCreate = true) {
    await this.verifyStoragePaths({ dataDirectories: [path.dirname(file)], protectedFiles: [file, file + '.lock', file + '.lock.reclaim'] }, { allowCreate });
  }
  async locked(id, fn, signal, deadline) {
    this.provider(id);
    const file = path.join(this.directory, id, 'tasks.json');
    await this.verifyStorage(file);
    const release = await acquireLock(`${file}.lock`, { signal, operation: 'task-journal', timeout: deadline ? Math.max(1, deadline - Date.now()) : 180000 });
    try {
      const raw = await readState(file);
      const state = validateJournal(raw, id);
      const save = () => writeState(file, state);
      return await fn(state, save);
    } finally { await release(); }
  }
  async run(id, fn, { signal, readOnly = false, name = 'unified-operation', sessionId, conversationChanged = false } = {}) {
    const adapter = this.adapter(id, sessionId);
    return this.locked(id, async (state, save) => {
      const active = activeIn(state, sessionId);
      if (active && !readOnly) throw new WebUIError('TASK_ACTIVE', `Session has task ${active.task_id}. Use chat_result or chat_cancel, or use a different session_id for independent work.`);
      const result = await adapter.browser.runExclusive(() => fn(adapter.browser), { signal, name });
      if (conversationChanged && sessionId) { state.sessionNavigations = { ...state.sessionNavigations, [sessionId]: Date.now() }; await save(); }
      return result;
    }, signal);
  }
  async send({ provider: id, request_id, prompt, files = [], model, newConversation = false, session_id, answer_tier, thinking_level, web_search = false, existing_draft = false }, { signal } = {}) {
    const adapter = this.adapter(id, session_id);
    if (typeof existing_draft !== 'boolean' || (existing_draft && (id !== 'gemini' || model || newConversation))) throw new WebUIError('INVALID_DRAFT_RECOVERY', 'existing_draft requires Gemini and cannot change the model or conversation.');
    if (typeof request_id !== 'string' || !request_id.trim() || request_id.length > 128) throw new WebUIError('INVALID_REQUEST_ID', 'A nonempty request_id of at most 128 characters is required. Reuse it after a timeout.');
    if (typeof prompt !== 'string' || !prompt.trim()) throw new WebUIError('EMPTY_PROMPT', 'Prompt must not be blank.');
    if (!Array.isArray(files) || files.length > 10 || files.some((file) => typeof file !== 'string' || !path.isAbsolute(file))) throw new WebUIError('INVALID_FILES', 'Use at most ten absolute local file paths.');
    const requestHash = fingerprint(request_id);
    if (model !== undefined && (typeof model !== 'string' || !model.trim())) throw new WebUIError('INVALID_MODEL', 'model must be a nonempty exact name.');
    if (answer_tier !== undefined && (typeof answer_tier !== 'string' || !answer_tier.trim())) throw new WebUIError('INVALID_TIER', 'answer_tier must be an exact available tier.');
    if (thinking_level !== undefined && (typeof thinking_level !== 'string' || !thinking_level.trim())) throw new WebUIError('INVALID_THINKING_LEVEL', 'thinking_level must be a nonempty exact name.');
    if (typeof web_search !== 'boolean') throw new WebUIError('INVALID_SEARCH', 'web_search must be a boolean.');
    if ((answer_tier || thinking_level || web_search) && id !== 'chatgpt') throw new WebUIError('UNSUPPORTED_SETTING', 'answer_tier, thinking_level and web_search currently require ChatGPT.');
    const payloadHash = fingerprint({ prompt, files, ...(model ? { model } : {}), ...(newConversation ? { newConversation: true } : {}), ...(session_id ? { session_id } : {}), ...(answer_tier ? { answer_tier } : {}), ...(thinking_level ? { thinking_level } : {}), ...(web_search ? { web_search } : {}), ...(existing_draft ? { existing_draft: true } : {}) });
    return this.locked(id, async (state, save) => {
      const existing = Object.values(state.tasks).find((task) => task.requestHash === requestHash);
      if (existing) {
        if (existing.fingerprint !== payloadHash) throw new WebUIError('IDEMPOTENCY_CONFLICT', 'This request_id was already used with different content.');
        return { ...taskView(existing), replayed: true };
      }
      const active = activeIn(state, session_id);
      if (active) throw new WebUIError('TASK_ACTIVE', `Session has task ${active.task_id}; do not resend. Use a different session_id for independent work.`);
      // Even an unbound/uncertain send reserves only its own target. Browser
      // adapters pin named sessions by CDP target ID and exclude those targets
      // from legacy selection. The conversation-identity guard below still
      // prevents two sessions from writing into the same known conversation.
      const task = { task_id: `${id}:${randomUUID()}`, provider: id, ...(session_id ? { session_id } : {}), state: 'preparing', requestHash, fingerprint: payloadHash, promptHash: textHash(prompt), created_at: Date.now(), updated_at: Date.now(), blocking: true, response: null, error: null };
      state.tasks[task.task_id] = task;
      if (session_id) state.version = 2; else state.active = task.task_id;
      await save();
      try {
        for (const file of files) {
          if (!(await fs.stat(file)).isFile()) throw new WebUIError('INVALID_FILES', 'Attachment must be a regular file.');
          await fs.access(file, fs.constants.R_OK);
        }
        await adapter.browser.runExclusive(async () => {
          if (newConversation) await adapter.browser.newChat();
          else if (session_id && adapter.restore) {
            const previous = Object.values(state.tasks).filter(t => t.task_id !== task.task_id && t.session_id === session_id && t.conversation_url).sort((a, b) => b.created_at - a.created_at)[0];
            if (previous && !(state.sessionNavigations?.[session_id] >= previous.created_at)) await adapter.restore(previous.conversation_url);
          }
          if (model && !adapter.prepareSettings) await adapter.browser.selectModel(model);
          task.baseline = await adapter.prepare({ prompt, files, existing_draft, model, thinking_level, answer_tier });
          if (!task.baseline.baselineHash && typeof task.baseline.lastUser === 'string') task.baseline.baselineHash = textHash(task.baseline.lastUser);
          if (adapter.prepareSettings && task.baseline.answerTier) task.answer_tier = task.baseline.answerTier;
          const baselineURL = canonicalURL(task.baseline.url);
          if (!adapter.isRoot(baselineURL) && !adapter.isProvisional?.(baselineURL) && Object.values(state.tasks).some(other => other.task_id !== task.task_id && !terminal.has(other.state) && [other.conversation_url, other.baseline?.url].some(url => url && canonicalURL(url) === baselineURL))) {
            throw new WebUIError('CONVERSATION_ACTIVE', 'Another session has an active task in this conversation. Use a new conversation for independent work.');
          }
          if (answer_tier && !adapter.prepareSettings) task.answer_tier = await adapter.browser.selectAnswerTier(answer_tier);
          if (thinking_level && !adapter.prepareSettings) await adapter.browser.selectThinkingLevel(thinking_level);
          if (web_search) await adapter.browser.enableWebSearch();
          // Persist before the first possible send. A crash from this point on
          // must be reconciled from the page, never retried automatically.
          const beforeSubmit = async () => { task.state = 'submitting'; task.updated_at = Date.now(); await save(); };
          if (!adapter.stagedSend) await beforeSubmit();
          let sent;
          const onIdentityConfirmed = async observed => {
            try { verifyTaskIdentity(task, observed, { confirming: true, adapter }); }
            catch (error) { throw new WebUIError('TASK_IDENTITY_CHANGED', error.message); }
            task.targetUserMessageId = observed.userMessageId;
            task.messageIdentityVersion = 1;
            task.updated_at = Date.now();
            await save();
          };
          try { sent = await adapter.send({ prompt, files, existing_draft, beforeSubmit,
            ...(strictIdentity(adapter) ? { baseline: task.baseline, managedTaskId: task.task_id, onIdentityConfirmed } : {}) }); }
          catch (error) {
            // Acknowledgement can render just after the browser timeout.
            // Reconcile once, read-only, while still owning the session lock.
            // Never infer delivery from a cleared composer or URL alone.
            if (error.code !== 'SEND_UNCONFIRMED') throw error;
            if (strictIdentity(adapter) && !task.targetUserMessageId) throw error;
            const observed = await adapter.inspect();
            if (strictIdentity(adapter)) {
              verifyTaskIdentity(task, observed, { adapter });
            }
            if (!adapter.isRoot(baselineURL) && !adapter.isProvisional?.(baselineURL) && canonicalURL(observed.url) !== baselineURL) throw error;
            if (!strictIdentity(adapter) && (observed.userCount !== task.baseline.userCount + 1 || !matchesUserPrompt(task.promptHash, observed.lastUser, id === 'chatgpt' ? observed.identityCandidates : []))) throw error;
            sent = { url: observed.url };
          }
          if (!strictIdentity(adapter)) {
            task.state = 'submitted'; task.submitted_at = Date.now(); task.updated_at = task.submitted_at;
          }
          const acknowledgement = strictIdentity(adapter) || adapter.restore ? await adapter.inspect() : null;
          if (strictIdentity(adapter)) {
            if (!task.targetUserMessageId) throw new WebUIError('SEND_UNCONFIRMED', 'No send-time identity confirmation was persisted.');
            verifyTaskIdentity(task, acknowledgement, { adapter });
            task.state = 'submitted'; task.submitted_at = Date.now(); task.updated_at = task.submitted_at;
          }
          const identityConfirmed = strictIdentity(adapter) || !acknowledgement || (acknowledgement.userCount === task.baseline.userCount + 1 && matchesUserPrompt(task.promptHash, acknowledgement.lastUser, id === 'chatgpt' ? acknowledgement.identityCandidates : []));
          const sentURL = acknowledgement?.url || sent.url;
          if (identityConfirmed && sentURL && !adapter.isRoot(canonicalURL(sentURL)) && !adapter.isProvisional?.(sentURL)) task.conversation_url = canonicalURL(sentURL);
          await save();
        }, { signal, name: 'chat_send' });
      } catch (error) {
        const definitelyNotSent = error.code === 'SEND_NOT_ATTEMPTED' && error.sendOutcome === 'not_attempted';
        task.state = definitelyNotSent ? 'failed' : task.state === 'preparing' ? 'failed' : 'uncertain';
        task.blocking = task.state !== 'failed';
        task.error = { code: error.code || (signal?.aborted ? 'INTERRUPTED' : 'PROVIDER_ERROR'), message: error.message.split('\n')[0], ...(error.safeDiagnostics ? { diagnostics: safeControlDiagnostics(error.safeDiagnostics) } : {}) };
        task.updated_at = Date.now(); if (!task.blocking) releaseTask(state, task);
        await save();
      }
      return taskView(task);
    }, signal);
  }
  async retry(taskId, { signal } = {}) {
    const id = this.taskProvider(taskId);
    return this.locked(id, async (state, save) => {
      const task = state.tasks[taskId];
      if (!task) throw new WebUIError('TASK_NOT_FOUND', 'Task not found.');
      // Persist a single attempt per task so reconnects never repeat a click.
      if (task.retry_count) return { ...taskView(task), replayed: true };
      const adapter = this.adapter(id, task.session_id);
      if (!adapter.prepareRetry) throw new WebUIError('RETRY_UNSUPPORTED', 'This provider does not support verified response retry.');
      if (task.state !== 'completed' || !task.response?.complete) throw new WebUIError('RETRY_NOT_COMPLETED', 'Retry requires a completed answer, not an uncertain send or running generation.');
      if (Object.values(state.tasks).some(t => t.task_id !== taskId && t.session_id === task.session_id && (t.created_at >= task.created_at || !terminal.has(t.state)))) throw new WebUIError('TASK_SUPERSEDED', 'A later or active task occupies this session.');
      await adapter.browser.runExclusive(async () => {
        const observed = await adapter.inspect();
        const expected = task.conversation_url || task.response.url;
        if (!expected || canonicalURL(observed.url) !== canonicalURL(expected)) throw new WebUIError('CONVERSATION_CHANGED', 'Open the original task conversation before retrying.');
        if (Object.values(state.tasks).some(t => t.task_id !== taskId && !terminal.has(t.state) && [t.conversation_url, t.baseline?.url].some(url => url && canonicalURL(url) === canonicalURL(expected)))) throw new WebUIError('CONVERSATION_ACTIVE', 'Another task is using this conversation.');
        if (observed.busy || !observed.complete || observed.userCount !== task.baseline.userCount + 1 || !matchesUserPrompt(task.promptHash, observed.lastUser, id === 'chatgpt' ? observed.identityCandidates : []) || observed.text !== task.response.text) throw new WebUIError('RETRY_TARGET_CHANGED', 'The page no longer matches the completed task response.');
        if (task.response.model && observed.model !== task.response.model) throw new WebUIError('RETRY_MODEL_CHANGED', 'The selected model or thinking setting changed; restore it before retrying.');
        const clickRetry = await adapter.prepareRetry(observed);
        task.previous_response = task.response; task.response = null;
        task.retry_count = 1; task.retry_started_at = Date.now(); task.retry_activity = false;
        task.state = 'submitting'; task.blocking = true; task.error = null;
        if (!task.session_id) state.active = taskId;
        task.updated_at = Date.now(); await save();
        try {
          const result = await clickRetry();
          task.retry_activity = result.started === true;
          task.state = 'submitted';
        } catch (error) {
          task.state = 'uncertain';
          task.error = { code: error.code || 'RETRY_UNCONFIRMED', message: error.message.split('\n')[0], ...(error.safeDiagnostics ? { diagnostics: safeControlDiagnostics(error.safeDiagnostics) } : {}) };
        }
        task.updated_at = Date.now(); await save();
      }, { signal, name: 'chat_retry' });
      return taskView(task);
    }, signal);
  }

  async read(taskId, { signal, cancel = false, refresh = false, conversation_url, deadline, budgetReason } = {}) {
    const id = this.taskProvider(taskId);
    return this.locked(id, async (state, save) => {
      const task = state.tasks[taskId];
      if (!task) throw new WebUIError('TASK_NOT_FOUND', 'Task not found.');
      const revalidate = refresh && task.state === 'completed' && !cancel;
      if (terminal.has(task.state) && !revalidate) return taskView(task);
      if (task.state === 'preparing') {
        task.state = 'failed'; task.blocking = false; releaseTask(state, task);
        task.error = { code: 'PREFLIGHT_INTERRUPTED', message: 'Interrupted before sending. No automatic retry.' }; await save(); return taskView(task);
      }
      const adapter = this.adapter(id, task.session_id);
      if (strictIdentity(adapter) && task.state === 'completed' && (!task.targetUserMessageId || task.messageIdentityVersion !== 1)) return taskView(task);
      const recoverUnconfirmed = strictIdentity(adapter) && !cancel && !refresh && conversation_url && adapter.restore &&
        task.state === 'uncertain' && !task.targetUserMessageId && !task.conversation_url &&
        ['SEND_UNCONFIRMED', 'LEGACY_IDENTITY_UNVERIFIED', 'GENERATION_CONVERSATION_MISMATCH'].includes(task.error?.code) &&
        task.baseline?.url && adapter.isRoot(canonicalURL(task.baseline.url)) &&
        task.baseline.userCount === 0 && task.baseline.responseCount === 0 &&
        task.baseline.userMessageId === null && task.baseline.responseId === null;
      if (strictIdentity(adapter) && !terminal.has(task.state) && !recoverUnconfirmed) {
        try { requireIdentityTarget(task); } catch (error) {
          task.state = 'uncertain'; task.error = { code: error.code, message: error.message };
          task.updated_at = Date.now(); await save(); return taskView(task);
        }
      }
      if (revalidate) {
        if (Object.values(state.tasks).some(t => t.task_id !== taskId && t.session_id === task.session_id && (t.created_at >= task.created_at || !terminal.has(t.state)))) throw new WebUIError('TASK_SUPERSEDED', 'A later task uses this session. The cached result is preserved; inspect history separately.');
        task.previous_response = task.response;
        task.response = null; task.state = 'uncertain'; task.blocking = true;
        if (!task.session_id) state.active = taskId;
        await save();
      }
      const previousState = task.state, previousError = task.error;
      let observationOnly = !cancel && !revalidate;
      try {
        await adapter.browser.runExclusive(async () => {
          const saved = task.conversation_url;
          const known = saved && !adapter.isProvisional?.(saved) ? saved : canonicalURL(task.baseline.url);
          const unresolved = adapter.isRoot(known) || adapter.isProvisional?.(known);
          if (conversation_url && !unresolved && canonicalURL(conversation_url) !== known) throw new WebUIError('CONVERSATION_CONFLICT', 'Recovery URL disagrees with the saved task conversation.');
          const expected = conversation_url ? canonicalURL(conversation_url) : known;
          const root = adapter.isRoot(expected) || adapter.isProvisional?.(expected);
          if (!root && adapter.restore && (task.session_id || conversation_url || revalidate)) await adapter.restore(expected);
          const observed = await adapter.inspect(recoverUnconfirmed ? { recovery: {
            url: expected, managedTaskId: taskId, promptHash: task.promptHash,
          } } : undefined);
          signal?.throwIfAborted();
          const url = canonicalURL(observed.url);
          if (url !== expected && !root) throw new WebUIError('CONVERSATION_CHANGED', 'Open the task conversation before resuming it.');
          if (recoverUnconfirmed) {
            // Only an explicitly selected, completed first turn can recover an
            // unconfirmed send. Do not adopt a user ID for cancellation.
            const occupied = Object.values(state.tasks).some(other => other !== task &&
              [other.conversation_url, other.baseline?.url].some(value => value && canonicalURL(value) === url));
            if (root || occupied || observed.userCount !== 1 || observed.responseCount !== 1 ||
                !observed.complete || observed.busy || !observed.text || !observed.responseId?.trim()) {
              throw new WebUIError('SEND_UNCONFIRMED', 'Recovery requires an unclaimed conversation with exactly one completed turn.');
            }
            verifyTaskIdentity(task, observed, { confirming: true, adapter });
            task.targetUserMessageId = observed.userMessageId;
            task.messageIdentityVersion = 1;
          } else if (strictIdentity(adapter)) {
            requireIdentityTarget(task);
            verifyTaskIdentity(task, observed, { adapter });
          }
          const acknowledged = strictIdentity(adapter) || (observed.userCount === task.baseline.userCount + 1 && matchesUserPrompt(task.promptHash, observed.lastUser, id === 'chatgpt' ? observed.identityCandidates : []));
          // UI acknowledgement may arrive after submitPrompt(wait:false).
          // Briefly keep observing an unchanged baseline, without a retry.
          if (!acknowledged && !cancel && task.state === 'submitted' && task.submitted_at && Date.now() - task.submitted_at < 20000 && observed.userCount === task.baseline.userCount && observed.responseCount === task.baseline.responseCount) return;
          if (!acknowledged) throw new WebUIError('SEND_UNCONFIRMED', 'The expected user turn is not confirmed. No resend was attempted.');
          // From here the callback may mutate task state or settle generation.
          // A timeout after this boundary is not a purely observational timeout.
          observationOnly = false;
          const identity = controlIdentity(task, observed, adapter);
          if (!adapter.isProvisional?.(url)) task.conversation_url = url;
          if (task.retry_count && !task.retry_activity) {
            if (observed.busy || (observed.text && observed.text !== task.previous_response?.text)) task.retry_activity = true;
            else throw new WebUIError('RETRY_UNCONFIRMED', 'Only the previous answer is visible; retry completion is not confirmed. Do not click again.');
          }
          const newResponse = strictIdentity(adapter) ? typeof observed.responseId === 'string' && !!observed.responseId.trim() && observed.responseId !== task.baseline.responseId : observed.responseCount > task.baseline.responseCount;
          updateTaskProgress(task, { ...observed, text: newResponse ? observed.text : '' }, Date.now(), this.progressStallMs, textHash);
          if (observed.complete && newResponse) {
            await adapter.settle(identity);
            task.state = 'completed'; task.blocking = false; releaseTask(state, task);
            task.response = { text: observed.text, format: 'plain_text', complete: true, model: observed.model || null, url: observed.url };
            task.progress = { ...task.progress, phase: 'completed' };
          } else if (cancel) {
            if (!observed.busy) throw new WebUIError('CANCEL_UNCONFIRMED', 'No active generation control could be confirmed. Task remains reserved.');
            await adapter.cancel(identity);
            await adapter.settle(identity, { allowIdle: true });
            task.state = 'cancelled'; task.blocking = false; releaseTask(state, task);
            task.response = { text: observed.text || '', format: 'plain_text', complete: false, model: observed.model || null, url: observed.url };
            task.progress = { ...task.progress, phase: 'cancelled' };
          } else { task.state = observed.busy ? 'running' : 'submitted'; task.blocking = true; }
          task.error = null;
        }, { signal, name: cancel ? 'chat_cancel' : 'chat_result' });
      } catch (error) {
        if (observationOnly && budgetReason && signal?.reason === budgetReason && error === budgetReason) throw error;
        task.state = 'uncertain';
        const interruptedAfterBoundary = budgetReason && signal?.reason === budgetReason && error === budgetReason;
        const retainPriorError = error.code === 'CONTROL_BUSY' && previousState === 'uncertain' && previousError && !['CONTROL_BUSY', 'RESULT_TIMEOUT'].includes(previousError.code);
        task.error = retainPriorError ? previousError : { code: interruptedAfterBoundary ? (cancel ? 'CANCEL_UNCONFIRMED' : 'RESULT_OBSERVATION_INTERRUPTED') : error.code || (signal?.aborted ? 'INTERRUPTED' : 'PROVIDER_ERROR'), message: error.message.split('\n')[0], ...(observationOnly && error.code === 'CONTROL_BUSY' ? { retryable_observation: true } : {}), ...(error.safeDiagnostics ? { diagnostics: safeControlDiagnostics(error.safeDiagnostics) } : {}) };
      }
      task.updated_at = Date.now(); await save(); return taskView(task);
    }, signal, deadline);
  }
  async result(taskId, { wait = false, timeoutMs = 30000, signal, refresh = false, conversation_url, onProgress } = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) throw new WebUIError('INVALID_TIMEOUT', 'timeoutMs must be between 1000 and 300000.');
    const deadline = Date.now() + timeoutMs;
    const budget = new AbortController();
    const budgetReason = Object.assign(new Error('Result observation timed out; read the same task again.'), { code: 'RESULT_TIMEOUT' });
    const timer = setTimeout(() => budget.abort(budgetReason), timeoutMs);
    const observationSignal = signal ? AbortSignal.any([signal, budget.signal]) : budget.signal;
    let latest;
    let pollStep = 0;
    let previousProgressKey = null;
    try {
      while (true) {
        observationSignal.throwIfAborted();
        latest = await this.read(taskId, { signal: observationSignal, refresh, conversation_url, deadline, budgetReason });
        refresh = false;
        if (typeof onProgress === 'function') {
          try {
            const pending = onProgress(latest.progress, latest);
            if (pending && typeof pending.then === 'function') Promise.resolve(pending).catch(() => {});
          } catch {}
        }
        const retryControlBusy = latest.state === 'uncertain' && latest.error?.code === 'CONTROL_BUSY' && latest.error?.retryable_observation === true;
        if (!wait || terminal.has(latest.state) || (latest.state === 'uncertain' && !retryControlBusy) || Date.now() >= deadline) return { ...latest, timed_out: !terminal.has(latest.state) && Date.now() >= deadline };
        // Retry only a controller-cleanup error proven to occur before settle/cancel.
        if (retryControlBusy) {
          await delay(Math.min(this.controlBusyRetryMs, Math.max(1, deadline - Date.now())), undefined, { signal: observationSignal });
          continue;
        }
        const progressKey = latest.progress
          ? String(latest.progress.phase) + ':' + String(latest.progress.response_chars) + ':' + String(latest.progress.last_progress_at)
          : latest.state;
        const hadProgress = progressKey !== previousProgressKey;
        previousProgressKey = progressKey;
        const next = nextPollDelayMs(pollStep, hadProgress, deadline - Date.now());
        pollStep = next.nextStep;
        await delay(next.delayMs, undefined, { signal: observationSignal });
      }
    } catch (error) {
      signal?.throwIfAborted();
      const budgetTimeout = budget.signal.aborted && (error === budgetReason || (error.name === 'AbortError' && error.code === 'ABORT_ERR' && error.cause === budgetReason));
      if (!budgetTimeout && !(error.code === 'BUSY' && Date.now() >= deadline)) throw error;
      // A busy journal belongs to another operation. Atomic state writes make
      // this read-only fallback safe; never modify or reclaim its live lock.
      const id = this.taskProvider(taskId);
      const raw = validateJournal(await readState(path.join(this.directory, id, 'tasks.json')), id);
      const task = raw.tasks[taskId];
      if (!task) throw new WebUIError('TASK_NOT_FOUND', 'Task not found.');
      return { ...taskView(task), timed_out: !terminal.has(task.state) };
    } finally { clearTimeout(timer); }
  }
  async abandon(taskId, { confirm = false, signal } = {}) {
    if (confirm !== true) throw new WebUIError('CONFIRM_REQUIRED', 'Explicit confirmation is required to abandon tracking; this cannot undo a send.');
    const id = this.taskProvider(taskId);
    return this.locked(id, async (state, save) => {
      const task = state.tasks[taskId];
      if (!task) throw new WebUIError('TASK_NOT_FOUND', 'Task not found.');
      if (terminal.has(task.state)) return taskView(task);
      if (task.state === 'preparing') {
        task.state = 'failed'; task.blocking = false; releaseTask(state, task);
        task.error = { code: 'PREFLIGHT_INTERRUPTED', message: 'Interrupted before sending. No automatic retry.' }; await save(); return taskView(task);
      }
      const adapter = this.adapter(id, task.session_id);
      if (strictIdentity(adapter)) {
        try { requireIdentityTarget(task); } catch (error) {
          task.state = 'uncertain'; task.error = { code: error.code, message: error.message };
          task.updated_at = Date.now(); await save(); return taskView(task);
        }
      }
      try {
      await adapter.browser.runExclusive(async () => {
        const observed = await adapter.inspect({ allowPageError: true });
        const saved = task.conversation_url;
        const expected = saved && !adapter.isProvisional?.(saved) ? saved : task.baseline?.url;
        if (!expected || canonicalURL(observed.url) !== canonicalURL(expected)) throw new WebUIError('CONVERSATION_CHANGED', 'Return to the original page before abandoning tracking.');
        if (strictIdentity(adapter)) {
          verifyTaskIdentity(task, observed, { adapter });
        }
        if (observed.busy) throw new WebUIError('GENERATING', 'Generation is active. Use chat_cancel for the verified task.');
        const sent = strictIdentity(adapter) || (observed.userCount === task.baseline.userCount + 1 && matchesUserPrompt(task.promptHash, observed.lastUser, id === 'chatgpt' ? observed.identityCandidates : []));
        const baseline = observed.userCount === task.baseline.userCount && observed.responseCount === task.baseline.responseCount &&
          matchesUserPrompt(task.baseline.baselineHash, observed.lastUser);
        if (!sent && !baseline) throw new WebUIError('TASK_IDENTITY_CHANGED', 'Neither the original sent turn nor the complete original baseline is confirmed; tracking was preserved.');
        await adapter.settle({ ...controlIdentity(task, observed, adapter),
          ...(sent ? {} : { baselineOnly: true, baselineHash: task.baseline.baselineHash, responseCount: task.baseline.responseCount }) }, { allowIdle: true });
      }, { signal, name: 'chat_abandon' });
      } catch (error) {
        if (!strictIdentity(adapter)) throw error;
        task.state = 'uncertain'; task.error = { code: error.code || 'PROVIDER_ERROR', message: error.message.split('\n')[0] };
        task.updated_at = Date.now(); await save(); return taskView(task);
      }
      task.state = 'abandoned'; task.blocking = false; task.updated_at = Date.now();
      task.error = { code: 'TRACKING_ABANDONED', message: 'Tracking explicitly abandoned. Delivery and completion are not asserted; the request_id remains reserved.' };
      releaseTask(state, task); await save(); return taskView(task);
    }, signal);
  }
  async list(id, limit = 20, { offset = 0, state: filter } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) throw new WebUIError('INVALID_PAGE', 'limit must be 1..100 and offset a nonnegative integer.');
    if (filter && !['preparing', 'submitting', 'submitted', 'running', 'uncertain', ...terminal].includes(filter)) throw new WebUIError('INVALID_STATE', 'Unknown task state.');
    const state = await this.readSnapshot(id);
    const now = Date.now();
    const tasks = Object.values(state.tasks).filter((task) => !filter || task.state === filter).sort((a, b) => b.created_at - a.created_at || a.task_id.localeCompare(b.task_id));
    return { provider: id, active_task: state.active, active_tasks: Object.values(state.tasks).filter(t => !terminal.has(t.state)).map(t => ({ task_id: t.task_id, session_id: t.session_id || null, state: t.state })), total: tasks.length, offset, next_offset: offset + limit < tasks.length ? offset + limit : null, tasks: tasks.slice(offset, offset + limit).map((task) => {
      const view = { ...taskView(task), ...taskAge(task, now) }; delete view.response; delete view.previous_response; return view;
    }) };
  }
  async findRequest(id, requestId) {
    const state = await this.readSnapshot(id);
    const task = Object.values(state.tasks).find((task) => task.requestHash === fingerprint(requestId));
    return task ? taskView(task) : null;
  }
}
