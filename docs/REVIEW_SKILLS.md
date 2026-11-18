# ChatGPT Web 代码复审 Skill 安装与维护

## 用途与模式

- `$gh-review` 是用户提出代码复审任务时的统一入口，默认 `mode=auto`；条件满足时使用固定 GitHub SHA，否则按既有规则委派 `$local-review`。
- `mode=github` 固定 GitHub 模式，条件不足时报告阻碍，不静默回退；`mode=local` 直接使用 `$local-review`，不执行 GitHub 推送。
- `$local-review` 仅接受用户明确选择或 gh-review 委派，不独立自动触发普通代码审查。
- 两种模式都需要源码外发许可；禁止任何源码外发时停止网页复审。禁止 GitHub 推送与禁止向 ChatGPT Web 分享代码是两种不同限制。

## 依赖与 MCP 接口

依赖已安装的 `$web-chat` Skill 和已配置、可发现的 web-chat MCP。当前 MCP 固定只暴露 `chat_send`、`chat_result`、`chat_history`、`chat_doctor` 四个工具，不再有 `full/unified` 双工具集或旧工具兼容模式。复审只使用 `chat_send` 与 `chat_result`；项目会话复用稳定 `session_id`，每轮新逻辑请求使用新 `request_id`，恢复始终读取原 `task_id`。

MCP 安装与登录见 [CODEX_SKILL.md](CODEX_SKILL.md)。安装 Skill 不会安装 MCP、登录浏览器、切换宿主模型或立即发送代码。已有部署不需要重复安装。

## 目录布局

两项必须成对安装，保持同级目录：

```text
<skills-root>/
  gh-review/
    SKILL.md
    references/github-review-workflow.md
    references/code-review-protocol.md
  local-review/
    SKILL.md
    references/local-review-workflow.md
```

共享协议仅存于 `gh-review/references/code-review-protocol.md`；local-review 通过相对路径引用，不复制第二份。

## 方式一：Codex 原生安装

仅适用于没有被 Skills Manager 管理的目标。从仓库根目录运行；有旧入口或同名目标时先核实归属。备份放在技能发现目录之外。

```powershell
$OutputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$codexRoot = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
$skillsRoot = Join-Path $codexRoot 'skills'
foreach ($name in @('gh-review', 'local-review')) {
    $source = Join-Path (Join-Path (Get-Location) 'skills') $name
    $target = Join-Path $skillsRoot $name
    if (-not (Test-Path -LiteralPath (Join-Path $source 'SKILL.md'))) { throw "Missing source: $source" }
    if (Test-Path -LiteralPath $target) {
        $backupRoot = Join-Path $codexRoot ('skill-backups/' + $name + '-' + [guid]::NewGuid().ToString())
        New-Item -ItemType Directory -Path (Split-Path $backupRoot) -Force | Out-Null
        Copy-Item -LiteralPath $target -Destination $backupRoot -Recurse
    }
    New-Item -ItemType Directory -Path $target -Force | Out-Null
    Copy-Item -Path (Join-Path $source '*') -Destination $target -Recurse -Force
}
```

重新打开聊天，必要时重启客户端，确认能发现 `$gh-review`、`$local-review` 和 `$web-chat`。不额外创建 `.agents` 副本。安装成功不等于网页复审端到端已验证。

## 方式二：Skills Manager

将 Skills Manager 中心源作为唯一编辑与管理源，通过当前版本已验证的导入/安装界面选择两个完整目录。确认共享相对路径可解析，再由 Manager 管理客户端链接。不要手工复制到客户端技能目录，也不要另外建立 `.agents` 同名入口。

已有安装改名或迁移必须保留管理 ID、链接和安装关系；不得通过删除旧记录再导入来假装完成迁移。若当前 Manager 没有已验证的保留 ID 迁移接口，保留原记录和链接不动，不猜测命令。

## 更新、卸载与重复入口

- 原生更新：先确认目标不是 Manager 链接；备份两项和本地定制后成对替换完整目录，核实共享协议引用。
- Manager 更新：只更新中心源并通过已验证的 Manager 流程同步，保留管理 ID 和链接关系。
- 原生卸载：核实实际技能根、两项路径及归属，只移除这两个自管目录；不要删除共享依赖 web-chat、MCP 或浏览器数据。
- Manager 卸载：通过管理界面移除对应安装关系，不手改数据库或盲删链接目标。
- 刷新技能列表后检查每个入口的真实目录、frontmatter name 和链接目标；每项只能有一个发现入口。备份和仓库候选不应成为第二个客户端技能根。

## npm 包

本仓库 `package.json` 的 `files` 包含 `skills/web-chat`、`skills/gh-review`、`skills/local-review` 和本安装文档。发布前运行 `npm run verify:package`，核对 `npm pack --dry-run --json` 的完整清单。npm 安装或 MCP upgrade/rollback 不会自动更新或卸载独立 Skill。
