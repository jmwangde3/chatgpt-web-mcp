import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {inspectToolset} from '../scripts/measure-toolsets.js';
import {mcpToolset} from '../src/config.js';
const baseline=JSON.parse(await fs.readFile(new URL('./fixtures/full-toolset-baseline.json',import.meta.url),'utf8'));
test('full/default preserve all baseline tool names and schemas; list creates no browser artifacts',async()=>{
 for(const mode of ['full',undefined]){
  const {tools,instructions,artifacts}=await inspectToolset(mode);
  assert.deepEqual(tools.map(t=>t.name),baseline.names);assert.equal(new Set(tools.map(t=>t.name)).size,tools.length);
  assert.deepEqual(Object.fromEntries(tools.map(t=>[t.name,createHash('sha256').update(JSON.stringify(t.inputSchema)).digest('hex')])),baseline.schemaHashes);
  assert.deepEqual(artifacts,[]);assert.match(instructions,/legacy chatgpt_/);
 }
});
test('unified exposes exactly existing unified schemas with matching instructions',async()=>{
 const {tools,instructions,artifacts}=await inspectToolset('unified');
 assert.deepEqual(tools.map(t=>t.name),baseline.names.filter(n=>n.startsWith('chat_')));
 for(const tool of tools){assert.equal(createHash('sha256').update(JSON.stringify(tool.inputSchema)).digest('hex'),baseline.schemaHashes[tool.name]);assert.equal(tool.inputSchema.type,'object');}
 assert.equal(new Set(tools.map(t=>t.name)).size,17);assert.deepEqual(artifacts,[]);
 assert.ok(!instructions.includes('chatgpt_')&&!instructions.includes('gemini_'));
 for(const name of instructions.match(/\bchat_[a-z_]+\b/g)||[])assert.ok(tools.some(t=>t.name===name),`Instructions mention absent tool ${name}`);
});
test('invalid toolset is rejected; missing value defaults full',async()=>{
 assert.equal(mcpToolset({}),'full');for(const value of ['', 'FULL','unknown'])assert.throws(()=>mcpToolset({CHATGPT_WEB_MCP_TOOLSET:value}),/must be full or unified/);
 await assert.rejects(inspectToolset('invalid'));
});