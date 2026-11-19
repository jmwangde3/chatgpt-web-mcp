# Web-First 四工具接口与持久化任务

本项目的 MCP 公共接口固定为四个工具，不提供 `full/unified` 双模式，也不保留旧的 provider-specific MCP 工具集：

| 工具 | 作用 | 默认行为 |
|---|---|---|
| `chat_send` | 提交一次 ChatGPT/Gemini 网页任务 | Provider 默认 `chatgpt`；ChatGPT 默认 GPT-6 + 高 |
| `chat_result` | 读取/恢复持久化任务 | `wait=true`、`timeoutMs=90000` |
| `chat_history` | 读取 provider/session 历史 | 只读；不新建或切换会话 |
| `chat_doctor` | 本机诊断 | 不打开浏览器、不验证网页登录 |

CLI 保留 provider、doctor、tasks、result、cancel、abandon、login、setup、upgrade、rollback、panel 和 report 等管理能力。删除的是 MCP 工具暴露面，不是浏览器、任务核心或 CLI 内部能力。没有 MCP 对应项的管理操作必须使用 CLI。

## Quick start

```json
{
  "session_id": "project_chatgpt_web_mcp",
  "request_id": "new-uuid-for-this-logical-request",
  "prompt": "Analyze this problem and return a concrete implementation specification..."
}
```

`provider` 省略时默认 ChatGPT。只有用户明确要求 Gemini 时传 `"provider":"gemini"`。同一项目复用稳定 `session_id`；每个新逻辑请求使用新 `request_id`。返回的 `task_id` 是唯一恢复入口。

## Durable send and idempotency

- 任务在任何可能发送之前持久化；相同 `request_id` 和相同 payload 重放会返回原任务，不会再次发送。
- 相同 `request_id` 配不同 prompt、provider、session、模型、思考强度或附件路径会触发 `IDEMPOTENCY_CONFLICT`。
- 附件只接受用户明确选定的绝对路径，最多 10 个；路径内容不作为重放时的重新上传依据。
- 提交响应丢失时，只能用原 `request_id` 和完全相同 payload 恢复；不得创建新 ID 猜测性重发。
- `task_id` 绑定 provider、原会话和发送身份。任务不确定时保留 reservation，不能通过换会话或新 ID 绕过。

## Bounded waiting and progress

Agent 自动观察预算为每个逻辑任务最多 20 分钟。每次 MCP `chat_result` 默认等待 90 秒，最后一段按剩余总预算缩短（接口最小 1 秒）；结束后由 Skill 在总预算内继续读取相同 `task_id`。该 20 分钟是 Agent 侧自动等待上限，不是网页生成超时。

任务视图提供 advisory `progress`：

- `phase`：`thinking`、`streaming`、`stalled`、`waiting`、`waiting_for_ack` 或终态；
- `response_chars`：当前可见回复长度，不包含回复正文；
- `last_progress_at` / `no_progress_ms`：最近可见文本变化时间与无进展时长。

`stalled` 默认在 120 秒没有可见文本变化时出现。它不是 task state，不释放任务、不允许再次发送，也不代表页面已失败。进度 hash 只在本地任务日志中用于检测文本变化，`taskView` 不返回该 hash，部分回答正文不会被进度元数据持久化。

当 MCP 客户端提供 progress token 时，`chat_result` 可发出 `notifications/progress`，只包含 phase、elapsed 和 response 字符数，不发送回答正文或虚构百分比。通知按序排队；客户端不支持通知时，普通结果中的 `progress` 仍可用。

服务端在同一次 `chat_result` 观察预算内采用 2s → 4s → 8s → 10s 的退避间隔；检测到可见文本变化时重置为 2s。调用者原始 `timeoutMs` deadline 不因退避或重试延长。

## CONTROL_BUSY and recovery boundary

只有 `read()` 已确认 `CONTROL_BUSY` 发生在 settle/cancel 边界之前，才给错误添加 `retryable_observation:true`。`chat_result(wait=true)` 对这类只读观察错误在同一 deadline 内约每 5 秒重试；不会重发 prompt、改变 request fingerprint 或延长预算。

一旦代码越过用户消息身份确认边界并可能调用 `settle()` 或 `cancel()`，后续 `CONTROL_BUSY` 不标记为可重试观察。若一个 90 秒片段结束时仍返回 `uncertain`、`timed_out:true` 和 `retryable_observation:true`，Agent 可在剩余 20 分钟总预算内再开一个 `chat_result(wait=true)` 片段，继续同一任务的只读观察。Agent 不得盲目重复 settle/cancel；应按 `recovery.action` 检查原页面。`LOGIN_REQUIRED`、`RATE_LIMITED`、`SEND_UNCONFIRMED`、`CONVERSATION_CHANGED` 等其他不确定错误也不自动重试。

## Recovery rules

