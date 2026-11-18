// Offline only: every request is fulfilled locally; owns only its test browser.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { browserTestTempRoot } from './helpers/temp-root.js';
import { GeminiBrowser } from '../src/gemini/browser.js';
import { geminiConfig } from '../src/gemini/config.js';
import { textHash } from '../src/shared/user-message-identity.js';
import { bootstrapSendGuard } from '../src/shared/send-guard.js';

let browser;
before(async () => { browser = await chromium.launch({ headless: true,
  executablePath: geminiConfig().executable || chromium.executablePath() }); });
after(async () => { await browser?.close(); });
const html = `<!doctype html><style>user-query,input-area,file-preview{display:block}[contenteditable]{white-space:pre-wrap}</style>
<main></main><input-area><rich-textarea><div contenteditable="true" role="textbox"></div></rich-textarea>
<file-preview>report.txt</file-preview><button aria-label="Send message">Send</button></input-area>
<script>window.sends=0;window.captures=0;
window.addEventListener('click',()=>window.captures++,true);
document.querySelector('button').onclick=e=>{window.sends++;window.trusted=e.isTrusted;};</script>`;

async function fixture(t, { early = true, persistRuntime = false } = {}) {
  const root = path.resolve(browserTestTempRoot());
  const directory = await fs.mkdtemp(path.join(root, 'gemini-send-guard-'));
  const context = await browser.newContext();
  t.after(async () => { await context.close(); assert.equal(path.dirname(directory), root);
    await fs.rm(directory, { recursive: true, force: true }); });
  await context.route('**/*', r => r.fulfill({ contentType: 'text/html', body: html }));
  const page = await context.newPage();
  const config = geminiConfig({ GEMINI_WEB_DATA_DIR: directory });
  config.actionTimeout = 10000;
  const b = new GeminiBrowser(config, { connect: async () => context, disconnect: async () => {} });
  // Keep this boundary suite independent of Windows state-file rename behavior.
  if (!persistRuntime) {
    let state = {};
    b.state = async () => structuredClone(state);
    b.update = async (fields, { expectedPendingAttempt } = {}) => {
      if (expectedPendingAttempt === undefined || state.pending?.attemptId === expectedPendingAttempt) {
        state = { ...state, ...structuredClone(fields) };
      }
      return structuredClone(state);
    };
  }
  b.throttle = async () => {};
  // page() installs the context document-start script, never a late page script.
  if (early) await b.page();
  await page.goto('https://gemini.google.com/app/fixture');
  if (!early) await b.page();
  b.currentPage = page;
  b.throttle = async () => {};
  await page.locator('[contenteditable]').fill('Exact\n\nCase  spacing');
  return { b, page, context };
}

test('formless Gemini region permits exactly one trusted send', async t => {
  const { b, page } = await fixture(t);
  await b.submitPrompt({ wait: false });
  assert.deepEqual(await page.evaluate(() => [window.sends, window.trusted]), [1, true]);
});

test('hidden generic progress outside the Gemini composer does not prevent a trusted send', async t => {
  const { b, page } = await fixture(t);
  await page.locator('file-preview').evaluate(node => node.remove());
  await page.locator('main').evaluate(node => node.insertAdjacentHTML('beforeend', '<div role="progressbar" style="display:none"></div><div role="progressbar" style="visibility:hidden">Hidden</div>'));
  await b.submitPrompt({ wait: false });
  assert.deepEqual(await page.evaluate(() => [window.sends, window.trusted]), [1, true]);
});

for (const { region, markup } of [
  { region: 'main', markup: '<div role="progressbar">Working</div>' },
  { region: 'input-area', markup: '<div role="progressbar" style="display:none"></div>' },
  { region: 'main', markup: '<div data-state="uploading" style="display:none"></div>' },
  { region: 'main', markup: '<div data-testid="upload-progress" style="display:none"></div>' },
]) {
  test(`Gemini keeps blocking progress or upload evidence in ${region}: ${markup}`, async t => {
    const { b, page } = await fixture(t);
    await page.locator(region).evaluate((node, snippet) => node.insertAdjacentHTML('beforeend', snippet), markup);
    await assert.rejects(b.submitPrompt({ wait: false }), error =>
      error.code === 'SEND_NOT_ATTEMPTED' && /Active upload or progress detected/.test(error.message));
    assert.deepEqual(await page.evaluate(() => [window.sends, window.captures]), [0, 0]);
    assert.equal((await b.state()).pending, null);
  });
}

