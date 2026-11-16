---
name: codex-chatgpt-review-github
description: 让 Codex 与 ChatGPT Web 按固定 GitHub Commit SHA 协作审查代码；默认 auto 优先 GitHub，条件不足时改用独立的本地证据 Skill。仅在用户要求 ChatGPT Web 参与代码复审或明确点名本 Skill 时使用。
---

# Codex × ChatGPT Web：GitHub 代码复审

本 Skill 负责 `mode=auto`（默认）和 `mode=github`。用户明确选择 `local` 时直接调用 `$codex-chatgpt-review-local`；不要执行 GitHub 推送。不要因为普通代码修改或普通本地审查而自动调用网页专家。

1. 先读取 [GitHub 工作流](references/github-review-workflow.md) 中的条件检查与推送门禁；运行 `git status --short`、`git branch --show-current`、`git rev-parse HEAD`、`git remote -v`。核实远程确为 GitHub、账号的推送能力、当前修改的归属和用户是否允许把本轮内容推送到指定审查分支。
2. 查看当前规范源中的 `$web-chat` Skill（`C:/Users/jmwan/.skills-manager/skills/web-chat/SKILL.md`），并按宿主工具发现结果获取当前 ChatGPT Web MCP 的实际接口定义。不得凭旧工具名或参数猜测调用。复用它的 `chat_send`、`chat_result`、会话保持及幂等恢复；不得开发新浏览器/CDP/发送机制。

   仅当 A 工具集已验收且当前宿主实际注册了 `unified` 工具集时，优先使用统一工具；未验证或未启用时继续使用 `full`。始终依据当前 Schema 发现工具，不擅自修改环境变量或宿主配置；当前工具集未提供的专用功能必须明示限制。
3. 尝试确认 **ChatGPT Web 自己**可以按仓库与完整 SHA 读取代码。Codex/GitHub 连接可读不等于 ChatGPT Web 可读。若不能证实，`auto` 转本地 Skill；显式 `github` 返回阻塞。转本地前核对用户对向 ChatGPT Web 发送本地代码证据的许可。
4. 代码修改完成、必要测试通过后，按工作流检查变更与敏感信息，安全提交并推送到允许的非默认审查分支。只发送仓库、分支、完整 SHA、审查范围、测试及上轮问题状态；让 ChatGPT Web 自行读取该 SHA 的 Diff、源文件和必要上下游。
5. 采用唯一的 [共享审查协议](references/code-review-protocol.md) 核验网页回复中的 **实际读取 SHA 和文件、未读缺口、逐项证据**。Codex 独立核实意见后修改、测试、产生新 SHA 并在同一网页会话复审。每轮有界；结果不确定时停止且不声称 PASS。

不要 `git add -A`、`git push --force`、`git reset --hard`、自动 stash，或推送到 `main/master`。不得将私有仓库改为公开；不得上传 Cookie、密钥、配置秘密、私有用户数据。涉及已有成品文件的改动，遵循项目 `AGENTS.md` 的修改确认约定。不得改 Codex 全局配置、TaskKernel、MCP、模型路由或其他 Skill。
