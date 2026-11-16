// Runs in the bound page. No await is permitted inside the capture handler.
export function installSendGuard({ composer, button, expectedText, expectedURL, allowedOrigin, key }) {
  const doc = document;
  const text = node => {
    if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) return node.value;
    return node.innerText ?? node.textContent ?? '';
  };
  const visible = node => node?.isConnected && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
  const state = { outcome: 'armed', attempted: false, dispose: null };
  const check = event => {
    // Block any attempted send while this one-shot capability is armed.
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
        Boolean(composer.closest('form')) && button.closest('form') === composer.closest('form') &&
        !doc.querySelector('[role="progressbar"], [data-state="uploading"], [data-testid*="upload-progress"], [aria-busy="true"]');
    } catch { valid = false; }
    state.outcome = valid ? 'allowed' : state.attempted ? 'uncertain' : 'rejected';
    if (valid) state.attempted = true;
    if (!valid) { event.preventDefault(); event.stopImmediatePropagation(); }
  };
  window.addEventListener('click', check, true);
  state.dispose = () => window.removeEventListener('click', check, true);
  window[key] = state;
}

export async function guardedSend({ page, composer, button, expectedText, expectedURL, allowedOrigin, click }) {
  const key = `__web_chat_send_${globalThis.crypto.randomUUID().replaceAll('-', '')}`;
  // Handle references pin the exact nodes, never resolve a second selector.
  const composerHandle = await composer.elementHandle();
  const buttonHandle = await button.elementHandle();
  if (!composerHandle || !buttonHandle) {
    throw Object.assign(new Error('Send nodes disappeared before clicking.'), { code: 'SEND_NOT_ATTEMPTED', sendOutcome: 'not_attempted' });
  }
  try {
    await page.evaluate(installSendGuard, { composer: composerHandle, button: buttonHandle, expectedText, expectedURL, allowedOrigin, key });
    // Once click begins, transport errors are ambiguous: never relabel them.
    await click(buttonHandle);
    const outcome = await page.evaluate(key => window[key]?.outcome, key);
    if (outcome === 'rejected') throw Object.assign(new Error('Final send validation rejected the click.'), { code: 'SEND_NOT_ATTEMPTED', sendOutcome: 'not_attempted' });
    if (outcome !== 'allowed') throw Object.assign(new Error('Final send outcome could not be verified.'), { code: 'SEND_UNCONFIRMED' });
  } finally {
    await page.evaluate(key => { window[key]?.dispose(); delete window[key]; }, key).catch(() => {});
    await composerHandle.dispose().catch(() => {});
    await buttonHandle.dispose().catch(() => {});
  }
}