for (const mutation of ['url', 'case', 'space', 'attachment replacement', 'attachment label',
  'manual user', 'region replacement', 'second region', 'readonly', 'busy']) {
  test(`persistence-window race rejects ${mutation} before application capture`, async t => {
    const { b, page } = await fixture(t);
    await assert.rejects(b.submitPrompt({ wait: false, beforeSubmit: async () => {
      await page.evaluate(kind => {
        const c = document.querySelector('[contenteditable]');
        const a = document.querySelector('file-preview');
        if (kind === 'url') history.pushState({}, '', '/app/other');
        if (kind === 'case') c.innerText = c.innerText.toLowerCase();
        if (kind === 'space') c.innerText = c.innerText.replace('  ', ' ');
        if (kind === 'attachment replacement') a.replaceWith(a.cloneNode(true));
        if (kind === 'attachment label') a.textContent = 'other.txt';
        if (kind === 'manual user') { const q = document.createElement('user-query'); q.textContent = 'manual'; document.querySelector('main').append(q); }
        if (kind === 'region replacement') { const r = document.querySelector('input-area'); const n = document.createElement('input-area'); r.replaceWith(n); while (r.firstChild) n.append(r.firstChild); }
        if (kind === 'second region') {
          const region = document.createElement('input-area');
          region.innerHTML = '<div contenteditable="true" role="textbox">Other draft</div><button aria-label="Send message">Other send</button>';
          document.body.append(region);
        }
        if (kind === 'readonly') c.setAttribute('contenteditable', 'false');
        if (kind === 'busy') document.querySelector('input-area').insertAdjacentHTML('beforeend', '<span aria-busy="true"></span>');
      }, mutation);
    } }), e => e.code === 'SEND_NOT_ATTEMPTED' && e.sendOutcome === 'not_attempted');
    assert.deepEqual(await page.evaluate(() => [window.sends, window.captures]), [0, 0]);
    assert.equal((await b.state()).pending, null);
  });
}

test('late attachment mutation during pending persistence is rejected', async t => {
  const { b, page } = await fixture(t);
  const update = b.update.bind(b);
  b.update = async (fields, options) => { const result = await update(fields, options);
    if (fields.pending) await page.locator('file-preview').evaluate(e => e.replaceWith(e.cloneNode(true)));
    return result; };
  await assert.rejects(b.submitPrompt({ wait: false }), e => e.code === 'SEND_NOT_ATTEMPTED');
  assert.equal(await page.evaluate(() => window.sends), 0);
});

test('confirmed rejection clears only its own persisted attempt and leaves the draft', async t => {
  const { b, page } = await fixture(t, { persistRuntime: true });
  const composer = page.locator('[contenteditable]');
  const draft = await composer.innerText();
  await assert.rejects(b.submitPrompt({ wait: false, beforeSubmit: () =>
    page.locator('main').evaluate(node => node.insertAdjacentHTML('beforeend', '<div role="progressbar">Busy</div>')),
  }), { code: 'SEND_NOT_ATTEMPTED' });
  assert.equal((await b.state()).pending, null);
  assert.equal(await composer.innerText(), draft);
});

test('a replacement pending attempt is not cleared after a rejected click', async t => {
  const { b, page } = await fixture(t, { persistRuntime: true });
  const update = b.update.bind(b);
  const replacement = { attemptId: 'another-attempt' };
  b.update = async (fields, options) => {
    const result = await update(fields, options);
    if (fields.pending) {
      await update({ pending: replacement });
      await page.locator('main').evaluate(node => node.insertAdjacentHTML('beforeend', '<div role="progressbar">Busy</div>'));
    }
    return result;
  };
  await assert.rejects(b.submitPrompt({ wait: false }), { code: 'SEND_NOT_ATTEMPTED' });
  assert.deepEqual((await b.state()).pending, replacement);
});

