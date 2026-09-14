# DSH BrowserScope 测试报告

[English Version](./VALIDATION.en.md) | 简体中文

本文记录 DSH BrowserScope 当前 Release Candidate 的测试目的、测试内容、测试过程和测试结果。

候选状态以外部候选身份文件和 tarball 摘要为准。本文描述测试结果，不能单独证明某个版本已经完成 Git Tag、GitHub Release 或 npm 发布。

## 测试对象

```text
package: dsh-browser-scope
version: 1.0.0-rc2
DSH compatibility target: 0.1.5-rc.2
full runtime validation baseline: 0.1.5-rc.1
RC.1 → RC.2 audit: relevant implementation and type files unchanged
Node.js: 22.x
package manager: pnpm 11.x
```

所有直接 `@deepseek-ai/dsh-*` Peer 均精确固定为 `0.1.5-rc.2`。

RC1→RC2 的 DSH 依赖迁移审计覆盖 BrowserScope 直接使用的 14 个 DSH Peer，并补充检查 `@deepseek-ai/dsh-app-boot`、`@deepseek-ai/dsh-web-app` 和 `@deepseek-ai/dsh`。相关发布包只有 `package.json` 发生版本联动，`lib` 实现、类型声明、导出入口和 Client 资源没有变化。

完整 Chromium 与复杂场景结果仍沿用 RC1 运行验证基线。尚未冻结的 RC2 工作线把 `session-select` 改为“首次选择后锁定”，并已完成严格 TypeScript、Host/Client 正式构建、Controller 专项、真实 DSH Agent Scope 集成以及 DSH `0.1.5-rc.2` Web 人工验收。本轮没有重复运行与 Session 锁定无关的完整 Chromium 回归；下文会分别标明历史基线与 RC2 新增验证。

本报告不自动承诺后续 DSH RC、正式版、其他操作系统或所有第三方浏览器插件兼容。

## 一、30 个浏览器工具集成

**测试目的**：确认 30 个 Agent 浏览器工具在真实 Chromium 中可以端到端工作，不是只通过类型检查和单元桩。

**测试内容**：标签与导航、页面观察、页面交互、文件链路、Console、Network、Debugger、Source Map、性能、环境模拟、Provider、扩展、人工协作和诊断取证。

**测试过程**：在真实 Chromium 中启动完整集成回归，由消费方依赖图解析 RC.2 npm 包，逐项调用工具并核对返回结果。

**测试结果**：

| 领域 | 已验证能力 |
| --- | --- |
| 标签与导航 | 新建、选择、关闭、前进、后退、刷新、导航 |
| 页面观察 | Snapshot、Ref、Query、Attribute、Screenshot |
| 页面交互 | Click、Hover、Type、Key、Scroll、Select、Wait、Dialog |
| 文件链路 | Upload、Download、Artifact 读取与 Session 隔离 |
| Console | 有界消息、错误、重复事件和脱敏 |
| Network | 请求列表、Body、请求/响应拦截、Continue、Abort、Fulfill、Replay、超时放行 |
| Debugger | Attach、断点、暂停、继续、单步、调用栈、Scope、脚本源码 |
| Source Map | 生成位置、原始位置、声明路径、解析路径、Build Identity |
| 性能 | CDP Trace、Playwright Trace、CPU、Coverage、Heap Snapshot、Heap Sampling |
| 环境 | Viewport、设备、Locale、Timezone、网络、CPU、离线、权限 |
| Provider | Managed、Persistent、External CDP、能力协商与断开 |
| 扩展 | Manifest V3、安装状态、启停、应用、真实 Popup |
| 人工协作 | Live View、Takeover、鼠标、键盘、输入法、PasteEvent、控制权归还 |
| 诊断证据 | Recorder、Checkpoint、Compare、Incident、Context/Build/Application Identity |

集成测试最终输出：

```text
toolCount: 30
navigation: pass
panel: pass
splitView: pass
persistentContext: pass
extensions: pass
debugger: pass
diagnose: pass
networkControl: pass
profile: pass
```

## 二、九视图 DSH 原生工作台

**测试目的**：确认 BrowserScope 使用 DSH 官方右侧栏机制提供九个工作台视图，并正确处理关闭、切换和多 Pane 生命周期。

