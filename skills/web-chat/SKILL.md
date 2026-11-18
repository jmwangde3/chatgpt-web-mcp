---
name: web-chat
description: 默认 Web-First 思考入口。用于需求理解、研究、分析、架构设计、技术选型、方案权衡、根因分析、调试决策和实施规划；ChatGPT Web 负责思考与决策，本地 Agent 负责证据收集、执行和验证。无需用户每次点名调用。
---

# Web-First：ChatGPT Web 是主脑，本地 Agent 是执行者

## 1. 何时自动调用

默认隐式调用本 Skill，只要用户任务需要实质性的理解、分析、研究、判断、设计、选择、权衡、根因定位或制定实施方案。包括但不限于：

- 新功能、需求拆解、架构设计、重构、技术选型；
- Bug 根因分析、复杂调试、性能/并发/可靠性方案；
- 项目评估、技术比较、风险判断、实施路线和测试策略；
- 多文件代码修改前的设计与实施规划。

不要等待用户明确说“使用 ChatGPT”“调用网页专家”或 `$web-chat`。不要以“先本地做一版，再请 ChatGPT 审阅”代替本流程。

仅以下情况可直接本地执行：用户明确指定的命令或测试、`git status`/`git diff`、读取指定文件、简单单行拼写/格式修正，以及用户明确要求“本地执行 / 仅本地 / 不调用 ChatGPT Web”。

## 2. 角色分工

**ChatGPT Web — Architect / Decision Maker**

- 理解目标、约束、已知事实和成功标准；
- 研究选项，比较取舍并作出推荐；
- 设计架构、数据流、接口、状态机和错误处理；
- 分析根因，制定修复方案；
- 为代码任务输出可执行的逐文件 Implementation Spec；
- 根据本地执行的新证据调整方案。

**本地 Agent — Evidence Collector / Editor / Executor**

- 在咨询前读取最少必要文件、接口、日志和测试证据；不先做实质设计；
- 将目标、约束和必要证据提交给 ChatGPT Web；
- 收到规格后按规格修改文件、运行命令和测试；
- 汇报真实 diff、测试结果和未解决问题；
- 只有出现重要新事实、新技术决策或原方案受阻时才回到原项目会话。

## 3. Implementation Spec 输出要求

对于代码、脚本、架构和项目任务，要求网页专家按任务复杂度给出：

1. **目标与事实**：目标、约束、已知事实、假设和证据缺口；
2. **推荐决策**：明确选型、关键理由及不采用的替代方案；
3. **逐文件修改**：文件路径、函数/模块、数据结构、关键逻辑和必要伪代码；
4. **边界与错误处理**：失败模式、并发/恢复/幂等约束、禁止行为；
5. **验证方案**：精确命令、回归范围、验收标准和停止条件。

简单问题可缩短格式，但必须给出明确结论。不要只返回泛泛建议或“可以考虑”。

## 4. 四工具调用方式

MCP 只提供以下四个工具；不得寻找或调用旧的 `chatgpt_*`、`gemini_*` 或其他 `chat_*` 工具：

| 工具 | 用途 |
|---|---|
| `chat_send` | 提交一次咨询/设计/分析任务，返回持久化 `task_id` |
| `chat_result` | 读取、等待和恢复同一任务 |
| `chat_history` | 读取指定 Provider / Session 的历史记录 |
| `chat_doctor` | 本地运行环境诊断，不验证网页登录 |

`chat_send` 默认使用 ChatGPT；只有用户明确指定 Gemini 时才传 `provider: "gemini"`。ChatGPT 在未指定模型、思考强度和回答档位时默认 GPT-6 + 高。模型/档位的显式参数优先。

用户明确授权把同一内容发给两个平台做对比时，可传 `providers: ["chatgpt", "gemini"]`，不再传 `provider` 或单平台模型、思考强度等设置。两个平台都会收到提示词及明确列出的附件。用返回的 `fanout:` 父 `task_id` 调用 `chat_result` 读取各子项；查询不会发送，部分失败也不自动重发整组。

**项目会话：**同一项目使用稳定 `session_id`，例如 `project_chatgpt_web_mcp`；不同项目或确实需要并行的独立任务使用不同值。不要依赖 `chat_new`（该工具不存在）；新的独立会话通过新的 `session_id` 建立。每个新逻辑请求生成新的 `request_id`。只有恢复同一个请求时才复用原 `request_id`，并且必须保持 provider、session、prompt、files、model、thinking_level、answer_tier、web_search 和 existing_draft 完全一致。

