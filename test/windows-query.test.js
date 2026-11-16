import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {windowsQuery,verifyWindowsProcess} from '../src/shared/windows-security.js';
const expected={pid:123,port:9222,profile:'C:\\private profile',executable:'C:\\Chrome\\chrome.exe'};
const actual={...expected,creationTime:'2026-11-17T00:00:00Z',ownerPid:123,address:'127.0.0.1',commandLine:'chrome.exe "--user-data-dir=C:\\private profile" --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1'};

function launchChildFixture(delta = 1000) {
 const startedAt = Date.parse('2026-11-17T00:00:00.000Z');
 return {
  saved: {...expected, pid:46428, startedAt},
  listener: {...actual, pid:51184, ownerPid:51184, parentPid:46428,
   creationTime:new Date(startedAt + delta).toISOString()},
 };
}

for (const delta of [-1000, 1000, 10000]) {
 test(`verified direct launch child migrates to listener PID at creation delta ${delta}ms`, async () => {
  const {saved, listener} = launchChildFixture(delta);
  let queries = 0;
  const identity = await verifyWindowsProcess(saved, {query:async (_script, input) => {
   queries++;
   assert.deepEqual(input, {pid:saved.pid, port:saved.port});
   return {...listener};
  }});
  assert.equal(queries, 1);
  assert.deepEqual(identity, {
   pid:listener.pid, port:listener.port, profile:saved.profile,
   executable:saved.executable, creationTime:listener.creationTime,
  });
  assert.equal(saved.pid, 46428, 'verification must not mutate the saved record');
  assert.equal(identity.commandLine, undefined);
 });
}

for (const [label, change] of [
 ['wrong parent', ({listener}) => {listener.parentPid = 999;}],
 ['created too early', ({saved, listener}) => {listener.creationTime = new Date(saved.startedAt - 1001).toISOString();}],
 ['created too late', ({saved, listener}) => {listener.creationTime = new Date(saved.startedAt + 10001).toISOString();}],
 ['missing startedAt', ({saved}) => {delete saved.startedAt;}],
 ['already enriched creationTime', ({saved, listener}) => {saved.creationTime = listener.creationTime;}],
 ['wrong executable', ({listener}) => {listener.executable = 'C:\\Other\\chrome.exe';}],
 ['wrong profile', ({listener}) => {listener.commandLine = listener.commandLine.replace('private profile', 'other profile');}],
 ['non-loopback listener', ({listener}) => {listener.address = '0.0.0.0';}],
 ['non-loopback command-line address', ({listener}) => {listener.commandLine = listener.commandLine.replace('127.0.0.1', '0.0.0.0');}],
 ['wrong listener owner', ({listener}) => {listener.ownerPid = 999;}],
 ['wrong listener port', ({listener}) => {listener.port = 9333;}],
 ['wrong command-line port', ({listener}) => {listener.commandLine = listener.commandLine.replace('9222', '9333');}],
]) {
 test(`launch-child migration rejects ${label}`, async () => {
  const pair = launchChildFixture();
  change(pair);
  let queries = 0;
  await assert.rejects(verifyWindowsProcess(pair.saved, {query:async () => {
   queries++;
   return {...pair.listener};
  }}), {code:'BROWSER_IDENTITY_MISMATCH'});
  assert.equal(queries, 1);
  assert.equal(pair.saved.pid, 46428);
 });
}
test('legacy identity is upgraded only after live verification and omits command line',async()=>{
 const identity=await verifyWindowsProcess(expected,{query:async()=>actual});
 assert.equal(identity.creationTime,actual.creationTime);assert.equal(identity.commandLine,undefined);
});
for(const commandLine of [actual.commandLine+' --remote-debugging-port=9999',actual.commandLine.replace('127.0.0.1','0.0.0.0'),actual.commandLine.replace('private profile','other')]){
 test('process command-line identity mismatch fails closed',async()=>{await assert.rejects(verifyWindowsProcess(expected,{query:async()=>({...actual,commandLine})}),{code:'BROWSER_IDENTITY_MISMATCH'});});
}
test('failed Windows query propagates without accepting identity',async()=>{await assert.rejects(verifyWindowsProcess(expected,{query:async()=>{throw Object.assign(new Error('query failed'),{code:'SECURITY_QUERY_FAILED'});}}),{code:'SECURITY_QUERY_FAILED'});});
test('Windows query timeout kills only the query helper',async()=>{
 let killed=0;const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{killed++;};
 await assert.rejects(windowsQuery('unused',{}, {timeout:20,spawnImpl:()=>child}),{code:'SECURITY_QUERY_TIMEOUT'});assert.equal(killed,1);
});import {PersistentBrowser,writeState} from '../src/shared/persistent-browser.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
test('unknown saved owner cannot connect or terminate and preserves legacy state',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'unknown-browser-owner-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const browserState=path.join(directory,'browser-state.json');await writeState(browserState,{pid:process.pid,port:9222,profile:directory});const before=await fs.readFile(browserState,'utf8');
 let connections=0;const runtime=new PersistentBrowser({browserState,profile:directory,executable:'synthetic.exe'},{security:{paths:async()=>{},process:async()=>{throw Object.assign(new Error('owner mismatch'),{code:'BROWSER_IDENTITY_MISMATCH'});}},connect:async()=>{connections++;},spawnImpl:()=>assert.fail('must not spawn')});
 await assert.rejects(runtime.connect(),{code:'BROWSER_IDENTITY_MISMATCH'});await assert.rejects(runtime.terminate(),{code:'BROWSER_IDENTITY_MISMATCH'});assert.equal(connections,0);assert.equal(await fs.readFile(browserState,'utf8'),before);
});
