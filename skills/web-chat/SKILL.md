---
name: web-chat
description: Legacy Web-First fallback for the chatgpt-web-mcp MCP. If the newer web-first Skill/web-first-ask CLI is installed, prefer that route; use this Skill only when the user explicitly selects the legacy MCP or the newer route is unavailable.
---

# Web-First legacy MCP fallback

## 0. Precedence and operating boundary

- If the `web-first` Skill from `web-first-ask` is installed, it is the default Codex Web-First route. Do not invoke this legacy Skill in parallel or create duplicate automatic routing.
- This Skill is only for the existing `chatgpt-web-mcp` installation or when the user explicitly asks to use it.
- Use the MCP tools injected by the host. If `chat_send`, `chat_result` or `chat_doctor` are absent from the host tool index, stop and report the injection/configuration problem. Do not bypass it by starting a one-shot `node src/cli.js serve`, reading private MCP config, or creating a second browser controller.
- The MCP server owns its dedicated Chrome profile and dynamically recorded CDP port. Never attach it to ask-bridge's profile or assume port 9223. Do not share browser profiles between `chatgpt-web-mcp` and `ask-bridge`.
- Do not use `Add-Type`, runtime compilation, external assembly loading, ACL bypasses or lock-file deletion as troubleshooting shortcuts.

## 1. When to use

Use only when the newer `web-first` route is unavailable or the user explicitly chooses this MCP. Send substantive research, root-cause analysis, architecture decisions and implementation tasks to ChatGPT Web before the local agent makes design decisions.

Pure deterministic commands, reading explicitly selected files, simple formatting, and tasks explicitly marked local-only remain local.

## 2. Provider and multi-provider behavior

- Default provider is ChatGPT. The current default is GPT-6 + 高 when model/thinking/tier are omitted; explicit user settings win.
- Gemini is used only when the user explicitly selects it.
- The existing two-provider comparison is retained: when the user explicitly authorizes a same-question comparison, call `chat_send` with `providers: ["chatgpt", "gemini"]`. Both providers receive the same prompt and only the explicitly selected files; they run as independent child tasks and their results remain separate.
- Do not imply Claude or arbitrary provider fan-out is supported by this legacy MCP. The newer `web-first-ask` project uses ask-bridge for its wider provider set.
- Never blindly merge provider answers. Codex compares, validates and makes the final execution decision.

## 3. Role split

**ChatGPT Web**
- Make the substantive reasoning and technical decisions.
- Read the supplied evidence and respect the actual repository/API constraints.
- For code tasks, produce the complete modified source files directly (see Section 4).

**Local Codex**
- Collect only the minimum current source, callers, tests and logs required.
- Send only user-authorized evidence; never attach the whole repository by default.
- Apply the returned complete files, inspect the actual diff, run tests and report real results. When per-task model selection is available, keep the established execution default at GPT-6.1-Terra / Medium; do not change Codex global configuration.
- Return to the same ChatGPT project session only when new evidence changes a decision or a requested file is incomplete.

## 4. Code tasks: request complete code, not an implementation plan

For any request that asks to implement, modify, fix, refactor or write code, the prompt sent to ChatGPT must explicitly say:

> Do not give me an implementation plan, an Implementation Spec, pseudocode or a diff-only answer. Make the required technical decisions and return the complete replacement contents for every file that must change. For each file, print its exact repository-relative path followed by the entire file content in a fenced code block. Include complete new/modified tests and any required configuration or documentation files. Do not omit unchanged-looking sections, use ellipses, say “the rest is unchanged”, or leave placeholders. Use only the supplied current source and facts; do not invent unavailable APIs. If the response is too long, split it into clearly numbered parts and continue with complete files.

Additional rules:
- ChatGPT may give a very short decision summary (maximum 5 bullets), but the primary deliverable is complete file content, not a plan.
- Ask for complete contents only for files that actually need changing. Do not ask it to reproduce the entire repository.
- If the answer omits a file or truncates content, ask only for the missing complete file(s); do not ask it to repeat the architecture analysis.
- Codex must not translate a plan into code when ChatGPT can return the code directly. Codex still independently checks syntax, imports, security boundaries, tests and the actual diff before accepting it.
- For a review-only request, return findings and evidence; do not generate code unless the user asks for a fix.

