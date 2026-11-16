// Offline regression: no account, network, or persistent profile access.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { ChatGPTBrowser } from '../src/browser.js';
import { SELECTORS } from '../src/selectors.js';
import { geminiConfig } from '../src/gemini/config.js';
let browser;
before(async () => { browser = await chromium.launch({executablePath:geminiConfig().executable || chromium.executablePath(), headless:true}); });
after(async () => { await browser?.close(); });
async function fixture(t, control) {
  const context = await browser.newContext();
  await context.route('**/*', route => route.abort());
  t.after(() => context.close());
  const page = await context.newPage();
  await page.setContent('<aside><button aria-label="添加新项目" onclick="window.wrong=true">Project</button><button aria-label="Upload avatar" onclick="window.wrong=true">Avatar</button></aside><main>' + control + '</main>');
  return {page, reader:{page:async()=>page}};
}
for(const label of ['添加文件等内容','添加照片和文件','上传文件','Attach files','Upload files','Add photos & files','Add files and more']) {
  test('attachment selector ignores unrelated sidebar controls: '+label, async t => {
    const {page,reader} = await fixture(t, '<button aria-label="'+label+'" onclick="window.correct=true">Attach</button>');
    const target = await ChatGPTBrowser.prototype.firstVisible.call(reader,SELECTORS.attachmentButton,{timeout:100});
    assert.ok(target);
    assert.equal(await target.getAttribute('aria-label'),label);
    await target.click();
    assert.equal(await page.evaluate(()=>window.correct),true);
    assert.equal(await page.evaluate(()=>window.wrong),undefined);
  });
}
test('missing attachment button does not fall back to Add project', async t => {
  const {reader} = await fixture(t,'<textarea></textarea>');
  assert.equal(await ChatGPTBrowser.prototype.firstVisible.call(reader,SELECTORS.attachmentButton,{timeout:100}),null);
});
test('legacy composer testid remains supported', async t => {
  const {reader} = await fixture(t,'<button data-testid="composer-plus-btn">+</button>');
  const target = await ChatGPTBrowser.prototype.firstVisible.call(reader,SELECTORS.attachmentButton,{timeout:100});
  assert.equal(await target.getAttribute('data-testid'),'composer-plus-btn');
});
test('web search recognizes current menu rows and ignores old answer text', async t => {
  const {page} = await fixture(t, '<article>网页搜索</article><div id="prompt-textarea" contenteditable="true"></div><button aria-label="添加文件等内容" onclick="document.querySelector(\'#menu\').hidden=false">+</button><div id="menu" hidden><button data-list-navigation-item="true" onclick="document.querySelector(\'#prompt-textarea\').innerHTML=\'<span data-inline-selection-pill data-id=search>网页搜索</span>\';document.querySelector(\'#menu\').hidden=true"><div data-menu-row-content="true">网页搜索<span>查找实时新闻和信息</span></div></button></div>');
  const reader = Object.create(ChatGPTBrowser.prototype);
  reader.page = async()=>page;
  reader.ensureSignedIn = async()=>{};
  reader.pageInteraction = async()=>{};
  const result = await reader.enableWebSearch();
  assert.equal(result.selected,true);
  assert.equal(result.changed,true);
  assert.equal(await page.evaluate(()=>window.wrong),undefined);
  assert.equal((await reader.enableWebSearch()).changed,false);
});

for (const label of ['Pro', '极高', 'High', 'Thinking effort: High']) {
  test('answer tier uses semantic composer control without a main region: ' + label, async t => {
    const { page } = await fixture(t, '');
    await page.setContent(`<aside><button class="__composer-pill">Pro</button></aside><form><textarea id="composer"></textarea><button id="tier" aria-label="${label}">${label.startsWith('Thinking') ? '⚙' : label}</button><button class="__composer-pill">Search</button></form>`);
    const reader = new ChatGPTBrowser();
    reader.page = async () => page; reader.composer = async () => page.locator('#composer');
    const target = await reader.advancedControlButton();
    assert.equal(await target.getAttribute('id'), 'tier');
  });
}

test('answer tier waits for hydration and never selects an unrelated pill or historical Pro text', async t => {
  const { page } = await fixture(t, '<article><button>Pro</button></article><form><textarea id="composer"></textarea><button class="__composer-pill">Upload</button></form>');
  const reader = new ChatGPTBrowser();
  reader.page = async () => page; reader.composer = async () => page.locator('#composer');
  await page.evaluate(() => setTimeout(() => {
    const button = document.createElement('button'); button.id = 'tier'; button.textContent = 'Pro'; document.querySelector('form').append(button);
  }, 200));
  assert.equal(await (await reader.advancedControlButton()).getAttribute('id'), 'tier');
  await page.locator('#tier').evaluate(e => e.remove());
  assert.equal(await reader.advancedControlButton(), null);
});

