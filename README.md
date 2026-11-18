# ChatGPT & Gemini Web MCP

## 代码复审 Skill

`gh-review` 是 ChatGPT Web 代码复审的统一入口（auto/github/local），`local-review` 处理显式本地证据或被委派的回退；两项复用已安装的 `web-chat`，不会自动切换宿主模型、注册第二份 MCP 或取得外发许可。成对安装、更新、卸载及 npm 包取文件见 [REVIEW_SKILLS.md](docs/REVIEW_SKILLS.md)。

## 当前发送默认值

ChatGPT 的 `chat_send` 在未指定模型、思考强度及回答档位时，发送前选择并重新核验 **GPT-6 + 高**；显式设置优先，无法核验时停止发送。Gemini 仅在用户明确指定时使用。已有 MCP 连接须重连以加载更新。

本仓库采用 Web-First：需要分析、研究、设计、技术判断或根因定位的任务默认先交给 ChatGPT Web；本地 Codex/Agents 只收集最少必要事实，再按网页专家给出的逐文件实施规格执行和测试。纯确定性操作及用户明确要求本地执行时可绕过。默认偏好为网页 GPT-6 高、Codex 6.1 Terra medium；MCP 不切换宿主模型，也不授权上传整个工作区或秘密。

## 浏览器稳定性修复（0.7.11）

- ChatGPT 与 Gemini 共用有界的本机端点探测、CDP 连接和断开流程；超时只断开控制器，保留浏览器、草稿及待恢复任务。存活但失联的专用浏览器不会触发同一配置目录的重复启动。
- `chat_result.timeoutMs` 同时约束任务锁排队和结果观察，并允许最多约 5 秒控制连接清理时间。超时后继续读取同一个任务，不自动重发。清理尚未完成时返回 `CONTROL_BUSY`；若持续出现，重连 MCP 后读取原任务。
- ChatGPT 档位控件等待页面挂载，并核验输入框附近的中英文标签；不再凭全局 pill 类名猜测按钮。
- 每个平台的 `browser-state.json` 同目录新增 `browser-diagnostics.jsonl`，记录连接耗时、控制器断连、页面崩溃及托管进程退出。日志超过 512 KiB 后保留一个 `.1` 轮转文件，不记录 URL、会话标识、网页正文或原始错误内容。`controller_disconnected` 且 `expected:true` 表示正常断开控制器，不代表 Chrome 闪退；进程退出本身也不能单独证明原生崩溃。

已有未完成任务时，使用 `node src/cli.js upgrade --preserve-tasks` 更新，完成后重连 MCP。升级不清除任务记录或登录配置。修复已通过离线浏览器回归；历史窗口消失未复现，不能宣称已确认其原生崩溃原因。


通过 MCP 统一连接 ChatGPT 和 Gemini 网页端，支持同题多模型问答、持久化任务、重启恢复与本地状态管理。各平台使用独立的浏览器登录环境，无需配置 API Key。

[English](README.en.md)

## Gemini Argon 网页适配（0.7.10 历史说明）

- 支持新版可折叠的 Thinking level 子菜单，等待选项展开后选择并重新核验 High；保留旧版平铺档位和 Extended thinking 开关支持。
- 0.7.10 的网页专家 Skill 曾默认使用 Gemini **4 Argon + High**，这是历史版本行为。当前默认咨询模型为 ChatGPT **GPT-6 + 高**。Gemini 仍受支持，必须遵从用户明确的平台和模型选择；模型或思考强度无法核验时停止，不自动降级。底层 MCP 仍要求显式 provider。
- 升级 MCP 后重连；已安装的 `skills/web-chat` 需单独更新。此处历史默认值不代表当前设置。

## 网页兼容修复（0.7.2）

