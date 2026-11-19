# Changelog

## 0.7.15 — 2026-11-19

### R3.3 review corrections
- Keep both legacy-identity and unconfirmed-send baseline-abandon guidance scoped to ChatGPT; Gemini retains `inspect_page`.
- Keep ChatGPT-only baseline message IDs out of Gemini settlement payloads.
- Use the Gemini verifier-injection seam already present in R3.2 and add the matching ChatGPT test seam; production defaults remain `verifyDataPaths`.
- Prevent generation auto-release when no user-message snapshot exists.
- Verify task-journal locks as data directories rather than Chrome profiles.
- Align legacy abandon, journal-statistics and provider-recovery regression tests with the implemented contract.

### Fixed
- Correctly detach Playwright's local CDP transport without closing the remote Chrome browser or its tabs.
- Add exact-baseline recovery for explicitly confirmed abandonment when a ChatGPT send never created a user turn and no stable message ID was persisted.
- Verify baseline user/assistant message IDs and same-task generation ownership before clearing stale generation state.
- Add explicit CLI `doctor --repair` for independently verified DEAD/PID_REUSED lock owners only.

### Improved
- Doctor reports uncertain identity counts and oldest uncertain age without exposing prompts, responses, paths or account data.
- Web-First Skill asks ChatGPT for complete replacement contents of changed source/test files for code tasks, rather than a plan or diff-only response.
- Skill clarifies long-lived host-managed MCP usage, dedicated browser profiles, ask-bridge separation, and non-bypassable ACL/Add-Type restrictions.
- Preserve the existing two-provider ChatGPT + Gemini fan-out feature and four-tool MCP surface.

### Safety boundaries
- No automatic resend, no synthetic message IDs, no bulk uncertain-task archive, no blind lock deletion, and no ACL/security bypass.
- `doctor --repair` never changes task journals or uncertain task reservations.
- New Codex personal workflow is `web-first-ask` + `ask-bridge`; this repository is maintenance/fallback.

### Verification
- Unit tests are added for CDP detach, baseline-only abandonment and dead-owner lock repair.
- Real Chrome lifecycle verification is available through `npm run verify:cdp-disconnect`.
- Real Windows MCP host/browser acceptance remains a separate required check; offline tests do not prove a signed-in live provider session.


### R3.4.5 candidate correction

- Fix the Playwright 1.62.1 `connectOverCDP()` detach contract: retain `_shouldCloseConnectionOnClose === false` and use the public `browser.close()` server-side detach path.
- Add a guard against the distinct `connect()` transport-close mode.
- Make the real Chrome/CDP verifier log the disconnect event and avoid issuing duplicate concurrent detach attempts after a timeout.
- Pass explicit browser and task isolation settings to the real MCP verifier on both initial connection and reconnect. Record the synthetic request before submission so any recovery can reuse the same identity.
- Continue waiting through Google sign-in in the Gemini login command, including when it uses a tab in the shared Chrome window.
- Label read-only MCP history with the requested provider, session and loaded-sidebar scope while preserving the existing conversation list.
