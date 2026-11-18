# 项目协作约定

- 默认由网页 ChatGPT GPT-6、高思考强度负责思考，Codex `gpt-6.1-terra`、medium 负责执行；用户显式指定优先。
- 这是协作偏好，不授权自动外发、路由或委派。无法切换宿主模型时如实说明，不声称 MCP 能切换。
- 代码修改按范围运行 `npm test`、`npm run smoke` 和相关离线浏览器测试；需要时运行完整 `npm run test:browser`。

<!-- web-first-four-tools:start -->
## Web-First：先思考，后执行

- 对需要理解、分析、研究、判断、设计、选择、权衡、根因定位或制定实施方案的任务，默认先调用现有 `$web-chat` Skill，让 ChatGPT Web 负责思考与决策；不要求用户每次重复说“调用 ChatGPT”。
- 本地 Codex / Agents 是证据收集者与执行者：先收集最少必要的源码、接口、日志和事实，再把任务交给 ChatGPT Web；取得方案后按规格修改、运行命令和测试。
- 不允许先由本地 Agent 自行完成架构设计、技术选型或根因结论，再仅让 ChatGPT Web 审阅。代码任务要求网页专家给出逐文件 Implementation Spec，至少包含修改文件、关键函数/逻辑、边界与错误处理、验证命令和验收标准。
- 纯确定性操作可直接本地执行：用户明确指定的命令/测试、`git status`/`git diff`、读取指定文件、简单单行拼写或格式修正。用户明确要求“本地执行”“仅本地”或“不调用 ChatGPT Web”时，以用户指令为准。

## 执行闭环

1. 本地只收集完成咨询所需的最少事实，不提前作实质设计或修改。
2. 使用 `chat_send` 提交目标、约束、已知事实和最小必要证据；要求 ChatGPT Web 给出决策与可执行实施规格。
3. 使用 `chat_result` 取得完整回答，再由本地 Agent 按规格执行和验证。
4. 只有原方案受阻、出现重要新事实或新的技术决策时，才把差异与最小证据交回同一项目会话；机械执行不反复咨询。
5. 最终区分网页建议、本地核验、测试证据和实际完成状态，不伪造验证。

## MCP 使用约定

- MCP 固定只暴露四个工具：`chat_send`、`chat_result`、`chat_history`、`chat_doctor`。不设置 `full/unified` 双模式，不保留旧工具集兼容分支。
- `chat_send` 默认 ChatGPT GPT-6 + 高；Gemini 仅在用户明确要求时选择。每个项目复用稳定 `session_id`；每个新逻辑请求使用新 `request_id`；恢复只使用原 `task_id` 和完全相同的请求参数。
- `chat_result` 默认 `wait=true`、单次 `timeoutMs=90000`。每个逻辑任务最多自动观察 20 分钟；超时只结束当前观察，不取消、不释放任务、不创建新请求或重发。达到总预算后保留 `task_id`，用户要求继续时再恢复。
- `stalled` 是进度提示，不代表失败。`CONTROL_BUSY` 只有在服务端确认仍处于 settle 边界之前时才允许只读重试；若单次 90 秒片段超时仍带 `retryable_observation=true`，可在 20 分钟总预算内用同一 `task_id` 开启下一片段。其他不确定状态按错误码处理。
- 取消、任务列表、模型维护和浏览器生命周期等操作使用项目 CLI，不增加 MCP 工具。

## 数据边界

- Web-First 是协作偏好，不替代外发授权。有授权时只发送当前任务必要的摘要、最小代码摘录和明确授权的文件；不发送整个工作区、无关文件、密码、Cookie、Token 或其他秘密。
- Web MCP 不可用、登录失败或任务状态不明时，报告具体阻碍并保留任务；不得静默改由本地 Agent 代替网页完成设计。
- 本项目默认网页 ChatGPT GPT-6 / 高思考、本地 Codex `gpt-6.1-terra` / medium 执行；这是宿主侧偏好，不代表 MCP 能切换宿主模型。用户显式设置优先。

## 验证

按修改范围运行 `npm test`、`npm run smoke`、`npm run verify:package` 和相关离线浏览器测试；需要时运行完整 `npm run test:browser`。不要为了显得充分而重复运行没有新信息的测试。
<!-- web-first-four-tools:end -->
