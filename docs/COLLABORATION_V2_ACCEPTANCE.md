# Collaboration V2 acceptance log

当前阶段结论：A 工程离线验收 PASS；B 真实网页闭环待登录，CONDITIONAL；整体暂为 CONDITIONAL。审查分支已推送，未合并、发布或部署；包版本与元数据未变。

Baseline: main `65c130ef9fb405dd12a13d6a0af9f8b225ece2c9`, Node 22.14.0/npm 10.9.2, clean checkout. Original baseline: unit 152/152, browser 106/106, smoke 63 tools, pack dry-run passed. Worktree dependencies installed with npm ci.

## A1 atomic send

- The guard is installed at document initialization, before application listeners. Before clicking, CDP verifies the first window click-capture listener is this exact guard. Existing uninitialized pages must refresh before preparing a draft; unknown earlier handlers cause a fail-closed refusal. The final synchronous guard checks the pinned nodes, exact raw draft, HTTPS configured origin and full conversation URL, writable composer, same form, visible/enabled send control, and upload indicators before application document listeners handle the trusted click.
- Uses the existing Playwright trusted click; no Enter, alternate selector resend or automatic retry. Ambiguous click/transport errors remain uncertain. Only explicit `SEND_NOT_ATTEMPTED` plus `sendOutcome=not_attempted` releases the reservation.
- Existing message-count, prompt identity and conversation acknowledgement checks remain intact.
- Local validation: original browser suite 106/106; added guard browser cases16/16; added durable outcome tests12/12 for both providers. Unit suite164/164 after A1.

## A2 Windows ownership and profile safety

