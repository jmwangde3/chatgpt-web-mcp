import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
export async function inspectToolset(mode) {
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'mcp-toolset-list-'));
 const env={...process.env,CHATGPT_WEB_PROFILE:path.join(directory,'profile'),CHATGPT_WEB_BROWSER_STATE:path.join(directory,'browser.json'),CHATGPT_WEB_RUNTIME_STATE:path.join(directory,'runtime.json'),CHATGPT_WEB_OPERATION_LOCK:path.join(directory,'operation.lock'),GEMINI_WEB_DATA_DIR:path.join(directory,'gemini'),CHATGPT_WEB_CHROME:path.join(directory,'nonexistent.exe'),GEMINI_WEB_CHROME:path.join(directory,'nonexistent.exe')};
 if(mode===undefined)delete env.CHATGPT_WEB_MCP_TOOLSET;else env.CHATGPT_WEB_MCP_TOOLSET=mode;
 const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../src/index.js',import.meta.url))],env,stderr:'pipe'});
 transport.stderr?.on('data',()=>{});
 const client=new Client({name:'toolset-acceptance',version:'1.0.0'});
 try {await client.connect(transport); const {tools}=await client.listTools();const instructions=client.getInstructions(); const artifacts=await fs.readdir(directory);return {tools,instructions,artifacts};}
 finally {await client.close();await fs.rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const results={};for(const mode of ['full','unified']){
  const {tools,instructions,artifacts}=await inspectToolset(mode);const inputSchemas=JSON.stringify(tools.map(({name,inputSchema})=>({name,inputSchema})));const schema=JSON.stringify(tools);results[mode]={count:tools.length,schemaBytes:Buffer.byteLength(schema),schemaChars:schema.length,inputSchemaBytes:Buffer.byteLength(inputSchemas),inputSchemaChars:inputSchemas.length,tokenEstimate:Math.ceil(schema.length/4),tokenEstimateMethod:'characters/4; heuristic, not billed tokens',instructionsChars:instructions.length,artifacts};
 }console.log(JSON.stringify(results,null,2));
}