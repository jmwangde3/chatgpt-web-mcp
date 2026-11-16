# ChatGPT Web × Codex 协作体系 V2.0 · 实施与验收报告

日期：2026-11-17。审查分支：`review/chatgpt-collaboration-v2`；[草稿PR #1](https://github.com/jmwangde3/chatgpt-web-mcp/pull/1)。

**WORK PACKAGE A：PASS（工程与离线验收）。WORK PACKAGE B：CONDITIONAL（核心真实双模式、功能分批及部分Git边界已验，仍有外部故障边界待验）。OVERALL：CONDITIONAL。**

代码已可审核；不把决策模拟当成全部真实环境测试。未合并、打Tag、发布版本或替换运行中的服务代码；全局MCP连接仍保持原full模式。

## 1. 基线与修改范围

- 修改前HEAD：`65c130ef9fb405dd12a13d6a0af9f8b225ece2c9`，原main工作区干净。
- 完整生产改动HEAD：`20069e5`；后续提交主要补充Skill与测试证据。实际提交后HEAD见PR分支。
- 环境：Node22.14.0、npm10.9.2、包版本0.7.11；未改package.json版本、作者、仓库等元数据。
- 原基线：单元152/152、离线浏览器106/106、smoke63工具、pack dry-run通过。隔离副本执行npm ci成功。
- 全部源码改动在隔离工作副本完成，原服务仓库源码未覆盖；没有reset --hard、force push、自动stash或默认分支推送。

| 文件 | 实际变化与原因 | 兼容影响 |
|---|---|---|
|src/browser.js、src/shared/send-guard.js|文档初始化时安装一次性发送保护器；点击前经CDP核对首个window捕获处理器的精确身份；事件内检查原始全文、页面URL/HTTPS/origin、绑定节点、可写/可见/启用、同form与上传状态；按已观察到的PRE/CODE结构保守还原围栏身份候选|保留Playwright可信点击；不使用Enter、改选择器重发或DOM原生click兜底。旧页面未初始化或顺序无法证明即拒绝；matchesUserPrompt/textHash全文匹配规则不改|
|src/core/tasks.js|只有SEND_NOT_ATTEMPTED与sendOutcome=not_attempted双标记才释放为failed|点击结果不明、断线、身份不匹配仍uncertain；原消息数量、identityCandidates、matchesUserPrompt及会话核验保留|
|src/shared/windows-security.js、src/shared/persistent-browser.js|校验PID/创建时间/程序/Profile/调试参数/端口监听归属；处理经过验证的Chrome直接子进程接管；null signal归一；路径、reparse、ACL检查|旧状态验证后升级；不删除旧状态或关闭未知进程，不递归修复现有Profile权限。只有本次新建目录初始化私有ACL|
|src/core/diagnostics.js、src/providers/adapters.js|增加不创建目录、不改变ACL的本地安全诊断与配置传递|不输出完整进程命令行、凭据、对话内容；不能确认时fail-closed|
|src/config.js、src/index.js|默认full，显式可选unified；instructions随实际注册工具生成|full63工具名称及Schema与改前精确基线一致；不删除旧工具、不改统一接口Schema|
|scripts/smoke-mcp.js、scripts/measure-toolsets.js|两模式smoke、实际MCP定义体积测量；明确向测试子进程传递工具集环境|不启用真实浏览器；未新增Tokenizer或浏览器框架|
|.github/workflows/ci.yml|扩展现有离线浏览器任务至Ubuntu/Windows；分别安装Chromium；保留所有原测试并增加专项|不登录AI、不读取真实Cookie/Profile、不要求本地VM|
|test/、integration/|新增发送结果、处理器顺序、Windows身份/ACL/Unicode路径/旧状态等回归|Windows专属ACL测试在Windows真实执行，Linux保留其余浏览器与模拟安全测试|
|README.md、README.en.md、.env.example|记录full/unified能力边界、默认配置、恢复约定|默认仍full，不修改用户全局配置|
|skills/双Skill及共享协议|从Skills Manager中心源导出的审查/分发快照|没有第三Router，没有新发现入口，没有第二套MCP实现|

## 2. 工作包A的实际验收

| 项目 | 判定 | 证据 |
|---|---|---|
|P0原子发送|PASS（离线）|19项真实Chromium专项；正常可信点击一次、全文差异、失效节点/页面/上传状态、模糊结果、前置捕获处理器及未初始化页面拒绝|
|P1 Windows安全|PASS（工程/离线）|22项进程查询与迁移测试、32项身份/权限规则测试、5项真实Windows目录/ACL专项、真实临时Chrome连接/断开/重连/关闭|
|P1双平台浏览器CI|PASS（已记录版本）|[20069e5的CI43915197406](https://github.com/jmwangde3/chatgpt-web-mcp/actions/runs/43915197406)四任务全绿；此历史结果不证明围栏补充及后续新提交已在云端通过|
|P2 full/unified|PASS|真实stdio MCP的full/default/unified/invalid启动测试；63个基线工具及全部定义哈希一致；unified仅17个既有chat_*；两种smoke通过|

最新本地完整单元：**221/221**；本轮完整浏览器**106/106**通过，另行执行19项发送、5项Windows安全及18项围栏专项。full/unified smoke与pack dry-run通过；git diff --check通过。

围栏补充源码提交为`2a2bfeff606849646116029f94d12956d6c0a521`，双平台结果见[补充CI43935043574](https://github.com/jmwangde3/chatgpt-web-mcp/actions/runs/43935043574)，具体状态以该次运行记录为准；后续仅报告文字更新不改变该源码版本。

Local分批的真实页面将两个Python围栏渲染为PRE/CODE，原inline候选不足以确认全文身份，首批任务因此进入uncertain。`src/browser.js`仅补充该已观察结构的保守围栏还原：最后用户消息、明确PRE及CODE复制标志、可见且无嵌套、最多32块/100k字符、单个完整候选；`matchesUserPrompt`和`textHash`全文匹配规则未改，没有截断或模糊匹配兜底。按主Agent本轮执行记录，围栏新专项18项，合并旧30项为**48/48**；全部补充专项为**18＋19＋5＝42/42**。本地单元仍**221/221**；full/unified smoke分别63/17工具，退出码均0。上述新增本地结果不等于云端新提交已经绿。

首轮Windows CI发现旧附件测试的250ms成功等待在runner负载下不稳定：仅将成功等待预算提高至3000ms，负向断言仍用250ms，没有跳过测试。P0复核曾发现晚注册保护器可能晚于应用同层捕获器；已改为文档初始化注册及CDP顺序证明，新增复现回归通过。

### 已登录误报的实机诊断

用户指出页面已经登录后，通过专用可见窗口确认了历史会话与输入框；没有再要求重复认证。当前实例的保存PID是已退出的启动父进程，CDP端口监听者和可见窗口则是它的直接子进程；同时旧登录入口启动时存在AbortSignal=null异常。

本次修复将null转为undefined，并只允许严格受限的PID迁移：旧记录尚无创建时间、实际进程为记录PID的直接子进程、创建时间位于启动记录的紧密窗口内，且程序/Profile/端口/loopback全部一致。已经有创建时间的记录不允许任意换PID。

在只读验证真实进程身份后，取得操作锁、备份旧状态，仅补正当前实例身份元数据；没有修改Cookie、Profile内容、全局headless配置或原13项uncertain任务。现有MCP随后明确返回signedIn=true，真实审查得以继续。临时可见窗口复用了专用Profile。该证据定位本次接管问题，不能据此断言历史全部CONTROL_CONNECT_TIMEOUT都同源。

## 3. 工作包B：Skill与实际工作流

### 规范源与分发

- 两项Skill：codex-chatgpt-review-github、codex-chatgpt-review-local，仍在Skills Manager中心源唯一编辑。
- 共享规则仅一份：GitHub Skill的references/code-review-protocol.md；Local通过相邻目录引用。
- Codex原有符号链接继续指向中心源；两项格式验证通过；5份导出与中心文本一致，见[一致性证据](evidence/skill-exports-v2.json)。没有新增.agents同名入口。
- 管理器原记录曾指向V1草稿；核实GitHub快照与中心文本一致后，经现有set-source机制迁移到审查分支，保留原ID和部署。两项skills check均up_to_date，部署dry-run为2技能/0变更入口。合并后应按维护策略迁移远端跟踪分支；中心源仍为唯一日常编辑位置。
- 只有A工具集已验收且宿主实际启用unified时才优先统一工具；未启用则继续full，不自动改环境、模型路由或宿主配置。

### GitHub真实双轮：PASS（本合成任务）

[专用公开测试仓库](https://github.com/jmwangde3/chatgpt-collaboration-review-fixture)，仅自建算术均值代码，无用户业务数据。初轮提交`744df28e0f2f65823f81717535ad3db4bdf46e64`，基线2/2测试通过。只向网页发送仓库/分支/SHA、任务和测试元数据，没有发送源码副本。

网页实际读出实现、测试、README及Diff，指出整除错误AVG-001和测试缺口AVG-002。Codex加入非整除、负数和浮点断言，先实测5项中3项失败；改为普通除法后5/5通过，推送新SHA`76eb2dc6b775bae3d1c73a58c0910a68498642d7`。

第二轮沿用原session、新request_id；网页按新SHA读取并逐字返回未在提示词披露的随机review-version注释，确认两项VERIFIED、无新问题、PASS。没有依靠浮动main或Codex的完整代码摘要。

证据：[首轮](evidence/github-round1.md)、[复审](evidence/github-round2.md)。

### Local真实双轮：PASS（本合成任务）

同一任务置于无Git本地目录；每轮从磁盘读取两个必要文件、行号、SHA-256，第二轮附实际Diff与5/5测试结果，没有GitHub push。初轮网页指出同一整除错误；Codex独立复现3项失败并修复；复审正确回显新Evidence ID、两份完整哈希、更新源码，AVG-001变为VERIFIED并PASS。

证据：[首轮](evidence/local-round1.md)、[复审](evidence/local-round2.md)。初始与最终源码和断言文本与GitHub样本一致；Git采用LF、Windows磁盘为CRLF，**字节哈希不同但规范化文本相同**，见[对照核验](evidence/fixture-equality-v2.json)。

### 私库与恢复：实际验证

- 新建仅含合成probe.py的专用私有fixture，Codex核实isPrivate=true。网页通过已有GitHub集成读取完整SHA`471ee9696cf7a885db8d67e17f218a3114884b15`，返回未在提示词披露的随机标记和正确blob SHA。没有改变授权或公开私库。见[私库证据](evidence/private-read-v2.md)。这只证明该账号对该测试仓库的实际访问，不代表所有私库均可访问。
- GitHub初轮用短观察窗口实际得到running/timed_out，再继续读取原task_id直到completed；同一轮仅发送一次，没有换request_id重发。两个模式各保持同一会话两轮，独立任务使用不同session。

### Local真实两批：PASS（本合成功能范围）

主Agent按每批10,000字符预算发送4份完整合成源码，源码合计15,198字符；两批提示词分别8,028和8,185字符。首批出现SEND_UNCONFIRMED/uncertain后，只恢复读取原task_id，不重发、不覆盖任务日志，最终completed；网页首批明确INCOMPLETE，等待必要文件齐备。次批随后completed并返回静态功能审查PASS。

网页正确回显4份声明SHA-256、两个目录版本`batch-a-8658dc58b487`和`batch-b-69f2aa76a991`，跨文件数据为4083＋7358＝11441。网页明确没有独立计算哈希或执行测试；3/3、退出码0是本机测试记录。该结果覆盖多文件依赖、顺序分批和原任务恢复，不是模型上下文极限压力测试，也不代表生产验收。见[完整两批响应及证据](evidence/local-batches-live-v2.json)。

## 4. 场景覆盖：真实证据与决策模拟分列

独立Sol low Agent按两个Skill执行25项离线决策场景，主Agent核对路由、推送门禁和停止条件，25/25决策符合预期；明确simulation=true，**不是25项真实外部故障测试PASS**。见[场景记录](evidence/scenario-agent-v2.json)。

| 编号 | 场景 | 真实证据 / 限制 |
|---|---|---|
|G01|公开仓库|真实双轮读取与修复复审PASS；自动路由另有模拟|
|G02|私库且网页授权|真实指定私库/SHA/隐藏标记读取PASS|
|G03|私库无授权回退|403回退决策模拟通过；未撤销账号权限制造真实拒绝|
|G04|无remote|无Git Local双轮PASS；auto路由为决策模拟|
|G05|未推送修改|真实安全提交、非默认分支推送、远端SHA核对、网页实读|
|G06|推送失败|真实clone公开合成fixture，新review/failure分支提交后由客户端pre-push hook拒绝；仅一次push、退出1，远端该分支前后均不存在，不重试、不发网页复审。不是服务端权限故障|
|G07|旧SHA回放|读取真实github-round1.md的744df28e…，对比远端review/average-v2的76eb2dc6…及实际Diff，Agent按Skill拒绝旧结论为INVALID_REVIEW；无推送、无代码修复|
|G08|main发生其他提交|独立local bare fixture真实推进main；固定旧SHA文件内容前后相同。属于真实Git组件测试，不是GitHub完整场景；未改GitHub默认分支|
|G09|敏感候选门禁|自建临时clone中检查含合成.env的候选集合，仅含SYNTHETIC_TEST_VALUE_NOT_A_CREDENTIAL；Agent在暂存/提交/推送前阻断，HEAD和远端均未变。是Agent执行Skill门禁，不是已有scanner；无真实密钥|
|G10|强制Local|实际无Git本地模式未push，完成两轮|
|G11|强制GitHub不可访问|阻塞决策模拟通过；无效SHA真实任务仍超时，等待用户是否延长，保持待验，不判PASS|
|G12|新提交复审|实际新SHA及未披露标记实读PASS|
|G13|修复后重核代码|两模式实际复现、修复、测试、新版本VERIFIED|
|G14|必要文件无法读|INCOMPLETE决策模拟通过；缺文件真实任务仍超时，等待用户是否延长，保持待验，不判PASS|
|L01|普通本地项目|实际两文件证据与两轮审查PASS|
|L02|单文件变化|最小必要调用上下文选择为决策模拟|
|L03|多个相关文件|真实两批4文件、15,198源码字符；四声明哈希及两目录版本回显正确，跨文件4083＋7358＝11441，静态功能审查PASS；网页未独立算哈希或执行测试|
|L04|第二轮修改|实际重新读文件/行号/Diff/哈希/测试PASS|
|L05|旧代码已变化|实际第二轮新证据与哈希回显一致，未使用旧版本|
|L06|没有Git|实际无Git两轮PASS|
|L07|不允许GitHub push|实际Local不push，必要代码经授权发送ChatGPT；完全禁止外发另有停止模拟|
|L08|观察超时恢复|除GitHub原task恢复外，Local首批uncertain后真实读取同一原task至completed，无重发；第二批completed PASS|
|L09|大证据分批|真实两批顺序覆盖4文件；每批预算10,000字符，提示词8,028/8,185字符；功能分批PASS，不是模型极限压力测试|

G06–G09的退出码、远端SHA/无分支证据及动作见[真实Git边界记录](evidence/git-boundaries-live-v2.json)；L03/L08/L09见[Local真实分批记录](evidence/local-batches-live-v2.json)。这些局部验收不扩大为全部GitHub故障场景PASS。

## 5. Token与效率对照

### A4实际MCP定义体积

| 指标 | full | unified |
|---|---:|---:|
|工具数|63|17|
|完整工具JSON UTF-8字节数（含描述）|34,147|12,057|
|完整工具JSON字符数|30,351|12,055|
|输入Schema/名称JSON字节数|19,865|7,399|
|Token粗估（字符/4向上取整）|7,588|3,014|
|instructions字符数|1,176|833|

[实测数据](evidence/toolset-metrics-v2.json)可用node scripts/measure-toolsets.js复现。Token只是启发式估算，不是精确Tokenizer计数或账单；未新增依赖。

### 同一真实任务的两模式对照

| 指标 | Local | GitHub |
|---|---:|---:|
|用于额外证据打包的Codex文件读取|4（每轮2）|0（仍正常读代码、测试与Diff）|
|网页请求轮数/发送次数|2/2|2/2|
|两轮提示词字符数|1,160＋2,281＝3,441|813＋699＝1,512|
|发送源码字符数（不计行号）|380＋676，另有712字符Diff|0|
|网页报告读取的文件数|每轮2|每轮3（含README）|
|首任务创建至第二轮首次读完的观测间隔|318.156秒|486.317秒|
|Codex额外实际计费Token|N/A，运行时未提供分步骤计量|N/A，同左|

[原始观测汇总](evidence/workflow-comparison-v2.json)。本样本GitHub模式确实省去了源码证据打包，提示词字符数较Local少约56%；但GitHub观测耗时更长，且时间包含调用方整理/并行等待，不能当成纯模型延迟。只有一组小型合成样本，不能推导一般性能或精确Codex Token节省率。两种模式均发现同一功能错误并对更新代码复审通过。

## 6. 最终结论与遗留项

- **A：PASS（工程与离线范围）**。四项工程改造及已记录版本的双平台离线CI通过；221项单元、围栏相关合并48/48与补充专项42/42、两模式smoke通过；历史pack及diff检查通过。围栏补充尚无云端新提交绿灯结论；新源码仍待审核，未覆盖运行服务。
- **B：CONDITIONAL**。公开GitHub双轮、Local双轮、私库已授权实读、版本绑定、原任务恢复、两批4文件功能验收和Skill分发已有真实证据；G06–G09按各自客户端/Agent门禁或组件范围通过，不扩大为全部外部故障验收。
- **整体：CONDITIONAL**。可以受监督试用和代码审核；尚不能称为所有场景均完成真实外部集成验收。

剩余：G03真实403/私库无授权拒绝仍未实测；G11无效SHA与G14缺文件真实任务仍超时，等待用户是否延长，保持待验。服务端推送权限拒绝不在本次客户端pre-push证据内。模型极限压力及精确账单Token仍未实测；本次10,000字符预算分批不能替代这些证据。围栏补充及后续新提交的云端CI状态未据此核实。没有为了测试而撤销权限、公开私库、上传真实敏感内容或改GitHub默认分支。账号当前已登录，**不需要重复登录**。

Git边界临时目录仅含本次生成的合成fixture，未清理，保留供追溯。缺文件/无效SHA任务及原编号见[待验记录](evidence/github-boundary-pending-v2.json)。

保留公开/私有合成fixture仓库供追溯，不删除用户资源。Skills Manager远端目前跟踪此审查分支，合并后再按维护策略迁移；中心源仍唯一编辑。后续若要部署新服务，应走现有安装/更新流程，本次没有擅自切换全局配置。
