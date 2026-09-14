# DSH BrowserScope 技术细节

本文说明 BrowserScope 的配置项、浏览器状态模型和安全边界。安装和功能概览见 [README](./README.md)，测试依据见 [测试报告](./VALIDATION.md)。

## 配置

完整配置示例：

```yaml
- id: browser-tools
  config:
    toolRegistrationMode: session-select
    headless: true
    proxy:
      mode: system
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
      includeTools: []
      excludeTools: []
```

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `toolRegistrationMode` | `session-select` | 每个正式 Session 首次选择一套浏览器工具，选定后保持锁定。显式 `global` 只用于独占 Profile，检测到已有浏览器工具时自动降级 |
| `sessionController.includeTools` | `[]` | 额外纳入浏览器选择范围的工具名 |
| `sessionController.excludeTools` | `[]` | 不纳入浏览器选择范围的工具名 |
| `executablePath` | 自动探测 | 显式指定浏览器可执行文件 |
| `headless` | `true` | 是否无头运行。需要人工完成安全验证时设为 `false` |
| `proxy.mode` | `system` | `system` 跟随 Chromium 和操作系统代理，`direct` 明确直连，`custom` 使用自定义代理 |
| `proxy.server` | 无 | 自定义 HTTP、HTTPS、SOCKS4 或 SOCKS5 代理地址 |
| `proxy.bypass` | 无 | Playwright 代理绕过列表 |
| `proxy.username` / `proxy.password` | 无 | 代理认证字段。不要写进 `proxy.server` URL，也不会出现在诊断输出里 |
| `artifactRoot` | `$DSH_HOME/browser-tools` | Profile、扩展、Chromium 和 Artifact 根目录 |
| `allowedOrigins` | `[]` | 非空时只允许指定 Origin |
| `allowLoopback` | `true` | 是否允许 Loopback |
| `allowPrivateNetwork` | `true` | 是否允许私有 IPv4 地址 |
| `uploadRoots` | 当前进程目录 | 上传文件允许的目录 |
| `chromiumDownloadSource` | `auto` | `auto`、`npmmirror` 或 `official` |
| `subagentInteractive` | `false` | 是否允许 Subagent 使用交互和敏感能力 |

## 工具注册模式

BrowserScope 支持两种模式，默认用更适合共存环境的 `session-select`。

独占 Profile 且确定没有其他浏览器工具时可以用 `global`：

```yaml
- id: browser-tools
  config:
    toolRegistrationMode: global
```

如果启动时已经存在 `browser_*` 工具，BrowserScope 会自动降级到 `session-select`，不会因为名称冲突拦住 DSH 启动。

多插件共存用 `session-select`：

```yaml
- id: browser-tools
  config:
    toolRegistrationMode: session-select
```

`session-select` 的行为：

- 新建正式 Session 时，BrowserScope 先等待用户选择浏览器工具。
- 选择前，当前 Session 暂时不向 Agent 暴露浏览器工具，防止 Agent 抢先使用某一套工具。
- 用户可以选择 DSH BrowserScope，也可以选择当前 Profile 中已有的其他浏览器工具。
- 选择 DSH BrowserScope 后，本插件的 30 个工具注册到当前 Agent Scope；同名第三方工具被本插件覆盖，其他浏览器工具只在当前 Session 隐藏。
- 选择其他浏览器工具后，BrowserScope 不注册工具，也不创建浏览器资源。
- 选择结果以 schema v2 写入 Session 对应的持久记录。DSH 重启或 Agent Scope 替换后仍保持原选择。
- schema v1 的 `dsh-browser-tools` 状态迁移后继续锁定 BrowserScope；schema v1 的 `other` 只表示旧版当时未启用 BrowserScope，迁移为 `unselected`，避免误锁。
- 损坏或不可读记录保持 `unselected`。如果 schema v2 已经锁定 BrowserScope，但本次工具面恢复失败，Controller 会保留 BrowserScope 锁定并继续隐藏第三方浏览器工具，不会把 Session 降级为可改选状态。
- 同一个 Session 不能中途更换浏览器插件。需要使用另一套浏览器工具时，新建 Session。
- 关闭 BrowserScope 标签或释放 BrowserScope 资源不会解除选择。后续再次使用时只会重新创建 BrowserScope 自己的页面。
- 兄弟 Session 可以独立选择，彼此不受影响。
- BrowserScope 不卸载、不停止、不重配其他插件，也不修改它们的 Provider、页面、Cookie 或进程。

这个限制用于避免状态混用。不同浏览器插件各自维护页面、标签、元素引用、Cookie 和调试状态。中途更换后，Agent 很容易把前一套工具生成的引用继续交给后一套工具，得到错误结果。让每个 Session 固定一套浏览器工具，可以从根源上消除这类冲突。