test('an interrupted click with unknown outcome preserves the pending attempt', async t => {
  const { b, page } = await fixture(t, { persistRuntime: true });
  const update = b.update.bind(b);
  b.update = async (fields, options) => {
    const result = await update(fields, options);
    if (fields.pending) await page.close();
    return result;
  };
  await assert.rejects(b.submitPrompt({ wait: false }), error => error.code !== 'SEND_NOT_ATTEMPTED');
  assert.ok((await b.state()).pending?.attemptId);
  assert.equal(page.isClosed(), true);
});

test('losing the guard outcome after the application receives the click preserves pending', async t => {
  const { b, page } = await fixture(t, { persistRuntime: true });
  const evaluate = page.evaluate.bind(page);
  page.evaluate = async (...args) => {
    const result = await evaluate(...args);
    if (result?.outcome === 'allowed') {
      assert.equal(await evaluate(() => window.sends), 1);
      throw new Error('Lost the guard outcome after dispatch');
    }
    return result;
  };
  await assert.rejects(b.submitPrompt({ wait: false }), /Lost the guard outcome after dispatch/);
  assert.ok((await b.state()).pending?.attemptId);
});

test('nested Gemini layout ancestors and empty regions do not create another composer', async t => {
  const { b, page } = await fixture(t);
  await page.locator('input-area').evaluate(region => {
    const ancestor = document.createElement('div'); ancestor.className = 'input-area-container';
    region.replaceWith(ancestor); ancestor.append(region); region.classList.add('input-area');
    document.body.append(document.createElement('input-area'));
  });
  await b.submitPrompt({ wait: false });
  assert.deepEqual(await page.evaluate(() => [window.sends, window.trusted]), [1, true]);
});

for (const change of ['cross-region button', 'nested independent composer']) {
  test(`nested layout still refuses ${change}`, async t => {
    const { b, page } = await fixture(t);
    await assert.rejects(b.submitPrompt({ wait: false, beforeSubmit: () => page.evaluate(change => {
      const inner = document.createElement('div'); inner.className = 'input-area-container';
      document.querySelector('input-area').append(inner);
      if (change === 'cross-region button') inner.append(document.querySelector('button'));
      else inner.innerHTML = '<div contenteditable="true" role="textbox">Independent</div><button aria-label="Send message">Send</button>';
    }, change) }), e => e.code === 'SEND_NOT_ATTEMPTED');
    assert.deepEqual(await page.evaluate(() => [window.sends, window.captures]), [0, 0]);
  });
}

test('existing unguarded page refuses send and preserves its exact draft', async t => {
  const { b, page } = await fixture(t, { early: false });
  const draft = await page.locator('[contenteditable]').innerText();
  let prepared = false;
  await assert.rejects(b.submitPrompt({ wait: false, beforeSubmit: () => { prepared = true; } }),
    e => e.code === 'SEND_NOT_ATTEMPTED');
  assert.equal(prepared, false);
  assert.equal(await page.locator('[contenteditable]').innerText(), draft);
  assert.equal(await page.evaluate(() => window.sends), 0);
});

test('context installation covers subsequent new pages', async t => {
  const { context } = await fixture(t);
  const page = await context.newPage();
  await page.goto('https://gemini.google.com/app/new');
  assert.equal(await page.evaluate(() => typeof window.__webChatSendGate.handler), 'function');
});

test('preflight refreshes an empty unguarded Gemini tab before preparing a send', async t => {
  const { b, page } = await fixture(t, { early: false });
  await page.locator('file-preview').evaluate(node => node.remove());
  await page.locator('[contenteditable]').fill('');
  await page.context().unrouteAll();
  await page.context().route('**/*', route => route.fulfill({ contentType: 'text/html', body: html.replace('<file-preview>report.txt</file-preview>', '') }));
  await b.prepareSendPage();
  assert.equal(await page.evaluate(() => typeof window.__webChatSendGate?.handler), 'function');
  assert.equal(await page.evaluate(() => window.sends), 0);
});

