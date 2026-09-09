# DSH BrowserScope

**Agent-Native Browser DevTools Workbench for DeepSeek Harness**

中文名称：**DSH BrowserScope 浏览器调试工作台**

当前版本：`0.11.0-alpha.1` — Developer Preview

DSH BrowserScope 是面向 DeepSeek Harness（DSH）的浏览器工具与右侧 DevTools 工作台。它提供 30 个受控模型工具、真实 Chromium 页面、会话级标签与调试状态、Console/Network/Debugger/Profile/Recorder/Extensions/Emulation，以及同一 Profile 下按 Agent Session 选择主浏览器控制器的能力。

> `session-select` 当前属于实验性 Developer Preview。它已经通过真实第三方插件、真实 Electron、单/双 Session Web 和完整确定性回归，但本版本不是 Beta 或稳定版，也不宣称完成新的 L3 8/8 正式验收。

## 核心特性

- 30 个 `browser_*` 模型工具。
- DSH Web 右侧九视图浏览器工作台。
- 多标签、上下双页、标准/自适应实况和人工接管。
- Console、Network、Debugger、Source Map、Checkpoint、Compare 和 Incident Report。
- CDP Trace、Playwright Trace、CPU、Coverage、Heap Snapshot 和 Heap Sampling。
- Manifest V3 扩展管理与真实 `chrome-extension://` Popup。
- 默认共享 Persistent Context，Session 之间共享网站状态但隔离页面、标签和调试状态。
- `global | session-select` 两种工具注册模式。
- 同一 Profile 可加载多个浏览器插件，每个正式 Agent Session 只选择一个主浏览器工具面。

## 安装

### 前置要求

- Node.js `^22.19.0` 或 `>=24.0.0`。
- 已可正常启动的 DSH Web Profile。
- 与目标 DSH 版本匹配的官方 CLI 和依赖。
- `dsh-browser-scope-0.11.0-alpha.1.tgz` 或公开 npm 包。

### 从本地 tarball 安装

```powershell
dsh plugin --profile web add ./dsh-browser-scope-0.11.0-alpha.1.tgz --ignore-scripts --config.auto-install-peers=false
```

隔离环境已有完整依赖 Store 时可以增加 `--offline`：

```powershell
dsh plugin --profile web add ./dsh-browser-scope-0.11.0-alpha.1.tgz --offline --ignore-scripts --config.auto-install-peers=false
```

### 从 npm 安装

公开包发布后可使用：

```powershell
dsh plugin --profile web add dsh-browser-scope@0.11.0-alpha.1 --ignore-scripts --config.auto-install-peers=false
```

不要在同一个 Profile 中同时安装历史包 `dsh-browser-tools` 和新包 `dsh-browser-scope`。两者会竞争同一工具、Client 入口和 RPC。

## 从历史包升级

公开包从 `dsh-browser-tools` 更名为 `dsh-browser-scope`。

推荐步骤：

1. 停止目标 DSH Web。
2. 备份 Profile 的 `package.json`、锁文件和 `cordis.patch.yml`。
3. 移除旧包 `dsh-browser-tools`。
4. 安装 `dsh-browser-scope`。
5. 保持 Cordis 节点 `id: browser-tools` 不变。
6. 保留 `$DSH_HOME/browser-tools`，使 Profile、扩展、Controller 状态和布局偏好继续可用。
7. 核对安装版版本和 `lib` 文件 Hash。
8. 启动 Web，验证 Client、Controller 状态和最小激活/退出流程。

卸载旧包：

```powershell
dsh plugin --profile web remove dsh-browser-tools
```

安装新包：

```powershell
dsh plugin --profile web add ./dsh-browser-scope-0.11.0-alpha.1.tgz --ignore-scripts --config.auto-install-peers=false
```

卸载不会自动删除 `$DSH_HOME/browser-tools` 中的 Persistent Profile、扩展、Controller 状态或 Artifact。是否删除这些数据应由用户明确决定。

## 配置模式

### 默认全局模式

```yaml
- id: browser-tools
  config:
    toolRegistrationMode: global
```

`global` 是默认值：

- 30 个工具在 Host Context 全局注册；
- 保持历史单浏览器插件 Profile 的行为；
- 若存在同名全局浏览器工具，插件会拒绝不安全的重复注册；
- 适合仅使用 DSH BrowserScope 的 Profile。

### Session 选择模式

```yaml
- id: browser-tools
  config:
    toolRegistrationMode: session-select
    sessionController:
      defaultMode: other
```