“其他浏览器工具”代表当前 Profile 中已经存在的第三方浏览器工具集合。DSH 当前的工具 Schema 没有提供可靠的插件归属信息，因此 BrowserScope 不能替多个第三方浏览器插件处理它们彼此之间的冲突。

Controller RPC 使用以下端点：

```text
controller_status
controller_activate
controller_select_other
controller_release
```

`controller_activate` 和 `controller_select_other` 只允许在 `unselected` 状态调用。`controller_release` 只释放 BrowserScope 自己的运行资源，不修改选择代际，也不解除工具锁定。

## 浏览器状态模型

默认 `managed-persistent/default` 使用插件级共享 Persistent BrowserContext。

跨 DSH Session 共享：

- Cookie、HTTP 缓存和网站存储
- Service Worker 与网站权限
- 扩展登记和加载状态

按 Session 隔离：

- Page、View、标签和 Popup
- Debugger、Network 拦截和 CDP Session
- Ref、Snapshot、Screencast 和 Viewport 代际
- Artifact、Takeover、上下或左右双页和焦点
- Controller 选择与 generation

需要完全隔离时用 `managed`，或者一个非默认命名的 Persistent Profile。

## 安全边界

- 只允许 HTTP/HTTPS 导航，拒绝 URL 内嵌用户名或密码。
- Host RPC 走 Connection 已认证的 `/api/browser-tools` 精确路由。
- 上传路径必须在 `uploadRoots` 内。
- Debugger、Console、Network 和诊断输出执行有界脱敏。
- `browser_evaluate` 始终算敏感操作。
- 插件不读取、不枚举、不保存系统剪贴板历史，只接收最终 PasteEvent。
- CAPTCHA、验证码、Passkey/WebAuthn、设备确认等安全挑战必须停止自动操作并请求人工接管。
- BrowserScope 通过共享 Persistent Profile、代理选择和更接近普通浏览器的启动参数，减少验证 Cookie、出口 IP 与启动环境反复变化造成的循环。它不绕过 Cloudflare、CAPTCHA 或站点安全策略。代理出口变化后站点仍可能要求重新验证。
- 自适应实况使用 Host 初始化状态、串行尺寸上报和测量代际丢弃过期布局，避免 Agent 工具调用后的短暂尺寸覆盖稳定 Viewport。
- `session-select` 不提升权限，也不为其他插件的执行结果提供安全背书。

安全问题按 [安全策略](./SECURITY.md) 私密报告。不要在公开 Issue 里贴凭据、会话或未脱敏日志。

## 内部标识

以下内部标识保留，避免改名破坏旧 Session、Controller Evidence、数据目录和用户偏好：

```text
Controller mode/id: dsh-browser-tools
RPC: /api/browser-tools
数据目录: $DSH_HOME/browser-tools
LocalStorage 前缀: dsh-browser-tools.*
Cordis 节点 id: browser-tools
```

## 30 个 Agent 工具

导航与页面操作：

`browser_tabs` · `browser_navigate` · `browser_navigate_back` · `browser_snapshot` · `browser_click` · `browser_hover` · `browser_scroll` · `browser_type` · `browser_press_key` · `browser_select_option` · `browser_wait_for` · `browser_get_attribute` · `browser_query` · `browser_handle_dialog`

观察、文件与网络：

`browser_take_screenshot` · `browser_console_messages` · `browser_network_requests` · `browser_upload_file` · `browser_download` · `browser_network_control`

调试与运行环境：

`browser_debugger` · `browser_diagnose` · `browser_profile` · `browser_emulate` · `browser_evaluate` · `browser_provider`

工作台与控制权：

`browser_live_view` · `browser_split_view` · `browser_extensions` · `browser_takeover`

## 九视图工作台

九个视图共用同一个 Session 级右侧标签：

| 视图 | 用途 |
| --- | --- |
| 实况 | 查看和人工操作当前页面，切换显示模式与上下或左右双页 |
| 诊断 | Debug Session、Action、Checkpoint、Compare、Incident 和 Context Topology |
| Console | 查看当前焦点页的有界 Console 记录 |
| Network | 请求元数据、暂停请求和受控网络操作 |
| Debugger | 脚本、断点、暂停、单步、调用栈和 Scope |
| Performance | Trace、CPU、Coverage、Heap 和 Artifact |
| Provider | Managed、Persistent 和 External CDP |
| Extensions | Manifest V3 扩展、应用状态和真实 Popup |
| Emulation | Viewport、设备、地区、网络、CPU、离线和权限 |

标签栏、后退、前进、刷新和地址栏在每个视图里都在。右侧栏标签由 DSH 官方 Tab 机制管理，关闭、切换和多 Pane 行为按 Session 隔离。