for (const label of ['中', '思考强度 高']) {
  test('recognizes current model trigger: ' + label, async t => {
    const {page} = await fixture(t, `<form><textarea id="composer"></textarea><button id="tier" aria-label="选择 ChatGPT 模型" aria-haspopup="menu">${label}</button><button onclick="window.wrong=true">中</button></form>`);
    const reader = new ChatGPTBrowser(); reader.page = async () => page; reader.composer = async () => page.locator('#composer');
    assert.equal(await (await reader.advancedControlButton()).getAttribute('id'), 'tier');
    assert.equal(await page.evaluate(() => window.wrong), undefined);
  });
}

test('semantic picker lists and verifies model and thinking changes', async t => {
  const {page} = await fixture(t, `<form><textarea id="composer"></textarea><button type="button" id="tier" aria-label="选择 ChatGPT 模型" aria-haspopup="menu">中</button></form><div role="menu" id="menu" hidden><div role="menuitem" aria-label="选择模型">中</div><span role="status">中，第 2 项，共 3 项。</span><div role="menuitem" aria-label="强度"><span role="slider" aria-hidden="true" tabindex="-1" aria-valuemin="0" aria-valuemax="2" aria-valuenow="1"></span></div><div role="menuitemradio" aria-checked="true">GPT-6</div><div role="menuitemradio" aria-checked="false">GPT-5.6 Sol</div></div>`);
  await page.addStyleTag({content: '[role=slider] { display: inline-block; width: 100px; height: 20px }'});
  await page.evaluate(() => {
    const trigger = document.querySelector('#tier'), menu = document.querySelector('#menu'), slider = menu.querySelector('[role=slider]');
    trigger.onclick = () => { menu.hidden = false; };
    document.addEventListener('keydown', e => { if (e.key === 'Escape') menu.hidden = true; });
    slider.onkeydown = e => { let n = +slider.getAttribute('aria-valuenow'); if (e.key === 'Home') n = 0; if (e.key === 'ArrowRight') n = Math.min(2,n+1); slider.setAttribute('aria-valuenow',n); const v=['即时','中','高'][n]; menu.querySelector('[aria-label="选择模型"]').textContent=v; menu.querySelector('[role=status]').textContent=v+'，第 '+(n+1)+' 项，共 3 项。'; trigger.textContent='思考强度 '+v; };
    menu.querySelectorAll('[role=menuitemradio]').forEach(r => r.onclick = () => { menu.querySelectorAll('[role=menuitemradio]').forEach(x => x.setAttribute('aria-checked','false')); r.setAttribute('aria-checked','true'); menu.hidden=true; });
  });
  const reader = new ChatGPTBrowser(); reader.page = async () => page; reader.composer = async () => page.locator('#composer'); reader.ensureSignedIn = async () => {}; reader.pageInteraction = async () => {};
  await page.locator('[role=status]').evaluate(e => e.textContent = '错误');
  await assert.rejects(reader.listModels(), /无法核验/);
  assert.equal(await page.locator('#menu').isVisible(), false);
  await page.locator('[role=status]').evaluate(e => e.textContent = '中，第 2 项，共 3 项。');
  assert.equal((await reader.listModels()).current, 'GPT-6');
  assert.equal((await reader.listThinkingLevels()).current, '中');
  assert.equal((await reader.selectThinkingLevel('高')).selected, '高');
  await page.locator('[role=menuitemradio]').nth(1).evaluate(e => { e.onclick = () => { document.querySelector('#menu').hidden = true; }; });
  await assert.rejects(reader.selectModel('GPT-5.6 Sol'), /未通过页面校验/);
  await page.locator('[role=menuitemradio]').nth(1).evaluate(e => { e.onclick = () => { document.querySelectorAll('[role=menuitemradio]').forEach(x => x.setAttribute('aria-checked', 'false')); e.setAttribute('aria-checked', 'true'); document.querySelector('#menu').hidden = true; }; });
  assert.equal((await reader.selectModel('GPT-5.6 Sol')).selected, 'GPT-5.6 Sol');
  const sequence = [];
  for (const method of ['selectModel', 'selectThinkingLevel', 'advancedSettings']) {
    const original = reader[method].bind(reader);
    reader[method] = async (...args) => { sequence.push(method); return original(...args); };
  }
  await reader.applySendSettings();
  sequence.push('send'); // represents the adapter's later submission boundary
  assert.deepEqual(sequence, ['selectModel', 'selectThinkingLevel', 'advancedSettings', 'send']);
  assert.equal(await page.locator('[role=menuitemradio][aria-checked=true]').innerText(), 'GPT-6');
  assert.equal(await page.locator('[role=menuitem][aria-label="选择模型"]').innerText(), '高');
  assert.equal(await page.evaluate(() => window.wrong), undefined);
});