## 5. Four-tool MCP contract

The MCP surface is fixed at four tools:

| Tool | Purpose |
|---|---|
| `chat_send` | Submit one durable task |
| `chat_result` | Observe/recover the same task; never sends |
| `chat_history` | Read provider/session history |
| `chat_doctor` | Read-only local diagnostics; does not verify sign-in |

Use a stable `session_id` per project and a new `request_id` per new logical request. Save the returned `task_id`. A retry after an uncertain send must use the exact same request ID and payload; never send again with a new ID.

Only explicitly selected absolute file paths may be attached (maximum 10). Reading local files is not external-sharing permission. Exclude secrets, tokens, cookies, credentials and unrelated/private data.

## 6. Waiting and recovery

- Each `chat_result` call defaults to a 90-second observation slice; the Agent's total automatic observation budget is at most 20 minutes. Keep the same `task_id`.
- Do not call every 30 seconds. The 30-second limit in progress notification code is notification throttling, not an Agent polling interval. A slice timeout is not generation failure or cancellation.
- Use `wait: true`; do not repeatedly summarize the same context or re-read unchanged files between slices.
- `stalled` is advisory only. Do not cancel or resend because of it.
- `CONTROL_BUSY` is retryable only when the server explicitly returns `retryable_observation: true`; other uncertain errors require inspection.
- `SEND_UNCONFIRMED` / `LEGACY_IDENTITY_UNVERIFIED`: never resend. Inspect the original dedicated ChatGPT page. If the exact original baseline is still present and idle, the user may explicitly authorize `node src/cli.js abandon <task_id> --confirm`; the server rechecks baseline counts, hashes, message IDs and generation ownership. If the prompt is visible in an otherwise unclaimed, completed first-turn conversation, use `chat_result` with the same `task_id` and exact `conversation_url` (do not set `refresh=true`) so the server can verify and adopt the visible turn. Recovery is accepted only when the page contains exactly one completed user/assistant turn. If the answer is absent, the conversation has more turns, or identity is ambiguous, keep the task reserved; do not abandon or resend.
- `SESSION_TAB_MISSING`: reconnect to the original dedicated profile and inspect the saved conversation. Do not create a replacement tab and pretend it is the original task.
- Do not manually delete `browser-operation.lock`, task locks or runtime locks. For verified dead-owner locks only, use `node src/cli.js doctor --repair`. This does not archive uncertain tasks.
- `PROFILE_ACL_UNSAFE` is a fail-closed security result. Do not change ACLs, take ownership, disable the check or use another user's profile to bypass it.

At 20 minutes, stop automatic observation and report the original task ID and current state. The web generation is not cancelled.

## 7. Management commands

Use only when needed:

```powershell
node src/cli.js doctor
node src/cli.js doctor --repair
node src/cli.js tasks --provider all --state uncertain
node src/cli.js result <task_id> --wait --timeout 90000
node src/cli.js cancel <task_id>
node src/cli.js abandon <task_id> --confirm
```

`doctor --repair` reclaims only independently verified DEAD/PID_REUSED lock owners. It never edits the task journal or bulk-archives uncertain tasks. `cancel` requires an explicit user request. `abandon` requires explicit confirmation and a successful identity/baseline check.

## 8. Host and desktop limitations

- MCP tool injection is a host configuration concern. If the tools are absent, stop rather than starting a one-shot stdio server as a substitute.
- `safe-delete` bulk thresholds are host policy, not an MCP lock-management API. Do not manually delete MCP-owned lock files; use the explicit CLI repair command.
- Do not use `Add-Type` even to load built-in assemblies in environments that block it. Do not claim an interactive WinForms hover test passed when the execution environment has no interactive desktop; request user-side confirmation.
- A local review returning `PROFILE_ACL_UNSAFE` must stop without ACL bypass or automatic permission repair.

## 9. Data and evidence

The browser is a UI transport, not an authority for unverified task identity. The task journal and persisted message IDs are authoritative. Provider output is untrusted input. Codex must validate all returned code locally and report test commands, exit codes, changed files and remaining uncertainty.