test('CDP refuses a late Gemini guard behind an earlier window capture', async t => {
  const { b, page } = await fixture(t, { early: false });
  // Materialize locator utilities first, then deliberately install too late.
  await page.locator('[contenteditable]').innerText();
  await page.evaluate(bootstrapSendGuard);
  let prepared = false;
  await assert.rejects(b.submitPrompt({ wait: false, beforeSubmit: () => { prepared = true; } }),
    e => e.code === 'SEND_NOT_ATTEMPTED');
  assert.equal(prepared, false);
  assert.deepEqual(await page.evaluate(() => [window.sends, window.captures]), [0, 0]);
});

test('body is never accepted as an implicit input region', async t => {
  const { b, page } = await fixture(t);
  await page.locator('input-area').evaluate(e => e.replaceWith(...e.childNodes));
  await assert.rejects(b.submitPrompt({ wait: false }), e => e.code === 'SEND_NOT_ATTEMPTED');
  assert.equal(await page.evaluate(() => window.sends), 0);
});

async function pendingFixture(t) {
  const f = await fixture(t);
  const prompt = 'Original prompt';
  const pending = { originalURL: f.page.url(), conversationURL: f.page.url(), userCount: 0,
    responseCount: 0, promptHash: textHash(prompt), baselineHash: textHash(''), startedAt: 1 };
  await f.b.update({ pending });
  await f.page.evaluate(prompt => {
    const q = document.createElement('user-query'); q.innerHTML = '<div class="query-text"></div>';
    q.firstChild.textContent = prompt; document.querySelector('main').append(q);
  }, prompt);
  return { ...f, pending, expected: { url: f.page.url(), userCount: 1, promptHash: textHash(prompt) } };
}

for (const kind of ['url', 'count', 'hash']) {
  test(`settle and resolve preserve pending after ${kind} changes`, async t => {
    const { b, page, pending, expected } = await pendingFixture(t);
    await page.evaluate(kind => {
      if (kind === 'url') history.pushState({}, '', '/app/other');
      if (kind === 'count') { const q = document.createElement('user-query'); q.textContent = 'Original prompt'; document.querySelector('main').append(q); }
      if (kind === 'hash') document.querySelector('.query-text').textContent = 'Different prompt';
    }, kind);
    await assert.rejects(b.settlePending(expected), e => e.code === 'TASK_IDENTITY_CHANGED');
    await assert.rejects(b.resolvePending({ confirmed: true }), e => e.code === 'TASK_IDENTITY_CHANGED');
    assert.deepEqual((await b.state()).pending, pending);
  });
}

test('settle accepts exact current total and full shared hash', async t => {
  const { b, expected } = await pendingFixture(t);
  await b.settlePending(expected, {});
  assert.equal((await b.state()).pending, null);
});

test('baseline settle checks original pending hash and response count', async t => {
  const { b, page, pending } = await pendingFixture(t);
  await page.locator('user-query').evaluate(e => e.remove());
  const expected = { url: page.url(), userCount: 0, promptHash: pending.promptHash, baselineHash: textHash(''), baselineOnly: true, responseCount: 0 };
  await assert.rejects(b.settlePending({ ...expected, promptHash: textHash('wrong') }), e => e.code === 'TASK_IDENTITY_CHANGED');
  await assert.rejects(b.settlePending({ ...expected, responseCount: 1 }), e => e.code === 'TASK_IDENTITY_CHANGED');
  await b.settlePending(expected);
  assert.equal((await b.state()).pending, null);
});

