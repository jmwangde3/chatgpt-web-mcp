# V2.1 稳定性与双 Skill 候选验收

日期：2026-11-17。基线 `931988cfcdab92d9ee4c1d7d58f078c682152876`。本轮用户另行授权：完成网页审查／修复闭环后发布暂时稳定版并更新本机，覆盖任务书原先的发布暂停限制；在这些条件满足前不发布、不切换生产部署。

## 改动与提交

| 工作包 | 提交 | 主要文件与结果 |
|---|---|---|
| A | `55f0fec` | process-identity/locks、persistent-browser、browser、tasks、diagnostics、tools；锁身份／操作／心跳、无锁 journal snapshot、任务统计及老化、generation 原会话完成证据、控制器状态和脱敏超时诊断 |
| B | `bc6cd9f` | Windows security、native browser identity、persistent-browser、生命周期诊断；祖先有序 DACL、无端口独立进程核验、最新 PID 关闭、进程与端点双结束及状态实例复核 |
| C | `c8735eb` | gh-review/local-review 候选、唯一共享协议、REVIEW_SKILLS、npm files 白名单 |
| D | 当前 PR 后续提交 | 统一浏览器入口、verify-package、CI、历史默认说明、证据脱敏、测试数量和本报告；另修正可选轻量 provider 的诊断兼容性 |

当前完整 SHA 及最终 CI 以 PR 分支和运行记录为准；不能把旧的 workflow_dispatch 绿灯当作本轮 PR 事件验收。

## 本地离线证据

| 检查 | 实际结果 |
|---|---|
| npm ci | 完成，按锁文件安装；另有依赖审计遗留，见限制 |
| npm test | **302/302**，较原基线 221 项新增 81 项；包含 journal snapshot、真实锁／进程、generation 恢复、生命周期及祖先 ACL 单元 |
| npm run test:browser | **154/154**；原五组 106，发送保护 22，Windows 安全 8，围栏身份 18，合计补充 48；新入口只执行一遍各组 |
| Windows 真实 ACL | **8/8**，含三个祖先危险权限拒绝；拒绝前后 SDDL、文件内容、目录结构不变 |
| full/unified smoke | **63/17**，既有工具名和输入 Schema 基线测试通过 |
| 实际 pack 清单 | 当前候选 **64 文件**；包括两个完整 Skill、web-chat、唯一协议及 REVIEW_SKILLS，verify-package 实际检查；发布版本号尚未宣称已改变 |
| Skill 静态检查 | 两项 quick_validate、相对引用和唯一共享协议检查通过；无本机绝对路径依赖 |

首次完整浏览器运行 153/154：面板轻量 provider 没有 browser 对象，新增控制器诊断未作可选检查。修正后单项通过，并通过正式统一入口完整重跑 154/154；没有跳过该项。受限沙箱的临时文件 rename EPERM 不作为实现回归，通过正常用户权限的隔离测试复核。

Windows 正向安全 fixtures 位于正常用户本地临时目录。共享 scratch 卷祖先存在真实不安全权限时应拒绝，不能通过放宽实现或修改既有祖先 ACL 让测试通过。

## 安全与恢复行为

1. journal 占用、OS 文件锁、runtime generation、控制器连接状态分别诊断。submitted/uncertain 的老化只是派生提示，不写回状态、不取消任务。
2. 锁只有确认进程退出或创建身份不符时才能在 reclaim 互斥及 token 复核下回收。心跳过期、UNKNOWN 或存活身份均不能自动删锁；release 停心跳且不删新 token。
3. 原进程退出不会自动清 generation；必须核对原 URL、停止／流式状态和完整回答证据。无法连接时保留状态。显式 cancel/abandon 的空闲 settle 仍受原任务和会话验证约束。
4. attach 的底层尝试未结束时不创建第二条连接；晚到控制器不能发布给新操作。错误输出白名单 PID／端口／阶段／年龄及锁元数据，不包含 Profile 路径、命令行、URL 或用户内容。
5. terminate 重连后重读并验证新身份，只发一次 Browser.close；原目标进程和端口均结束才允许删除相同实例的状态。身份不明、超时或状态被新实例替换均保留记录。
6. 祖先权限按 SID、有序 Allow/Deny、mask 和继承作用域评估。对无法证明的组成员关系采用保守判断；CreateDirectories 不独立判为可替换受保护目录。没有自动修复已有 ACL。

恢复顺序：doctor → 无锁 tasks snapshot → 现有生命周期诊断 → 已核实端点重连 → 只按原 task_id 读取。活锁无响应时重启其 MCP 服务，不删除锁或终止未知 Chrome。独立会话和幂等记录保留。

## 真实环境与发布门禁

本轮初次网页咨询在接管前报 CONTROL_CONNECT_TIMEOUT，未发送业务内容。只读确认过专用进程与端口归属，CDP 握手和版本查询可达，未将既有 13 个 uncertain 当作根因。后续独立诊断已接回 signedIn=true，不能据一次恢复将具体根因归结为超时配置。

截至本报告提交准备阶段：尚未完成候选固定 SHA 的网页代码复审、最终 pull_request 事件 CI 和发布／本机切换。这些必须另行核实，未取得结果前状态为 **CONDITIONAL**，不冒充整体 PASS。

## Skill 迁移与剩余限制

- 仓库候选名称为 `gh-review`、`local-review`。本机 Skills Manager CLI 1.44 没有已验证的保留管理 ID／目录／链接的改名接口，因此按任务 C4 兜底，原中心记录和客户端入口不动。新候选的安装、更新、卸载及迁移条件见 [REVIEW_SKILLS.md](REVIEW_SKILLS.md)。
- npm 包提供文件不等于技能自动安装；不创建第二套 MCP，不自动改变工具集或宿主模型。
- 当前工作树已脱敏私有测试仓库名、私有随机值和本机路径，保留事实。历史公开提交未重写，既有公开记录不能据此声称被彻底抹除。
- npm audit 在既有锁文件报告 9 项依赖告警（含高／严重项）；未自动使用 audit fix --force。需在网页复审中核对实际使用路径及修复范围，不能称为无已知依赖风险版本。
- Linux 进程／端口核验需要双平台 CI 实测。macOS 没有相同独立浏览器所有权核验时，关闭操作保守拒绝；锁进程身份有 macOS 查询分支，但未在本机实测。
- 本轮未撤销私库授权、上传真实敏感内容、重发历史 uncertain、自动 abandon、清除账本、关闭专用浏览器或修改其 Profile／Cookie。原始诊断和测试日志保存在未跟踪的本机私有目录，不进入 npm 包。
