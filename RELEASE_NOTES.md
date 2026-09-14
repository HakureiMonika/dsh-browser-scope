# DSH BrowserScope 1.0.0-rc2 — DSH 0.1.5-rc.2 Release Candidate

## 发布定位

`1.0.0-rc2` 是后续候选版本。它面向公开发布展示，并提高文档的可读性。RC1 已验证的 BrowserScope 运行能力保持不变。公开文档分为产品首页、测试报告、技术细节和安全策略四个部分。npm 预发布标签和公开访问级别检查也已加入。

DSH RC1→RC2 兼容迁移不需要修改 BrowserScope 业务 API。已审计直接使用的 14 个 DSH Peer，以及组合启动、Web App 和宿主包的官方 npm 包差异。相关包只有 `package.json` 版本联动。发布实现、类型声明、导出入口和 Client 资源没有变化。所有直接 DSH Peer 已精确迁移到 `0.1.5-rc.2`。完整运行验证仍以 `0.1.5-rc.1` 为基线。本次兼容迁移没有重复运行无关的大型浏览器测试。

同一条尚未冻结的 RC2 工作线还加入了可靠性修复。Controller 将完整浏览器工具列表放入可滚动的二级栏。默认注册模式为 `session-select`。正式 Session 第一次使用浏览器前必须选择 BrowserScope 或其他浏览器工具，选择后在该 Session 内保持锁定；释放 BrowserScope 资源不会解除选择，需要换插件时必须新建 Session。显式全局模式发现已有浏览器工具时会安全降级，避免安装顺序导致 DSH 启动失败。代理支持系统、直连和自定义 HTTP/HTTPS/SOCKS 模式。浏览器启动参数删除了非必要开关，并继续复用共享 Persistent Profile。这些调整用于保持人工安全验证的连续性，不会绕过 Cloudflare/CAPTCHA。自适应实况改用 Host 初始化状态、串行尺寸上报和测量代际。双页支持上下和左右方向，并兼容 v1→v2 布局偏好。默认大型测试聚合脚本和不稳定的工具数量运行时自检已删除。隐私摘要、Source Map/CRX 内容身份和历史冻结候选完整性 Hash 保持不变。

## 相对 RC1 的变化

- `session-select` 改为单 Session 单浏览器选择：新正式 Session 初始为 `unselected`，选择前暂时隐藏识别到的浏览器工具；第一次选择 BrowserScope 或其他浏览器工具后，该 Session 不能再改选。
- 释放 BrowserScope 资源只关闭本插件页面和调试状态，不注销 BrowserScope 工具，也不恢复第三方浏览器工具。需要换插件时新建 Session。
- Controller 持久记录升级为 schema v2。旧 `dsh-browser-tools` 激活状态继续锁定 BrowserScope；旧 `other` 状态迁移为 `unselected`；损坏记录保持尚未选择。
- DSH 重启或 Agent Scope 替换后继续恢复原选择。已经持久锁定 BrowserScope 的 Session 即使本次恢复失败，也不会降级为可改选状态。
- Host RPC 从 `controller_deactivate` 改为 `controller_select_other`；Client 菜单改为一次性选择和资源释放，不再提供中途退出后改用其他插件的入口。
- Controller 专项、真实 DSH Agent Scope 集成、严格 TypeScript 和正式 Host/Client 构建已经通过。真实 DSH `0.1.5-rc.2` Web 也已完成两个 Session 的首次选择、资源释放不解锁、独立锁定和重启恢复验收。
- README 改为产品首页，采用产品推介语气，面向 DSH 用户、插件开发者和测试诊断团队。内容依次为插件简介、能力测试结果、能力展示、安装、功能介绍、兼容范围、使用反馈和 License。
- `VALIDATION.md` 改为纯测试文档，标题为“DSH BrowserScope 测试报告”。每章按测试目的、测试内容、测试过程和测试结果组织，不包含产品主张，也不含截图。
- 新增 `TECHNICAL.md`，集中记录配置项、工具注册模式、浏览器状态模型、安全边界、内部标识、30 工具清单和九视图说明。README 只保留指向它的链接。
- 对比测试对象统一写为“当前较常见、使用率较高的成熟浏览器插件”。公开文档不点名，也不根据一个对照对象判断整个插件生态。
- 公开文档不再使用“第一梯队”这类需要背书的判断，改为直接陈述已验证的能力事实。
- npm 包白名单从 RC2 无图阶段的 9 个文件增加到 20 个文件。包中保留 `VALIDATION.md`，新增 `TECHNICAL.md`，并加入 `assets/` 下 10 张真实 DSH Web PNG。实际 tarball 检查仍要求每张图片非空，并与工作树逐字节一致。
- `publishConfig` 明确指定官方 npm Registry 和公开访问级别。项目 `.npmrc` 固定 `rc` dist-tag。正式发布命令仍需显式传入 `--tag rc`，防止预发布版本占用 `latest`。
- RC2 使用独立冻结入口和独立候选目录。RC1 tarball、身份、摘要和验收记录保持不可变。