**测试内容（RC1 历史基线）**：Hero 临时 Session 门禁、正式 Session 激活、九个视图切换、标签栏与导航栏持续性、面板内关闭与官方标签关闭同步、Session 切换、多 Pane 去重、旧版退出与释放流程。

**测试过程（RC1 历史基线）**：在真实 DSH Web Client 中人工操作，逐项核对界面状态与输入区状态是否同步。

**测试结果（RC1 历史基线）**：

- Hero 临时 Session 不会提前绑定正式 Agent Scope；
- 正式 Session 可以启用 BrowserScope；
- BrowserScope 使用 DSH 官方右侧栏页面型 Tab；
- 实况、诊断、Console、Network、Debugger、Performance、Provider、Extensions、Emulation 九视图可以切换；
- 标签栏、导航栏和当前页面状态在各视图中持续存在；
- 面板内关闭和 DSH 官方标签关闭都会同步输入区状态；
- Session 切换不会误关其他 Session 保存的 BrowserScope Tab；
- 多 Pane 中已挂载标签从自身 Action 导航，不会在当前活动 Pane 重复创建；
- RC1 旧版 Controller 的退出并保留页面、重新激活、退出并释放资源流程均符合当时预期。

### RC2 新锁定界面实机结果

**测试环境**：隔离 `DSH_HOME`、隔离端口 `31880`、DSH `0.1.5-rc.2`、当前工作树 BrowserScope，以及同一 Profile 中的真实第三方浏览器插件。

**测试过程**：用户在真实 DSH Web 中建立两个正式 Session。Session A 选择 BrowserScope，打开九视图菜单并释放本插件资源；Session B 独立选择其他浏览器工具。随后精确重启隔离 DSH Web，再次打开两个原 Session 检查锁定恢复。

**测试结果**：

- 新正式 Session 初始显示“尚未选择浏览器工具”；
- 选择 BrowserScope 后显示“已锁定”，九视图和已仲裁工具列表可用；
- 释放 BrowserScope 资源后仍保持 BrowserScope 锁定；
- 第二个 Session 可以独立选择其他浏览器工具，且不再提供启用 BrowserScope 的入口；
- 重启 DSH Web 后，两个原 Session 分别恢复为 BrowserScope 锁定和其他浏览器工具锁定；
- 两个持久记录均为 schema v2、`generation=1`；
- 三张 Session Controller 截图已按新界面重新生成并覆盖正式资源。

## 三、Session 级 Controller 共存

**测试目的**：确认 BrowserScope 可以在同一个 Profile 内按 Agent Session 管理浏览器工具面，并与第三方浏览器插件共存而不修改对方进程、配置或页面。

### RC1 已执行的切换基线

**测试内容**：代表性共存测试使用了一款当前较常见、使用率较高的成熟浏览器插件作为压力对照。公开报告不披露对照插件名称、仓库或精确版本。单一对照结果不代表全生态兼容。

**测试过程**：在同一 Profile 中同时加载 BrowserScope 与对照插件，分别在普通 Session 和 BrowserScope Session 中统计可见工具，检查兄弟 Session 状态，最后按 RC1 旧流程退出 BrowserScope 并复查对照插件恢复情况。

**测试结果**：

```text
当前 Session 启用 BrowserScope 后：30 个 BrowserScope 工具可见
同名工具：由 BrowserScope 在当前 Agent Scope 遮蔽
对照插件独有浏览器工具：只在当前 Agent Scope 受限
兄弟 Session：不受影响
RC1 旧版 BrowserScope 退出后：对照工具恢复
对照插件进程、配置和页面：不由 BrowserScope 关闭或修改
```

RC1 Controller 生命周期还验证了原子注册、维护队列、冷恢复、Agent 替换竞态、损坏状态回退、安全退出和 HMR 清理。这些结果证明旧切换实现的历史基线，不等同于 RC2 新锁定状态机已经通过。

### RC2 新锁定规则

RC2 工作线已经实现以下契约：

- 新正式 Session 初始为 `unselected`，选择前浏览器工具不向 Agent 暴露；
- 第一次选择 BrowserScope 或其他浏览器工具后，该 Session 永久锁定所选工具；
- 释放 BrowserScope 页面和运行资源不解除锁定，也不恢复第三方工具；
- DSH 重启或 Agent Scope 替换后恢复原选择；
- 持久记录升级为 schema v2；旧 BrowserScope 激活状态继续锁定，旧 `other` 状态迁移为 `unselected`；
- 损坏记录保持 `unselected`；已经持久锁定 BrowserScope 的记录即使恢复失败，也不会降级成可改选状态；
- BrowserScope 只修改当前 Agent Scope 的工具可见性，不停止或重配第三方插件。