`session-select`：

- Host RPC 和轻量 Controller 入口保持加载；
- 30 个模型工具不在 Host Context 全局注册；
- 用户为当前正式 Agent Session 激活 DSH BrowserScope 后，工具才注册到该 Agent Scope；
- 同名第三方工具在当前 Agent Scope 被遮蔽；
- 第三方独有浏览器工具只在当前 Agent Scope 被限制；
- 兄弟 Session、第三方插件配置和第三方浏览器进程不受影响；
- 退出后第三方工具自动恢复。

### 冲突识别

默认冲突模式：

```yaml
sessionController:
  conflictingToolPatterns:
    - '^browser_'
    - '^chrome_'
    - '^pilot_'
    - '^mcp__playwright__'
    - '^mcp__chrome_devtools__'
  includeTools: []
  excludeTools: []
```

- `includeTools` 显式加入需要限制的第三方工具。
- `excludeTools` 优先排除误判。
- 规则只影响当前 Agent Session 的模型工具面，不会停止或修改第三方插件。

## Session Controller 使用流程

### 1. 新建空白 Session

DSH Web 新建会话首先是临时 Hero Session，`blank=true`。它尚未形成可绑定的正式 Agent Scope，因此“启用 DSH BrowserScope”入口保持禁用。

先发送首条消息，让 DSH 形成正式 Session。

### 2. 选择 Controller

正式 Session 中打开“浏览器”菜单：

- **继续使用其他浏览器工具**：本插件不向当前 Agent 注册 30 个工具，也不限制第三方工具。
- **启用 DSH BrowserScope**：确认后在当前 Agent Scope 注册本插件工具，并隐藏当前 Session 中识别到的其他浏览器控制工具。

Controller 切换会等待 Agent 空闲，并在维护队列中原子执行。从下一个模型 Step 起使用新的工具面。

### 3. 退出

- **退出并保留页面**：安全收敛 Debugger、Network、Profile、Recorder、Takeover、Screencast 和旧引用，撤销 scoped 工具面，但保留当前 BrowserContext 和页面供后续重新激活。
- **退出并释放资源**：执行同样的安全收敛，并完整释放当前 Session 的浏览器资源。

安全退出失败时，Controller 保持 `active` 和工具所有权，避免第三方工具与仍暂停的 Debugger/Fetch 状态同时暴露。

### 4. 状态恢复

Controller 选择按 Session 持久化到：

```text
$DSH_HOME/browser-tools/controller/sessions/<session-sha256>.json
```

恢复 Session 时，插件会在首次模型 Step 前重建对应 Agent-scoped 工具面。损坏或不可读状态安全回退为 `other`。

## 第三方插件兼容

已完成真实组合验证：

```text
package: dsh-builtin-browser
version: 0.1.21
repository: wqty123/dsh-browser
gitHead: b26bab0f732ab6300447345a17e6cc42739fa9cc
```

实际结果：

```text
普通 Session：33 个第三方 browser_* 工具
BrowserScope Session：30 个本插件工具
同名遮蔽：5
第三方独有工具限制：28
退出后恢复：33
兄弟 Session：不受影响
```

真实 Electron 验收使用实际解析版本 `44.2.0`，确认：

- 普通 Session 的两个标签保持；
- Cookie 保持；
- 第三方 Session ID 保持；
- 销毁 BrowserScope Session 不关闭普通 Session 的第三方 Browser Host；
- 隔离 Profile Dispose 后无 Electron 残留。

这表示该组合达到已验证兼容级别，不表示兼容所有浏览器插件。

## 右侧工作台

九个视图：

| 视图 | 用途 |
| --- | --- |
| 实况 | 查看和人工操作当前页面，切换标准/自适应与双页 |
| 诊断 | 查看 Debug Session、Action、Checkpoint、Compare、Incident 和 Context Topology |
| Console | 查看当前焦点页的有界 Console 记录 |
| Network | 查看请求元数据、暂停请求和控制操作 |
| Debugger | 脚本、断点、暂停、单步、调用栈和 Scope |
| Performance | Trace、CPU、Coverage、Heap 和 Artifact |
| Provider | Managed、Persistent 和 External CDP |
| Extensions | Manifest V3 扩展、应用状态和真实 Popup |
| Emulation | Viewport、设备、地区、网络、CPU、离线和权限 |

完整标签栏、后退、前进、刷新和地址栏在各视图中保持存在。

