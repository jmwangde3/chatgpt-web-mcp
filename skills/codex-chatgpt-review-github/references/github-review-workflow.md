# GitHub 模式：证据与推送操作规范

## 1. 决策：auto / github / local

从当前用户本轮明确指令判定模式：`local` 永远直达本地 Skill；`github` 只执行 GitHub 方案，不自动更换；未指定时 `auto`。`auto` 只有在**真实 GitHub remote、允许推送、GitHub 上为当前完整 SHA、ChatGPT Web 能自行读取目标版本**全部满足时选 GitHub，否则在用户允许分享相关本地证据时转 `$codex-chatgpt-review-local`。不允许任何外发时停下并提供仅本地 Codex 检查结果，不能冒充网页复审。

### 检查命令（只读）

```powershell
git status --porcelain=v1 -uall
git branch --show-current
git rev-parse HEAD
git remote -v
git branch -r
git diff --name-only
git diff --cached --name-only
git ls-files --others --exclude-standard
```

用远程 GitHub 仓库的分支信息确认默认分支（可能不叫 main/master），核对 `HEAD` 是否包含所有待审修改和本轮测试是否针对该代码。工作区不是 Git 仓库、只有未推送代码、远程无法访问、当前没有可用身份或不能安全提交，均不满足 GitHub 复审前提；可补齐后再进入 GitHub，`auto` 可回退本地，`github` 必须报告阻碍。

**不能以 Codex 能读取 GitHub 代替 ChatGPT Web 能读取的证据。** 对公开仓库仍要检查 Web 回复的仓库/SHA/文件列表；对私有仓库核实 ChatGPT Web 使用的身份有相应授权。只读首页或 README 不合格。仓库能读但某个必要源文件不能读也判本轮 `INCOMPLETE`。

## 2. GitHub 审查分支与提交门禁

1. 确定变更归属、基线及目标分支；默认分支上不得直接推送。必要时建立 `review/<task-slug>`（此前无未处理冲突或无法归属的修改）。若无法安全分离他人工作，停止提交并使用本地模式或报告阻塞。
2. 在准备的提交集合内逐个检查 `git diff`、`git diff --cached` 和未跟踪文件，仅用 `git add -- <明确列出的本轮文件>`。不要执行 `git add -A`、`reset --hard`、`push --force`、自动 stash。
3. 推送前确认 staged 文件不含 `.env`、令牌、密码、Cookie、浏览器 Profile、用户数据、敏感日志、私有配置及不应发布的大文件。**不打印秘密内容**。发现可疑立即停下；不能以忽略某一个文件名替代内容检查。
4. 执行相关测试并记录实际命令、退出状态及输出摘要；`git diff --cached --check`；检查确认只包含相关变更。用常规提交生成不可变 SHA，推送到指定允许的非默认审查分支。`git push` 必须检查返回码，再比对远程分支 HEAD 与本地完整 SHA；不一致不可发起 GitHub 代码复审。
5. 若当前分支已有用户他人的提交或未批准的改动，不改写历史；无法安全提交时停止并说明原因。推送失败或权限不可核时本轮判 `BLOCKED`，不得宣称已同步。

## 3. 最小交接内容（直接发送给 ChatGPT Web）

```text
模式: github
Repository: <owner>/<repo>
Branch: review/<task>
Commit: <40-char SHA>
Base: <40-char SHA 或明示不适用>
Task: <精确审查范围>
Tests: <实际执行命令及 PASS/FAIL>
Prior findings: <ID/状态；首次为 none>

请你亲自打开 GitHub 上指定 Commit SHA 的 Diff，阅读所有本轮变更文件以及相关调用方、被调用方和测试。不要把我提供的元数据当作已经阅读代码的证明。按共享审查协议逐项列出实际读取的文件及路径、SHA、无法读取的文件和证据缺口，然后给出逐问题审查表。若只能读取 README 或无法核对 SHA，请返回 INCOMPLETE。
```

复审前将共享审查协议相关要求纳入本轮提示词；可以引用旧轮结果，但代码证据必须来自新 SHA。尽量保持原 ChatGPT 对话的 `session_id`，新轮使用**新的** `request_id`；仅网络超时恢复时复用**原** `request_id` 和参数并按旧 `task_id` 取回结果。严格按照当前 `$web-chat` 的等待与停止规则。

## 4. 结果处理

核实 ChatGPT Web 实读的仓库、SHA、文件清单和重要问题证据。被审 SHA 不吻合、缺少关键文件、审查只基于 Readme/用户摘要时不得使用 PASS。Codex 针对每条问题复核后修复、重测，生成并推送新 SHA；在原网页会话要求按新 SHA 核验旧 ID 和新问题。到两轮上限时输出问题状态及剩余工作。
