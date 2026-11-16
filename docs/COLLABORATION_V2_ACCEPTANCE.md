# Collaboration V2 acceptance log

Status: IN PROGRESS. This review branch is not a release; package version and metadata are unchanged.

Baseline: main `65c130ef9fb405dd12a13d6a0af9f8b225ece2c9`, Node 22.14.0/npm 10.9.2, clean checkout. Original baseline: unit 152/152, browser 106/106, smoke 63 tools, pack dry-run passed. Worktree dependencies installed with npm ci.

## A1 atomic send

- The guard is installed at document initialization, before application listeners. Before clicking, CDP verifies the first window click-capture listener is this exact guard. Existing uninitialized pages must refresh before preparing a draft; unknown earlier handlers cause a fail-closed refusal. The final synchronous guard checks the pinned nodes, exact raw draft, HTTPS configured origin and full conversation URL, writable composer, same form, visible/enabled send control, and upload indicators before application document listeners handle the trusted click.
- Uses the existing Playwright trusted click; no Enter, alternate selector resend or automatic retry. Ambiguous click/transport errors remain uncertain. Only explicit `SEND_NOT_ATTEMPTED` plus `sendOutcome=not_attempted` releases the reservation.
- Existing message-count, prompt identity and conversation acknowledgement checks remain intact.
- Local validation: original browser suite 106/106; added guard browser cases16/16; added durable outcome tests12/12 for both providers. Unit suite164/164 after A1.

## A2 Windows ownership and profile safety

- Constant PowerShell5.1 query scripts receive JSON through UTF-8 stdin; child timeout/output bounds; no interpolated paths or raw process command lines in diagnostics/state. Child-only system module path avoids PowerShell7 inheritance issues.
- Validates PID, creation time, executable, command-line profile/port/address and TCP listener PID. Legacy identity is enriched only after live verification. Unverifiable ownership prevents connection/termination and preserves saved state.
- Refuses links/reparse points, repository-contained profiles and foreign write ACLs. Initializes only directories just created by this call; does not recursively repair existing profiles. Read-only doctor never creates paths or changes ACLs.
- Local validation: identity/ACL unit32/32; query/legacy/unknown-owner tests7/7; real Windows security fixtures5/5 (junction, non-directory, unsafe ACL unchanged, query failure preservation, Unicode/space paths); session browser7/7; Gemini persistent lifecycle1/1. Unit202/202 before last unknown-owner case was added.
- Design reference (no Python code transplanted): [MCP-CodexGPT platform security](https://github.com/MosMotov/MCP-CodexGPT/blob/6b088fb15f1e9c3728cca2b642ab7b0316674237/platform_security.py).

## A3 CI

Expanded existing offline-browser job to Ubuntu/Windows; retained all existing tests and added guard/security fixtures. Only local synthetic pages and ephemeral profiles are used. GitHub CI results pending first branch push. No local VM or real AI login required.

## Remaining gates

A4 full/unified tools and schema measurements, Skill V2 updates/distribution checks, real GitHub/local two-round review and token comparison are not yet accepted. Cloud CI must be observed rather than inferred from local tests.
## First cloud run and review follow-up

Run [43906307224](https://github.com/jmwangde3/chatgpt-web-mcp/actions/runs/43906307224) at dd5a345: Ubuntu browser PASS; both platform unit/smoke/pack jobs PASS; Windows browser105/106, failed the pre-existing attachment fixture's250ms positive wait under runner load. The fixture's positive readiness budget will be increased while keeping negative assertions.

A review found that a late-installed window capture guard could run after a pre-existing same-target handler. This invalidated the old no-send proof; document-start installation plus runtime CDP listener-order proof replaces that approach. A new run is required. No production deployment has occurred.

Saved Windows process state that cannot be verified (including stale/dead PIDs) deliberately refuses connection and preserves the state/profile for explicit recovery. Live-process CDP disconnect/reconnect is tested. Automatic replacement after a browser crash is not claimed safe or verified.