- ChatGPT 识别新版“发送”按钮，只有确认新增消息与提示词一致后才报告发送成功；找不到按钮时保留草稿，不使用 Enter 猜测发送。
- Gemini 识别新增的服务错误提示，及时返回 `PAGE_ERROR`，不把错误当作持续生成。
- 旧服务遇到新版任务记录时，可从当前源码运行 `node src/cli.js upgrade --preserve-tasks`。新版先验证现有记录的兼容性，保留任务和防重复发送记录。详见 [升级说明](docs/COMPARISONS_AND_INSTALL.md#upgrade-and-rollback)。

## MCP + Web-First Skill

本仓库同时维护 MCP 服务（`src/`）和 [web-chat Web-First Skill](skills/web-chat/SKILL.md)。涉及理解、分析、研究、设计、技术选型、根因定位和实施规划时，默认先由 ChatGPT Web 负责思考与决策；本地 Agent 收集最少必要事实，再按逐文件 Implementation Spec 修改、测试和反馈。无需用户每次点名调用。

MCP 固定只暴露四个工具：`chat_send`、`chat_result`、`chat_history`、`chat_doctor`。默认 Provider 为 ChatGPT GPT-6 + 高；Gemini 仅在用户明确要求时选择。每个项目复用稳定 `session_id`，每个新逻辑请求使用新 `request_id`，恢复始终使用原 `task_id`。

按照 [Codex 安装与使用指南](docs/CODEX_SKILL.md) 配置现有 `web-chat` MCP 并安装同名 Skill。不要安装第二份 Architect Skill。Skill 使用隐式调用策略；确定性本地操作和用户明确要求仅本地执行时不触发。

## 同平台任务并行（0.7.0）

为不同研究任务传入不同的 `session_id`，即可在同一 ChatGPT 或 Gemini 登录环境中使用独立标签页并行生成回答。每个任务仍有自己的 `task_id`，支持进程重连后恢复读取；一个任务未确认，不会占用其他会话。页面操作和账号限流仍统一协调。

`chat_send` 新增 `session_id`、`model`、`answer_tier` 和 `web_search`；ChatGPT 可直接选择并核验 `answer_tier: "Pro"`。使用方法、旧任务兼容及升级要求见 [并行会话文档](docs/PARALLEL_SESSIONS.md)。更新后请重启所有 MCP 连接。

## 安装与维护

通过 `node src/cli.js setup` 安装受管理版本；使用 `upgrade`、`rollback`、`panel` 和 `report` 管理本地运行。多模型比较 MCP 工具不再暴露；本项目个人使用接口以四个 Web-First 工具为准。详细命令见 [安装与维护文档](docs/COMPARISONS_AND_INSTALL.md)。

## 本地诊断与任务管理

`chat_doctor` 检查本地运行环境，不打开浏览器，也不证明网页登录成功。任务列表、结果管理、取消和显式放弃跟踪通过 CLI：`node src/cli.js tasks`、`result`、`cancel`、`abandon`。

## 持久化任务与恢复

`chat_send` 接收稳定的 `request_id` 并返回持久化 `task_id`；`chat_result` 在 MCP 重启后继续读取。同一请求重放不会重复发送。任务日志、会话身份核验、取消和恢复仍由同一任务核心管理。详见 [Web-First 任务与恢复](docs/WEB_FIRST_TASKS.md)。

## Gemini 网页端支持

Gemini 保留独立的专用浏览器、登录目录、操作锁、限流状态及任务日志。MCP 不再提供独立的 `gemini_*` 工具；用户明确要求 Gemini 时，通过 `chat_send({provider:"gemini", ...})` 使用同一持久化任务接口，后续通过 `chat_result` 恢复。登录和维护仍通过 `node src/cli.js login --provider gemini`、`doctor` 等 CLI 命令完成。

Gemini 不复用 ChatGPT 的模型名称或 Pro 探针。模型选择应使用用户提供或已确认的精确名称；无法核验时停止，不静默降级。历史结果受网页当前加载范围限制，不声称完整。

## 原有 ChatGPT 功能

一个本地、非官方的 MCP Server，让 Codex 等 MCP 客户端通过独立的持久浏览器配置操作 `chatgpt.com`。它不使用 OpenAI 官方付费 API，也不需要 API Key。消息发送通过网页完成；历史读取可能使用当前网页会话的内部接口。它不读取用户日常浏览器配置，也不会把登录信息写进 MCP 配置。

> [!IMPORTANT]
> 本项目与 OpenAI 无隶属或背书关系。它依赖 ChatGPT 网页界面，页面改版、账号权限、地区或工作区策略都可能影响可用性。请遵守适用于你账号的条款，不要用它绕过访问控制、用量限制或安全机制。

## 主要能力

- 写入提示词、上传文件、发送消息并读取完整回答
- 通过稳定的 `session_id` 隔离独立对话，并读取会话历史
- 普通 ChatGPT 发送默认选择并核验 GPT-6 + 高；需要其他模型时显式传入精确名称
- 普通 ChatGPT 发送默认使用 GPT-6 + 高；临时 Pro 身份探针默认停用，避免额外创建临时对话和发送测试消息
- 浏览器和 ChatGPT 页面默认常驻，工具结束后只断开本地控制连接
- 跨进程串行操作、低频节流、回答完成后的切换静默期
- 页面限流文字或对话生成 POST 接口 HTTP 429 阻止新操作；后台任务、模型列表和历史读取接口的 429 仅记诊断，不自动重试；已有完整回答仍可只读取回
- 对话达到 40 轮或出现 ChatGPT maximum-length banner 时，发送前先滚动加载完整 transcript（含较早历史），再归档并轮换普通对话
- 只记录脱敏后的异常请求方法、路径、状态码和资源类型

## 运行要求

- Node.js 20 或更高版本
- Google Chrome、Chromium 或 Microsoft Edge
- 支持本地 stdio MCP 的客户端，例如 Codex
- 可正常访问并手动登录的 ChatGPT 账号

项目会在 macOS、Windows 和 Linux 的常见位置查找浏览器。找不到时可通过 `CHATGPT_WEB_CHROME` 指定可执行文件。

## 安装

```bash
git clone https://github.com/Tw6249/chatgpt-web-mcp.git
cd chatgpt-web-mcp
npm ci
npm run doctor
```

为了在任意目录使用统一命令，可以建立本地全局链接：

```bash
npm link
chatgpt-web-mcp doctor
```

## 首次登录

```bash
chatgpt-web-mcp login
```

未执行 `npm link` 时也可以使用：

```bash
npm run login
```

在打开的专用浏览器窗口中手动登录。登录资料默认保存在 `~/.chatgpt-web-mcp/chrome-profile`，与日常浏览器配置分离。不要复制、提交或分享这个目录，也不要把密码、Cookie、令牌或验证码写进环境变量。

## 添加到 Codex

使用统一命令：

```bash
codex mcp add chatgpt-web -- chatgpt-web-mcp serve
codex mcp get chatgpt-web
```

如果 Codex 找不到全局命令，可以直接使用 Node.js 和项目的绝对路径：

```bash
codex mcp add chatgpt-web -- node /absolute/path/to/chatgpt-web-mcp/src/index.js
```

Codex 的 MCP 配置方式可参考 [OpenAI Docs](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。

## MCP JSON 配置（Windows）

MCP 不需要设置工具集环境变量。服务固定只注册四个工具，保存配置后重连 MCP：

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

## 四个 MCP 工具

| 工具 | 用途 |
| --- | --- |
| `chat_send` | 默认向 ChatGPT 提交任务；明确要求 Gemini 时可指定 provider |
| `chat_result` | 等待、读取和恢复原任务；默认单次观察 90 秒 |
| `chat_history` | 读取指定 provider/session 的历史记录 |
| `chat_doctor` | 本地运行环境诊断，不验证网页登录 |

`chat_send` 默认 ChatGPT GPT-6 + 高。每个项目复用稳定 `session_id`，每个新逻辑请求使用新 `request_id`；恢复必须使用原 `task_id`。`chat_result` 默认 `wait=true`、`timeoutMs=90000`。Agent 对单个逻辑任务最多自动观察 20 分钟；到期只停止等待，不取消、不释放、不重发。继续时读取原任务。

任务列表、取消、放弃跟踪、登录、诊断和安装维护通过 CLI。模型发现/选择、显式归档和多模型比较不再通过 MCP 暴露；`chat_send` 只接受用户提供或已确认的精确模型名称：

```powershell
node src/cli.js doctor
node src/cli.js tasks --provider all --state uncertain
node src/cli.js result <task_id> --wait --timeout 90000
node src/cli.js cancel <task_id>
node src/cli.js abandon <task_id> --confirm
```

## 默认路由策略

普通 ChatGPT `chat_send` 在模型、思考强度和回答档位均省略时选择并复核 GPT-6 + 高；显式设置优先，无法核验时停止发送。Gemini 仅在用户明确指定时使用。临时 Pro 身份探针默认停用；不要把模型自我说明或网络标签当成实际服务模型的独立证明。

## 安全节流

| 环境变量 | 默认值 |
| --- | ---: |
| `CHATGPT_WEB_PAGE_INTERACTION_INTERVAL_MS` | 1000 ms |
| `CHATGPT_WEB_SITE_ACTION_INTERVAL_MS` | 5000 ms |
| `CHATGPT_WEB_SEND_INTERVAL_MS` | 5000 ms |
| `CHATGPT_WEB_CONVERSATION_CHANGE_INTERVAL_MS` | 5000 ms |
| `CHATGPT_WEB_POST_RESPONSE_CONVERSATION_COOLDOWN_MS` | 5000 ms |
| `CHATGPT_WEB_PAGE_STARTUP_DELAY_MS` | 6000 ms |
| `CHATGPT_WEB_POST_BREAKER_COOLDOWN_MS` | 300000 ms |
| `CHATGPT_WEB_HISTORY_QUIET_PERIOD_MS` | 300000 ms |

**默认 5 秒是最小间隔，不是每 5 秒必定完成一次操作，也不是免于限流或封禁的保证。** 页面加载、页面交互、生成回答以及其他等待会叠加；完成上一条回答后才开始下一条，不并发发送。已有客户端环境变量会覆盖新默认值；例如原先显式配置了 `30000`，升级后仍使用 30 秒。

新建、临时切换和历史选择受独立的 5 秒对话变更间隔约束，回答完成后至少静默 5 秒才允许切换。首次打开 ChatGPT 页面后仍等待 6 秒。若账号出现请求频繁提示，应停止并增大间隔，例如把上述三个 `5000` 配置改回 `30000`，不要反复重试。

人工确认限流消失并清除本地熔断后，首次站点操作仍等待 5 分钟；页面明确提示历史限流时还有独立的 5 分钟静默截止时间，清除熔断不会绕过它。ChatGPT 对话生成 POST 接口（含 `/backend-api/f/conversation`）返回 HTTP 429 时触发全局熔断；历史读取、后台任务列表和模型列表等接口的 429 仅保留诊断，不推断为生成额度耗尽，也不自动重试。历史读取失败仍沿用页面 transcript 回退。网页明确限流继续阻止新操作，但 `chat_result` 可读取原页面已有的完整回答，仍核验原会话和准确用户轮次；限流提示本身或仍在生成的部分回答不会作为完整结果返回。读取不清除已有熔断，包括旧版本留下的误判。缺少现成请求头时不再额外打开页面取认证信息。

保留 PR 的旧进程锁回收逻辑：记录的 MCP 进程已退出时，后续操作会自动清除其生成标记，避免遗留锁阻塞。进程仍存活或标记未记录进程 ID 时，不按此规则清除；这不会同时清除限流熔断，也不会关闭浏览器。

## 其他环境变量

- `CHATGPT_WEB_CHROME`：浏览器可执行文件绝对路径
- `CHATGPT_WEB_PROFILE`：专用浏览器配置目录
- `CHATGPT_WEB_HEADLESS`：是否无界面运行，默认 `false`
- `CHATGPT_WEB_ACTION_TIMEOUT_MS`：单次页面操作超时
- `CHATGPT_WEB_RESPONSE_TIMEOUT_MS`：浏览器生成等待超时；与 Agent 的 20 分钟自动观察预算不同
- `CHATGPT_WEB_RECONNECT_DELAY_MS`：浏览器异常重连间隔
- `CHATGPT_WEB_AUTH_CACHE_MS`：登录状态本地缓存时间
- `CHATGPT_WEB_PRO_RECHECK_AFTER_CLOSE_MS`：页面或浏览器关闭后的探针重验间隔，默认 3 小时
- `CHATGPT_WEB_BROWSER_STATE`、`CHATGPT_WEB_RUNTIME_STATE`：本地状态文件
- `CHATGPT_WEB_OPERATION_LOCK`：跨进程浏览器独占锁
- `CHATGPT_WEB_NETWORK_LOG`：脱敏网络异常日志
- `CHATGPT_WEB_MAX_CONVERSATION_TURNS`：发送前自动轮换阈值，默认 `40`
- `CHATGPT_WEB_CONTEXT_ARCHIVE_DIR`：对话轮换前 Markdown 归档目录

## 隐私与局限

- 登录资料、运行状态和诊断日志默认位于 `~/.chatgpt-web-mcp`，不在仓库中。
- 文件上传只接受调用者明确提供的绝对路径。
- 网络诊断不保存查询参数、Cookie、请求体、响应体或对话 ID。
- 等待回答使用页面内的变更事件，不持续轮询页面。
- 每次发送前只做一次当前对话整页刷新并重新校验；页面、对话 URL、用户草稿或附件状态异常时停止，不自动重试。
- 自动轮换对话前，完整 transcript（含懒加载的较早消息）以 `0600` Markdown 文件保存；归档目录应按部署需要纳入受控的研究文档路径。
- ChatGPT 网页不是稳定 API；选择器可能随页面更新而需要维护。
- 模型自我说明和网络模型标记都不构成对实际服务模型的独立证明；尤其不能把“非 mini”当作 Pro 保证。

## 开发

```bash
npm ci
npm test
npm run smoke
npm pack --dry-run
```

CI 只运行离线测试和打包检查，不登录 ChatGPT，也不执行真实网页请求。贡献前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)；安全问题请阅读 [SECURITY.md](SECURITY.md)。

## 许可证

[MIT](LICENSE)