## 30 个模型工具

### 标签与导航

- `browser_tabs`
- `browser_navigate`
- `browser_navigate_back`

### 页面观察与交互

- `browser_snapshot`
- `browser_click`
- `browser_hover`
- `browser_scroll`
- `browser_type`
- `browser_press_key`
- `browser_select_option`
- `browser_wait_for`
- `browser_take_screenshot`
- `browser_get_attribute`
- `browser_query`
- `browser_handle_dialog`

### 文件、Console 与 Network

- `browser_console_messages`
- `browser_network_requests`
- `browser_upload_file`
- `browser_download`
- `browser_network_control`

### 调试与运行环境

- `browser_debugger`
- `browser_diagnose`
- `browser_profile`
- `browser_emulate`
- `browser_evaluate`
- `browser_provider`

### 面板、扩展与控制权

- `browser_live_view`
- `browser_split_view`
- `browser_extensions`
- `browser_takeover`

## 浏览器状态模型

默认 `managed-persistent/default` 使用插件级共享 Persistent BrowserContext。

跨 DSH Session 共享：

- Cookie；
- HTTP 缓存；
- LocalStorage；
- IndexedDB；
- Cache Storage；
- Service Worker；
- 网站权限；
- 扩展登记和加载状态。

按 Session 隔离：

- Page、View 和标签；
- 网页 Popup 与扩展 Popup View；
- Debugger 和 CDP Session；
- Network 拦截；
- refs、Snapshot 和 Screencast 代际；
- Artifact；
- Takeover；
- 上下双页和焦点；
- Controller 选择与 generation。

需要完全隔离时，使用 `managed` 或非默认命名 Persistent Profile。

## 主要配置

```yaml
- id: browser-tools
  config:
    toolRegistrationMode: session-select
    headless: true
    allowLoopback: true
    allowPrivateNetwork: true
    allowedOrigins: []
    uploadRoots: []
    maxUploadBytes: 26214400
    maxDownloadBytes: 104857600
    maxArtifactBytes: 268435456
    maxOutputChars: 12000
    interceptionTimeoutMs: 15000
    externalCdpTimeoutMs: 15000
    chromiumDownloadSource: auto
    chromiumDownloadTimeoutMs: 300000
    subagentInteractive: false
    sessionController:
      defaultMode: other
      includeTools: []
      excludeTools: []
```

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `toolRegistrationMode` | `global` | 全局注册或 Session 选择 |
| `sessionController.defaultMode` | `other` | 新正式 Session 的默认 Controller 模式 |
| `executablePath` | 自动探测 | 显式浏览器可执行文件 |
| `headless` | `true` | 是否无头运行 |
| `artifactRoot` | `$DSH_HOME/browser-tools` | Profile、扩展、Chromium 和 Artifact 根目录 |
| `allowedOrigins` | `[]` | 非空时只允许指定 Origin |
| `allowLoopback` | `true` | 是否允许 Loopback |
| `allowPrivateNetwork` | `true` | 是否允许私有 IPv4 地址 |
| `uploadRoots` | 当前进程目录 | 上传文件允许目录 |
| `chromiumDownloadSource` | `auto` | `auto`、`npmmirror` 或 `official` |
| `subagentInteractive` | `false` | 是否允许 Subagent 使用交互和敏感能力 |

## 浏览器与扩展

普通 Managed 或未加载扩展的 Persistent Provider 优先使用显式 `executablePath` 或系统 Edge/Chrome。

启用扩展时，插件按需安装与 `playwright-core` 匹配的 Chrome for Testing 到：

```text
$DSH_HOME/browser-tools/chromium
```

`chromiumDownloadSource=auto` 先尝试 npmmirror，失败后回退 Playwright 官方 CDN。当前自动安装路径只验证 Windows x64。

扩展边界：

- 只接受 Chrome Web Store URL 或扩展 ID；
- 只支持 Manifest V3；
- 校验 CRX、公钥派生 ID、ZIP 路径、重复条目、符号链接、加密和大小上限；
- 不使用第三方扩展镜像；
- `applyMode=now` 会重建 Persistent Context，未提交表单和页面内存可能丢失。

## 安全边界