新的 `tests/browser-controller.ts` 和 `tests/session-controller-integration.mjs` 已按上述契约执行通过。

Controller 专项结果：

```text
unselectedToolsHidden: true
browserScopeLocked: true
otherToolsLocked: true
releasePreservedSelection: true
restartPreservedSelection: true
migrationPersistedAsSchemaV2: true
failedSelectionRolledBack: true
failedOtherSelectionRolledBack: true
failedRestorePreservedLock: true
```

真实 DSH Agent Scope 集成结果：

```text
globalBrowserToolCount: 3
unselectedBrowserToolCount: 0
activeBrowserToolCount: 30
browserScopeSelectionLocked: true
otherBrowserSelectionLocked: true
releasePreservedSelection: true
sameNameShadowed: true
uniqueThirdPartyRestricted: true
browserScopePersistedGeneration: 1
otherBrowserPersistedGeneration: 1
runtimeRemoved: true
```

## 四、浏览器状态与 Session 隔离

**测试目的**：确认共享 Persistent Context 与 Session 隔离同时成立，共享网站状态但不串页面和调试状态。

**测试内容**：默认 `managed-persistent/default` 的共享项和隔离项。

**测试过程**：在多个 DSH Session 之间交叉操作页面、标签、Popup、Debugger、Network 拦截和 Artifact，核对状态边界。

**测试结果**：

已验证的跨 Session 共享内容：

- Cookie；
- LocalStorage、IndexedDB、Cache Storage；
- HTTP 缓存；
- Service Worker；
- 网站权限；
- 扩展登记与加载状态。

已验证的 Session 隔离内容：

- Page、View、标签与 Popup；
- 活动标签和上下双页焦点；
- Debugger、Network、Ref、Snapshot 和 Screencast；
- Artifact 与人工接管；
- Controller 状态与 generation。

网页 `window.open()` 会继承正确 Owner。无法确认 Owner 的新页面不会暴露给任意 Session。销毁一个 Session 不会关闭其他 Session 的页面。扩展立即生效触发全局协调重建时，各 Session 的 URL、活动标签和双页布局会按记录恢复。

## 五、跨上下文与真实浏览器边界

**测试目的**：防止 Agent 把"相同 URL""相同页面外观"或"同身份测试"误判为完整业务等价证明。

**测试内容**：主页面与 OOPIF、Target / Frame / Document / Execution Context 生命周期、同文档与跨文档导航、Frame 交换、多种执行世界、Shadow DOM / SVG / Canvas Surface、多 Build 与 Application Identity。

**测试过程**：在真实 Chromium 中构造跨上下文场景，检查身份传播、失败关闭和源码内容身份。

**测试结果**：

- 主页面与 OOPIF；
- Target、Frame、Document 和 Execution Context 生命周期；
- 同文档导航与跨文档导航；
- Frame 交换、占位提交与移除；
- 主世界、隔离世界和暂停帧；
- Shadow DOM、SVG 和 Canvas Surface；
- 多 Build 与 Application Identity；
- 不可比 Checkpoint/Compare 的失败关闭；
- Source Map 声明路径、解析路径和源码内容身份。

以上项目全部符合预期。

## 六、输入、实况与人工接管

**测试目的**：确认实况画面和人工输入在真实浏览器中可用，且控制权归属清晰。

**测试内容**：标准实况尺寸、自适应 Viewport、双页画面流、帧预算、输入坐标系一致性、代际变化后的旧输入拒绝、鼠标与键盘输入、中文输入法、剪贴板 PasteEvent 和 Takeover 权限边界。

**测试过程**：在实况画面中执行人工输入，并在 View、Screencast 和 Viewport 代际变化后重放旧输入。

**测试结果**：

- 标准 `1280×720` 实况；
- 自适应 Viewport 与有限强制重排；
- 浏览器内部上下双页独立画面流；
- 30 FPS 有效帧预算；
- 最高 `1920×1200`、JPEG 85 的实况参数；
- 同坐标系动画换帧下的人工输入；
- View、Screencast 和 Viewport 代际变化后的旧输入拒绝；
- 鼠标按下、移动、释放与滚轮；
- 键盘修饰键、中文输入法与空格输入；
- 系统剪贴板只通过最终 PasteEvent 进入页面，不读取或枚举历史；
- Takeover 期间模型写操作受限，归还后恢复。

