import { matchesUserPrompt } from './user-message-identity.js';

const refused = message => Object.assign(new Error(message), { code: 'CANCEL_UNCONFIRMED' });

// Runs at window capture, before document/application handlers. Never await here.
export function installStopGuard({ key, users, stops, snapshot }) {
  const doc = document;
  const visible = node => node?.isConnected && node.getClientRects().length > 0 &&
    getComputedStyle(node).visibility !== 'hidden' && getComputedStyle(node).display !== 'none';
  const user = [...doc.querySelectorAll(users)].at(-1);
  const buttons = [...doc.querySelectorAll(stops)].filter(visible);
  if (buttons.length !== 1 || !user || user.outerHTML !== snapshot.lastHTML || location.href !== snapshot.url || doc.querySelectorAll(users).length !== snapshot.count) return false;
  const button = buttons[0];
  const gate = window.__webChatSendGate;
  if (gate) {
    if (gate.active || typeof gate.handler !== 'function') return false;
    gate.active = { kind: 'stop', key, user, button, users, stops, snapshot };
    gate.outcome = 'armed'; gate.attempted = false;
    window[key] = { handler: gate.handler, user, button, early: true, get outcome() { return gate.outcome; } };
    return true;
  }
  const state = { outcome: 'armed', handler: null, user, button };
  state.handler = event => {
    if (!event.composedPath().includes(button)) return;
    const nodes = [...doc.querySelectorAll(users)];
    const controls = [...doc.querySelectorAll(stops)].filter(visible);
    const valid = state.outcome === 'armed' && event.isTrusted && event.composedPath().includes(button) &&
      location.href === snapshot.url && nodes.length === snapshot.count && nodes.at(-1) === user &&
      user?.ownerDocument === doc && user.isConnected && user.outerHTML === snapshot.lastHTML &&
      controls.length === 1 && controls[0] === button && button.ownerDocument === doc && visible(button) &&
      !button.disabled && button.getAttribute('aria-disabled') !== 'true';
    state.outcome = valid ? 'allowed' : 'rejected';
    if (!valid) { event.preventDefault(); event.stopImmediatePropagation(); }
  };
  window[key] = state;
  window.addEventListener('click', state.handler, true);
  return true;
}

export async function guardedStop({ page, expected, users, stops, readIdentity, click = button => button.click() }) {
  if (!expected?.url || !Number.isInteger(expected.userCount) || !expected.promptHash) throw refused('Missing original task identity.');
  const key = `__webChatStop_${globalThis.crypto.randomUUID().replaceAll('-', '')}`;
  let user, button, inspector;
  try {
    // Do not create handles before capture installation: Playwright installs a
    // click-capture utility when creating handles, even for evaluateHandle.
    const snapshot = await page.evaluate(`(() => { const s = ${JSON.stringify(users)}; const e = [...document.querySelectorAll(s)].at(-1); return e ? (${readIdentity.toString()})(e, s) : null; })()`);
    if (!snapshot) throw refused('Original user node is unavailable.');
    if (!snapshot.isLast || snapshot.url !== expected.url || snapshot.count !== expected.userCount ||
        !matchesUserPrompt(expected.promptHash, snapshot.lastText, snapshot.identityCandidates)) throw refused('Original user identity changed.');
    if (!await page.evaluate(installStopGuard, { key, users, stops, snapshot })) throw refused('Stop nodes changed before guard installation.');
    button = (await page.evaluateHandle(key => window[key]?.button, key)).asElement();
    user = (await page.evaluateHandle(key => window[key]?.user, key)).asElement();
    inspector = await page.context().newCDPSession(page);
    await inspector.send('Runtime.enable');
    const remote = await inspector.send('Runtime.evaluate', { expression: 'window', objectGroup: key });
    const { listeners } = await inspector.send('DOMDebugger.getEventListeners', { objectId: remote.result.objectId });
    let own = false;
    for (const listener of listeners.filter(l => l.type === 'click' && l.useCapture)) {
      if (own) break; // Later window listeners execute after our guard.
      if (!listener.handler?.objectId) throw refused('Stop capture precedence is unproven.');
      const result = await inspector.send('Runtime.callFunctionOn', {
        objectId: listener.handler.objectId,
        functionDeclaration: 'function(key) { if (this === window[key]?.handler) return "own"; const g = window.__webChatSendGate; return g && !g.active && this === g.handler ? "idle-send" : "unknown"; }',
        arguments: [{ value: key }], returnByValue: true,
      });
      if (result.result.value === 'own') own = true;
      else if (result.result.value !== 'idle-send') throw refused('An unknown earlier window click capture prevents safe cancellation.');
    }
    if (!own) throw refused('Stop capture precedence is unproven.');
    await click(button);
    if (await page.evaluate(key => window[key]?.outcome, key) !== 'allowed') throw refused('Stop click was not verified.');
    await page.waitForFunction(stops => ![...document.querySelectorAll(stops)].some(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden'), stops, { timeout: 20000 });
    const after = await page.evaluate(`(${readIdentity.toString()})(window[${JSON.stringify(key)}].user, ${JSON.stringify(users)})`);
    if (!after.isLast || after.url !== expected.url || after.count !== expected.userCount || after.lastHTML !== snapshot.lastHTML ||
        !matchesUserPrompt(expected.promptHash, after.lastText, after.identityCandidates)) throw refused('Task identity changed after stop.');
  } finally {
    if (inspector) {
      await inspector.send('Runtime.releaseObjectGroup', { objectGroup: key }).catch(() => {});
      await inspector.detach().catch(() => {});
    }
    await page.evaluate(key => {
      const s = window[key];
      if (s?.early) { const gate = window.__webChatSendGate; if (gate?.active?.key === key) gate.active = null; }
      else if (s) window.removeEventListener('click', s.handler, true);
      delete window[key];
    }, key).catch(() => {});
    await user?.dispose().catch(() => {});
    await button?.dispose().catch(() => {});
  }
}

export function readGeminiStopIdentity(element, selectors) {
  const nodes = [...document.querySelectorAll(selectors)];
  const lines = [...element.querySelectorAll('.query-text-line')];
  return { count: nodes.length, isLast: nodes.at(-1) === element, url: location.href, lastHTML: element.outerHTML,
    lastText: lines.length ? lines.map(e => e.innerText.trim()).join('\n') : (element.querySelector('.query-text') || element).innerText.trim(), identityCandidates: [] };
}
