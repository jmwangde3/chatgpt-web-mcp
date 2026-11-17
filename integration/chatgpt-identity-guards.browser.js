import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { bootstrapSendGuard, guardedSend } from '../src/shared/send-guard.js';
import { guardedStop } from '../src/shared/stop-guard.js';
import { readUserMessageIdentityDOM } from '../src/browser.js';
import { textHash } from '../src/shared/user-message-identity.js';

let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });
const users = '[data-user]';
async function fixture(t, { empty = false, early = true } = {}) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  t.after(() => context.close());
  // All requests are fulfilled locally; no dedicated Chrome or live site is used.
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body:
    `${empty ? '' : '<div data-user data-message-id="u1">Original prompt</div>'}
     <form><textarea>Draft</textarea><button type="submit">Send</button></form><button data-stop>Stop</button>` }));
  if (early) await context.addInitScript(bootstrapSendGuard);
  const page = await context.newPage();
  await page.goto('https://chatgpt.com/c/offline');
  await page.evaluate(() => {
    window.submits = 0; window.stops = 0; window.trusted = [];
    document.querySelector('form').addEventListener('submit', e => { e.preventDefault(); window.submits++; });
    document.addEventListener('click', e => {
      if (e.target.matches('[data-stop]')) { window.stops++; window.trusted.push(e.isTrusted); e.target.remove(); }
    });
  });
  return { page };
}
async function baseline(page) {
  return page.evaluate(users => {
    const nodes = [...document.querySelectorAll(users)], last = nodes.at(-1);
    return { selectors: users, count: nodes.length, lastId: last?.getAttribute('data-message-id') ?? null,
      lastHTML: last?.outerHTML ?? null };
  }, users);
}
function send(page, baselineUser, click = button => button.click()) {
  return guardedSend({ page, baselineUser, composer: page.locator('textarea'), button: page.locator('[type=submit]'),
    expectedText: 'Draft', expectedURL: page.url(), allowedOrigin: 'https://chatgpt.com', click });
}
async function mutate(page, change) {
  await page.evaluate(change => {
    const user = document.querySelector('[data-user]');
    if (change === 'id') user.setAttribute('data-message-id', 'u2');
    if (change === 'node') { const next = user.cloneNode(true); next.setAttribute('data-message-id', 'u2'); user.replaceWith(next); }
    if (change === 'clone') user.replaceWith(user.cloneNode(true));
    if (change === 'html') user.textContent = 'Edited prompt';
    if (change === 'count') document.body.insertAdjacentHTML('afterbegin', '<div data-user data-message-id="new">New</div>');
  }, change);
}
for (const empty of [true, false]) test(`send baseline ${empty ? 0 : 1}: trusted once`, async t => {
  const { page } = await fixture(t, { empty });
  await send(page, await baseline(page));
  assert.equal(await page.evaluate(() => window.submits), 1);
});
for (const change of ['id', 'node', 'html', 'count']) test(`send rejects before installation: ${change}`, async t => {
  const { page } = await fixture(t), saved = await baseline(page);
  await mutate(page, change);
  let clicks = 0;
  await assert.rejects(send(page, saved, async button => { clicks++; await button.click(); }), { code: 'SEND_NOT_ATTEMPTED' });
  assert.equal(clicks, 0);
  assert.equal(await page.evaluate(() => window.submits), 0);
});
for (const change of ['id', 'clone', 'html', 'count']) test(`send rejects at capture: ${change}`, async t => {
  const { page } = await fixture(t), saved = await baseline(page);
  await assert.rejects(send(page, saved, async button => { await mutate(page, change); await button.click(); }), { code: 'SEND_NOT_ATTEMPTED' });
  assert.equal(await page.evaluate(() => window.submits), 0);
});
for (const atCapture of [false, true]) test(`empty baseline rejects new user, capture=${atCapture}`, async t => {
  const { page } = await fixture(t, { empty: true }), saved = await baseline(page);
  if (!atCapture) await mutate(page, 'count');
  await assert.rejects(send(page, saved, async button => {
    if (atCapture) await mutate(page, 'count');
    await button.click();
  }), { code: 'SEND_NOT_ATTEMPTED' });
  assert.equal(await page.evaluate(() => window.submits), 0);
});
for (const attr of ['id', 'data-testid', 'ambiguous-search', 'unique-search']) test(`send stable ID source: ${attr}`, async t => {
  const { page } = await fixture(t);
  await page.evaluate(attr => {
    const user = document.querySelector('[data-user]'); user.removeAttribute('data-message-id');
    user.setAttribute(attr.endsWith('search') ? 'data-chatgpt-search-message-ids' : attr,
      attr === 'ambiguous-search' ? 'u1 u2' : 'u1');
  }, attr);
  const saved = { ...await baseline(page), lastId: 'u1' };
  if (attr === 'unique-search') await send(page, saved);
  else await assert.rejects(send(page, saved), { code: 'SEND_NOT_ATTEMPTED' });
  assert.equal(await page.evaluate(() => window.submits), attr === 'unique-search' ? 1 : 0);
});
function stop(page, userMessageId, click) {
  return guardedStop({ page, users, stops: '[data-stop]', readIdentity: readUserMessageIdentityDOM,
    expected: { url: page.url(), userCount: 1, promptHash: textHash('Original prompt'), userMessageId },
    ...(click ? { click } : {}) });
}
test('send capture checks ancestor search ID even when user HTML is unchanged', async t => {
  const { page } = await fixture(t);
  await page.evaluate(() => {
    const user = document.querySelector('[data-user]'); user.removeAttribute('data-message-id');
    const wrapper = document.createElement('section'); wrapper.setAttribute('data-chatgpt-search-message-ids', 'u1');
    user.replaceWith(wrapper); wrapper.append(user);
  });
  const saved = { ...await baseline(page), lastId: 'u1' };
  await assert.rejects(send(page, saved, async button => {
    await page.evaluate(() => document.querySelector('section').setAttribute('data-chatgpt-search-message-ids', 'u2'));
    await button.click();
  }), { code: 'SEND_NOT_ATTEMPTED' });
  assert.equal(await page.evaluate(() => window.submits), 0);
});
for (const early of [false, true]) {
  test(`stop rejects same hash/count with different ID before arm, early=${early}`, async t => {
    const { page } = await fixture(t, { early }); let clicks = 0;
    await assert.rejects(stop(page, 'u2', async () => { clicks++; }), { code: 'CANCEL_UNCONFIRMED' });
    assert.equal(clicks, 0);
    assert.deepEqual(await page.evaluate(() => [window.stops, window.__webChatSendGate?.active ?? null]), [0, null]);
  });
  test(`stop correct ID permits exactly one trusted click, early=${early}`, async t => {
    const { page } = await fixture(t, { early });
    await stop(page, 'u1');
    assert.deepEqual(await page.evaluate(() => [window.stops, window.trusted]), [1, [true]]);
  });
  test(`stop rejects ID capture race, early=${early}`, async t => {
    const { page } = await fixture(t, { early });
    await assert.rejects(stop(page, 'u1', async button => { await mutate(page, 'id'); await button.click(); }), { code: 'CANCEL_UNCONFIRMED' });
    assert.equal(await page.evaluate(() => window.stops), 0);
  });
  test(`stop rejects ID mutation after trusted click, early=${early}`, async t => {
    const { page } = await fixture(t, { early });
    await assert.rejects(stop(page, 'u1', async button => { await button.click(); await mutate(page, 'id'); }), { code: 'CANCEL_UNCONFIRMED' });
    assert.equal(await page.evaluate(() => window.stops), 1);
  });
}