test('baseline settle rejects an edited original user at identical URL and counts', async t => {
  const { b, page, pending } = await pendingFixture(t);
  const requestedHash = textHash('Next requested prompt');
  const baselinePending = { ...pending, userCount: 1, promptHash: requestedHash, baselineHash: textHash('Original prompt') };
  await b.update({ pending: baselinePending });
  const expected = { url: page.url(), userCount: 1, responseCount: 0, baselineOnly: true,
    baselineHash: textHash('Original prompt'), promptHash: requestedHash };
  await assert.rejects(b.settlePending({ ...expected, baselineHash: undefined }), { code: 'TASK_IDENTITY_CHANGED' });
  await assert.rejects(b.settlePending({ ...expected, responseCount: undefined }), { code: 'TASK_IDENTITY_CHANGED' });
  await page.locator('.query-text').evaluate(node => { node.textContent = 'Edited original prompt'; });
  const after = await b.snapshot();
  assert.equal(after.url, expected.url); assert.equal(after.userCount, 1); assert.equal(after.responseCount, 0);
  await assert.rejects(b.settlePending(expected), { code: 'TASK_IDENTITY_CHANGED' });
  assert.deepEqual((await b.state()).pending, baselinePending);
  await page.locator('.query-text').evaluate(node => { node.textContent = 'Original prompt'; });
  await b.settlePending(expected);
  assert.equal((await b.state()).pending, null);
});

test('legacy pending without baseline identity cannot be cleared at the original baseline', async t => {
  const { b, page, pending } = await pendingFixture(t);
  const legacy = { ...pending }; delete legacy.baselineHash;
  await b.update({ pending: legacy });
  await page.locator('user-query').evaluate(node => node.remove());
  await assert.rejects(b.resolvePending({ confirmed: true }), { code: 'TASK_IDENTITY_CHANGED' });
  assert.deepEqual((await b.state()).pending, legacy);
});

for (const root of ['https://gemini.google.com/app', 'https://gemini.google.com/app/']) {
  test(`unbound pending from ${root} settles only the acknowledged permanent turn`, async t => {
    const { b, pending, expected } = await pendingFixture(t);
    await b.update({ pending: { ...pending, originalURL: root, conversationURL: null } });
    const update = b.update.bind(b), writes = [];
    b.update = async fields => { writes.push(fields); return update(fields); };
    await b.settlePending(expected);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].pending, null);
    assert.equal((await b.state()).selectedURL, expected.url);
  });
}

for (const kind of ['bound URL', 'non-root original', 'extra user', 'pending hash',
  'expected hash', 'expected URL', 'invalid path', 'query', 'fragment', 'foreign origin', 'baselineOnly']) {
  test(`root pending cannot acquire a permanent binding after ${kind} mismatch`, async t => {
    const { b, page, pending, expected } = await pendingFixture(t);
    const pinned = { ...pending, originalURL: 'https://gemini.google.com/app', conversationURL: null };
    const identity = { ...expected };
    if (kind === 'bound URL') pinned.conversationURL = 'https://gemini.google.com/app/original';
    if (kind === 'non-root original') pinned.originalURL = 'https://gemini.google.com/app/original';
    if (kind === 'pending hash') pinned.promptHash = textHash('Other pending prompt');
    if (kind === 'expected hash') identity.promptHash = textHash('Other expected prompt');
    if (kind === 'expected URL') identity.url = 'https://gemini.google.com/app/other';
    if (kind === 'extra user') {
      await page.locator('user-query').evaluate(e => e.after(e.cloneNode(true)));
      identity.userCount = 2; // Both identical hashes still cannot bypass pending's exact total.
    }
    if (['invalid path', 'query', 'fragment'].includes(kind)) {
      const suffix = { 'invalid path': '/app/fixture/extra', query: '/app/fixture?q=1', fragment: '/app/fixture#other' }[kind];
      await page.evaluate(url => history.replaceState({}, '', url), suffix);
      identity.url = page.url();
    }
    if (kind === 'foreign origin') {
      await page.goto('https://foreign.example/app/fixture');
      await page.evaluate(() => {
        const q = document.createElement('user-query');
        q.innerHTML = '<div class="query-text">Original prompt</div>';
        document.querySelector('main').append(q);
      });
      identity.url = page.url();
    }
    if (kind === 'baselineOnly') {
      pinned.userCount = 1;
      identity.baselineOnly = true;
      identity.baselineHash = textHash('Original prompt');
      identity.responseCount = 0;
    }
    await b.update({ pending: pinned });
    await assert.rejects(b.settlePending(identity), { code: 'TASK_IDENTITY_CHANGED' });
    assert.deepEqual((await b.state()).pending, pinned);
  });
}
