// Runs in the bound page. No await is permitted inside the capture handler.
export function bootstrapSendGuard() {
  if (window.__webChatSendGate) return;
  const doc = document;
  const text = node => {
    if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) return node.value;
    return node.innerText ?? node.textContent ?? '';
  };
  const visible = node => node?.isConnected && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
  const state = { outcome: 'idle', attempted: false, handler: null };
  const check = event => {
    // Block any attempted send while this one-shot capability is armed.
    if (!state.active) return;
    if (state.active.kind === 'stop') {
      const { button, user, users, stops, snapshot } = state.active;
      if (!event.composedPath().includes(button)) return;
      let valid = false;
      try {
        const nodes = [...doc.querySelectorAll(users)];
        const controls = [...doc.querySelectorAll(stops)].filter(visible);
        valid = state.outcome === 'armed' && event.isTrusted && location.href === snapshot.url &&
          nodes.length === snapshot.count && nodes.at(-1) === user && user.ownerDocument === doc &&
          user.isConnected && user.outerHTML === snapshot.lastHTML && controls.length === 1 && controls[0] === button &&
          button.ownerDocument === doc && visible(button) && !button.disabled && button.getAttribute('aria-disabled') !== 'true';
      } catch { valid = false; }
      state.outcome = valid ? 'allowed' : 'rejected';
      if (valid) state.attempted = true;
      if (!valid) { event.preventDefault(); event.stopImmediatePropagation(); }
      return;
    }
    const { composer, button, expectedText, expectedURL, allowedOrigin, gemini, binding } = state.active;
    const target = event.composedPath();
    if (!target.includes(button)) return;
    let valid = false;
    try {
      const url = new URL(location.href);
      valid = state.outcome === 'armed' && event.isTrusted &&
        location.href === expectedURL && url.protocol === 'https:' && url.origin === allowedOrigin &&
        composer.ownerDocument === doc && button.ownerDocument === doc &&
        visible(composer) && visible(button) && !button.disabled && button.getAttribute('aria-disabled') !== 'true' &&
        !composer.disabled && !composer.readOnly &&
        (composer.isContentEditable || composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) &&
        text(composer) === expectedText &&
        (gemini ? location.origin === 'https://gemini.google.com' && binding?.valid &&
          binding.region.isConnected && composer.closest(gemini.region) === binding.region &&
          button.closest(gemini.region) === binding.region &&
          binding.region.querySelectorAll(gemini.composer).length === 1 &&
          binding.region.querySelectorAll(gemini.send).length === 1 &&
          // Nested layout ancestors are not independent composers. Count the
          // actual editors, while keeping both nodes pinned to their closest region.
          [...doc.querySelectorAll(gemini.composer)].filter(node => !node.closest('user-query, model-response')).length === 1 &&
          [...doc.querySelectorAll(gemini.user)].filter(visible).length === gemini.userCount &&
          ![...doc.querySelectorAll(gemini.stop)].some(visible) &&
          (() => {
            const nodes = [...doc.querySelectorAll(gemini.attachments)].filter(e => visible(e) && !e.closest('user-query, model-response') && !e.parentElement?.closest(gemini.attachments));
            return nodes.length === binding.attachments.length && nodes.every((node, i) =>
              node === binding.attachments[i].node && node.outerHTML === binding.attachments[i].html);
          })() : Boolean(composer.closest('form')) && button.closest('form') === composer.closest('form')) &&
        !doc.querySelector('[role="progressbar"], [data-state="uploading"], [data-testid*="upload-progress"]') &&
        ![...doc.querySelectorAll('[aria-busy="true"]')].some(node => visible(node) || (gemini ? binding?.region : composer.closest('form'))?.contains(node));
    } catch { valid = false; }
    state.outcome = valid ? 'allowed' : state.attempted ? 'uncertain' : 'rejected';
    if (valid) state.attempted = true;
    if (!valid) { event.preventDefault(); event.stopImmediatePropagation(); }
  };
  window.addEventListener('click', check, true);
  state.handler = check;
  window.__webChatSendGate = state;
}