- Constant PowerShell5.1 query scripts receive JSON through UTF-8 stdin; child timeout/output bounds; no interpolated paths or raw process command lines in diagnostics/state. Child-only system module path avoids PowerShell7 inheritance issues.
- Validates PID, creation time, executable, command-line profile/port/address and TCP listener PID. Legacy identity is enriched only after live verification. Unverifiable ownership prevents connection/termination and preserves saved state.
- Refuses links/reparse points, repository-contained profiles and foreign write ACLs. Initializes only directories just created by this call; does not recursively repair existing profiles. Read-only doctor never creates paths or changes ACLs.
- Local validation: identity/ACL unit32/32; query/legacy/unknown-owner tests7/7; real Windows security fixtures5/5 (junction, non-directory, unsafe ACL unchanged, query failure preservation, Unicode/space paths); session browser7/7; Gemini persistent lifecycle1/1. Unit202/202 before last unknown-owner case was added.
- Design reference (no Python code transplanted): [MCP-CodexGPT platform security](https://github.com/MosMotov/MCP-CodexGPT/blob/6b088fb15f1e9c3728cca2b642ab7b0316674237/platform_security.py).

## A3 CI

Expanded existing offline-browser job to Ubuntu/Windows; retained all existing tests and added guard/security fixtures. Only local synthetic pages and ephemeral profiles are used. GitHub CI results pending first branch push. No local VM or real AI login required.

## Remaining gates

该段记录 dd5a345 时的阶段门槛；A4 与 Skill 文件/分发验证已在后文完成。当前剩余项为真实 GitHub/Local 双轮审查、实际权限/路由场景及工作流 Token 对照。云端 CI 必须实测，不能由本地结果推定。
## First cloud run and review follow-up

Run [43906307224](https://github.com/jmwangde3/chatgpt-web-mcp/actions/runs/43906307224) at dd5a345: Ubuntu browser PASS; both platform unit/smoke/pack jobs PASS; Windows browser105/106, failed the pre-existing attachment fixture's250ms positive wait under runner load. The fixture's positive readiness budget will be increased while keeping negative assertions.

A review found that a late-installed window capture guard could run after a pre-existing same-target handler. This invalidated the old no-send proof; document-start installation plus runtime CDP listener-order proof replaces that approach. A new run is required. No production deployment has occurred.

Saved Windows process state that cannot be verified (including stale/dead PIDs) deliberately refuses connection and preserves the state/profile for explicit recovery. Live-process CDP disconnect/reconnect is tested. Automatic replacement after a browser crash is not claimed safe or verified.

## A3 successful gate / A4 toolsets

Run [43908050033](https://github.com/jmwangde3/chatgpt-web-mcp/actions/runs/43908050033) at 8c8a7c7: all four Ubuntu/Windows unit+browser jobs SUCCESS. A4 production changes started after this gate.

- Default `full` preserves63 baseline tool names and exact tool-definition hashes; `unified` exposes only the17 existing unified tools with unchanged schemas. Invalid configuration fails startup. Instructions match the actual registration.
- Actual stdio MCP tools/list tests passed in full, unset/default, unified, and invalid cases. No browser executable existed in the isolated test configuration; no profile/state artifacts were created. Both full/unified smoke passed after explicitly forwarding the toolset environment to the client child process.
- The existing smoke client's SDK transport omitted custom environment variables by default; explicit environment forwarding was necessary to test unified rather than silently launching full.

| Actual compact tools/list definitions | full | unified |
|---|---:|---:|
| tool count |63|17|
| UTF-8 bytes including descriptions |34147|12057|
| characters including descriptions |30351|12055|
| input-schema/name JSON bytes |19865|7399|
| token heuristic (characters/4, rounded up) |7588|3014|
| instructions characters |1176|833|

These are serialized definition measurements, not Codex billed-token measurements or Local/GitHub review-workflow savings. Run `node scripts/measure-toolsets.js` to reproduce. No tokenizer dependency was added and the user's runtime configuration remains unchanged.

## B0–B6：双模式 Skill 与分发（2026-11-17）

- 延用已安装的 `codex-chatgpt-review-github` 与 `codex-chatgpt-review-local`，不新增第三个 Router。共享协议只在 GitHub Skill 的 references 中保留一份，本地 Skill 通过相邻目录引用。
- 唯一编辑位置仍为 Skills Manager 中心源；仓库 `skills/` 下为从中心源导出的审查/分发快照，不新增宿主发现入口。
- 本次只在两份入口补充 V2 工具集门槛：A 已验收且宿主实际启用 unified 才优先统一工具；否则继续 full；不自动修改环境或全局配置。
- 两份中心源与导出目录格式校验通过；5个文件一致性见 [导出证据](evidence/skill-exports-v2.json)。Codex原有符号链接仍指向中心源，部署 dry-run 显示2技能/0新增或变更入口；未创建 `.agents` 同名入口。
- 旧安装记录曾引用V1草稿，中心源更新后 `skills check` 报 update_available。逐文件核实 GitHub 快照与中心源文本一致后，经 Skills Manager `set-source` 迁移至本审查分支，保留原技能ID、标签与部署。两项现均 `up_to_date`。中心源仍为日常唯一编辑位置；源码跟踪分支为本审查分支，合并后应按实际维护策略迁移到主分支。
- 全局 MCP 连接仍保持原 full 模式，未部署新服务代码，未改模型路由或现有浏览器实现。

## B7 场景验收账本（实时审查进行中）

以下严格区分规则已交付、Codex侧测试与真实网页端到端测试。没有网页独立实读证据的场景不能算PASS。

| 编号 | 场景 | 当前证据 / 状态 |
|---|---|---|
|G01|公开仓库独立读取|实际请求已提交，等待独立实读证据|
|G02|私有仓库已有授权|没有可核实的网页授权证据，未验证|
|G03|私有仓库无授权自动回退|规则已写入，真实权限场景未验证|
|G04|无remote回退Local|规则已写入；本地无Git证据采集成功，独立Agent路由未验证|
|G05|未推送代码安全同步|本工程审查分支已实测提交/推送/远端SHA一致；非网页Skill完整流程|
|G06|推送失败不得假成功|规则已写入，Skill级故障注入未验证|
|G07|错误SHA无效|规则已写入，网页错SHA场景未验证|
|G08|main变化仍锁定SHA|完整SHA要求已交付，独立场景未验证|
|G09|敏感文件阻止推送|提交范围检查已执行；未用真实敏感数据做上传测试，Skill场景未验证|
|G10|强制Local不推送|规则已写入，本地合成证据测试未push；独立Agent路由未验证|
|G11|强制GitHub无法读取阻塞|规则已写入，网页登录阻塞被如实报告；私库访问场景未验证|
|G12|新提交重新读取SHA|本工程已多批新SHA推送，网页实读未验证|
|G13|修复后对照新代码|Codex本地缺陷重现→修复→测试通过，网页复审未验证|
|G14|必要文件不能读取|规则已写入，网页缺文件场景未验证|
|L01|普通本地项目取材|Codex合成样例已实测；网页审查未完成|
|L02|单文件变化最小证据|范围规则已交付；独立Agent取材行为未验证|
|L03|多文件调用关系|范围规则已交付；复杂调用链场景未验证|
|L04|第二轮重新读取|Codex每阶段实际重读和hash已实测；网页复审未完成|
|L05|拒绝旧证据|文件hash变化已实测；网页旧证据拒绝场景未验证|
|L06|没有Git仓库|Codex合成样例已确认不属Git仓库、仍正常运行测试并取材|
|L07|禁止GitHub上传|Codex合成样例没有remote/没有push；独立Agent权限场景未验证|
|L08|MCP等待超时恢复原任务|TaskKernel离线恢复回归通过；真实网页任务恢复未完成|
|L09|证据过大适度分批|规则已交付；真实大证据分批未验证|

自动选择和手动覆盖的规则已交付；不得把阅读这些规则当成上述场景的行为测试。

### 曾出现的网页登录误报与当前修复

现有 MCP `chat_status`（本任务独立session）返回“专用浏览器尚未登录”；没有提交任何新的审查消息，因此没有新task_id可恢复。用户要求打开浏览器后，已使用现有项目登录入口打开专用登录窗口，等待手动认证。没有读取Cookie/凭据、接管日常Chrome、关闭其他浏览器或清理13项旧uncertain任务。此前V1失败请求没有重复发送。

### Local证据阶段的实际结果

[本地合成证据](evidence/local-fixture-v2.json)：初始2项通过；加入非整数均值断言后3项中1项失败；修复整除后3项通过。每阶段重新读取源码、测试并计算SHA-256，确认临时目录不属于Git仓库；没有GitHub推送，也没有ChatGPT回复。该证据仅验证Codex侧取材和修复，不能算完整Local双轮PASS。

## B8：Local/GitHub工作流效率

目前没有完成同一合成任务的两种网页审查闭环：Codex额外Token、网页实际读取文件数、两轮审查时间和真实发送内容长度均缺乏可比较的测量，记为N/A。A4的工具定义体积对比不能代替这项工作流A/B测试。没有使用虚构节省率。
## 当前总判定与审核范围

- **WORK PACKAGE A: PASS（工程离线验收）**。A1–A3 在 `8c8a7c7` 的 [CI43908050033](https://github.com/jmwangde3/chatgpt-web-mcp/actions/runs/43908050033) 四任务全绿；完整 A1–A4 代码 `fe93eb9` 的 [CI43910588482](https://github.com/jmwangde3/chatgpt-web-mcp/actions/runs/43910588482) 也四任务全绿。本地最终单元206/206、发送专项19/19、Windows安全专项5/5，full/unified smoke通过，pack dry-run通过，diff check通过。没有声称已在真实账号部署新代码。
- **WORK PACKAGE B: CONDITIONAL**。两项Skill中心源、单份协议、分发与静态验收通过；真实复审完成前，GitHub独立实读、私有仓库权限、真实双轮复审、任务恢复及23场景行为验收仍不完整。不得作为完整端到端PASS。
- **OVERALL: CONDITIONAL**。代码可交审；正式稳定使用的完整验收仍依赖后续真实网页证据。

### 审核文件与影响

| 范围 | 文件 | 原因及兼容影响 |
|---|---|---|
|原子发送|src/browser.js、src/shared/send-guard.js、src/core/tasks.js|初始化时提前安装校验器，点击前证明顺序，事件内做最终精确校验；明确未发送才释放任务，保留原消息身份验证|
|Windows安全|src/shared/windows-security.js、src/shared/persistent-browser.js、src/core/diagnostics.js、src/providers/adapters.js|进程创建时间/可执行文件/Profile/端口所有权、路径/ACL和只读诊断；不修复既有权限、不关闭未知进程、不存储完整命令行|
|工具集|src/config.js、src/index.js、scripts/smoke-mcp.js、scripts/measure-toolsets.js|默认full63工具兼容；可选unified17工具，动态说明；不改全局连接|
|CI与测试|.github/workflows/ci.yml、test/、integration/|Ubuntu/Windows离线fixture；现有测试保留，附件成功等待适配runner负载，负向断言保留|
|文档/技能|README.md、README.en.md、.env.example、skills/双Skill、docs/evidence/|明确能力边界、中心源导出快照和可复核证据；不新增第三入口或浏览器实现|

修改前HEAD：`65c130ef9fb405dd12a13d6a0af9f8b225ece2c9`；完整工程代码HEAD：`fe93eb9`；审查分支：`review/chatgpt-collaboration-v2`。后续文档/Skill快照提交不代表新生产部署。实际当前HEAD以GitHub审查分支为准。原仓库main及其工作区未写入本次源码改动；所有生产改动在隔离工作副本完成。本地HANDOFF不提交。

### 后续必要事项

1. 当前已确认账号登录，继续本任务独立会话的真实复审；不再要求重复登录，不清理其他任务或读取凭据。
2. 用无敏感专用测试仓库执行GitHub固定SHA双轮审查；私库分别核实网页授权，不以Codex授权替代。
3. 对同一合成任务完成Local两轮、真实观察超时后的同task_id恢复，以及完整路由场景。
4. 记录真实请求字符数、文件读取次数、轮数/时间；无法获得精确Token时继续标明估算或N/A。
5. 本审查分支合并后，按维护策略迁移Skills Manager远端跟踪分支；中心源仍是唯一编辑位置。

## 实机发现的启动父子PID问题（后续修正）

用户指出可见页面已经登录。原登录辅助进程在启动时还遇到 `AbortSignal=null` 错误；同时Chrome实际监听进程为启动PID的直接子进程，保存的父PID已经退出。专用Profile和账号会话没有丢失。不能把接管失败直接解释成账号需要重新登录。

- `PersistentBrowser.connect` 现将空signal归一为undefined，并允许Windows已验证启动链在父进程正常退出后有界等待实际监听进程。
- 只有尚未补充创建时间的启动记录、实际进程是记录PID的直接子进程、创建时间落在启动记录的紧密窗口内，才允许迁移；可执行文件/Profile/端口/loopback检查仍全部保留。已验证创建时间的记录不能任意迁移PID。
- 新增15项模拟回归，身份查询文件22/22；完整单元221/221；包含connect(null)的真实临时浏览器回归通过。
- 在实际窗口只读核实完整身份后，取得操作锁、备份旧状态，仅补正实际PID等身份元数据。未改Cookie/Profile内容或原13项uncertain记录；现有MCP随后明确返回signedIn=true。
- 该修正源码仍在审查分支，未覆盖已运行服务代码。当前实例恢复依靠经过验证的兼容状态迁移。
- 已用独立session实际提交GitHub合成仓库审查；首次1秒观察到期返回running/timed_out=true，仍保留原task_id继续读取，没有重发。
