import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { guardedSend } from '../src/shared/send-guard.js';
test('real cross-origin navigation invalidates the pinned send nodes without sending', async t => {
 const f = await fixture(t);
 await f.page.context().route('https://foreign.example/**', r => r.fulfill({
  contentType: 'text/html',
  body: '<form><textarea>Ab c\nnext</textarea><button>Send</button></form><script>window.count=0;document.querySelector("form").onsubmit=e=>{e.preventDefault();window.count++}</script>',
 }));
 let clicks = 0;
 await assert.rejects(guardedSend({...f, click: async b => {
  await f.page.goto('https://foreign.example/c/other');
  clicks++;
  await b.click({timeout: 1000});
 }}));
 assert.equal(new URL(f.page.url()).origin, 'https://foreign.example');
 assert.equal(clicks, 1);
 assert.equal(await f.page.evaluate(() => window.count), 0);
});

test('missing send button fails before the click callback', async t => {
 const f = await fixture(t);
 await f.button.evaluate(button => button.remove());
 // A nullable handle result exercises absence without a locator wait timeout.
 const missingButton = {elementHandle: async () => null};
 let clicks = 0;
 await assert.rejects(guardedSend({...f, button: missingButton, click: async () => {clicks++;}}),
  e => e.code === 'SEND_NOT_ATTEMPTED' && e.sendOutcome === 'not_attempted');
 assert.equal(clicks, 0);
 assert.equal(await f.page.evaluate(() => window.count), 0);
});

test('contenteditable preserves the complete multi-paragraph text during a trusted send', async t => {
 const f = await fixture(t);
 await f.composer.evaluate(node => {
  const editor = document.createElement('div');
  editor.contentEditable = 'true';
  editor.innerHTML = '<p>First paragraph</p><p>Second line<br>continued</p><p>Last paragraph</p>';
  node.replaceWith(editor);
  window.sentText = null;
  document.querySelector('form').addEventListener('submit', () => {window.sentText = editor.innerText;});
 });
 const composer = f.page.locator('[contenteditable="true"]');
 const expectedText = await composer.innerText();
 assert.equal(expectedText, 'First paragraph\n\nSecond line\ncontinued\n\nLast paragraph');
 await guardedSend({...f, composer, expectedText, click: b => b.click()});
 assert.equal(await composer.innerText(), expectedText);
 assert.deepEqual(await f.page.evaluate(() => [window.count, window.trusted, window.sentText]),
  [1, true, expectedText]);
});

test('a trusted double click sends once and stays ambiguous rather than not_attempted', async t => {
 const f = await fixture(t);
 await assert.rejects(guardedSend({...f, click: b => b.dblclick()}), e => {
  assert.equal(e.code, 'SEND_UNCONFIRMED');
  assert.notEqual(e.sendOutcome, 'not_attempted');
  return true;
 });
 assert.deepEqual(await f.page.evaluate(() => [window.count, window.trusted]), [1, true]);
});

let browser;
before(async()=>{ browser=await chromium.launch({headless:true}); });
after(async()=>{await browser?.close();});
async function fixture(t){
 const context=await browser.newContext(); t.after(()=>context.close());
 await context.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<form><textarea>Ab c\nnext</textarea><button>Send</button></form>'}));
 const page=await context.newPage(); await page.goto('https://chatgpt.com/c/fixture');
 await page.evaluate(()=>{window.count=0; window.trusted=false; document.querySelector('form').onsubmit=e=>{e.preventDefault();window.count++};document.querySelector('button').onclick=e=>{window.trusted=e.isTrusted};});
 const composer=page.locator('textarea'); const button=page.locator('button');
 return {page, composer, button, expectedText:await composer.inputValue(), expectedURL:page.url(), allowedOrigin:'https://chatgpt.com'};
}
test('trusted click submits exactly once',async t=>{const f=await fixture(t);await guardedSend({...f,key:'guard',click:b=>b.click()});assert.deepEqual(await f.page.evaluate(()=>[window.count,window.trusted]),[1,true]);});
for(const [label,change] of [['case','ab c\nnext'],['space','Ab  c\nnext'],['newline','Ab c next'],['cleared','']]){
 test(`capture rejects ${label} after guard installation`,async t=>{const f=await fixture(t);await assert.rejects(guardedSend({...f,key:'guard',click:async b=>{await f.composer.fill(change);await b.click();}}),e=>e.code==='SEND_NOT_ATTEMPTED'&&e.sendOutcome==='not_attempted');assert.equal(await f.page.evaluate(()=>window.count),0);});
}
for(const kind of ['disabled','hidden','readonly','detached','uploading']){
 test(`capture rejects ${kind}`,async t=>{const f=await fixture(t);await assert.rejects(guardedSend({...f,key:'guard',click:async b=>{
 await f.page.evaluate(kind=>{const c=document.querySelector('textarea'),b=document.querySelector('button'); if(kind==='disabled')b.disabled=true;if(kind==='hidden')b.style.visibility='hidden';if(kind==='readonly')c.readOnly=true;if(kind==='detached')c.remove();if(kind==='uploading')document.querySelector('form').insertAdjacentHTML('beforeend','<span role="progressbar"></span>');},kind);
 // dispatchEvent tests rejection paths only; success above requires trusted input.
 await b.dispatchEvent('click');
 }}),e=>e.code==='SEND_NOT_ATTEMPTED');assert.equal(await f.page.evaluate(()=>window.count),0);});
}
test('foreign navigation cannot send',async t=>{const f=await fixture(t);await assert.rejects(guardedSend({...f,key:'guard',click:async b=>{await f.page.evaluate(()=>history.pushState({},'', '/c/other'));await b.click();}}),e=>e.code==='SEND_NOT_ATTEMPTED');assert.equal(await f.page.evaluate(()=>window.count),0);});
test('connection loss after click stays ambiguous without retry',async t=>{const f=await fixture(t);let clicks=0;await assert.rejects(guardedSend({...f,key:'guard',click:async b=>{clicks++;await b.click();throw new Error('connection lost');}}),e=>e.message==='connection lost'&&!e.sendOutcome);assert.equal(clicks,1);assert.equal(await f.page.evaluate(()=>window.count),1);});
