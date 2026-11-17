#!/usr/bin/env node

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const unified = process.env.CHATGPT_WEB_MCP_TOOLSET === 'unified';
const transport = new StdioClientTransport({
  command: process.execPath,
  env: { ...process.env },
  args: [fileURLToPath(new URL("../src/index.js", import.meta.url))],
  stderr: "pipe",
});

transport.stderr?.on("data", (chunk) => process.stderr.write(chunk));

const client = new Client({ name: "chatgpt-web-mcp-smoke", version: "0.2.0" });
try {
  await client.connect(transport);
  const tools = await client.listTools();
  console.log(`tools=${tools.tools.length}`);
  console.log(tools.tools.map((tool) => tool.name).join("\n"));
  assert.equal(tools.tools.filter((tool) => tool.name.startsWith('chatgpt_')).length, unified ? 0 : 29);
  assert.equal(tools.tools.filter((tool) => tool.name.startsWith('gemini_')).length, unified ? 0 : 17);
  for (const name of ['chat_providers', 'chat_status', 'chat_models', 'chat_select_model', 'chat_new', 'chat_send', 'chat_result', 'chat_cancel', 'chat_tasks', 'chat_history', 'chat_open', 'chat_archive', 'chat_abandon']) {
    assert.ok(tools.tools.some((tool) => tool.name === name), `Missing tool: ${name}`);
  }
  const providers = await client.callTool({ name: 'chat_providers', arguments: {} });
  assert.deepEqual(JSON.parse(providers.content[0].text).providers.map((p) => p.id), ['chatgpt', 'gemini']);
  assert.ok(tools.tools.some((tool) => tool.name === 'chat_doctor'));
  for (const name of ['chat_compare', 'chat_compare_result']) assert.ok(tools.tools.some((tool) => tool.name === name));
  assert.equal(tools.tools.length, unified ? 17 : 63);
  assert.ok(tools.tools.some(t => t.name === 'chat_retry'));
  assert.equal(tools.tools.find(t => t.name === 'chat_select_model').inputSchema.properties.extended_thinking.type, 'boolean');
  const wrongProvider = await client.callTool({ name: 'chat_select_model', arguments: { provider: 'chatgpt', model: 'unused', extended_thinking: true } });
  assert.equal(wrongProvider.isError, true);
  assert.equal(JSON.parse(wrongProvider.content[0].text).code, 'INVALID_ARGUMENT');
  const doctor = await client.callTool({ name: 'chat_doctor', arguments: {} });
  assert.ok(!doctor.isError);
  assert.equal(JSON.parse(doctor.content[0].text).scope, 'local_only');
  if (!unified) {
  for (const name of ['chatgpt_upload_files', 'chatgpt_send_message', 'chatgpt_route_new_chat']) {
    assert.equal(tools.tools.find(tool => tool.name === name).inputSchema.properties.files.maxItems, 10);
    const rejected = await client.callTool({ name, arguments: { prompt: 'unused', files: Array.from({ length: 11 }, (_, i) => `C:/unused/file-${i}.txt`) } });
    assert.equal(rejected.isError, true, `${name} must reject eleven files`);
    assert.match(rejected.content[0].text, /10/);
  }
  for (const name of ["chatgpt_send_message", "chatgpt_status", "gemini_send_message", "gemini_get_latest_response", "gemini_status", "gemini_circuit_breaker_status"]) {
    assert.ok(tools.tools.some((tool) => tool.name === name), `Missing tool: ${name}`);
  }
  const localStatus = await client.callTool({ name: "gemini_circuit_breaker_status", arguments: {} });
  assert.ok(!localStatus.isError, "Gemini local state tool must work without opening a browser");
  }
  if (process.argv.includes("--status")) {
    const status = await client.callTool({ name: unified ? "chat_status" : "chatgpt_status", arguments: unified ? {provider:"chatgpt"} : {} });
    console.log(JSON.stringify(status, null, 2));
  }
} finally {
  await client.close();
}