## 复杂应用试跑口径

- BrowserScope 插件能力：`PASS`。30 工具、真实浏览器、调试、证据采集和资源清理预检通过。
- Agent 提交的应用补丁：`PARTIAL PASS`。公开测试与构建通过。私有关系矩阵为 `4/5`，缺少一个身份变化与低顺序回退组合。
- 外部正式验收设施：`FAIL`。正式访问前，服务端口已经无法连接。完整进程退出证据缺失。
- 综合分类：`QUALIFIED_PARTIAL_PASS`。该结论只支持 BrowserScope 插件能力。应用修复、模型表现和测试设施没有全部通过。

## 发布状态

`1.0.0-rc2` 当前已完成单 Session 浏览器锁定实现、正式构建、Controller 专项、真实 Agent Scope 集成、DSH `0.1.5-rc.2` Web 人工验收和三张 Controller 截图更新。两个实机 Session 的持久记录分别为 BrowserScope 与其他浏览器工具，schema v2、`generation=1`，重启后均正确恢复。20 文件发布结构保持不变，README 已恢复引用新截图。

不可变候选尚未形成。公开副本已通过白名单 Staging 同步，Git 元数据保持不变，敏感内容检查为 0；最终 npm 20 文件 tarball 门禁已通过，临时归档已自动删除。当前只等待用户决定是否授权冻结 RC2。

自动化卫生检查脚本已按用户要求删除，文档格式改由人工核对。npm 包白名单检查、公开导出器和 RC2 冻结器保留。

Git 提交、远端推送、仓库公开化、Git Tag、GitHub Release 和 npm 发布均未执行。后续不能覆盖 `1.0.0-rc1`，也不能在同一 RC2 版本下生成多份内容不同的冻结制品。

---

# 历史：DSH BrowserScope 1.0.0-rc1 — DSH 0.1.5-rc.1 Release Candidate

## 发布定位

`1.0.0-rc1` 是 BrowserScope 的首个公开 Release Candidate 准备版本。它已完成 DSH `0.1.5-rc.1` Host、Client、右侧栏、权限和 Controller RPC 迁移。版本包含 30 个浏览器工具、Session Controller 和完整 DevTools 工作台。冻结后还增加了通用的“身份 × 顺序 × Owner/Context”完成指导。

本版本不是稳定版。`session-select` 仍是实验能力。本版本不继承历史 Alpha 10 的 L3 8/8 发布资格。所有直接 DSH Peer 继续精确固定为 `0.1.5-rc.1`，不自动承诺兼容后续 RC 或正式版。

## 相对 Alpha 2 的变化

- 包版本迁移到 `1.0.0-rc1`。版本使用独立 RC 冻结入口和独立候选目录，不覆盖 Alpha 候选。
- `browser_diagnose` 完成指导加入通用关系矩阵。同身份测试不能单独证明单调性。完成前需要覆盖身份不变/变化、顺序相等/升高/降低、Owner/Context 当前/陈旧。未覆盖的组合保持未验证，证据声明不能超出实际证明的关系。
- 生产指导和测试不硬编码 PixelForge 业务字段、私有检查编号或本次答案。工具数量、名称、参数 Schema、Client、权限、协议、配置、UI 和 Runtime 行为保持不变。
- 修复 Workspace、锁文件和 CI 中重复的 UTF-8 BOM。pnpm、YAML 和公开导出恢复可复现。
- 发布检查加入真实临时 tarball 解包审计，不再只检查 `npm pack --dry-run` 的预览清单。
- 公开源码先进入独立 Staging 审计，再按白名单同步。公开 Git 工作树的 `.git` 不允许被导出器删除。

## PixelForge 正式试跑结论

