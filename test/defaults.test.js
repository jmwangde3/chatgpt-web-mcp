import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatGPTBrowser } from '../src/browser.js';
import { chatgptProvider } from '../src/providers/adapters.js';
import { TaskKernel } from '../src/core/tasks.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeState } from '../src/shared/persistent-browser.js';

function setup() {
  const events = [], state = { model: 'old', thinkingLevel: '中' };
  const browser = {
    selectModel: async model => { events.push(['model', model]); state.model = model; },
    selectThinkingLevel: async level => { events.push(['thinking', level]); state.thinkingLevel = level; return {selected: level}; },
    selectAnswerTier: async tier => { events.push(['tier', tier]); return { selected: tier }; },
    advancedSettings: async options => { events.push(['read', options]); return { ...state }; },
  };
  browser.applySendSettings = options => ChatGPTBrowser.prototype.applySendSettings.call(browser, options);
  return { browser, events, state };
}

test('ChatGPT defaults are selected and force verified; failure rejects', async () => {
  const { browser, events } = setup();
  await browser.applySendSettings();
  assert.deepEqual(events, [['model','GPT-6'], ['thinking','高'], ['read',{force:true}]]);
  browser.advancedSettings = async () => ({ model: 'wrong', thinkingLevel: '高' });
  await assert.rejects(browser.applySendSettings(), /复核/);
});

test('only exact 高 and High are aliases in thinking verification and conflicts', async () => {
  const {browser, events} = setup();
  browser.selectThinkingLevel = async value => { events.push(['thinking', value]); return {selected:'High'}; };
  browser.advancedSettings = async () => ({model:'GPT-6', thinkingLevel:'High'});
  await browser.applySendSettings();
  const result = await browser.applySendSettings({thinkingLevel:'高', answerTier:'High'});
  assert.equal(result.answerTier.selected, 'High');
  for (const other of ['极高', 'Pro', '较高', 'Very High']) {
    await assert.rejects(browser.applySendSettings({thinkingLevel:'高', answerTier:other}), /冲突/);
    browser.advancedSettings = async () => ({model:'GPT-6', thinkingLevel:other});
    await assert.rejects(browser.applySendSettings(), /复核/);
  }
  browser.advancedSettings = async () => ({model:'GPT-6', thinkingLevel:'High'});
  await assert.rejects(browser.applySendSettings({model:'GPT-6 High'}), /复核/);
});

test('legacy thinking menu requires one exact semantic match', async () => {
  const b = new ChatGPTBrowser(); let options = [{name:'High'}], clicked;
  b.page = async () => ({});
  b.openAdvancedSettings = async () => ({modelRow:{value:'GPT-6'}, thinkingRow:{value:'中'}});
  b.closeAdvancedMenus = async () => {};
  b.clickAdvancedRow = async () => {};
  b.visibleMenuOptions = async () => options;
  b.clickMenuOption = async option => { clicked = option.name; };
  b.firstVisible = async () => null;
  assert.equal((await b.selectThinkingLevel('高')).selected, 'High');
  assert.equal(clicked, 'High');
  options = [{name:'高'}, {name:'High'}]; clicked = null;
  await assert.rejects(b.selectThinkingLevel('高'), /多个选项/); assert.equal(clicked, null);
  for (const name of ['Very High', '极高', 'Pro', '较高']) {
    options = [{name}];
    await assert.rejects(b.selectThinkingLevel('高'), /不在当前账号/);
    assert.equal(clicked, null);
  }
});

test('explicit choices suppress defaults and conflicting tiers fail before clicks', async () => {
  const { browser, events } = setup();
  await browser.applySendSettings({ model: 'Other' });
  assert.deepEqual(events, [['model','Other'], ['read',{force:true}]]); events.length = 0;
  await browser.applySendSettings({ thinkingLevel: '中' });
  assert.deepEqual(events, [['thinking','中'], ['read',{force:true}]]); events.length = 0;
  await browser.applySendSettings({ answerTier: 'Pro' });
  assert.deepEqual(events, [['tier','Pro']]); events.length = 0;
  await browser.applySendSettings({ thinkingLevel: '高', answerTier: '高' });
  assert.deepEqual(events, [['thinking','高'], ['read',{force:true}]]); events.length = 0;
  await assert.rejects(browser.applySendSettings({ thinkingLevel: '中', answerTier: '高' }), /冲突/);
  assert.deepEqual(events, []);
});

