# ChatGPT & Gemini Web MCP

## Code review skills

`gh-review` is the ChatGPT Web review entry point (auto/github/local); `local-review` handles explicitly requested local evidence or delegated fallback. Both use the existing `web-chat` skill and MCP. Installation does not switch the host model, register another server, or authorize sharing code. See [REVIEW_SKILLS.md](docs/REVIEW_SKILLS.md) for paired installation, updates, removal and npm package files.

## Current send defaults

For ChatGPT, `chat_send` selects and verifies GPT-6 + 高 when model, thinking level and answer tier are omitted. Explicit settings take precedence; failed verification stops the send. Gemini is used only when explicitly requested. This repository uses Web-First collaboration: ChatGPT Web handles substantive reasoning and design first; local agents gather minimum evidence, execute the resulting specification and test it. The preferred settings are web GPT-6 High and Codex 6.1 Terra medium. MCP does not switch the host model or authorize uploading a whole workspace or secrets.

## Browser stability fixes (0.7.11)

Both providers now use bounded loopback probes, CDP attachment and controller cleanup. A timeout preserves the dedicated browser, draft and pending task. A live but unreachable browser never triggers a duplicate launch against its profile. `chat_result.timeoutMs` also covers journal-lock contention and observation, with up to approximately five additional seconds for controller cleanup. Continue reading the same task after a timeout; nothing is automatically resent. Persistent `CONTROL_BUSY` means cleanup is unconfirmed: reconnect MCP and read the original task.

ChatGPT tier detection waits for hydration and verifies English/Chinese labels near the composer instead of choosing a global pill by CSS class. Lifecycle metadata is recorded in `browser-diagnostics.jsonl` beside each provider's `browser-state.json`, rotating after 512 KiB into one `.1` file. It contains connection timing, controller disconnects, page crashes and managed process exits, never URLs, conversation identifiers, page content or raw errors. An expected controller disconnect is normal and does not mean Chrome exited; a process exit alone does not prove a native crash.

With unfinished tasks, upgrade using `node src/cli.js upgrade --preserve-tasks`, then reconnect MCP. Journals and signed-in profiles are retained. Offline browser regressions verify the fixes; the reported historical window disappearance has not been reproduced or attributed to a native crash.


## Browser compatibility fixes (0.7.2)