- 只允许 HTTP/HTTPS 导航。
- 拒绝 URL 内嵌用户名或密码。
- Host RPC 保持 Loopback/BrowserAuth 信任边界。
- 上传路径必须位于 `uploadRoots`。
- Debugger、Console、Network 和诊断输出执行有界脱敏。
- `browser_evaluate` 始终属于敏感操作。
- 插件不读取、不枚举、不保存 Windows 剪贴板历史，只接收最终 PasteEvent。
- CAPTCHA、验证码、Passkey/WebAuthn、设备确认和其他安全挑战必须停止自动操作并请求人工接管。
- `session-select` 不提升权限，也不对第三方工具执行结果提供安全背书。

安全报告请参阅 [SECURITY.md](https://github.com/HakureiMonika/dsh-browser-scope/blob/main/SECURITY.md)。

## 内部兼容标识

虽然公开包和品牌已经改为 `dsh-browser-scope` / DSH BrowserScope，以下内部值暂时保留：

```text
Controller mode/id: dsh-browser-tools
RPC: /browser-tools
数据目录: $DSH_HOME/browser-tools
LocalStorage 前缀: dsh-browser-tools.*
Cordis 节点 id: browser-tools
```

这些值属于已有 Session 持久状态、Controller Evidence、RPC、数据目录和用户偏好协议。保留它们可以避免品牌更名导致旧 Session、Compare Identity、Profile 数据或布局偏好失效。

## DSH 兼容范围

当前实现基线：

- 主要运行和 Web 验收：DSH `0.1.2-alpha.1`；
- 最低类型与核心兼容门禁：DSH `0.1.0-rc.8`。

`0.11.0-alpha.1` 已通过 Alpha 1 和 rc.8 双版本严格 TypeScript 检查，以及 Alpha 1 的真实 Agent Scope、Host RPC、Client 和 Web 验收。

这不等于所有高级 UI 和 L3 能力都已在每个旧 DSH 版本逐项人工验证。未来版本必须经过真实安装与运行验证后再扩展支持声明。

## 验证状态

工作树已经通过：

```text
npm run build
npm test
node tests/final-hygiene.mjs
```

覆盖：

- Alpha 1 / rc.8 双版本类型；
- Host 与 Client 构建；
- 30 工具真实 DSH 集成；
- Agent-scoped Controller 原子注册、恢复和竞态；
- Persistent Context、扩展、Popup 和双页；
- 输入、PasteEvent 和 Takeover；
- Debugger、Network、Profile、Provider 和 Emulation；
- L3 Context、Build、Application、Checkpoint、Compare、Incident 和隐私；
- 端口、External CDP、BrowserContext 和 `.runtime` 清理。

真实 Web 单 Session 和双 Session 验收均为：

```text
consoleErrors=[]
pageErrors=[]
```

## 开发

安装依赖：

```powershell
pnpm install --ignore-scripts --config.auto-install-peers=true
```

类型检查：

```powershell
npm run typecheck
```

构建：

```powershell
npm run build
```

完整内部回归：

```powershell
$env:DSH_ALPHA1_ROOT='D:\path\to\deepseek-harness-alpha1'
$env:DSH_BROWSER_SCOPE_CHROMIUM_ROOT='D:\path\to\browser-tools\chromium'
npm run test:full
```

公开默认回归使用 `npm test`，不执行依赖上述维护者环境的真实 DSH Agent Scope 和浏览器集成。

构建产物：

```text
lib/index.mjs
lib/index.d.mts
lib/client.js
lib/client.js.map
```

npm tarball 只允许包含：

```text
package.json
README.md
LICENSE
cordis.patch.yml
lib/index.mjs
lib/index.d.mts
lib/client.js
lib/client.js.map
```

## Developer Preview 限制

- `session-select` 仍为实验能力。
- 当前只完成一个高压力第三方浏览器插件的真实组合验证。
- 不自动迁移第三方标签、Cookie、Storage、ref 或页面状态。
- 不关闭、不卸载、不重配第三方插件。
- 不支持所有桌面浏览器能力、DRM、Native Messaging、Manifest V2 或所有硬件/系统授权。
- 本版本不继承 Alpha 10 的完整 L3 发布资格，不能宣称 L3 正式验收全绿。

详细版本变化见 [RELEASE_NOTES.md](https://github.com/HakureiMonika/dsh-browser-scope/blob/main/RELEASE_NOTES.md)。

## 反馈

普通问题和功能建议：

https://github.com/HakureiMonika/dsh-browser-scope/issues

敏感漏洞不要直接发布到公开 Issue，请先阅读 [SECURITY.md](https://github.com/HakureiMonika/dsh-browser-scope/blob/main/SECURITY.md)。

## 许可证

[MIT](./LICENSE)
