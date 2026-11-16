// Offline renderer regression: fresh ephemeral Chromium, no service/browser attachment.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { readUserMessageIdentityDOM } from '../src/browser.js';
import { matchesUserPrompt, textHash } from '../src/shared/user-message-identity.js';
import { SELECTORS } from '../src/selectors.js';
import { geminiConfig } from '../src/gemini/config.js';

let browser;
before(async () => {
  browser = await chromium.launch({
    executablePath: geminiConfig().executable || chromium.executablePath(), headless: true,
  });
});
after(async () => { await browser?.close(); });
const selector = SELECTORS.userMessages.join(', ');
const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const source = Array.from({length: 180}, (_, i) => `def synthetic_${i}(value):\n    return value + ${i}`).join('\n\n');
const sources = [source, 'assert synthetic_1(2) == 3\nassert synthetic_2(3) == 5'];
const prompt = `Review both complete files.\n\n\`\`\`python\n${sources[0]}\n\`\`\`\n\nSecond file:\n\n\`\`\`python\n${sources[1]}\n\`\`\`\n\nEnd of request.`;
const block = (code, language = 'python') => `<pre data-markdown-copy="code-block"><code data-language="${language}" data-markdown-copy-content="true">${escape(code)}</code></pre>`;
const rendered = () => `Review both complete files.\n\n${block(sources[0])}\n\nSecond file:\n\n${block(sources[1])}\n\nEnd of request.`;
const message = body => `<div data-message-author-role="user" data-message-id="fixture-user">${body}</div>`;

async function fixture(t, body = rendered()) {
  const context = await browser.newContext({offline: true, serviceWorkers: 'block'});
  t.after(() => context.close());
  await context.route('**/*', route => route.abort());
  const page = await context.newPage();
  await page.setContent(message(body));
  assert.equal(page.url(), 'about:blank');
  return page;
}
const read = page => page.locator(selector).last().evaluate(readUserMessageIdentityDOM, selector);
const matches = (expected, data) => matchesUserPrompt(textHash(expected), data.lastText, data.identityCandidates);

test('two Python fences recover exactly one complete 8KB source prompt', async t => {
  assert.ok(Buffer.byteLength(source, 'utf8') >= 8192);
  const data = await read(await fixture(t));
  assert.equal(data.isLast, true);
  assert.equal(data.count, 1);
  assert.deepEqual(data.identityCandidates, [prompt]);
  assert.equal(matches(prompt, data), true);
  assert.equal(matchesUserPrompt(textHash(prompt), data.lastText, []), false);
});

test('one changed source character rejects the full original prompt', async t => {
  const page = await fixture(t);
  await page.locator('code').first().evaluate(code => { code.textContent = code.textContent.replace('value + 0', 'value + 9'); });
  const data = await read(page);
  assert.equal(data.identityCandidates.length, 1);
  assert.equal(matches(prompt, data), false);
});

test('different fence language rejects the original prompt', async t => {
  const page = await fixture(t);
  await page.locator('code').first().evaluate(code => code.setAttribute('data-language', 'javascript'));
  const data = await read(page);
  assert.equal(data.identityCandidates.length, 1);
  assert.equal(matches(prompt, data), false);
});

for (const [name, mutate] of [
  ['missing copy-content marker', code => code.removeAttribute('data-markdown-copy-content')],
  ['unknown PRE marker', code => code.parentElement.setAttribute('data-markdown-copy', 'unknown')],
  ['unknown element structure', code => { const section = document.createElement('section'); code.parentElement.replaceWith(section); section.append(code); }],
  ['nested SPAN', code => { const span = document.createElement('span'); span.textContent = code.textContent; code.replaceChildren(span); }],
  ['extra PRE text', code => { code.parentElement.append('unaccounted visible text'); }],
  ['comment inside CODE', code => { code.append(document.createComment('unknown node')); }],
  ['hidden PRE', code => { code.parentElement.style.display = 'none'; }],
  ['missing language', code => code.removeAttribute('data-language')],
  ['embedded triple backticks', code => { code.textContent += '\n```'; }],
]) {
  test(`rejects fenced candidate: ${name}`, async t => {
    const page = await fixture(t);
    await page.locator('code').first().evaluate(mutate);
    const data = await read(page);
    assert.deepEqual(data.identityCandidates, []);
    assert.equal(matches(prompt, data), false);
  });
}

test('plain text continues to match without a markup candidate', async t => {
  const plain = 'Ordinary text with Case and punctuation: 123.';
  const data = await read(await fixture(t, escape(plain)));
  assert.deepEqual(data.identityCandidates, []);
  assert.equal(matches(plain, data), true);
  assert.equal(matches(plain.replace('123', '124'), data), false);
});

for (const rich of [false, true]) {
  test(`existing inline code still matches (${rich ? 'rich paragraph' : 'flat text'})`, async t => {
    const body = 'Call <code>synthetic(1)</code> exactly.';
    const data = await read(await fixture(t, rich ? `<div class="rich-text-user-turn"><p>${body}</p></div>` : body));
    assert.deepEqual(data.identityCandidates, ['Call `synthetic(1)` exactly.']);
    assert.equal(matches('Call `synthetic(1)` exactly.', data), true);
    assert.equal(matches('Call `synthetic(2)` exactly.', data), false);
  });
}

test('33 fenced blocks exceed the candidate bound', async t => {
  const data = await read(await fixture(t, Array.from({length: 33}, () => block('pass')).join('\n')));
  assert.deepEqual(data.identityCandidates, []);
});

test('content above 100k rejects the candidate', async t => {
  const data = await read(await fixture(t, block('x'.repeat(100001))));
  assert.deepEqual(data.identityCandidates, []);
});

test('an older matching turn is flagged non-last and cannot supply last-message evidence', async t => {
  const page = await fixture(t);
  await page.setContent(message(rendered()) + message('newer distinct turn'));
  const old = await page.locator(selector).first().evaluate(readUserMessageIdentityDOM, selector);
  assert.equal(old.isLast, false);
  assert.equal(old.count, 2);
  // Production caller gates candidates and text on isLast before hash comparison.
  assert.equal(matchesUserPrompt(textHash(prompt), old.isLast ? old.lastText : '', old.isLast ? old.identityCandidates : []), false);
  assert.equal(matches(prompt, await read(page)), false);
});
