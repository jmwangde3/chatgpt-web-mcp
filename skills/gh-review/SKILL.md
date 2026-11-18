---
name: gh-review
description: 用户提出代码复审任务时的统一入口。默认 mode=auto，优先固定 GitHub SHA 并由 ChatGPT Web 复审；条件不足时按既有规则委派 local-review。支持显式 github/local。
---

# ChatGPT Web 代码复审统一入口

本 Skill 负责用户明确提出的代码复审任务。普通功能设计、实现和测试遵循 `$web-chat` 的 Web-First 规则，不要把所有代码工作误路由成复审。

1. 读取 [GitHub 工作流](references/github-review-workflow.md) 的条件检查与推送门禁；检查 `git status --short`、当前分支、完整 HEAD SHA 和 GitHub remote。核实用户是否允许推送到指定的非默认审查分支。
2. 依赖已安装的 `$web-chat` Skill 和当前 `web-chat` MCP。MCP 固定只有 `chat_send`、`chat_result`、`chat_history`、`chat_doctor` 四个工具；不要查找 `full/unified` 模式或旧工具集。复用 `chat_send`、`chat_result`、稳定 `session_id` 和幂等恢复，不自行开发浏览器/CDP/发送机制。
3. 确认 ChatGPT Web 自己能够按仓库和完整 SHA 读取源码。Codex/GitHub 连接可读不等于 ChatGPT Web 可读。若无法证实，`auto` 按既有规则回退 local-review；显式 `github` 报告阻塞。发送本地代码证据前遵守用户的数据分享授权。
4. 代码修改和必要测试完成后，检查 diff 与敏感信息；仅在用户许可时提交并推送到非默认审查分支。向网页发送仓库、分支、完整 SHA、审查范围、测试及上轮问题状态，让 ChatGPT Web 自行读取固定 SHA 的 Diff、源文件和必要上下游。
5. 按 [共享审查协议](references/code-review-protocol.md) 核验实际读取 SHA、文件、证据与覆盖缺口。Codex 独立核实意见后再修改、测试并在同一项目会话复审。结果不确定时停止，不声称 PASS。

不要 `git add -A`、`git push --force`、`git reset --hard`、自动 stash 或推送到 `main/master`。不得将私有仓库改为公开；不得上传 Cookie、密钥、配置秘密或无关用户数据。不得修改 Codex 全局配置、MCP 路由或其他 Skill。
