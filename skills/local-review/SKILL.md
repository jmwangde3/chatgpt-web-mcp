---
name: local-review
description: 使用最新本地代码、Diff、调用方和测试证据请 ChatGPT Web 复审。仅在用户明确选择 local-review/mode=local，或 gh-review 委派时使用；不执行 GitHub 推送。
---

# 本地证据代码复审

仅在用户明确选择本地复审或 `$gh-review` 的 auto 模式委派时使用。普通设计和实现任务仍遵循当前默认 Web-First 路由；若新版 `web-first` Skill 已安装，不要重复触发旧 `web-chat` Skill。

1. 阅读 [本地证据工作流](references/local-review-workflow.md)。从真实磁盘采集授权范围内的变更、必要调用上下文和测试；相关文件带路径、最新行号和哈希。没有 Git 仓库也可以操作。
2. 旧 MCP 回退路径依赖宿主已注入的 `chat_send`、`chat_result`、`chat_history`、`chat_doctor`。如果工具索引中缺失，停止并报告宿主注入问题；不要读取私有 MCP 配置、启动第二个短命 stdio 服务或自行操作 CDP/Playwright。
3. 向网页发送代码证据前核实用户许可。屏蔽凭据、隐私内容和无关目录。禁止外发时只做本地复审。
4. 按 [共享审查协议](../gh-review/references/code-review-protocol.md) 要求逐项证据与覆盖缺口。Codex 独立核实、修复、测试；下一轮重新读取本地真实代码，未变文件引用旧证据前核对哈希。
5. 每轮新逻辑请求使用新 `request_id`，沿用同一项目 `session_id`；等待超时按原 `task_id` 读取，不重发。默认最多两轮自动复审；有未解问题输出真实状态。

## Windows / ACL / UI 验证边界

- `PROFILE_ACL_UNSAFE` 是安全校验失败，不是建议放宽权限。不得自动运行 `takeown`、`icacls /reset`、广泛授予 Everyone 权限、关闭 ACL 检查或改用其他用户的浏览器 Profile。
- 宿主策略禁止 `Add-Type` 时，不要尝试通过 PowerShell 动态编译、加载外部程序集或改名绕过。只使用已允许的内置能力。
- 无交互桌面的会话不能证明 WinForms 鼠标悬停、焦点、托盘和窗口消息泵行为。静态审查、语法检查和进程启动不能冒充交互验收；需要用户在真实桌面人工确认。
- 不要手动删除 MCP 锁文件。仅对明确报告为 DEAD/PID_REUSED 的锁使用 `node src/cli.js doctor --repair`；UNKNOWN/LIVE 锁必须保留。

本地模式不执行 `git push`、不创建远程仓库、不修改 GitHub 可见性。不得修改 MCP、全局 Codex 配置或其他 Skill。