- BrowserScope 插件能力：`PASS`。维护者 Chromium 中的 30 工具可见性、导航、Snapshot、OOPIF、Checkpoint/Compare、Screenshot、Download、Console/Network、Debugger、Fetch、Trace/Profile、Emulation、Split View、Takeover、Recorder、Source Map 和资源清理预检通过。
- 模型/Agent 补丁：`PARTIAL PASS`。公开测试与构建通过。私有 Oracle 为 `4/5`，缺少身份变化时低顺序结果回退的边界。
- 正式 customer harness：`FAIL`。正式访问前，验收端口已经无法连接。协调器没有保留 PID、stdout、stderr 和退出码，无法恢复精确退出机制。
- 综合分类：`QUALIFIED_PARTIAL_PASS`。该结果不影响 BrowserScope RC 的插件能力结论。PixelForge 应用修复没有全部通过。

## 发布状态

`1.0.0-rc1` 不可变候选已经形成。公开发布制品文件名为 `dsh-browser-scope-1.0.0-rc1.tgz`。文件大小为 178025 字节。SHA-256 为 `dac6456ba86c21ce50131b97cc570c240573a1ecdba5199b5c4dfc82a0008a31`。npm integrity 为 `sha512-0qPHlc8HSRSOlh1Pw1yT7UfUC5oD912NtkZ3YnVtMCO0i/X2/YNE43SpnnLzXGsIBVlRRk0VPi0f+idP4H6Ygw==`。Candidate Digest 为 `5235244340195ff56ba5d33022c54071ae281063db6fb27e99a8c727377d0a1b`。冻结器第二次执行返回 `reused=true`。tarball 和 `candidate-identity.json` 均为只读。

Git Tag、GitHub Release、公开仓库提交与推送、npm 发布均尚未执行。后续发布只能使用上述冻结 tarball，不能从工作树或 Git Tag 重新打包。

---

# 历史：DSH BrowserScope 0.12.0-alpha.2 — DSH 0.1.5-rc.1 Compatibility Preview

## 发布定位

`0.12.0-alpha.2` 是面向 DSH `0.1.5-rc.1` 的兼容候选修正版本。BrowserScope 业务源码、协议、工具数量和 DSH Peer 边界没有变化。本版本只修正候选版本、自描述和不可变身份流程。Alpha 2 不可变 tarball 已经形成。Git Tag、GitHub Release 和 npm 发布尚未执行。

## Alpha 2 候选治理修正

- 包版本从 `0.12.0-alpha.1` 升级到 `0.12.0-alpha.2`。
- npm 包内 README 改为不含时态的候选身份规则。候选状态以外部 `candidate-identity.json`、tarball SHA-256、npm integrity、Candidate Digest 和安装后四个 `lib` 产物身份为准。
- 新增卫生检查。README 不能写入会在冻结后立即过时的“尚未形成候选”或“已经形成候选”状态。
- 新冻结流程不调用 build、test 或 prepack。调用者完成全部检查后，流程只原样封存当前八文件生产产物。候选目录已有 tarball 时只能复核，不能覆盖或重新打包。
- Alpha 1 失败候选保留原始 tarball、身份和拒绝判定。它不进入 PixelForge 正式试跑，也不能用于 Tag、Release 或 npm 发布。

## RC.1 适配

- Host 权限读取从已删除的 `Session.events` 迁移到 `ctx.permissionPresets.current(session)`。`danger-full-access` 继续在进入交互审批前直接放行。
- `JsonValue` 改为从 `@deepseek-ai/dsh-util-values` 导入。
- Client 输入区从旧 `useSessions` 迁移到 Session 标准属性 `useSession`。空白 Hero Session 继续禁止打开 BrowserScope。
- 面板通信从 RC.1 运行时无法注册的自定义 `/browser-tools` Channel 迁移到 Connection 已认证的 `/api/browser-tools` 精确 Fetch Route。Client 继续使用标准 Connection 请求/响应信封。Host/Origin 和 BrowserAuth 检查保持不变。
- 面板从动态 `details` Slot 和宿主根 Grid 覆盖迁移到官方右侧栏扩展：`ctx.sidebarRightTabs.register()`、`sidebar.right.pane.tab`、`ctx.sidebarRight.openTab()` 和标签自身 Action。
- Tab 挂载、关闭和视图导航按 Session 隔离。用户从 DSH 标签栏关闭时，输入区按钮会同步。Session 切换不会关闭旧 Session 保存的 Tab。
- 删除旧外层 30%–70% Grid 分隔线和对应 LocalStorage。浏览器内部上下双页比例功能保留。

