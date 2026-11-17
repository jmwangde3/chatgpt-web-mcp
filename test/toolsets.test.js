import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {inspectToolset} from '../scripts/measure-toolsets.js';
import {mcpToolset} from '../src/config.js';
const original=JSON.parse(await fs.readFile(new URL('./fixtures/full-toolset-schema-v3.json',import.meta.url),'utf8'));
const baseline=JSON.parse(await fs.readFile(new URL('./fixtures/full-toolset-baseline.json',import.meta.url),'utf8'));
// Object key order (including $schema placement) is irrelevant to deep equality.
// Keep all keywords and array order: never erase validation constraints to compare.
function assertCompatible(tool) {
 const old=original.tools.find(t=>t.name===tool.name);
 assert.ok(old, tool.name);
 const expected=structuredClone(old.inputSchema);
 if (['chatgpt_upload_files','chatgpt_send_message','chatgpt_route_new_chat'].includes(tool.name)) {
  assert.equal(expected.properties.files.maxItems,undefined);
  assert.equal(tool.inputSchema.properties.files.maxItems,10,tool.name+' files limit');
  expected.properties.files.maxItems=10;
 }
 if(tool.name==='chat_tasks') {
  const offset=expected.properties.offset;
  assert.equal(offset.type,'integer');assert.equal(offset.minimum,0);
  assert.equal(offset.maximum,undefined);
  assert.equal(tool.inputSchema.properties.offset.maximum,Number.MAX_SAFE_INTEGER);
  // Zod 4 int rejects unsafe integers; the pre-existing minimum already bounds below.
  offset.maximum=Number.MAX_SAFE_INTEGER;
 }
 assert.deepEqual(tool.inputSchema,expected,tool.name+' schema constraints changed');
}

test('original runtime fixture retains all 63 historical baseline hashes',()=>{
 assert.deepEqual(original.tools.map(t=>t.name),baseline.names);
 assert.deepEqual(Object.fromEntries(original.tools.map(t=>[t.name,createHash('sha256').update(JSON.stringify(t.inputSchema)).digest('hex')])),baseline.schemaHashes);
});

test('full/default preserve original constraints except explicit files and safe integer limits; no artifacts',async()=>{
 const failures=[];
 for(const mode of ['full',undefined]){
  const {tools,instructions,artifacts}=await inspectToolset(mode);
  assert.deepEqual(tools.map(t=>t.name),baseline.names);
  assert.equal(new Set(tools.map(t=>t.name)).size,tools.length);
  assert.deepEqual(artifacts,[]);assert.match(instructions,/legacy chatgpt_/);
  for(const tool of tools){try{assertCompatible(tool);}catch(error){failures.push(`${mode ?? 'default'}: ${error.message}`);}}
 }
 assert.deepEqual(failures,[]);
});

test('only intended new limits are explicitly advertised',async()=>{
 const {tools,artifacts}=await inspectToolset('full');
 assert.deepEqual(artifacts,[]);
 for(const name of ['chatgpt_upload_files','chatgpt_send_message','chatgpt_route_new_chat']){
  assert.equal(tools.find(t=>t.name===name).inputSchema.properties.files.maxItems,10,name);
 }
 const offset=tools.find(t=>t.name==='chat_tasks').inputSchema.properties.offset;
 assert.equal(offset.type,'integer');assert.equal(offset.minimum,0);
 assert.equal(offset.maximum,Number.MAX_SAFE_INTEGER);assert.equal(offset.default,0);
});

test('unified exposes exactly existing unified schemas with matching instructions',async()=>{
 const {tools,instructions,artifacts}=await inspectToolset('unified');
 assert.deepEqual(tools.map(t=>t.name),baseline.names.filter(n=>n.startsWith('chat_')));
 for(const tool of tools){assertCompatible(tool);assert.equal(tool.inputSchema.type,'object');}
 assert.equal(new Set(tools.map(t=>t.name)).size,17);assert.deepEqual(artifacts,[]);
 assert.ok(!instructions.includes('chatgpt_')&&!instructions.includes('gemini_'));
 for(const name of instructions.match(/\bchat_[a-z_]+\b/g)||[])assert.ok(tools.some(t=>t.name===name),`Instructions mention absent tool ${name}`);
});
test('invalid toolset is rejected; missing value defaults full',async()=>{
 assert.equal(mcpToolset({}),'full');for(const value of ['', 'FULL','unknown'])assert.throws(()=>mcpToolset({CHATGPT_WEB_MCP_TOOLSET:value}),/must be full or unified/);
 await assert.rejects(inspectToolset('invalid'));
});

test('actual MCP calls reject unknown root and nested keys before browser handlers',async()=>{
 const {artifacts}=await inspectToolset('full',{verifyClient:async client=>{
  const cases=[
   ['chat_status',{provider:'chatgpt',unknown:1}],
   ['chatgpt_write_prompt',{prompt:'unused',unknown:1}],
   ['gemini_write_prompt',{prompt:'unused',unknown:1}],
   ['chat_compare',{request_id:'schema-rejection-only',prompt:'unused',targets:[
    {provider:'chatgpt',model:'unused',unknown:1},
    {provider:'gemini',model:'unused'},
   ]}],
  ];
  for(const [name,args] of cases){
   const result=await client.callTool({name,arguments:args});
   assert.equal(result.isError,true,name);
   const message=result.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');
   assert.match(message,/Input validation error/i,name);
   assert.match(message,/unrecognized_keys|unrecognized key/i,name);
   assert.match(message,/unknown/,name);
  }
 }});
 assert.deepEqual(artifacts,[],'Rejected calls must not create browser or task artifacts');
});
