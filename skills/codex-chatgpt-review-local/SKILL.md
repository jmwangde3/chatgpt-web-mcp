---
name: codex-chatgpt-review-local
description: 用本地最新代码、精简 Diff、调用方与测试证据请 ChatGPT Web 复审；用于无可用 GitHub、尚未推送或用户明确选择本地证据的情况。仅在用户要求网页协作审查时使用，不执行 GitHub 推送。
---

# Codex × ChatGPT Web：本地证据代码复审

显式 `mode=local` 直接使用本 Skill；由 `$codex-chatgpt-review-github` 的 `auto` 回退时也使用本 Skill。**不执行** `git push`、不创建远程仓库、不修改 GitHub 仓库可见性。

1. 阅读 [本地证据工作流](references/local-review-workflow.md)。逐轮从当前真实磁盘代码采集已授权范围内的变更、必要调用上下文和测试；相关文件带路径及最新行号，使用哈希/版本辨别旧证据。没有 Git 仓库也可以操作。
2. 阅读同一规范源中的 `$web-chat` Skill：`C:/Users/jmwan/.skills-manager/skills/web-chat/SKILL.md`；通过工具发现获取本次有效的 MCP Schema，复用其 ChatGPT `chat_send`/`chat_result`/恢复机制和原会话，不自行操作 CDP、Playwright 或浏览器，也不复制外部任务管理逻辑。

   仅当 A 工具集已验收且当前宿主实际注册了 `unified` 工具集时，优先使用统一工具；未验证或未启用时继续使用 `full`。始终依据当前 Schema 发现工具，不擅自修改环境变量或宿主配置；当前工具集未提供的专用功能必须明示限制。
3. 向网页发送证据前核实用户许可。**禁止 GitHub 推送 ≠ 禁止向 ChatGPT Web 发送必要代码**；若用户禁止任何代码对外发送，则不能启动网页复审，直接说明限制，允许仅 Codex 本地检查。屏蔽凭据、隐私内容和无关目录。
4. 以 [共享审查协议（唯一来源）](../codex-chatgpt-review-github/references/code-review-protocol.md) 要求 ChatGPT Web 给出逐问题证据和覆盖缺口。Codex 逐条核实、修复、测试，下一轮重新读取本地真实代码；未变文件引用旧证据前核对哈希。
5. 每轮新请求使用新 `request_id`、沿用任务 `session_id`；等待超时按原 `task_id` 读取，不重发。默认最多两轮自动复审；有未解问题输出实际状态。

本地模式不需要 GitHub Skill 的网络功能，但两个 Skill 必须安装在同一 Skills Manager 中心源，才能共享上面的单份协议。任何已有成品文件修改均遵守当前工作区 `AGENTS.md` 的改动确认要求。不得修改 MCP、全局 Codex 配置或其他 Skill。