## 依赖与兼容边界

- 当前包版本：`0.12.0-alpha.2`。
- 所有直接 DSH Peer 精确固定为 `0.1.5-rc.1`，不自动接纳未审计的后续 RC 或正式版。
- Cordis 最低版本为 `4.0.2`。Schemastery 最低版本为 `3.18.2`。
- 本地开发依赖已补齐 RC.1 宿主 Peer 原子集。根 Workspace 和锁文件都固定 `autoInstallPeers=false`。`pnpm peers check` 已通过。
- 旧 Alpha 1 类型配置和 rc.8/Alpha 1 双检查脚本已删除。

## 已继承验证

- Alpha 1 冻结前已完成 RC.1 隔离声明环境、严格 TypeScript、Host/Client 正式构建、公开测试、Session Controller、30 工具真实 Chromium 集成和真实 DSH Web Client 人工验收。
- Controller RPC 已通过认证后的 `/api/browser-tools` 标准信封进入 Host Handler。HTTP 405 和“控制器状态读取中”停滞已经消失。
- Hero 临时 Session 检查、正式 Session 激活、BrowserScope Tab、视图切换、关闭同步、双 Session 隔离、多 Pane 去重、退出和资源释放均通过。
- DSH 官方“收起右侧栏”只改变可见性，不销毁标签。Trae 的 `/@vite/client` 404 和 `chrome-extension://` 消息属于浏览器环境噪声。
- Alpha 2 版本和文档迁移完成后，仍需重新执行冻结安装、Peer、构建、完整回归、最终卫生和八文件打包检查。Alpha 1 候选资格不能直接沿用。

## Alpha 1 失败候选

`0.12.0-alpha.1` 曾生成一份 177638 字节的冻结 tarball。SHA-256 为 `269f5bdc2dddd930f05ea317643df3acef3fb9ffd179cbbb2fdf8ac6a5e5707d`。四个 `lib` 产物与冻结前最终门禁 Hash 一致。包内 README 仍声明尚未形成不可变候选，与外部最终候选身份冲突。因此，该候选在安装和正式试跑前被拒绝。原始 tarball、身份和 `rejection-verdict.json` 保留，不覆盖，也不删除。

## 尚未完成

- PixelForge Domino 正式能力预检和盲测。
- Git Tag、GitHub Release 和 npm 发布。

Alpha 2 不可变候选位于 `.release/0.12.0-alpha.2/dsh-browser-scope-0.12.0-alpha.2.tgz`。文件大小为 177807 字节。SHA-256 为 `5576c59e5058ed20b7b2c3cd89b51caa9ae4d6af6acbf551a5ce3e73d703fe1a`。npm integrity 为 `sha512-CfgRBt8sMMbV8ku0/5QXHmxpNev38jUX9EgUVQsxGQ52eOhjrbBnbibIsml2X+99BEiIoQMTBVO8gqu1xkgVuA==`。Candidate Digest 为 `c65e5d16ece44c451163bd5ffb95d75c70f68f3edeadfe713ae252c97cc4dc3d`。冻结器复用检查返回 `reused=true`。候选和身份文件均已设为只读。本版本尚未发布，也不是稳定版。它不声明兼容未审计的未来 DSH 版本。

---

# 历史：DSH BrowserScope 0.11.0-alpha.1 — Developer Preview

## 发布定位

`0.11.0-alpha.1` 是 DSH BrowserScope 的开发者预览版本。主要变化是同一 DSH Profile 下的 Session 级浏览器控制器选择。

开发者可以在日常 Session 中继续使用其他浏览器插件，并在前端开发 Session 中单独启用 DSH BrowserScope。

本版本不是 Beta 或稳定版。新的 L3 8/8 正式验收尚未完成。

## 主要变化

### Session 级浏览器控制器

新增两种工具注册模式：

```yaml
toolRegistrationMode: global | session-select
```

- `global`：默认值。它保持历史行为，并全局注册 30 个浏览器工具。
- `session-select`：用户为当前正式 Agent Session 激活插件后，插件才注册 30 个工具。

`session-select` 使用 DSH Agent Scope 原生能力：