## 七、扩展与浏览器供应

**测试目的**：确认扩展安装链路的输入校验和运行时边界有效。

**测试内容**：扩展来源输入、CRX 解析、Manifest 版本、ZIP 结构安全、扩展身份一致性、安装与启停、Popup 页面行为、并发 RPC 互斥。

**测试过程**：在真实 Chromium 中安装扩展，检查 Popup 是否进入普通标签栏，并验证长 RPC 与 Snapshot 轮询的互斥行为。

**测试结果**：

- Chrome Web Store URL 或扩展 ID 输入；
- CRX2/CRX3 解析与签名相关身份校验；
- Manifest V3；
- ZIP 路径穿越、重复条目、符号链接、加密、文件数量与大小上限；
- 扩展 ID 与运行时 Origin 一致；
- 安装、启用、禁用、卸载和重启应用；
- 真实 `chrome-extension://` Popup 页面、实况和输入；
- Popup 不进入普通标签栏，不污染 Session 活动网页；
- 扩展长 RPC 与 Snapshot 轮询互斥，避免连接层并发错误。

当前自动 Chromium 安装路径重点验证 Windows x64。网络源不可达时，面板返回可恢复错误，超时不会显示为安装成功。

## 八、性能、隐私与有界性

**测试目的**：确认诊断数据有界、输入隐私不落盘、跨 Session 读取失败关闭。

**测试内容**：Recorder 的 Off、Rolling、Deep、Metadata-only 和 Incident 阶段，保留窗口、淘汰规则、降级行为、输入追踪脱敏、诊断值 JSON 无损和跨 Session Artifact 读取。

**测试过程**：运行公开测试并执行 30 分钟**虚拟时间**保留窗口模拟。

**测试结果**：

- Rolling 保留窗口为 180 秒；
- Incident Freeze 在普通事件淘汰后仍保留；
- 高负载可以降级为 Metadata-only；
- Timeline 和事件数量有界；
- 输入追踪不保留输入明文；
- 诊断值满足无损 JSON；
- 跨 Session Artifact 读取失败关闭。

30 分钟虚拟时间模拟只证明保留与淘汰算法边界，不等同于真实墙钟 30 分钟浏览器稳定性测试。

生产依赖已通过官方 npm Registry 安全审计，当前结果为无已知漏洞。安全数据库结果会随时间变化，发布后仍需持续复核。

## 九、复杂应用场景试跑

**测试目的**：在一个接近真实生产故障的任务中检验 BrowserScope 的完整证据采集能力。

**测试内容**：任务包含连续异步任务、旧结果迟到、页面预览与草稿与导出与刷新之间的身份传播、生产压缩 Bundle 与外部 Source Map、跨站点与 OOPIF、私有判定边界，以及修复前后的浏览器证据采集。

**测试过程**：由 Agent 使用 BrowserScope 复现故障、采集证据、提交修复补丁，再由外部验收设施执行判定。

**测试结果**：结果分为四层，必须分层理解。

| 层级 | 结论 | 解释 |
| --- | --- | --- |
| BrowserScope 插件能力 | `PASS` | 30 工具、真实浏览器、调试、证据采集和资源清理预检通过 |
| Agent 提交的应用补丁 | `PARTIAL PASS` | 公开测试与构建通过，私有关系矩阵为 4/5，漏掉一个身份变化与低顺序回退组合 |
| 外部正式验收设施 | `FAIL` | 正式访问前服务端口已经不可连接，且缺少完整进程退出证据 |
| 综合 | `QUALIFIED_PARTIAL_PASS` | 支撑插件能力结论，但不能宣称应用修复、模型表现和外部设施全部通过 |

本次试跑推动 `browser_diagnose` 增加通用"身份 × 顺序 × Owner/Context"完成指导。改进不包含任务专属字段、私有答案或硬编码测试结论。

## 十、构建与发布确定性

**测试目的**：确认构建产物不随绝对路径漂移，npm 包内容与工作树一致。

**历史测试内容**：在两个不同绝对目录中执行构建并比对字节。npm 门禁先预览清单，再生成真实临时 gzip tarball，直接解析 POSIX tar 条目逐项核对，最后删除临时 tarball。

