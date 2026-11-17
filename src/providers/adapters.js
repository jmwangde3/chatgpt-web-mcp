import { SELECTORS as chatgptSelectors } from '../selectors.js';
import { SELECTORS as geminiSelectors } from '../gemini/selectors.js';
import { WebUIError } from '../shared/persistent-browser.js';
import { USER_DATA_DIR, CHROME_EXECUTABLE, BROWSER_STATE_FILE, RUNTIME_STATE_FILE, OPERATION_LOCK_FILE } from '../config.js';
import { isResponseFailure } from '../gemini/browser.js';
import { classifyRateLimitText, readUserMessageIdentityDOM } from '../browser.js';
import { guardedStop, readGeminiStopIdentity } from '../shared/stop-guard.js';
import { textHash } from '../shared/user-message-identity.js';

async function stop(browser, selectors, users, readIdentity, expected) {
  return guardedStop({ page: await browser.page(), stops: selectors.join(','), users, readIdentity, expected });
}

export function geminiProvider(browser) {
  return {
    id: 'gemini', browser, stagedSend: true,
    localConfig: browser.config,
    capabilities: { files: true, models: true, history: true, archive: 'loaded-messages', cancellation: true, sessions: true, retry: true },
    isRoot: (url) => url === 'https://gemini.google.com/app',
    async prepare({ prompt, files, existing_draft } = {}) {
      await browser.editable({ empty: !existing_draft });
      if (existing_draft) {
        const draft = await browser.snapshot();
        const normalized = text => text.replace(/\s+/g, ' ').trim();
        if (normalized(draft.draft) !== normalized(prompt)) throw new WebUIError('DRAFT_MISMATCH', 'Existing draft differs from the explicitly supplied prompt; nothing was sent.');
        await browser.waitForUploads(files, { exact: true });
      }
      const s = await browser.snapshot();
      return { url: s.url, userCount: s.userCount, responseCount: s.responseCount, baselineHash: textHash(s.lastUser || '') };
    },
    async send({ prompt, files, existing_draft, beforeSubmit }) {
      if (!existing_draft) {
        await browser.writePrompt(prompt);
        if (files.length) await browser.uploadFiles(files);
      }
      return browser.submitPrompt({ wait: false, beforeSubmit });
    },
    async inspect({ allowPageError = false } = {}) {
      const s = await browser.snapshot(); await browser.check(s, { allowPending: true });
      if (!allowPageError && !s.busy && isResponseFailure(s.text)) throw new WebUIError('PAGE_ERROR', 'Gemini returned a service error instead of an answer. No automatic retry.');
      return { ...s, complete: !!s.text && !s.busy && s.completeControl };
    },
    settle: (expected, options) => browser.settlePending(expected, options),
    prepareRetry: (observed) => browser.prepareRetry(observed),
    cancel: expected => stop(browser, geminiSelectors.stop, geminiSelectors.user, readGeminiStopIdentity, expected),
  };
}

export function chatgptProvider(browser) {
  return {
    id: 'chatgpt', browser, stagedSend: true, prepareSettings: true,
    messageIdentityVersion: browser.messageIdentityVersion,
    localConfig: { profile: USER_DATA_DIR, executable: CHROME_EXECUTABLE, browserState: BROWSER_STATE_FILE, runtimeState: RUNTIME_STATE_FILE, operationLock: OPERATION_LOCK_FILE },
    capabilities: { files: true, models: true, history: true, archive: 'provider-transcript', cancellation: true, sessions: true },
    isRoot: (url) => url === 'https://chatgpt.com',
    isProvisional: (url) => /^\/c\/(?:WEB:|local-chatgpt:)[^/]+$/.test(decodeURIComponent(new URL(url).pathname)),
    restore: (url) => browser.restoreTaskConversation(url),
    async prepare({ model, thinking_level, answer_tier } = {}) {
      await browser.assertActionsAllowed('chat_send');
      await browser.ensureSignedIn();
      await browser.assertComposerEmpty('chat_send');
      await browser.ensureConversationCapacity({ allowRotate: false });
      await browser.refreshBeforeSend({ reason: 'unified-send' });
      const settings = await browser.applySendSettings({ model, thinkingLevel: thinking_level, answerTier: answer_tier });
      const s = await browser.getLatestResponse({ includeTranscript: false, includeIdentityCandidates: true });
      if (s.generating) throw new WebUIError('GENERATING', 'ChatGPT is still generating.');
      if (s.userMessageCount > 0 && s.identitySnapshotValid === false) throw new WebUIError('TASK_IDENTITY_CHANGED', 'Baseline identity is unstable.');
      return { url: s.url, userCount: s.userMessageCount, responseCount: s.assistantMessageCount,
        userMessageId: s.lastUserMessageId || null, responseId: s.lastResponseMessageId || null,
        baselineHash: textHash(s.lastUserMessage || ''), ...(settings.answerTier ? { answerTier: settings.answerTier } : {}) };
    },
    async send({ prompt, files, beforeSubmit, baseline, managedTaskId, onIdentityConfirmed }) {
      if (files.length) await browser.uploadFiles(files);
      await browser.writePrompt(prompt);
      const sent = await browser.submitPrompt({ wait: false, refresh: false, beforeSubmit, baseline, managedTaskId, onIdentityConfirmed });
      // Keep submission locked briefly so the permanent conversation URL can
      // be recorded and checked against the expected user turn.
      if (browser.waitForConversationURL) sent.url = await browser.waitForConversationURL();
      return sent;
    },
    async inspect() {
      const s = await browser.getLatestResponse({ includeTranscript: false, includeIdentityCandidates: true, skipGenerationRelease: true });
      // A persisted breaker gates actions, not observation. The task kernel still
      // verifies the conversation and exact user turn before accepting this text.
      const readableAnswer = !!s.response && !s.generating && !classifyRateLimitText(s.response).limited;
      if (s.rateLimited && !readableAnswer) throw new WebUIError('RATE_LIMITED', 'ChatGPT displays a rate-limit warning without a completed answer. No retry was sent.');
      return { url: s.url, userCount: s.userMessageCount, mountedUserCount: s.userMessageCount,
        userMessageId: s.lastUserMessageId || null, responseId: s.lastResponseMessageId || null,
        responseCount: s.assistantMessageCount, lastUser: s.identitySnapshotValid === false ? '' : s.lastUserMessage || '', identityCandidates: s.identitySnapshotValid === false ? [] : s.identityCandidates || [], text: s.response || '', busy: s.generating, complete: !!s.response && !s.generating, model: s.model };
    },
    settle: (expected, options) => browser.settleManagedGeneration(expected, options),
    async cancel(expected) {
      const physical = expected.userMessageId ? await browser.prepareTaskStop(expected) : expected;
      await stop(browser, chatgptSelectors.stopButton, chatgptSelectors.userMessages.join(','), readUserMessageIdentityDOM, physical);
      if (expected.userMessageId) await browser.verifyTaskMessage(expected);
    },
  };
}
