import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const runNode = promisify(execFile);

async function isolatedPolicyCheck(source, overrides = {}) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("CHATGPT_WEB_")),
  );
  const directory = await mkdtemp(path.join(tmpdir(), 'isolated-policy-'));
  const paths = Object.fromEntries(Object.entries({
    PROFILE: 'profile', BROWSER_STATE: 'browser.json', RUNTIME_STATE: 'runtime.json',
    OPERATION_LOCK: 'operation.lock', NETWORK_LOG: 'network.jsonl', CONTEXT_ARCHIVE_DIR: 'archive',
  }).map(([key, name]) => [`CHATGPT_WEB_${key}`, path.join(directory, name)]));
  try {
    return await runNode(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: { ...env, ...paths, ...overrides },
  });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("default intervals are five seconds and disabled probes never touch the browser", async () => {
  await isolatedPolicyCheck(`
    import assert from "node:assert/strict";
    import * as config from "./src/config.js";
    import { ChatGPTBrowser } from "./src/browser.js";
    for (const name of ["SEND_INTERVAL_MS", "CONVERSATION_CHANGE_INTERVAL_MS", "POST_RESPONSE_CONVERSATION_COOLDOWN_MS"]) {
      assert.equal(config[name], 5000, name);
    }
    assert.equal(config.PAGE_STARTUP_DELAY_MS, 6000);
    assert.equal(config.POST_BREAKER_COOLDOWN_MS, 300000);
    assert.equal(config.HISTORY_QUIET_PERIOD_MS, 300000);
    assert.equal(config.PROBE_ENABLED, false);
    assert.equal(config.REFRESH_BEFORE_NEW_CHAT, false);

    const browser = new ChatGPTBrowser();
    browser.page = async () => assert.fail("disabled probe must not open a page");
    browser.newChat = async () => assert.fail("disabled probe must not create a chat");
    browser.submitPrompt = async () => assert.fail("disabled probe must not send");
    await assert.rejects(browser.probeProIdentity({ force: true }), /默认停用/);
    await assert.rejects(browser.routeNewChat({ prompt: "offline fixture", requestPro: true, forceProbe: true }), /默认停用/);
  `);
});

test("exited MCP owner cannot release generation without original-page completion evidence", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "chatgpt-web-mcp-policy-"));
  const runtimeFile = path.join(directory, "runtime.json");
  try {
    await writeFile(runtimeFile, JSON.stringify({
      activeGeneration: { active: true, ownerPid: 2_147_483_647 },
    }), { encoding: 'utf8', mode: 0o600 });
    await isolatedPolicyCheck(`
      import assert from "node:assert/strict";
      import { readFile, writeFile } from "node:fs/promises";
      import { ChatGPTBrowser } from "./src/browser.js";
      import { RUNTIME_STATE_FILE } from "./src/config.js";
      const browser = new ChatGPTBrowser();
      browser.page = async () => assert.fail("stale-owner cleanup must not open a page");
      browser.getLatestResponse = async () => assert.fail("stale-owner cleanup needs no page read");
      await assert.rejects(browser.assertActionsAllowed("offline-test"), /生成任务/);
      const state = JSON.parse(await readFile(RUNTIME_STATE_FILE, "utf8"));
      assert.equal(state.activeGeneration.active, true);
      assert.equal(state.lastGenerationInterruptedAt, undefined);

      for (const ownerPid of [process.pid, null]) {
        await writeFile(RUNTIME_STATE_FILE, JSON.stringify({ activeGeneration: { active: true, ownerPid } }), { encoding: 'utf8', mode: 0o600 });
        await assert.rejects(browser.assertActionsAllowed("offline-test"), /生成任务/);
      }
    `, { CHATGPT_WEB_RUNTIME_STATE: runtimeFile });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('ChatGPT session context isolates production runtime writes while preserving the account circuit breaker', async () => {
  const root = path.resolve(tmpdir());
  const directory = await mkdtemp(path.join(root, 'chatgpt-session-policy-'));
  try {
    await isolatedPolicyCheck(`
      import assert from 'node:assert/strict';
      import { readFile, writeFile } from 'node:fs/promises';
      import { ChatGPTBrowser } from './src/browser.js';
      import { RUNTIME_STATE_FILE } from './src/config.js';
      const generation = { active: true, ownerPid: process.pid, url:'https://chatgpt.com/c/original' };
      const { createHash } = await import('node:crypto');
      const lastUser = 'session policy prompt';
      const expected = { url: generation.url, userCount: 1,
        promptHash: createHash('sha256').update(lastUser).digest('hex') };
      await writeFile(RUNTIME_STATE_FILE, JSON.stringify({activeGeneration:generation,sessions:{a:{activeGeneration:generation},b:{activeGeneration:generation}}}), { encoding: 'utf8', mode: 0o600 });
      const a = new ChatGPTBrowser({sessionId:'a'}), b = new ChatGPTBrowser({sessionId:'b'}), fresh = new ChatGPTBrowser({sessionId:'new'});
      a.firstVisible = async () => null;
      a.page = async () => ({ evaluate: async () => ({ url: generation.url,
        count: 1, isLast: true, lastText: lastUser, identityCandidates: [] }) });
      a.getLatestResponse = async () => ({generating:false,activeGeneration:generation,url:generation.url,
        userMessageCount:1,lastUserMessage:lastUser,identitySnapshotValid:true});
      await a.runExclusive(() => a.settleManagedGeneration(expected, {allowIdle:true}));
      const read = async () => JSON.parse(await readFile(RUNTIME_STATE_FILE,'utf8'));
      const state = await read();
      assert.equal(state.activeGeneration.active,true);
      assert.equal(state.sessions.b.activeGeneration.active,true);
      assert.equal(state.sessions.a.activeGeneration,null);
      await fresh.runExclusive(() => fresh.assertActionsAllowed());
      await assert.rejects(b.runExclusive(() => b.assertActionsAllowed()), /生成任务/);
      await writeFile(RUNTIME_STATE_FILE, JSON.stringify({...await read(),circuitBreaker:{active:true}}), { encoding: 'utf8', mode: 0o600 });
      await assert.rejects(a.runExclusive(() => a.assertActionsAllowed()), /熔断/);
      await assert.rejects(fresh.runExclusive(() => fresh.assertActionsAllowed()), /熔断/);
      const { chatgptProvider } = await import('./src/providers/adapters.js');
      const provider = chatgptProvider(a);
      a.getLatestResponse = async () => ({ response:'Completed answer', generating:false,
        rateLimited:false, circuitBreaker:(await read()).circuitBreaker });
      assert.equal((await provider.inspect()).complete, true);
      assert.equal((await read()).circuitBreaker.active, true);
      await assert.rejects(provider.prepare(), /熔断/);
    `, { CHATGPT_WEB_RUNTIME_STATE: path.join(directory, 'runtime.json'), CHATGPT_WEB_OPERATION_LOCK: path.join(directory, 'operation.lock') });
  } finally {
    if (path.dirname(directory) !== root) throw new Error('Unexpected test directory');
    await rm(directory, { recursive: true, force: true });
  }
});
