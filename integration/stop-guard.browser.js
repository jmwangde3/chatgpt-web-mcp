import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { guardedStop, readGeminiStopIdentity } from '../src/shared/stop-guard.js';
import { readUserMessageIdentityDOM } from '../src/browser.js';
import { textHash } from '../src/shared/user-message-identity.js';
import { bootstrapSendGuard } from '../src/shared/send-guard.js';

let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });
async function fixture(t, gemini = false) {
  const context = await browser.newContext(); t.after(() => context.close());
  await context.route('**/*', r => r.fulfill({ contentType: 'text/html', body: gemini ?
    '<user-query><div class="query-text"><p class="query-text-line">Original</p><p class="query-text-line">prompt</p></div></user-query><button>Stop</button>' :
    '<div data-user>Original <code>prompt</code></div><button>Stop</button>' }));
  const page = await context.newPage(); await page.goto(`https://${gemini ? 'gemini.google.com/app' : 'chatgpt.com/c'}/original`);
  await page.evaluate(() => { window.count = 0; document.addEventListener('click', e => { if (e.target.closest('button')) { window.count++; e.target.closest('button').remove(); } }); });
  return { page, users: gemini ? 'user-query' : '[data-user]', stops: 'button',
    readIdentity: gemini ? readGeminiStopIdentity : readUserMessageIdentityDOM,
    expected: { url: page.url(), userCount: 1, promptHash: textHash(gemini ? 'Original\nprompt' : 'Original `prompt`') } };
}
for (const gemini of [false, true]) {
  test(`${gemini ? 'Gemini lines' : 'ChatGPT inline identity'}: successful trusted stop once`, async t => {
    const f = await fixture(t, gemini); await guardedStop(f);
    assert.equal(await f.page.evaluate(() => window.count), 1);
  });
}
for (const early of [false, true]) for (const change of ['url', 'message', 'append', 'button', 'disabled']) {
  test(`trusted click capture rejects raced ${change}, early=${early}`, async t => {
    const f = await fixture(t);
    if (early) { await f.page.evaluate(bootstrapSendGuard); const h = await f.page.locator('button').elementHandle(); await h.dispose(); }
    let attempts = 0;
    await assert.rejects(guardedStop({ ...f, click: async button => {
      attempts++;
      await f.page.evaluate(change => {
        if (change === 'url') history.pushState({}, '', '/c/manual');
        if (change === 'message') document.querySelector('[data-user]').textContent = 'manual edit';
        if (change === 'append') document.body.insertAdjacentHTML('beforeend', '<div data-user>manual message</div>');
        if (change === 'button') { const old = document.querySelector('button'); old.replaceWith(old.cloneNode(true)); }
        if (change === 'disabled') document.querySelector('button').setAttribute('aria-disabled', 'true');
      }, change);
      // Keep the pinned original handle: never resolve and click a replacement.
      await button.click({ force: true, timeout: 500 });
    } }), change === 'button' ? /not attached|detached/ : { code: 'CANCEL_UNCONFIRMED' });
    assert.equal(attempts, 1);
    assert.equal(await f.page.evaluate(() => window.count), 0);
  });
}
test('transport failure after accepted click never retries', async t => {
  const f = await fixture(t); let attempts = 0;
  await assert.rejects(guardedStop({ ...f, click: async button => { attempts++; await button.click(); throw new Error('transport failed'); } }), /transport failed/);
  assert.equal(attempts, 1); assert.equal(await f.page.evaluate(() => window.count), 1);
});
test('unknown earlier window capture refuses before any click', async t => {
  const f = await fixture(t); let attempts = 0;
  await f.page.evaluate(() => window.addEventListener('click', () => { window.count++; }, true));
  await assert.rejects(guardedStop({ ...f, click: async () => { attempts++; } }), { code: 'CANCEL_UNCONFIRMED' });
  assert.equal(attempts, 0); assert.equal(await f.page.evaluate(() => window.count), 0);
});
test('known idle send capture is accepted', async t => {
  const f = await fixture(t); await f.page.evaluate(bootstrapSendGuard); await guardedStop(f);
  assert.equal(await f.page.evaluate(() => window.count), 1);
});

test('early gate survives prior selector/handle reads and cleanup retains send handler', async t => {
  const f = await fixture(t);
  await f.page.evaluate(bootstrapSendGuard);
  await f.page.locator('[data-user]').innerText();
  const handle = await f.page.locator('button').elementHandle(); await handle.dispose();
  await guardedStop(f);
  assert.deepEqual(await f.page.evaluate(() => [window.count, window.__webChatSendGate.active, typeof window.__webChatSendGate.handler]), [1, null, 'function']);
});

test('legacy page with prior utility capture fails closed without clicking', async t => {
  const f = await fixture(t); const h = await f.page.locator('button').elementHandle(); await h.dispose(); let attempts = 0;
  await assert.rejects(guardedStop({ ...f, click: async () => { attempts++; } }), { code: 'CANCEL_UNCONFIRMED' });
  assert.equal(attempts, 0); assert.equal(await f.page.evaluate(() => window.count), 0);
});

test('unknown capture before early gate refuses without clicking', async t => {
  const f = await fixture(t); let attempts = 0;
  await f.page.evaluate(() => window.addEventListener('click', () => { window.count++; }, true));
  await f.page.evaluate(bootstrapSendGuard);
  await assert.rejects(guardedStop({ ...f, click: async () => { attempts++; } }), { code: 'CANCEL_UNCONFIRMED' });
  assert.equal(attempts, 0); assert.equal(await f.page.evaluate(() => window.count), 0);
  assert.equal(await f.page.evaluate(() => window.__webChatSendGate.active), null);
});

for (const early of [false, true]) {
  test(`unrelated click remains available during post-click verification: early=${early}`, async t => {
    const f = await fixture(t); if (early) await f.page.evaluate(bootstrapSendGuard);
    await f.page.evaluate(() => { const a = document.createElement('a'); a.id = 'manual'; a.textContent = 'Manual'; a.onclick = () => { window.manual = true; }; document.body.append(a); });
    await guardedStop({ ...f, click: async button => { await button.click(); await f.page.locator('#manual').click(); } });
    assert.equal(await f.page.evaluate(() => window.manual), true);
  });
}
test('synthetic event is rejected', async t => {
  const f = await fixture(t);
  await assert.rejects(guardedStop({ ...f, click: button => button.dispatchEvent('click') }), { code: 'CANCEL_UNCONFIRMED' });
  assert.equal(await f.page.evaluate(() => window.count), 0);
});
test('identity mutation during application stop preserves uncertainty', async t => {
  const f = await fixture(t);
  await f.page.evaluate(() => document.addEventListener('click', () => { document.querySelector('[data-user]').textContent = 'changed during stop'; }));
  await assert.rejects(guardedStop(f), { code: 'CANCEL_UNCONFIRMED' });
  assert.equal(await f.page.evaluate(() => window.count), 1);
});
