---
name: local-review
description: 使用最新本地代码、Diff、调用方和测试证据请 ChatGPT Web 复审。仅在用户明确选择 local-review/mode=local，或 gh-review 委派时使用；不执行 GitHub 推送。
---

# 本地证据代码复审

仅在用户明确选择本地复审或 `$gh-review` 的 auto 模式委派时使用。普通设计和实现任务仍遵循 `$web-chat` 的 Web-First 规则，不要把本 Skill 当作默认编码入口。

1. 阅读 [本地证据工作流](references/local-review-workflow.md)。从真实磁盘采集授权范围内的变更、必要调用上下文和测试；相关文件带路径、最新行号和哈希。没有 Git 仓库也可以操作。
2. 依赖已安装的 `$web-chat` Skill 和当前 `web-chat` MCP。MCP 固定只有 `chat_send`、`chat_result`、`chat_history`、`chat_doctor` 四个工具；不要检查 `full/unified` 或旧工具集。复用其发送、等待、任务恢复与项目会话，不自行操作 CDP、Playwright 或浏览器。
3. 向网页发送代码证据前核实用户许可。禁止 GitHub 推送不等于禁止向 ChatGPT Web 分享必要代码；若用户禁止任何代码外发，则停止网页复审并说明限制。屏蔽凭据、隐私内容和无关目录。
4. 按 [共享审查协议](../gh-review/references/code-review-protocol.md) 要求逐项证据与覆盖缺口。Codex 独立核实、修复、测试；下一轮重新读取本地真实代码，未变文件引用旧证据前核对哈希。
5. 每轮新逻辑请求使用新 `request_id`，沿用同一项目 `session_id`；等待超时按原 `task_id` 读取，不重发。默认最多两轮自动复审；有未解问题输出真实状态。

本地模式不执行 `git push`、不创建远程仓库、不修改 GitHub 可见性。不得修改 MCP、全局 Codex 配置或其他 Skill。
