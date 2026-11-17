# V2 本机部署与使用验收

日期：2026-11-17（香港时间）。结论：**本机限定范围 PASS，可以开始日常受监督使用**；不代表全部权限故障、模型上下文极限或生产可靠性均已验收。

## 当前安装

- 原安装目录：`%USERPROFILE%/source/chatgpt-web-mcp`，本地分支 `local/deploy-collaboration-v2-20261117`。
- 实际部署源码：`59652a951784097b839ddac491b35e429148b121`；旧 `main` 仍保留 `65c130ef9fb405dd12a13d6a0af9f8b225ece2c9`。安装目录无未提交修改，依赖及包版本未改变。
- Codex 原有 MCP 名称、Node 可执行文件、启动脚本路径保持不变；该服务环境设置为 `CHATGPT_WEB_HEADLESS=false`、`CHATGPT_WEB_MCP_TOOLSET=unified`。
- 继续复用已登录的专用浏览器；未修改 Cookie、Profile 内容或 ACL，未关闭浏览器，未清理其他任务。
- 宿主最初仍缓存旧 63 工具；重载后，本会话的实际工具清单已变为 **17 个 chat_*，无 legacy 工具**。随后通过宿主直接发送及取回追问成功，而非仅凭 SDK 的 listTools 宣称宿主生效。

## 实际验收

| 检查 | 结果与边界 |
|---|---|
| full 工具集 | 实际安装目录的新 stdio 服务注册 63 个工具，标准 smoke 通过 |
| unified 工具集 | 实际安装目录注册 17 个工具，标准 smoke 通过；宿主实际重载后也观察到 17 个 |
| 登录及页面 | signedIn=true；没有要求重新登录 |
| Local Skill | 新建两文件合成 fixture，读取完整源码、行号及 SHA-256；本机 unittest 3/3；网页静态审查 PASS，明确未独立执行测试或核算哈希；没有 GitHub 推送 |
| stdio 断连恢复 | 提交后关闭客户端及其服务进程；新进程只读取原 task_id，成功取回完整回答；旧浏览器继续运行 |
| 幂等防重发 | 完全相同 request_id 和内容返回同一已完成任务；只读页面核对仍为 1 条用户消息、1 条回答 |
| 同会话追问 | 文件哈希重新核对未变；full 发出的追问由 unified 新连接取回，正确引用旧实现并返回 2.5 |
| GitHub Skill | 网页在固定 SHA `76eb2dc6b775bae3d1c73a58c0910a68498642d7` 实读 average.py、test_average.py、README.md 和指定 Diff，返回 PASS；未在提示词提供的源码首行及 blob SHA 与 Codex 独立读取一致 |
| 宿主直接调用 | 17 工具实际生效后，在 GitHub 原会话发送新追问，成功取回完整 SHA、原实现及正确结果 3.5 |
| 工程回归 | 221 项单元、22 项原子发送浏览器专项通过；full/unified smoke 通过；[59652a9 的 CI](https://github.com/jmwangde3/chatgpt-web-mcp/actions/runs/43994780640) Ubuntu/Windows 四任务全部成功，包含完整浏览器及补充专项 |

本机首次部署为已测提交 `2a2bfef`，真实发送发现下述误拒绝后，才修复并更新到当前 `59652a9`。成功记录不能掩盖首次失败。

## 部署发现并修复的问题

最终发送保护器原先全页面匹配任意 `aria-busy=true`。真实页面有一个隐藏、位于输入表单之外的 busy 按钮，因此首次点击被保护器拒绝，任务为 `SEND_NOT_ATTEMPTED`，页面仍为零用户消息。

现在通用 aria-busy 只有在可见或属于当前 composer form 时才阻止发送；明确的 progressbar、uploading、upload-progress 标志仍全局拦截。三项新增真实 Chromium 回归分别验证隐藏表单外允许一次可信提交、可见表单外拒绝、隐藏表单内拒绝。

原失败记录保留。准备修复后测试时，草稿保护又拒绝了一次带草稿的新请求，仍未发送；没有换编号重发 uncertain 任务。清除自建草稿前，使用与发送保护器一致的可见全文读取确认完整哈希及零消息数，保存草稿备份后才清除。克隆节点的 composerText 会丢失部分段落分隔；本次仅调整诊断读取方式，没有修改生产全文匹配或草稿保护规则。

本轮沙箱曾使临时状态文件 rename 报 EPERM，并限制 smoke 对现有状态的读取；正常用户权限下重跑全部 221 项单元及 smoke 通过，没有为此修改测试或放宽安全校验。

## 备份与回退

两份配置备份均留在 `%USERPROFILE%/.codex/`，不纳入 Git：

- `config.toml.pre-collaboration-v2-20261117T011046Z.bak`：部署前原始配置。
- `config.toml.collaboration-v2-full-20261117.bak`：本轮可见 full 模式配置。

只需回退工具集时，优先还原可见 full 配置并重连 MCP。回退代码前先核对安装目录 git status 干净，再切回保留的 main；不要 reset --hard 或覆盖用户后续修改。完整原始配置中的 headless=true 会使后续新启动窗口不可见，恢复它时应留意这一差别。备份在整个配置文件层面，若之后添加其他设置，应只定点还原本 MCP 段，避免覆盖新设置。

## 保留的限制

本次只使用自建合成代码；测试的网页与本机 Python 分别执行静态审查和真实断言，不混淆二者。没有撤销私库权限、上传真实敏感内容、制造服务端推送拒绝或测试模型最大上下文。原有 uncertain 任务及先前超时的独立探测保留，未在本轮继续等待、取消或重发。

完整测试原始响应、请求及自建草稿保存在本机 `.deployment-evidence/`，不纳入 PR；公开报告仅记录核验结果。仍保留草稿 PR，未合并、打 Tag 或发布版本。