| 状态 | 处理 |
|---|---|
| `submitted` / `running` | 总 20 分钟预算内读取同一 `task_id` |
| `timed_out:true` | 仅本次观察结束；保留并继续原任务 |
| `progress.phase=stalled` | 继续观察；不取消、不重发 |
| `uncertain + retryable_observation` | 服务端在当前片段内只读重试；若片段超时仍保留标记，可在 20 分钟总预算内开启下一片段，仍读取同一 `task_id` |
| `uncertain + CONTROL_BUSY` without retryable flag | 检查原页面；不要自动重复 settle/cancel |
| `LOGIN_REQUIRED` / `RATE_LIMITED` | 报告实际阻碍；不切换 provider |
| `SEND_UNCONFIRMED` / identity mismatch | 按原任务身份恢复；绝不换 ID 重发 |
| `completed` | 读取完整缓存结果 |

达到 20 分钟仍未完成时，Agent 停止自动观察并报告 `task_id`、`session_id`、state 和 progress。任务不取消、不清理、不标记失败；用户要求继续时再从原 `task_id` 恢复。用户要求停止等待只停止 Agent 等待。只有用户明确要求取消，才执行 `node src/cli.js cancel <task_id>`。

## CLI management

```powershell
node src/cli.js providers
node src/cli.js doctor --provider all
node src/cli.js tasks --provider all --state uncertain
node src/cli.js result <task_id> --wait --timeout 90000
node src/cli.js cancel <task_id>
node src/cli.js abandon <task_id> --confirm
```

`abandon` 只在用户检查原页面空闲并明确授权后使用；它仅释放本地跟踪，不撤销网页发送，也不宣称任务完成。

## Architecture and boundaries

- `src/index.js`：只注册四个 MCP 工具。
- `src/core/tools.js`：四工具 Schema、默认参数与 progress 通知。
- `src/core/tasks.js`：持久化、幂等、会话绑定、身份核验、等待与恢复。
- `src/core/progress.js`：进度阶段与轮询退避计算。
- `src/providers/adapters.js`、`src/browser.js`、`src/gemini/`：保留各 provider 浏览器适配。

没有自动 Provider fallback、账号切换或模型名映射。历史结果按 provider 返回的 scope/completeness 理解；未加载的历史不能声称完整。MCP 工具数量收敛不改变现有浏览器实现、登录目录、任务日志格式或 request fingerprint。

## Verification

```bash
npm test
npm run smoke
npm run verify:package
npm run test:browser
```

Smoke 必须通过真实 MCP `tools/list` 确认恰好四个工具，并核对 `chat_send.provider=chatgpt`、`chat_result.wait=true`、`chat_result.timeoutMs=90000` 默认值。Live acceptance 是可选的，运行 `node scripts/verify-web-first.js --send` 才会创建合成对话并发送测试标记；不加 `--send` 只检查四工具接口。
## 显式多平台同题对比

用 `chat_send` 传入 `providers: ["chatgpt", "gemini"]`、`request_id` 和 `prompt`。不要同时传 `provider`、模型、思考强度、回答档位、网页搜索或已有草稿设置。只有显式选择的两个平台收到相同内容和明确列出的附件；默认仍只发给 ChatGPT。

发送返回 `fanout:` 父任务 ID 和两个独立子任务。对父 ID 调用 `chat_result` 并行读取，各子项可部分失败，单次共用同一观察预算。父任务读取永不发送；`queued` 子项只在用完全相同的原请求与 ID 调用 `chat_send` 时补齐。已有子项不会重发。取消、刷新或指定会话 URL 时使用子任务 ID。

Gemini 在预检发现发送保护未安装时，只会在确认编辑器为空且没有附件、上传或挂起生成后刷新原标签一次。发现未知页面、已有草稿或刷新后身份变化时停止，不重发。


## 2026-11-19 recovery hardening

- A Playwright CDP disconnect now detaches only the local control transport; it must not close the remote Chrome browser. The browser/profile remains the MCP-owned dedicated instance across MCP process reconnects.
- `LEGACY_IDENTITY_UNVERIFIED` means a stable per-message ID was not persisted. Do not invent an identity or resend. Explicit `abandon --confirm` can release only when the original URL, baseline counts/hash/IDs and idle state are reverified. If a same-task generation owner record remains, it is cleared only when that owner is confirmed exited and the page remains at the exact baseline.
- `doctor --repair` reclaims only DEAD/PID_REUSED lock owners. It never edits the task journal, releases uncertain tasks or archives history. LIVE/UNKNOWN locks remain untouched.
- The MCP progress notification's 30-second rate limiter is not an Agent polling interval. The Skill keeps the 90-second slice pending real host transport measurements. For new personal Codex long-wait work, prefer `web-first-ask` + ask-bridge CLI.
- The existing two-provider ChatGPT + Gemini fan-out remains unchanged.