ChatGPT now recognizes the current Send button and verifies the appended prompt before reporting success, without an Enter fallback. Gemini surfaces its additional service-error message as `PAGE_ERROR`. To repair an older installation that cannot read newer task journals, run `node src/cli.js upgrade --preserve-tasks` from a current checkout; the candidate must validate existing journals before activation. See [upgrade compatibility](docs/COMPARISONS_AND_INSTALL.md#upgrade-and-rollback).

## MCP + Web-First skill

This repository includes the MCP server and the existing [web-chat Web-First skill](skills/web-chat/SKILL.md). For tasks requiring understanding, research, analysis, architecture, design, technical choices, root-cause analysis or implementation planning, ChatGPT Web is the default decision layer. Local agents gather minimum necessary facts, execute its file-by-file Implementation Spec and verify the result. Users do not need to name the skill on every substantive task.

The skill enables implicit invocation through `agents/openai.yaml`. Deterministic local commands/tests and explicit local-only requests remain local. Do not install a second Architect skill.

## Four-tool MCP interface

The MCP server intentionally exposes exactly four tools: `chat_send`, `chat_result`, `chat_history` and `chat_doctor`. The default provider is ChatGPT GPT-6 + 高; choose Gemini only when explicitly requested. Reuse a stable `session_id` per project, create a new `request_id` for each new logical request, and recover only with the original `task_id`.

Task listing, cancellation, abandonment, login and installation maintenance use the CLI. There is no `full/unified` toolset switch and no legacy provider-specific MCP compatibility mode. See [Web-First task and recovery details](docs/WEB_FIRST_TASKS.md).

## Existing ChatGPT features

[中文说明](README.md)

An unofficial local MCP server that lets Codex and other MCP clients operate `chatgpt.com` through a dedicated persistent browser profile. It does not use OpenAI's official paid API or require an API key. Messages are sent through the UI; history reads may use the current web session's internal endpoint. It does not read a user's regular browser profile or place login credentials in MCP configuration.

> [!IMPORTANT]
> This project is not affiliated with or endorsed by OpenAI. It depends on the ChatGPT web UI, which may change without notice. Account permissions, region, and workspace policy may also affect behavior. Do not use this project to bypass access controls, usage limits, or safety systems.

## Features

- Use stable named sessions and read provider/session history
- Submit prompts, attach explicitly selected files, and read complete responses
- Default ChatGPT sends to GPT-6 + 高; explicit model settings take precedence
- Keep the dedicated browser and ChatGPT page open between MCP calls
- Serialize browser control across MCP processes and apply conservative delays
- Gate new actions on rate-limit text or conversation-generation POST HTTP 429; background/history 429 is diagnostic-only, with no endpoint retry; completed answers remain readable
- Default ChatGPT sends to GPT-6 + 高 with temporary Pro identity probes disabled, avoiding extra temporary chats and test messages
- Rotate conversations before the 40-turn cap, loading older lazy history and archiving the complete transcript first; direct submit calls are rejected at the cap
- Store only sanitized network error metadata

## Requirements

- Node.js 20+
- Google Chrome, Chromium, or Microsoft Edge
- A local stdio MCP client such as Codex
- A ChatGPT account that can be logged in manually

Common browser locations are detected on macOS, Windows, and Linux. Set `CHATGPT_WEB_CHROME` when auto-detection does not find your browser.

## Install

```bash
git clone https://github.com/Tw6249/chatgpt-web-mcp.git
cd chatgpt-web-mcp
npm ci
npm run doctor
npm link
```

Log in through the dedicated browser:

```bash
chatgpt-web-mcp login
```

The browser profile is stored in `~/.chatgpt-web-mcp/chrome-profile` by default. Never commit or share that directory.

Add the server to Codex:

```bash
codex mcp add chatgpt-web -- chatgpt-web-mcp serve
codex mcp get chatgpt-web
```

If the Codex process cannot resolve the linked command, use an absolute project path:

```bash
codex mcp add chatgpt-web -- node /absolute/path/to/chatgpt-web-mcp/src/index.js
```

See the [official OpenAI MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) for Codex MCP configuration concepts.

### MCP JSON configuration (Windows)

No toolset environment variable is required. The server always exposes exactly four MCP tools. Reconnect the MCP client after saving:

```json
{
  "mcpServers": {
    "web-chat": {
      "command": "C:\\path\\to\\node.exe",
      "args": ["C:\\path\\to\\chatgpt-web-mcp\\src\\index.js"]
    }
  }
}
```

## Four MCP tools

| Tool | Purpose |
| --- | --- |
| `chat_send` | Submit a task to ChatGPT by default; select Gemini only when explicitly requested |
| `chat_result` | Wait for, read and resume the original task; 90-second observation slice by default |
| `chat_history` | Read provider/session history |
| `chat_doctor` | Local runtime diagnostics; does not verify website sign-in |

`chat_send` defaults to ChatGPT GPT-6 + 高. Reuse one stable `session_id` per project and a new `request_id` for each new logical request. Recovery always uses the original `task_id`. `chat_result` defaults to `wait=true` and `timeoutMs=90000`. Agents automatically observe a logical task for at most 20 minutes; reaching that budget only stops waiting—it does not cancel, release or resend the task.

Task listing, cancellation, abandonment, login, diagnostics and installation maintenance use the CLI. Model discovery/selection, explicit archive and multi-model comparison are not exposed through MCP:

```powershell
node src/cli.js doctor
node src/cli.js tasks --provider all --state uncertain
node src/cli.js result <task_id> --wait --timeout 90000
node src/cli.js cancel <task_id>
node src/cli.js abandon <task_id> --confirm
```

## Default routing policy

For ordinary ChatGPT `chat_send`, GPT-6 + 高 is selected and verified when model, thinking level and answer tier are all omitted. Explicit settings take precedence; a failed verification stops the send. Gemini is used only when explicitly requested. Temporary Pro identity probes remain disabled by default. A model's self-description or network label is not independent proof of the serving model.

## Other environment variables

- `CHATGPT_WEB_CHROME`: absolute browser executable path
- `CHATGPT_WEB_PROFILE`: dedicated browser profile directory
- `CHATGPT_WEB_HEADLESS`: headless mode, default `false`
- `CHATGPT_WEB_ACTION_TIMEOUT_MS`: single page-action timeout
- `CHATGPT_WEB_RESPONSE_TIMEOUT_MS`: browser generation timeout; separate from the Agent's 20-minute automatic observation budget
- `CHATGPT_WEB_RECONNECT_DELAY_MS`: browser reconnect interval
- `CHATGPT_WEB_AUTH_CACHE_MS`: local sign-in cache duration
- `CHATGPT_WEB_PRO_RECHECK_AFTER_CLOSE_MS`: probe recheck delay after a detected close, default three hours
- `CHATGPT_WEB_BROWSER_STATE`, `CHATGPT_WEB_RUNTIME_STATE`: local state files
- `CHATGPT_WEB_OPERATION_LOCK`: cross-process browser operation lock
- `CHATGPT_WEB_NETWORK_LOG`: sanitized network diagnostics log
- `CHATGPT_WEB_MAX_CONVERSATION_TURNS`: conversation rotation threshold, default `40`
- `CHATGPT_WEB_CONTEXT_ARCHIVE_DIR`: Markdown archive directory for conversation rotation

## Optional refresh before a new chat

`CHATGPT_WEB_REFRESH_BEFORE_NEW_CHAT=false` by default. Set it to `true` and restart the MCP server to check drafts/attachments, reload the current page, then open a new chat through the UI. A failed reload or rate limit stops the operation without retrying.

This is separate from the existing refresh before sending. Enabling both usually means two reloads for a new-chat send, increasing requests and latency. This option is for stale-page troubleshooting, **not rate-limit prevention**. Small successful trials do not establish that another reload reduces rate limits. The browser and its page still remain open.

## Rate-limit policy and five-second defaults

- Page interactions: at least 1 second apart
- High-level site actions: at least 5 seconds apart
- Message sends: at least 5 seconds apart (`CHATGPT_WEB_SEND_INTERVAL_MS=5000`)
- Conversation changes: at least 5 seconds apart (`CHATGPT_WEB_CONVERSATION_CHANGE_INTERVAL_MS=5000`)
- Conversation changes after a completed answer: at least 5 seconds (`CHATGPT_WEB_POST_RESPONSE_CONVERSATION_COOLDOWN_MS=5000`)
- After initially opening ChatGPT: 6 seconds (`CHATGPT_WEB_PAGE_STARTUP_DELAY_MS=6000`)
- First site action after clearing a breaker: 5 minutes
- Independent history quiet period after a history rate limit: 5 minutes

**Five seconds is a minimum interval, not an operation duration or a guarantee against rate limits or account restrictions.** Loading, UI interactions, generation, and other waits add to it; messages are not sent concurrently. Existing client environment overrides still win: an explicit `30000` remains 30 seconds after upgrading. Increase the three intervals to `30000` if needed; stop instead of repeatedly retrying when a warning appears.

The five-minute breaker recovery and history quiet period are unchanged. The server does not automatically clear the breaker, dismiss warnings, retry HTTP 429, or close the persistent browser. ChatGPT conversation-generation POST HTTP 429 (including `/backend-api/f/conversation`) trips the global breaker. History reads, background task lists, model lists and other auxiliary 429 responses remain diagnostic-only; they do not establish generation quota exhaustion. An unsuccessful direct history read still uses the page-transcript fallback without retrying that endpoint. Explicit page-visible rate-limit warnings still gate new actions. `chat_result` can read a completed answer on the original page while a breaker remains active, including a legacy false positive; it still verifies the conversation and exact user turn. A rate-limit notice or still-streaming answer is not accepted as a completed response. Reading never clears the breaker. Missing observed API headers no longer cause another conversation page to open just for authentication priming.

The PR's stale-owner cleanup is preserved: when the recorded MCP process has exited, a subsequent operation automatically clears its generation marker. This rule does not clear markers with a live or missing owner PID, clear a rate-limit breaker, or close the browser.

## Privacy and limitations

- Login state, runtime state, and sanitized diagnostics live under `~/.chatgpt-web-mcp` by default.
- Upload tools only accept explicit absolute file paths.
- Diagnostics omit query strings, cookies, request and response bodies, and conversation identifiers.
- Response waiting uses in-page mutation events rather than page polling.
- Failed in-page navigation stops instead of repeatedly reloading ChatGPT.
- The ChatGPT web UI is not a stable API and selectors may require maintenance.
- Before automatic conversation rotation, the complete transcript (including older lazy-loaded messages) is written as a `0600` Markdown archive.
- Neither a model's self-description nor its network label independently proves the serving model; a non-mini label is not a Pro guarantee.

## Development

```bash
npm ci
npm test
npm run smoke
npm pack --dry-run
```

CI performs offline unit tests and package checks only. It never logs in to ChatGPT or sends live requests. See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