**提交一次：**调用 `chat_send` 后保存返回的 `task_id`、`session_id`、`request_id`。提交响应丢失时，只有通过相同 `request_id` 和完全相同 payload 才能安全恢复原记录；不得用新 ID 猜测性重发。

示例形状（每次实际生成新的 request_id）：

```json
{
  "session_id": "project_chatgpt_web_mcp",
  "request_id": "每个新逻辑请求生成的UUID",
  "prompt": "完整目标、约束、最小必要事实和 Implementation Spec 要求"
}
```

如需授权文件，在 `files` 中提供明确选定的绝对路径；最多 10 个。不要自动附加整个仓库。读取本地文件不等于授权上传完整文件；优先提交相关代码摘录、接口和日志，完整文件仅在确有必要且授权范围明确时附加。

## 5. 有界等待与恢复

- **总自动观察预算：每个逻辑任务最多 20 分钟。**从首次收到 `task_id` 时开始计算。该预算只限制 Agent 自动等待，不是网页生成超时。
- 每次调用 `chat_result` 使用 `wait: true`、默认 `timeoutMs: 90000`；最后一段按总预算剩余时间缩短（接口最小 1000ms）。单次观察结束后，如果任务仍为 `submitted` / `running`，在总预算剩余时间内继续读取同一个 `task_id`。
- 不要短间隔紧密轮询、重复总结仓库、重读已知材料或每隔几十秒向用户报告。优先进度通知；没有通知时按 90 秒观察片段继续。
- `progress.phase` 的 `thinking`、`streaming`、`stalled`、`waiting` 只是观察信息。`stalled` 表示可见文本至少 2 分钟未变化，不代表失败，不取消、不释放任务。
- `timed_out: true` 或旧任务的 `RESULT_TIMEOUT` 只代表一次观察预算结束。若任务仍可恢复，在总预算内继续读取同一个 `task_id`；不得创建新 `request_id`、新会话、重新发送或调用取消。
- `CONTROL_BUSY`：服务端若确认 `retryable_observation: true`，会在当前 `chat_result` 的同一 90 秒预算内自动进行只读重试。如果该片段结束时仍返回 `uncertain`、`timed_out:true` 且保留此标记，可在 20 分钟总预算内再次调用 `chat_result`，仍使用同一 `task_id`；这只会重试安全的只读观察，不会重发。没有该标记时不要自行重复 settle/cancel 操作，按 `recovery` 建议检查原页面。
- `LOGIN_REQUIRED`、`RATE_LIMITED`、`SEND_UNCONFIRMED`、`CONVERSATION_CHANGED` 等状态按实际错误处理，不一概当成可等待。不得自动切换 Provider。
- 达到 20 分钟仍未完成：停止本轮自动观察，向用户报告原 `task_id`、`session_id`、最新 state/progress 和“任务未取消，可继续恢复”。保留所有任务记录。用户之后要求继续时，从原 `task_id` 继续；不要重新 `chat_send`。
- 用户说“停止等待”只停止 Agent 等待，不取消网页生成。只有用户明确要求取消时才执行 CLI 取消。

推荐调用：

```json
{"task_id":"原任务ID","wait":true,"timeoutMs":90000}
```

## 6. CLI 管理入口

以下操作不占用 MCP 工具名额，通过项目 CLI 执行：

```powershell
node src/cli.js doctor
node src/cli.js tasks --provider all --state uncertain
node src/cli.js result <task_id> --wait --timeout 90000
node src/cli.js cancel <task_id>
node src/cli.js abandon <task_id> --confirm
```

`cancel` 只在用户明确要求取消时使用。`abandon` 仅在用户已检查原页面为空闲且明确授权后使用；它不撤销发送，也不代表回答完成。不要在超时后自动调用这两个命令。

模型发现/选择、独立状态页、比较任务、显式归档和浏览器生命周期不再作为 MCP 工具暴露。ChatGPT 默认模型由 `chat_send` 现有逻辑处理；需要其他模型时，使用用户提供或已确认的精确模型名称。不要假设有 `chat_models` 或 `chat_select_model`。

## 7. 数据与失败边界

- 仅发送当前任务必需的上下文与最小证据；不上传整个工作区、无关资料、凭据、Cookie、Token 或秘密。
- 本地分析或修改授权不等于外发授权。仅在已有授权范围内发送必要的代码摘录、接口、diff、日志或明确选定的文件。
- MCP 不可用、浏览器未登录或原任务无法确认时，报告具体阻碍并保留状态。不得静默让本地 Agent 自行完成原本应由网页承担的设计。
- 网页专家输出是决策建议，不是本地验证证据。Agent 必须按规格执行并运行适当测试，报告真实结果。