- 本插件在当前 Agent Scope 遮蔽同名第三方工具。
- 第三方独有浏览器工具只在当前 Agent Scope 被限制。
- 兄弟 Session 不受影响。
- 退出后，第三方工具自动恢复。
- 插件不会卸载、重配或停止第三方插件及其浏览器进程。

### Controller 生命周期

新增：

- 原子注册与回滚。
- `agent.whenIdle()` 和维护队列。
- 持久 Session 模式与 generation。
- 使用 `bindingGeneration` 防止 Agent 原地替换时发生竞态。
- 冷恢复等待门。
- 安全退出与显式资源释放。
- Controller Identity 与 Compare 可比性保护。

### Web UI

- 空白 Hero Session 不能提前激活 Controller。
- 用户发送首条消息并形成正式 Agent Session 后，才可以启用 DSH BrowserScope。
- 提供“退出并保留页面”和“退出并释放资源”。
- Session 切换时，Controller 快照、确认框和右侧面板不会显示到其他 Session。
- 迟到的尽力清理 RPC 不再产生页面未处理 Promise rejection。

## 真实兼容验证

已使用一个冻结版本的代表性成熟浏览器插件进行真实运行时共存压力测试。该插件在当前 DSH 用户中较常见。公开文档不披露它的名称、仓库或准确版本。此测试只说明当前组合的结果，不承诺兼容整个插件生态。

实际结果：

```text
普通 Session：33 个第三方 browser_* 工具
BrowserScope Session：30 个本插件工具
同名遮蔽：5
第三方独有工具限制：28
退出后恢复：33
兄弟 Session：不受影响
```

真实 Electron 验收使用实际解析版本 `44.2.0`。普通 Session 的两个标签、Cookie 和第三方 Session ID，在另一 Session 激活和退出本插件期间保持不变。隔离 Profile Dispose 后没有 Electron 残留。

## Web 验收

单正式 Session 已验证：

- 空白 Session 激活检查。
- 正式 Session 激活。
- 完整九视图。
- 面板内关闭。
- 退出并保留页面。
- 重新激活。
- 退出并释放资源。

双正式 Session 已验证：

- Session A 启用 BrowserScope。
- Session B 保持 `other`。
- A 的右侧分屏不显示到 B。
- A/B 双向切换后状态保持。
- A 最终公开释放资源。

两组验收均为：

```text
consoleErrors=[]
pageErrors=[]
```

## 构建与回归

工作树已通过：

```text
npm run build
npm test
node tests/final-hygiene.mjs
```

覆盖范围包括 DSH `0.1.2-alpha.1`、最低类型基线 `0.1.0-rc.8`、30 工具真实集成、Controller 竞态、Persistent Context、扩展、分屏、Debugger、Network、Profile、Recorder、L3 Controller Identity 和资源清理。

## 品牌与包名

公开包名从历史 `dsh-browser-tools` 更名为：

```text
dsh-browser-scope
```

产品名称为：

```text
DSH BrowserScope — Agent-Native Browser DevTools Workbench
```

为兼容旧 Session、Controller Evidence、数据目录和用户偏好，以下内部协议标识继续保留：

```text
Controller mode/id: dsh-browser-tools
RPC: /browser-tools
数据目录: $DSH_HOME/browser-tools
Cordis 节点 id: browser-tools
```

目标 Profile 不能同时安装 `dsh-browser-tools` 和 `dsh-browser-scope`。

## 已知限制

- `session-select` 仍是实验性 Developer Preview 能力。
- 不承诺兼容所有第三方浏览器插件。
- 第三方标签、Cookie、Storage、ref 和页面状态不会迁移到本插件。
- 空白 Hero Session 必须先发送首条消息，形成正式 Session。
- 当前只对一个冻结版本的代表性成熟浏览器插件完成真实运行时组合验证。
- 本版本不继承 Alpha 10 的完整 L3 发布资格。

## 历史验收边界

Alpha 10 权威执行保持：

```text
executionId=2026-09-07T06-38-54-484Z
validationQualified=true
scoresIdentityQualified=true
allEightScored=true
credentialQualified=true
allEightPassed=false
pairQualified=false
waveQualified=false
releaseQualified=false
```

本版本没有覆盖该历史结论。本版本只声明 Session Controller、真实第三方兼容、Web UI 和确定性回归已经通过。

## 安全与反馈

普通问题：

https://github.com/HakureiMonika/dsh-browser-scope/issues

安全报告请参阅 `SECURITY.md`。敏感漏洞细节不要发布到公开 Issue。
