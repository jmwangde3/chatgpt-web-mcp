# Managed installation and maintenance

## Current MCP scope

The current MCP server intentionally exposes exactly four tools: `chat_send`, `chat_result`, `chat_history` and `chat_doctor`. The historical multi-model `chat_compare` MCP workflow and provider-specific MCP tools are no longer exposed. This is a deliberate personal-use surface reduction, not a `full/unified` setting. Do not set `CHATGPT_WEB_MCP_TOOLSET`; the variable is removed.

For normal Web-First work, use `chat_send` once and recover through `chat_result`. Provider defaults to ChatGPT. Gemini must be explicitly requested. The MCP does not offer model-discovery, model-selection, compare, cancel, archive or task-list tools; use the documented CLI for supported management actions. No CLI multi-model comparison replacement is claimed.

## One command family for installation and maintenance

Prerequisites: Node.js 20+, npm, Git and Chrome/Edge. From a checkout, run `npm ci`, then:

```sh
node src/cli.js setup
node src/cli.js login --provider all
node src/cli.js doctor
node src/cli.js upgrade
node src/cli.js rollback
node src/cli.js panel
node src/cli.js report --out /ABSOLUTE/PATH/diagnostics.json
```

`web-chat-mcp` and `chatgpt-web-mcp` are equivalent installed executable aliases. `npm run setup`, `npm run upgrade`, `npm run rollback` and `npm run panel` are also available. `login` defaults to both providers; `--provider chatgpt` or `--provider gemini` chooses one. Login recognizes already signed-in browsers and otherwise waits for manual sign-in. Credentials are never passed to the program. Existing active tasks block login page operations.

### Setup and the stable MCP entry point

`setup` installs from the maintained repository. It clones into a private staging directory, runs `npm ci --ignore-scripts`, unit tests and MCP smoke tests, and activates only after they pass. Browser tests are run by project CI, not on every local upgrade. The initial install does not modify an existing source checkout, browser profile or client configuration.

The default install root is `~/.web-chat-mcp/install`; override it with `WEB_CHAT_INSTALL_DIR`. Setup prints an MCP `command`/`args` configuration and writes `mcp-config.json` there. Point your MCP client at that generated `launch.mjs serve` entry point to use managed versions. A client still pointing directly at a source checkout continues to use that checkout, independently of managed upgrade/rollback. Configure this once and restart the MCP connection after version changes.

### Upgrade and rollback

All candidate activations, including rollback, verify that the candidate can read both existing task journals. Rollback to a runtime that cannot read newer session records is refused; journals are never downgraded or deleted to make rollback succeed.

If an older installation reports `INVALID_JOURNAL` after a newer client has created session tasks, preserve the journals and bootstrap the upgrade from a current checkout (`npm ci`, then `node src/cli.js upgrade --preserve-tasks`). This explicit option permits pending/uncertain tasks to remain recorded while upgrading. The candidate must pass tests and a read-only `doctor` check against both existing provider journals; unreadable state, incompatible journals and active operation locks still block activation. It does not send, cancel, abandon or delete tasks, and it is not available for rollback. Restart existing MCP clients after activation so they stop running the old code.

`upgrade` fetches the maintained `main` branch by default. `--ref TAG_OR_FULL_COMMIT` selects another revision from that repository. Release directories are named by full commit IDs; existing ones are not overwritten. Activation uses an atomic manifest update and preserves the previous revision. Tracked modifications in an installed release prevent its activation. Existing tasks/pending sends or damaged local state block a switch. Checks run again immediately before activation, but no currently running MCP process is forcibly stopped.

`rollback` verifies and smoke-tests the previous local release, then switches the manifest. It needs no download and can switch back again. The managed launcher retains a maintenance-capable revision for upgrade/rollback commands, even when the selected MCP runtime predates these commands. Running connections keep their loaded code until restarted. Browser profiles and task journals are not rolled back or deleted; compatibility with very old revisions is not guaranteed.

Failed validation keeps the active manifest unchanged. `doctor`/`report` identify the failing installation stage without publishing raw command output. Private `install-debug.log` contains details for local inspection. Releases and staging directories are retained, including failed candidates; there is no automatic cleanup or removal of rollback data.

## Local status panel and fault reports

`panel --port 0` chooses an available port and prints a local URL; a fixed port is optional. Open the printed URL in your browser. The server binds only to `127.0.0.1`. A random token authorizes the data API; other origins, wrong Host headers and non-GET requests are rejected. The panel is read-only and does not launch provider browsers, send prompts or cancel tasks. Ctrl+C stops it.

The panel shows provider health, managed version and recent tasks. It omits prompts, answers, raw errors and conversation URLs. The download button exports only the redacted diagnostics report, not the task table. Do not share the panel URL token.

`report` prints the same redacted diagnostics as JSON; `--out` saves to a new absolute path and refuses to overwrite existing files. `doctor` reports local executables, runtime flags, lock snapshots, task-journal health and managed-installation state. It does not prove website sign-in or availability.

## CLI task management

```powershell
node src/cli.js providers
node src/cli.js doctor --provider all
node src/cli.js tasks --provider all --state uncertain
node src/cli.js result <task_id> --wait --timeout 90000
node src/cli.js cancel <task_id>
node src/cli.js abandon <task_id> --confirm
```

Task listings contain metadata, not answer text. `result` may return private response content. `cancel` verifies the task identity before stopping it. `abandon` is only for an inspected idle original page and does not undo delivery. No command or tool automatically resends an uncertain task.