test('ChatGPT adapter applies settings after refresh before baseline', async () => {
  const events = [];
  const browser = { assertActionsAllowed: async()=>{}, ensureSignedIn: async()=>{}, assertComposerEmpty: async()=>{}, ensureConversationCapacity: async()=>{}, refreshBeforeSend: async()=>events.push('refresh'), applySendSettings: async value=>{ events.push(value); return {}; }, getLatestResponse: async()=>({url:'https://chatgpt.com', userMessageCount:0, assistantMessageCount:0}) };
  await chatgptProvider(browser).prepare({model:'Other', thinking_level:'中'});
  assert.deepEqual(events, ['refresh', {model:'Other', thinkingLevel:'中', answerTier:undefined}]);
});

test('new durable ChatGPT task selects and verifies defaults before sending', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'web-chat-defaults-'));
  t.after(() => fs.rm(dir, {recursive:true, force:true}));
  const {browser, events} = setup();
  Object.assign(browser, {runExclusive: fn => fn(), assertActionsAllowed: async()=>{}, ensureSignedIn: async()=>{}, assertComposerEmpty: async()=>{}, ensureConversationCapacity: async()=>{}, refreshBeforeSend: async()=>events.push(['refresh']), getLatestResponse: async()=>({url:'https://chatgpt.com', userMessageCount:0, assistantMessageCount:0, generating:false})});
  const adapter = chatgptProvider(browser);
  adapter.send = async () => { events.push(['send']); return {url:'https://chatgpt.com'}; };
  adapter.inspect = async () => ({url:'https://chatgpt.com', userCount:1, lastUser:'hello'});
  const kernel = new TaskKernel([adapter], {directory:dir});
  const task = await kernel.send({provider:'chatgpt', request_id:'new', prompt:'hello'});
  assert.equal(task.state, 'submitted');
  assert.deepEqual(events, [['refresh'], ['model','GPT-6'], ['thinking','高'], ['read',{force:true}], ['send']]);
});

test('pre-upgrade fingerprint journal replays without browser activity', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'web-chat-old-journal-'));
  t.after(() => fs.rm(dir, {recursive:true, force:true}));
  const task_id = 'chatgpt:00000000-0000-4000-8000-000000000001';
  await writeState(path.join(dir, 'chatgpt', 'tasks.json'), {version:1, active:null, tasks:{[task_id]:{task_id, provider:'chatgpt', state:'completed', requestHash:'5d9c3a82fc45fc20263ea4a025e89688912df1dfd92729366d02de31026bec77', fingerprint:'d8ce36d12febe042523b4e3fa1060e0652e5420c4e06dc879af8f685d8b95796'}}});
  const browser = {runExclusive: async () => assert.fail('replay accessed browser')};
  const kernel = new TaskKernel([chatgptProvider(browser)], {directory:dir});
  const input = {provider:'chatgpt', request_id:'old-request', prompt:'old prompt'};
  assert.equal((await kernel.send(input)).task_id, task_id);
  await assert.rejects(kernel.send({...input, thinking_level:'高'}), {code:'IDEMPOTENCY_CONFLICT'});
});

test('unverified defaults in real adapter fail durable task without sending', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'web-chat-default-fail-'));
  t.after(() => fs.rm(dir, {recursive:true, force:true}));
  const {browser, events} = setup();
  browser.advancedSettings = async () => ({model:'GPT-6', thinkingLevel:'Very High'});
  Object.assign(browser, {runExclusive: fn => fn(), assertActionsAllowed: async()=>{}, ensureSignedIn: async()=>{}, assertComposerEmpty: async()=>{}, ensureConversationCapacity: async()=>{}, refreshBeforeSend: async()=>{}});
  const adapter = chatgptProvider(browser);
  adapter.send = async () => { events.push(['send']); };
  const task = await new TaskKernel([adapter], {directory:dir}).send({provider:'chatgpt', request_id:'failure', prompt:'hello'});
  assert.equal(task.state, 'failed');
  assert.equal(events.some(item => item[0] === 'send'), false);
});

test('Gemini explicit model is still selected once and rejects ChatGPT thinking_level', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'web-chat-gemini-unchanged-'));
  t.after(() => fs.rm(dir, {recursive:true, force:true}));
  const events = [];
  const adapter = {id:'gemini', browser:{runExclusive: fn=>fn(), selectModel: async m=>events.push(m)}, isRoot:()=>true, prepare:async()=>({url:'https://example.com',userCount:0,responseCount:0}), send:async()=>({url:'https://example.com'})};
  const kernel = new TaskKernel([adapter], {directory:dir});
  assert.equal((await kernel.send({provider:'gemini', request_id:'g', prompt:'hello', model:'Gemini'})).state, 'submitted');
  assert.deepEqual(events, ['Gemini']);
  await assert.rejects(kernel.send({provider:'gemini',request_id:'other',prompt:'hello',thinking_level:'高'}), {code:'UNSUPPORTED_SETTING'});
  assert.deepEqual(events, ['Gemini']);
});