test('older testid direct picker remains readable', async t => {
  const {page} = await fixture(t, `<div data-testid="composer-intelligence-picker-content"><div data-testid="composer-model-picker-slider-simple-view"><span role="slider" style="display:inline-block;width:20px;height:20px"></span></div><div data-testid="composer-model-picker-slider-advanced-view"><div role="menuitemradio" aria-checked="true">GPT-6</div></div><div role="menuitem" aria-label="选择模型">高</div></div>`);
  const reader = new ChatGPTBrowser(); reader.page = async () => page;
  const result = await reader.directAdvancedSettings();
  assert.equal(result.layout, 'direct-picker');
  assert.equal(result.modelRow.value, 'GPT-6');
  assert.equal(result.thinkingRow.value, '高');
});

test('semantic menu rejects ambiguous or inconsistent controls', async t => {
  const {page} = await fixture(t, `<div role="menu"><div role="menuitem" aria-label="选择模型">高</div><span role="status">高，第 3 项，共 3 项。</span><div role="menuitem" aria-label="强度"><span role="slider" style="display:inline-block;width:20px;height:20px"></span></div><div role="menuitemradio" aria-checked="true">GPT-6</div></div>`);
  const reader = new ChatGPTBrowser(); reader.page = async () => page;
  const menu = page.locator('[role=menu]');
  assert.equal((await reader.directAdvancedSettings(menu)).modelRow.value, 'GPT-6');
  await menu.locator('[role=status]').evaluate(e => e.textContent = '中，第 2 项，共 3 项。');
  await assert.rejects(reader.directAdvancedSettings(menu), /无法核验/);
  await menu.locator('[role=status]').evaluate(e => e.textContent = '高，第 3 项，共 3 项。');
  await menu.locator('[role=slider]').evaluate(e => e.parentNode.append(e.cloneNode()));
  await assert.rejects(reader.directAdvancedSettings(menu), /歧义/);
});

test('mixed language picker recognizes and verifies High as 高 without changing displayed labels', async t => {
  const {page} = await fixture(t, `<form><textarea id="composer"></textarea><button type="button" id="tier" aria-label="选择 ChatGPT 模型" aria-haspopup="menu">High</button></form><div role="menu" id="menu" hidden><div role="menuitem" aria-label="选择模型">High</div><span role="status">高，第 3 项，共 3 项。</span><div role="menuitem" aria-label="强度"><span role="slider" aria-hidden="true" tabindex="-1" aria-valuemin="0" aria-valuemax="2" aria-valuenow="2" style="display:inline-block;width:100px;height:20px"></span></div><div role="menuitemradio" aria-checked="true">GPT-6</div></div>`);
  await page.evaluate(() => {
    const trigger = document.querySelector('#tier'), menu = document.querySelector('#menu'), slider = menu.querySelector('[role=slider]');
    window.keys = [];
    trigger.onclick = () => { menu.hidden = false; };
    document.addEventListener('keydown', e => { if (e.key === 'Escape') menu.hidden = true; });
    slider.onkeydown = e => { window.keys.push(e.key); let n = +slider.getAttribute('aria-valuenow'); if (e.key === 'Home') n = 0; if (e.key === 'ArrowRight') n = Math.min(2,n+1); slider.setAttribute('aria-valuenow',n); const v=['即时','中','High'][n]; menu.querySelector('[aria-label="选择模型"]').textContent=v; menu.querySelector('[role=status]').textContent=(n === 2 ? '高' : v)+'，第 '+(n+1)+' 项，共 3 项。'; trigger.textContent=v; };
  });
  const reader = new ChatGPTBrowser(); reader.page = async () => page; reader.composer = async () => page.locator('#composer'); reader.ensureSignedIn = async () => {}; reader.pageInteraction = async () => {};
  assert.deepEqual(await reader.selectThinkingLevel('高'), {requested:'高', selected:'High', changed:false});
  await reader.applySendSettings();
  assert.deepEqual(await page.evaluate(() => window.keys), []);
  assert.equal((await reader.advancedSettings({force:true})).thinkingLevel, 'High');
  await page.evaluate(() => { document.querySelector('[role=slider]').setAttribute('aria-valuenow','1'); document.querySelector('[aria-label="选择模型"]').textContent='中'; document.querySelector('[role=status]').textContent='中，第 2 项，共 3 项。'; });
  const changed = await reader.selectThinkingLevel('高');
  assert.equal(changed.selected, 'High'); assert.equal(changed.changed, true);
  assert.deepEqual(changed.available, ['即时', '中', 'High']);
});
