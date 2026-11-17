# ChatGPT Web 代码复审 Skill 安装与维护

## 用途与模式

- `$gh-review` 是统一入口，仅在要求 ChatGPT Web 参与代码复审时使用。默认 `mode=auto`：真实 GitHub remote、推送许可、目标完整 SHA 及网页自行读取源码条件均满足时走 GitHub，否则在已获本地证据分享许可时委派 `$local-review`。
- `mode=github` 固定 GitHub 模式，条件不足时报告阻碍，不静默回退；`mode=local` 直接委派 `$local-review`，不执行 GitHub 推送。
- `$local-review` 仅接受用户明确选择（名称或 `mode=local`）或 gh-review 委派，不独立自动触发普通代码审查，不 push、不创建远程仓库。没有 Git 仓库也能使用最新本地证据。
- 两种模式都需要源码外发许可；禁止任何源码外发时停止网页复审。禁止 GitHub 推送与禁止向 ChatGPT Web 分享代码是两种不同限制。

## 依赖与目录布局

依赖已安装的 `$web-chat` Skill 和已配置、可发现的 web-chat MCP。通过宿主发现其实际 `SKILL.md` 和当前 MCP Schema，不猜用户路径或工具参数。安装这两项不会安装 MCP、登录浏览器、切换宿主模型或自动发送资料。MCP 安装与登录见 [CODEX_SKILL.md](CODEX_SKILL.md)。已有部署不需要重复安装。

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

共享协议仅存于 `gh-review/references/code-review-protocol.md`；local-review 通过 `../gh-review/references/code-review-protocol.md` 引用，不复制第二份。下面两种安装方式二选一，不同时安装。

## 方式一：Codex 原生安装

仅适用于没有被 Skills Manager 管理的目标。从本仓库根目录运行以下 PowerShell 示例；有旧入口或同名目标时先按维护章节核实，示例拒绝覆盖。备份必须放在技能发现目录之外。

```powershell
$OutputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$reviewCodexRoot = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
$reviewSkillsRoot = Join-Path $reviewCodexRoot 'skills'
$reviewNames = @('gh-review', 'local-review')
$reviewOldNames = @('codex-chatgpt-review-github', 'codex-chatgpt-review-local')
foreach ($reviewName in ($reviewNames + $reviewOldNames)) {
    if (Test-Path -LiteralPath (Join-Path $reviewSkillsRoot $reviewName)) {
        throw "Existing entry: $reviewName; inspect ownership before installing."
    }
}
foreach ($reviewName in $reviewNames) {
    if (-not (Test-Path -LiteralPath (Join-Path "./skills/$reviewName" 'SKILL.md'))) {
        throw "Missing source: $reviewName"
    }
}
New-Item -ItemType Directory -Path $reviewSkillsRoot -Force | Out-Null
foreach ($reviewName in $reviewNames) {
    Copy-Item -LiteralPath "./skills/$reviewName" -Destination (Join-Path $reviewSkillsRoot $reviewName) -Recurse
}
```

重新打开聊天，必要时重启客户端，确认能发现 `$gh-review`、`$local-review` 和 `$web-chat`。不额外创建 `.agents` 副本。安装成功不等于网页复审端到端已验证。

## 方式二：Skills Manager

将 Skills Manager 中心源作为唯一编辑与管理源，通过当前版本已验证的导入/安装界面选择本仓库 `skills/gh-review` 与 `skills/local-review` 完整目录。确认中心布局保持同级、共享引用可解析，再由 Manager 管理客户端链接。不要手工复制到客户端技能目录，也不要另外建立 `.agents` 同名入口。

首次安装先检查新旧名称与管理记录是否冲突。已有安装的改名必须保留原管理 ID、链接及安装关系，不能通过删除旧记录再导入来假装完成迁移。

本次预检：Skills Manager CLI 1.44 没有已验证的“保留管理 ID 改名”接口。因此本轮仅生成仓库候选，不修改 live 中心原两项、已有管理 ID、符号链接、安装关系、Manager 数据库或生产部署，也不宣称已完成本机迁移。不猜测 Manager 命令。

后续本机迁移步骤：先记录原两项管理 ID、中心位置、客户端链接与安装关系，备份；确认当前 Manager 提供可验证的保留 ID 迁移接口及回滚方式；经授权后用该接口迁移两项并更新链接；核对原 ID 保留、相对协议引用有效、每项只被发现一次。接口仍不可验证时保留旧记录和链接不动，继续使用候选而不部署。

## 更新与卸载

- 原生更新：先检查目标是否为独立目录，若为 Manager 链接则回到 Manager 流程。将两项及本地定制备份到技能发现目录之外，检查新版差异后成对替换完整目录，避免仅覆盖文件留下旧文件。核实协议引用并刷新客户端；需要回滚时恢复同一版本的两项备份。
- Manager 更新：只更新中心源并通过当前已验证的 Manager 流程同步，保留管理 ID 和链接关系，不直接写客户端副本。旧名迁移仍受上述接口限制。
- 原生卸载：核实实际技能根、两项路径及归属，备份后只移除这两个自管目录；递归删除前确认绝对路径仍在预期技能根内。不要顺带删除共享依赖 web-chat、MCP 或浏览器数据。
- Manager 卸载：通过当前已验证的管理界面移除这两项的安装关系；中心记录是否删除按界面含义及用户选择处理，不手改数据库、不盲删链接目标。卸载 review Skill 不等于卸载 MCP。

## 重复入口检查

刷新宿主技能列表，检查新旧四个名称；结合 Manager 安装列表和宿主实际技能搜索根，查看每个入口解析到的真实目录、frontmatter name 与链接目标。每项只能有一个发现入口；不要只按文件夹名判断，也不要扫描其他用户目录。备份和仓库候选不应再作为另一套客户端技能根加载。

发现重复时先核实 owner：Manager 管理的入口由 Manager 处理，自管副本先备份再移除。当前 live 仍用旧名、仓库仅有新名候选属于未部署状态，不代表已迁移或已验证最终发现唯一性。

## npm 包如何取得文件

本仓库 `package.json` 的 `files` 已包含 `skills/web-chat`、`skills/gh-review`、`skills/local-review` 和本安装文档。发布前运行 `npm run verify:package`，它根据实际 `npm pack --dry-run --json` 清单检查完整 Skill、唯一共享协议及安装说明，并拒绝已知运行数据或私有备份进入包。当前源码候选不等于已经发布的 npm 版本。

先运行 `npm pack <package-spec> --dry-run --json` 检查准确版本清单，确认所选已发布版本确实包含这些文件后，再用 `npm pack <package-spec>` 获取 tarball，解压其 `package/skills/gh-review` 和 `package/skills/local-review`，按上面任一方式成对安装。`<package-spec>` 替换为已确认的包名与版本；也可从源码 checkout 运行 `npm pack` 获取本地候选。npm 安装或 MCP upgrade/rollback 均不会自动安装、更新或卸载这些独立 Skill。
