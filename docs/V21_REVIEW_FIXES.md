# V2.1 网页复审问题闭环

日期：2026-11-17。首轮固定候选为 `204bb07def5b1fe6fd02581c9667a0490586449b`，用户提供的网页审阅结论为 **NEEDS_FIX**。本文件记录后续修复，不将该结论改写成通过。

## 问题与实现

| 问题 ID | 修复 | 验证方向 |
|---|---|---|
| LOCK-01 / LOCK-02 | 完整记录写入临时 inode 并 flush，通过排他硬链接原子发布；reclaim 本身采用相同可恢复协议 | 真实子进程在准备、发布、释放和回收阶段被强杀；并发回收、活锁和替代 token 保留 |
| WIN-01 / WIN-02 | 保护对象同时检查读取及修改权限；检查未来后代的继承规则，递归核实已有 Profile 子对象，拒绝内部 reparse point | 读取权限、inheritOnly、独立子文件 ACL、内部 junction；拒绝前后 ACL、字节和目录结构不变 |
| WIN-03 | 核实 TaskKernel 实际存储目录和 journal/lock；覆盖自定义 operationLock 父目录及 runtime lock；doctor 分别报告存储安全 | 使用实际 TaskKernel 读写路径验证不安全 ACL 会在副作用前被拒绝 |
| GEM-01 | Gemini 复用文档初始化的可信点击守卫；发送边界同步核对绑定节点、URL、完整草稿、附件和消息数量 | 持久化间隙修改草稿、会话、节点、附件及用户消息时均拒绝错误点击 |
| TASK-01 / TASK-02 | Stop 绑定原任务身份；优先复用早期守卫并核实事件顺序；取消前后、abandon 和 settle 都复核消息身份 | 不同会话、同会话手动新消息、消息修改、按钮替换、传输异常及准确一次点击 |
| STATE-01 | 原子状态 writer 对瞬时 rename 错误有界退避；spawn 前持久化 launch intent，状态可靠保存后才 unref | 真实并发读取直接调用生产 writer；永久失败保留原记录；不确定 launch 阻止第二次启动 |
| LINUX-01 / CI-01 | 精确核实 launcher 到实际 ELF 的关系，保存实际身份，保留 flags/start/socket inode 验证 | 直接 ELF、符号链接、受支持 wrapper、错误路径、PID 变化和无监听；最终仍需 Ubuntu CI |
| LINUX-02 / LINUX-03 | Z/X 状态视为死亡；MCP 新数据目录 0700、文件 0600，验证现有权限及祖先，拒绝自动修复 | POSIX 专项在 Linux 执行，Windows 按平台跳过 |
| DEP-01 | 三个 full 工具的 files 均限制 10 个；SDK/Zod 和可修复传递依赖更新 | 11 文件输入拒绝、旧完整 Schema 逐项比较、真实 MCP 非法字段拒绝、审计 |
| PR-01 | 保留 PR 的真实 main 基线；下一轮复审明确覆盖完整 PR 差异 | 不把首轮仅四个提交的 Diff 审查冒充此前 11 个提交的完整审查 |

ChatGPT 自动解除 generation 额外要求准确用户数量和提示词哈希。没有这些字段的历史记录不会只因页面空闲、owner 退出或出现新回复而被自动解除；显式恢复仍须核实原任务。旧请求记录和幂等标识继续保留。

## 兼容与平台边界

- full/default 仍注册 63 个工具，unified 注册 17 个工具。旧 Schema 的每个约束均与完整历史 fixture 比较，原历史 hash 未改写。
- 明确的输入变化：三个 files 数组增加 `maxItems: 10`；offset 限制在安全整数范围内；非空参数对象拒绝未声明字段，与此前已发布的 `additionalProperties: false` 一致。参见 [Schema 核验说明](../test/fixtures/schema-compatibility.md)。
- Linux wrapper 只解析明确支持的形式，不执行脚本、不按 basename 放行；Snap/Flatpak 和无法证明的子进程接管保守拒绝。发行版 wrapper 参考 [Chromium 官方源文件](https://chromium.googlesource.com/chromium/src/+/HEAD/chrome/installer/linux/common/wrapper)。
- POSIX Profile 的隐私边界是经过验证的私有根目录；Chrome 管理其内部文件和 SingletonLock。MCP 自己的状态、任务和锁文件另行检查，不修改已有目录权限。
- Windows 实测 Chrome 会给缓存与网络存储添加专用沙箱能力。仅识别 [Chromium 固定的五个通道能力名](https://chromium.googlesource.com/chromium/src/+/HEAD/chrome/browser/chrome_content_browser_client.cc)，限定在 Default 的缓存、Network、Shared Dictionary、Safe Browsing Network 及精确匹配的扩展默认网络分区；显式 MCP 私有文件和目录树不适用此规则。普通账户、未知 capability、Profile 根目录、所有权及祖先权限检查不放宽。沙箱存储授权机制见 [Chromium 网络沙箱源码](https://chromium.googlesource.com/chromium/src/+/HEAD/content/browser/network_sandbox.cc)，SID 原生核验使用 [Windows 官方 API](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-derivecapabilitysidsfromname)。未验证的浏览器能力名保持拒绝。
- 当前依赖为 SDK 1.32.2、Zod 4.6.7、proxy-addr 2.0.8；更新后的 `npm audit` 报告 0 项。此结果是当次 registry 审计结果，不代表未来没有新公告。
- Skills Manager 的保 ID 改名接口仍未验证；按原任务 C4 兜底保留旧中心、ID 和链接，不将仓库改名宣称成本机迁移完成。

## 验收状态

最终本机验收环境为 Windows、Node 22.14。单元测试共 451 项：449 通过、2 项 POSIX 测试按平台跳过、0 失败（`.v21-private/unit-final-rerun.log`）；浏览器测试 256 项全部通过（`.v21-private/browser-final-rerun.log`）。full 63 个工具、unified 17 个工具的 smoke 均通过；npm pack 包含 67 个文件；npm audit 为 0 项。

已在 GitHub Actions 页面观察并点击启用 fork 工作流，此操作不作为实际 CI 通过的证据。当前仍需新固定 SHA 网页复审、真实 `pull_request` 事件的双平台 CI 和生产恢复验证。先前手动运行 `44019477524` 的 Ubuntu 浏览器失败属于旧候选，不能代替本轮验收。未满足这些条件前不发布或切换本机生产服务。