**历史测试结果**：RC1 对应四个产物已证明可在不同绝对目录中逐字节一致。CSS Modules 使用仓库相对稳定路径参与 Hash，维护者目录、公开副本和 CI 不会因绝对路径不同而生成不同的 Client 字节。

**当前 RC2 工作树构建结果**：`npm run build` 已通过严格 TypeScript、Host ESM、类型声明和 Client Bundle 构建。当前产物摘要如下；本轮没有重复执行双目录确定性构建。

| 产物 | SHA-256 |
| --- | --- |
| `lib/client.js` | `25b8950a1e4e2c210fd31df5ee8f32dcb32d1e67501ad3ae44af4f94583923b3` |
| `lib/client.js.map` | `69274b7bf3820d9ed3fcfd4645e7b1c2ee47f3de17f701ea8d43ffdf36034eda` |
| `lib/index.mjs` | `3247b9fc53f2b5869aa20d1edb249748b74a1875681c9035cbd9c325fac8ead6` |
| `lib/index.d.mts` | `6884ae01362ca921f53016f2034670da9a36653fbf79333006a5e3414ddf5952` |

npm 发布门禁要求：

1. `npm pack --dry-run --json` 预览文件清单；
2. 生成实际临时 gzip tarball；
3. 直接解析 POSIX tar 条目；
4. 核对固定公开文件白名单；
5. 核对包内每个文件非空；
6. 核对包内文件与工作树逐字节一致；
7. 删除临时 tarball；
8. 候选冻结后，同版本只允许复核，不允许重新打包覆盖。

当前 RC2 工作树已实际执行上述 npm 门禁。文档回填前后两次检查均通过：预览 20 个文件、实际 tarball 20 个文件、包内文件全部非空并与工作树逐字节一致；临时 tarball 均由检查器删除。压缩体积属于检查运行结果，不写入包内文档，避免文档自身改变归档字节。

Release Candidate 的项目 `.npmrc` 默认发布标签固定为 `rc`。正式发布命令仍必须显式传入 `--tag rc`，并以 npm dry-run 输出 `with tag rc` 作为最终判定，避免预发布版本占用 `latest`。

## 十一、资源清理

**测试目的**：确认测试结束后浏览器、端口、External CDP 和运行目录均已释放。

**测试内容**：端口关闭、External CDP 断开、运行目录移除，以及各类浏览器资源的生命周期收敛。

**测试过程**：完整 Chromium 集成结束后检查残留进程、端口和目录，并单独验证 External CDP Disconnect 对用户浏览器的影响。

**测试结果**：

```text
portClosed: true
externalCdpClosed: true
runtimeRemoved: true
```

另验证：

- External CDP Disconnect 不关闭用户浏览器；
- BrowserContext、CDP Session、Debugger、Fetch、Trace、Recorder 和 Screencast 按生命周期收敛；
- 临时 tarball 和候选解包副本完成清理；
- 根级运行目录不残留；
- 冻结候选与身份文件只读。

## 十二、尚未证明的内容

当前结论不覆盖：

- 所有 DSH 版本；
- 所有操作系统与 CPU 架构；
- 所有第三方浏览器插件；
- DRM、Native Messaging、Manifest V2；
- CAPTCHA、验证码、Passkey/WebAuthn 或设备确认自动化；
- 所有网站反自动化策略；
- 所有浏览器扩展和 Chrome Web Store 网络环境；
- 被调试应用本身的业务正确性；
- 任意模型在任意任务中的成功率；
- 外部测试服务和部署系统的稳定性；
- 对 DSH 插件全生态的绝对排名。

## 十三、复现方式

```powershell
pnpm install --frozen-lockfile --ignore-scripts
pnpm peers check
npm run build
node scripts/check-public-package.mjs
```

仓库保留历史专项和集成测试文件，默认脚本不聚合启动大型 Chromium。复核特定能力时，维护者应根据变更范围显式运行对应的单个测试文件。需要真实 Chromium 时，还必须显式提供已经验收的浏览器根。测试不得隐式下载，也不得扩大到无关场景。

公开 CI 不隐式下载维护者浏览器，也不运行需要私有测试设施的场景。公开结果只用于复核源码、依赖、构建和实际 npm tarball。复杂应用试跑与真实 Web 人工验收按各自记录独立成立。
