> **Historical validation record:** the sections below preserve earlier Gemini UI findings and test results. Those historical runs used provider-specific MCP tools, which the current Web-First patch removes. Current Gemini live acceptance uses only `chat_send` and `chat_result` through `scripts/verify-gemini.js`; model listing/selection and provider-specific MCP tools are no longer exposed. Historical tool counts and old direct-tool instructions below do not describe the current interface.

## Current four-tool acceptance

No prompt is sent by default. Run local diagnostics only:

```powershell
node scripts/verify-gemini.js
```

Explicitly test a synthetic Gemini prompt and a same-session follow-up:

```powershell
node scripts/verify-gemini.js --send
```

Explicitly test a temporary synthetic attachment:

```powershell
node scripts/verify-gemini.js --upload
```

The script verifies the exact four-tool MCP surface, uses a new `request_id` per logical prompt, preserves the same `session_id` for follow-up context, and resumes only the original `task_id`. It observes for at most 20 minutes and never resends an uncertain task. If upload acceptance does not complete, the temporary file is preserved for manual recovery.

---

# Gemini validation

## Thinking-level menu compatibility — 2026-10-10

The dedicated live Gemini menu now exposes Low, Medium, and High beneath the model choices, replacing the previous Extended thinking toggle. The old lookup incorrectly reported THINKING_UNAVAILABLE while 3.8 Flash was selected at Low.

The existing extended_thinking boolean remains compatible: true requests High on this menu, and false requests Low. Legacy binary toggles still work. The adapter distinguishes settings from model rows, scopes them to the visible model menu, and reopens the menu after a change to verify selection. Missing, disabled, ambiguous, or ineffective High controls fail closed without choosing a lower setting. Results expose the observed thinkingLevel.

Live verification through a fresh stdio MCP connection returned selectedModel 3.8 Flash, selectionVerified true, extendedThinking true, thinkingLevel High, and thinkingVerified true. The already-authorized research consultation was then submitted once; no synthetic prompt or identity probe was sent.

Offline regressions cover High selection and readback, idempotence, Low selection, unrelated High text, missing/disabled High, ineffective clicks, duplicate High rows, and multiple selected levels, alongside legacy tests. Validation passed: 11 targeted offline browser tests and 16 Gemini/observation unit tests. Whitespace checks passed.

## 0.7.6 model-menu state correction — 2026-10-07

The live model picker exposed an Escape-dismissal mismatch: Escape hid the menu, but the next trigger click did not reopen it; a second click did. The old list/select/verify sequence used Escape after each operation, producing either a menu timeout or a misleading THINKING_UNAVAILABLE error even though Extended thinking was visible and enabled when the menu was opened correctly.

Model and thinking operations now reuse an already-open menu, scope options to its visible container, and close it through the model-picker button with a confirmed hidden-state wait. A stale trigger left by an earlier Escape allows one bounded recovery click, respecting the existing operation interval. A picker that still fails to open reports MODEL_MENU_NOT_OPEN; this is distinct from a missing or disabled setting in an open menu. No prompt retry, model downgrade, page reload, or task-state reset is involved.

Offline regression fixtures reproduce the Escape-stale trigger, hidden stale options, reconnecting with the picker open, recovery from a previous Escape, and a picker that never opens. Existing tests also cover idempotent thinking selection and missing or ineffective controls.

Validation: all 102 unit tests and 54 offline browser tests passed, along with the 63-tool MCP smoke check, package dry run, and whitespace checks.

Live acceptance used the dedicated Gemini session through a fresh stdio MCP process. Listing models followed by two consecutive selections of 3.8 Flash with Extended thinking enabled returned selectionVerified: true, extendedThinking: true, and thinkingVerified: true both times. No prompt or attachment was sent. This validates menu/settings handling on the observed UI; it does not address the separate provider refusals described below.

## 0.7.4 initialization correction — 2026-10-06

New named tabs previously called newChat() immediately after navigation. If Gemini had not mounted its composer, this reported LOGIN_REQUIRED for a signed-in account; a later reconnect skipped the incomplete initialization. The controller now waits for the composer or explicit sign-in UI, marks initialization only after readiness, and avoids the second navigation. A loading timeout reports PAGE_NOT_READY. Retrying initialization on a bound tab preserves its draft.

