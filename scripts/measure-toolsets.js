import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
export async function inspectToolset(mode, { entrypoint = fileURLToPath(new URL('../src/index.js',import.meta.url)), verifyClient } = {}) {
 const tempRoot = process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA, 'Temp') : os.tmpdir();
 const directory=await fs.mkdtemp(path.join(tempRoot,'mcp-toolset-list-'));
 const env={...process.env,CHATGPT_WEB_PROFILE:path.join(directory,'profile'),CHATGPT_WEB_BROWSER_STATE:path.join(directory,'browser.json'),CHATGPT_WEB_RUNTIME_STATE:path.join(directory,'runtime.json'),CHATGPT_WEB_OPERATION_LOCK:path.join(directory,'operation.lock'),GEMINI_WEB_DATA_DIR:path.join(directory,'gemini'),CHATGPT_WEB_CHROME:path.join(directory,'nonexistent.exe'),GEMINI_WEB_CHROME:path.join(directory,'nonexistent.exe')};
 // Isolate every persistence location, including inherited overrides.
 // Default inspection only lists; tests may explicitly verify rejected calls.
 Object.assign(env, {
  CHATGPT_WEB_NETWORK_LOG:path.join(directory,'network.jsonl'),
  CHATGPT_WEB_CONTEXT_ARCHIVE_DIR:path.join(directory,'archives'),
  GEMINI_WEB_PROFILE:path.join(directory,'gemini-profile'),
  GEMINI_WEB_ARCHIVE_DIR:path.join(directory,'gemini-archives'),
  GEMINI_WEB_BROWSER_STATE:path.join(directory,'gemini-browser.json'),
  GEMINI_WEB_RUNTIME_STATE:path.join(directory,'gemini-runtime.json'),
  GEMINI_WEB_OPERATION_LOCK:path.join(directory,'gemini-operation.lock'),
  WEB_CHAT_DATA_DIR:path.join(directory,'tasks'),
 });
 if(mode===undefined)delete env.CHATGPT_WEB_MCP_TOOLSET;else env.CHATGPT_WEB_MCP_TOOLSET=mode;
 const transport=new StdioClientTransport({command:process.execPath,args:[entrypoint],env,stderr:'pipe'});
 transport.stderr?.on('data',()=>{});
 const client=new Client({name:'toolset-acceptance',version:'1.0.0'});
 try {await client.connect(transport); const {tools}=await client.listTools();const instructions=client.getInstructions(); await verifyClient?.(client); const artifacts=await fs.readdir(directory);return {tools,instructions,artifacts};}
 finally {await client.close();await fs.rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const results={};for(const mode of ['full','unified']){
  const {tools,instructions,artifacts}=await inspectToolset(mode);const inputSchemas=JSON.stringify(tools.map(({name,inputSchema})=>({name,inputSchema})));const schema=JSON.stringify(tools);results[mode]={count:tools.length,schemaBytes:Buffer.byteLength(schema),schemaChars:schema.length,inputSchemaBytes:Buffer.byteLength(inputSchemas),inputSchemaChars:inputSchemas.length,tokenEstimate:Math.ceil(schema.length/4),tokenEstimateMethod:'characters/4; heuristic, not billed tokens',instructionsChars:instructions.length,artifacts};
 }console.log(JSON.stringify(results,null,2));
}
