# Codex：Web-First MCP + Skill 安装与使用

本项目将网页 ChatGPT 作为默认思考与决策层，本地 Codex 作为证据收集、编辑和执行层。MCP 固定只注册四个工具：`chat_send`、`chat_result`、`chat_history`、`chat_doctor`。取消 `full/unified` 配置，不保留旧 MCP 工具集兼容分支。

## 1. 安装与注册 MCP

需要 Node.js 20+、npm、Git、Chrome/Edge，以及支持 stdio MCP 的 Codex。

```powershell
npm ci
node src/cli.js doctor
node src/cli.js login --provider chatgpt
```

需要 Gemini 时再单独登录：

```powershell
node src/cli.js login --provider gemini
```

推荐使用项目 CLI 管理入口：

```powershell
node src/cli.js setup
```

按 setup 输出注册 `web-chat` MCP。已有配置时检查并沿用，不重复创建服务。也可直接配置项目绝对路径：

```powershell
codex mcp add web-chat -- node "C:\path\to\chatgpt-web-mcp\src\index.js"
codex mcp get web-chat
```

保存后重连 MCP 客户端。登录只在专用浏览器窗口手动完成，不把密码、Cookie 或验证码写入配置。

## 2. 安装 Skill

将整个 `skills/web-chat` 目录复制到 Codex Skill 根目录：默认 `%USERPROFILE%\.codex\skills\web-chat`；设置 `CODEX_HOME` 时使用 `$env:CODEX_HOME\skills\web-chat`。先备份已有同名 Skill，确认只有一个发现入口。安装后重开聊天，必要时重启客户端。

仓库内 `skills/web-chat/agents/openai.yaml` 设置 `policy.allow_implicit_invocation: true`。它允许宿主根据任务自动调用 Skill；触发仍由宿主的 Skill 匹配决定，不是 MCP 代码级强制路由。因此 `AGENTS.md` 也写明了项目 Web-First 默认规则，避免只依赖 Skill 描述。

## 3. 默认协作方式

- 需求理解、研究、架构、设计、技术选型、根因分析、调试决策和实施规划：先由 ChatGPT Web 处理。
- 本地 Agent 可以先收集最少必要事实，但不得先完成实质设计再把网页当作审阅者。
- ChatGPT Web 应给出可执行的逐文件 Implementation Spec；本地 Agent 按规格修改、测试并汇报证据。
- 纯命令、明确指定的测试、Git status/diff、指定文件读取和简单机械修改可本地直执行。用户明确要求仅本地时优先。

## 4. 四个 MCP 工具

| 工具 | 用途 |
|---|---|
| `chat_send` | 默认 ChatGPT，提交一次任务并返回 `task_id`；明确要求 Gemini 时传 `provider: "gemini"` |
| `chat_result` | 默认 `wait=true`、`timeoutMs=90000`；继续读取原任务，不重发 |
| `chat_history` | 读取指定 provider/session 的历史，注意结果可能不含未加载历史 |
| `chat_doctor` | 本地诊断，不打开浏览器、不验证网页登录 |

不再存在 `chat_new`、`chat_models`、`chat_select_model`、`chat_cancel`、`chat_tasks`、`chat_status`、`chat_retry`、`chat_archive` 等 MCP 工具。取消、任务列表、放弃跟踪、登录、诊断和安装维护通过 CLI 管理；模型发现/选择不提供 MCP 或 CLI 的通用替代命令。

## 5. 会话、幂等与等待

同一项目复用稳定 `session_id`，例如 `project_chatgpt_web_mcp`。新逻辑请求生成新 `request_id`；同一请求恢复时必须保持完整 payload 不变并使用原 `request_id`。提交成功后保存原 `task_id`。任何超时、断连或 pending 都只读取原 `task_id`，不生成新编号重发。

每个逻辑任务最多自动观察 20 分钟。每次 `chat_result` 默认使用 `wait=true`、`timeoutMs=90000`；最后一段按总预算剩余时间缩短（最小 1000ms）。达到单次观察预算后，若仍是 `submitted/running`，在总预算内继续读取原任务。`stalled` 只表示一段时间没有可见文本变化，不代表失败。达到 20 分钟后停止自动等待，保留任务并报告原 `task_id`；用户要求继续时再恢复。停止等待不等于取消生成。

只有用户明确要求取消时，才执行：

```powershell
node src/cli.js cancel <task_id>
```

其他管理命令：

```powershell
node src/cli.js tasks --provider all --state uncertain
node src/cli.js result <task_id> --wait --timeout 90000
node src/cli.js abandon <task_id> --confirm
```

`abandon` 只能在用户已检查原网页空闲并明确授权后使用。它不撤销发送，也不证明回答完成。

## 6. 数据边界与验收

只发送当前任务必要的摘要、代码摘录、diff 和明确授权文件；不自动上传整个工作区或秘密。MCP 不可用、未登录或任务不确定时，报告阻碍并保留任务，不静默由本地 Agent 接管设计。

更新后重连 MCP，确认 `tools/list` 恰好返回四个名称。运行 `npm run smoke` 可自动检查工具数量、名称和默认参数。端到端网页验证需要用户授权后实际发送一次合成请求；工具发现通过不等于真实网页生成已验证。
