# Independent browser sessions

`chat_send` supports multiple independent sessions on the same provider. Give each independent conversation a stable `session_id`; ChatGPT and Gemini reuse their existing signed-in browser, while each named session owns a separate tab.

```json
{
  "session_id": "project_research_a",
  "request_id": "research-a-001",
  "prompt": "Review the first research question..."
}
```

Provider defaults to ChatGPT. Select Gemini explicitly with `"provider":"gemini"`. A new named session is initialized on first `chat_send`; there is no `chat_new` MCP tool. Submit another request with a different `session_id` and a different request ID for independent work. Each send returns its own `task_id`; use `chat_result` to wait for and recover that task.

For a follow-up, wait until that session's task completes, then send a new `request_id` with the same `session_id`. Do not reuse a request ID with changed content, session, model, tier, search settings or attachment paths. Request IDs remain scoped by provider, not just by session.

## Isolation and limits

- Tabs are pinned by Chrome target ID, not active-tab order, page title or URL. Redirects and provisional conversation URLs do not change tab ownership.
- A new session is created on first use. ChatGPT submission waits briefly for its permanent address; reads and follow-ups restore the saved conversation when another tab's selection changed. Prompt identity is checked before accepting an answer or cancelling.
- MCP process reconnects retain the binding and duplicate-send protection. A closed tab or restarted browser fails closed with `SESSION_TAB_MISSING`; no replacement tab is silently created and no prompt is resent.
- Browser operations are serialized; server-side answers can generate concurrently. Account-level send spacing, recovery cooldowns and rate-limit circuit breakers remain shared. Parallel sessions do not bypass site limits.
- A rate limit blocks all sessions on that provider. Never retry using another session or account to evade it.
- Cancellation is available through `node src/cli.js cancel <task_id>` and verifies the bound conversation and last user prompt. It is not an MCP tool.
- History is read with `chat_history({provider, session_id})`; returned scope/completeness must be preserved. Do not claim unloaded history is complete.

## Recovery and verification

Use the original `task_id` for all reads and recovery. A timeout is an observation boundary, not task failure. Keep the same `session_id` and request fingerprint; do not send a new prompt to compensate for uncertain delivery. The Agent's automatic wait budget is 20 minutes across 90-second `chat_result` calls; reaching it stops waiting only.

Run `npm test`, `npm run smoke` and `npm run test:browser` for regression checks. Smoke verifies the four-tool MCP surface and default schema values. Live acceptance is opt-in through `node scripts/verify-web-first.js --send`.