export function installSendGuard(input) {
  const state = window.__webChatSendGate;
  if (!state || state.active) return false;
  if (input.gemini) {
    const g = input.gemini;
    const region = input.composer.closest(g.region);
    const nodes = [...document.querySelectorAll(g.attachments)].filter(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden' && !e.closest('user-query, model-response') && !e.parentElement?.closest(g.attachments));
    input.binding = { region, valid: !!region && input.button.closest(g.region) === region &&
      JSON.stringify(nodes.map(e => e.innerText)) === JSON.stringify(g.expectedAttachments),
      attachments: nodes.map(node => ({node, html: node.outerHTML})) };
  }
  state.active = input; state.outcome = 'armed'; state.attempted = false;
  window[input.key] = state;
  return true;
}

export async function guardedSend({ page, composer, button, expectedText, expectedURL, allowedOrigin, click, gemini }) {
  const key = `__web_chat_send_${globalThis.crypto.randomUUID().replaceAll('-', '')}`;
  // Handle references pin the exact nodes, never resolve a second selector.
  const composerHandle = await composer.elementHandle();
  const buttonHandle = await button.elementHandle();
  if (!composerHandle || !buttonHandle) {
    throw Object.assign(new Error('Send nodes disappeared before clicking.'), { code: 'SEND_NOT_ATTEMPTED', sendOutcome: 'not_attempted' });
  }
  let inspector;
  try {
    const installed = await page.evaluate(installSendGuard, { composer: composerHandle, button: buttonHandle, expectedText, expectedURL, allowedOrigin, key, gemini });
    if (!installed) throw Object.assign(new Error('Early send guard is unavailable; refresh the bound conversation before preparing the draft.'), {code:'SEND_NOT_ATTEMPTED',sendOutcome:'not_attempted'});
    // A capture listener registered on window earlier could already send before
    // our rejection. CDP must prove ours is the first window click-capture handler.
    // Listeners registered later run after ours; application document listeners
    // also run after this window guard. Never click if this ordering is unproven.
    inspector = await page.context().newCDPSession(page);
    await inspector.send('Runtime.enable');
    const remote = await inspector.send('Runtime.evaluate', { expression: 'window', objectGroup: key });
    const { listeners } = await inspector.send('DOMDebugger.getEventListeners', { objectId: remote.result.objectId });
    const captures = listeners.filter(l => l.type === 'click' && l.useCapture);
    let own = false;
    if (captures.length >= 1 && captures[0].handler?.objectId) {
      const same = await inspector.send('Runtime.callFunctionOn', { objectId: captures[0].handler.objectId, functionDeclaration: 'function(key) { return this === window[key]?.handler; }', arguments: [{value:key}], returnByValue:true });
      own = same.result.value === true;
    }
    if (!own) {
      const armed = await page.evaluate(key => window[key]?.outcome === 'armed', key);
      throw Object.assign(new Error('Final send guard precedence could not be established; no automation click was started.'), armed ? {code:'SEND_NOT_ATTEMPTED',sendOutcome:'not_attempted'} : {code:'SEND_UNCONFIRMED'});
    }
    // Once click begins, transport errors are ambiguous: never relabel them.
    await click(buttonHandle);
    const outcome = await page.evaluate(key => window[key]?.outcome, key);
    if (outcome === 'rejected') throw Object.assign(new Error('Final send validation rejected the click.'), { code: 'SEND_NOT_ATTEMPTED', sendOutcome: 'not_attempted' });
    if (outcome !== 'allowed') throw Object.assign(new Error('Final send outcome could not be verified.'), { code: 'SEND_UNCONFIRMED' });
  } finally {
    if (inspector) { await inspector.send('Runtime.releaseObjectGroup', {objectGroup:key}).catch(()=>{}); await inspector.detach().catch(()=>{}); }
    await page.evaluate(key => { if (window[key]) window[key].active = null; delete window[key]; }, key).catch(() => {});
    await composerHandle.dispose().catch(() => {});
    await buttonHandle.dispose().catch(() => {});
  }
}