Validation: 99 unit tests, 47 offline browser tests, and the 62-tool MCP smoke check passed. Regression coverage includes delayed app mounting, one navigation per new tab, a genuine signed-out page, loading timeout, and preservation of a draft when reconnecting after incomplete initialization.

Live diagnosis used only the synthetic question “模型预测控制是什么？” with 3.8 Flash. Earlier Extended thinking tests returned capability refusals on both first and subsequent turns, although one follow-up succeeded; retrying is therefore not a guaranteed workaround. Two fresh conversations with Extended thinking off returned substantive answers. After the initialization correction, a fresh Extended thinking conversation also returned a substantive first answer. This verifies the concrete initialization defect and a working live path, but does not establish that it caused every provider refusal. A completed transport task is not proof that the response satisfies the question. Do not silently downgrade thinking, send warm-up prompts, or automatically duplicate a refused request.

Additional live checks after the correction: Extended thinking first turns produced one substantive answer and two capability refusals across three fresh sessions. One refusal occurred without reselecting the inherited model, ruling out redundant model selection as a necessary condition. The two thinking-off controls both answered. These are small, single-account diagnostic samples, not reliability estimates. The initialization fix does not resolve the remaining intermittent refusal behavior, and no server-side root cause is established.

## Historical validation — 2026-09-22

Version: 0.3.0. Local environment: Windows, Node.js 24.14.0, installed Google Chrome. Original ChatGPT tools and unrelated local edits were preserved.

## Automated checks

- `npm test`: 50/50 passed, including existing ChatGPT regression tests.
- `npm run test:browser`: 13 offline Chromium integration cases covering the live DOM variants below.
- `npm run smoke`: 46 MCP tools registered, including 17 Gemini tools; local Gemini state retrieval passed over stdio.
- `npm pack --dry-run`: private `scripts/local-*` helpers excluded; Gemini modules included.
- `npm audit --omit=dev`: zero known vulnerabilities with the committed lockfile. Existing patched versions of `fast-uri`, `hono` and `qs` were retained.
- `git diff --cached --check`: passed.

Browser fixtures intercept all requests: they never access a live account or send a real prompt. They cover final answers and multi-line prompts, follow-up context, drafts and attachments, input/file-chooser uploads, model/settings menu separation, selection confirmation, sidebar history, delayed history loading, scoped Markdown archives, timeout recovery without resending, prevention of stale-answer reads, conversation-change detection, authentication, HTTP 429, cancellation, last-minute draft changes and browser reconnect/shutdown.

## Live Gemini acceptance — historical toolset

After the user manually signed in, the following were verified through the real stdio MCP server:

- The former `node scripts/verify-gemini.js --send --upload` flow passed using provider-specific Gemini MCP tools. The current replacement script uses `chat_send` and `chat_result` only.
- Model listing and selection were verified through the former Gemini model tools; those tools are no longer exposed.
- Attachment detection and Markdown archive were verified in the earlier toolset. Current four-tool MCP does not expose a dedicated archive or model-selection tool.
- An earlier slow attachment response exercised timeout recovery: the existing send was resumed and completed without resending.
- Dedicated browser remained open; login data stayed outside the repository.

Real-page differences found and fixed during acceptance:

1. Hidden, truncated screen-reader announcements inside user messages must not enter prompt acknowledgement hashes or archives.
2. Model descriptions and settings are distinct from model names; selected state may use a CSS class.
3. The upload menu can be labelled `Upload & tools`, and file chips can omit extensions while a hidden tooltip retains the full filename.
4. Opening a history URL mounts the composer before messages; selection now waits for the transcript or active-generation UI.
5. While a new response has not appeared, a pending read must not return the previous turn's answer as its content.

## Scope

Historical acceptance covers the account and available English Gemini UI on the dates above. Model availability and UI layout can change. History and archives include only currently loaded messages and explicitly do not claim complete history. No provider limit was bypassed. Linux and Windows CI jobs provide additional automated validation on GitHub.
