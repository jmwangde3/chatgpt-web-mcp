# Private GitHub access probe

Public copy sanitized: the private synthetic repository name and original random marker value are withheld; the original evidence is retained only in a local untracked backup. Conclusions and evidence types below are unchanged.

Only repository/branch/SHA/path metadata was sent. The source marker value was not disclosed in the prompt. Codex independently confirmed the fixture repository is private.

VERIFIED — 读取成功

已通过当前已连接的 GitHub 集成，直接读取指定私有仓库的源码，无需 Codex 转交文件。

读取凭据

项目



实际结果




Repository



[私有合成测试仓库名称已脱敏]




Visibility



Private（按任务提供）




Branch



review/access-probe（按任务提供）




实际读取 Commit SHA



471ee9696cf7a885db8d67e17f218a3114884b15




文件路径



probe.py




文件 Blob SHA



d8973c40d07cda52d33c4d1de43a8ec69cdcf614




编码



UTF-8




读取结果



成功，完整源码已返回

源码：查看指定 SHA 下的 probe.py

REVIEW_ACCESS_MARKER

历史逐字读取证据（以下为脱敏摘要，不是原始源码）：

Python
运行
[源码证据：成功读取未在提示词中提供的随机标记；原始值已脱敏]

随机标记证据：

[私有合成测试随机标记原始值已脱敏]

最终判定

VERIFIED

访问的是指定私有仓库，没有使用其他仓库替代。
通过现有 GitHub 集成权限读取成功。
使用指定的完整 Commit SHA，而非默认分支最新版本。
实际读取 probe.py 源码，而非 README 或登录页面。
成功获取未由用户提供的随机标记。
未修改授权、仓库可见性或任何代码。
未执行代码。

结论：当前 ChatGPT 已连接的 GitHub 集成具备读取这个指定私有仓库、指定提交源码的实际能力。
