<div align="center">

# DSH BrowserScope

### 把完整 Chromium DevTools 交给 DSH Agent

不只看页面。能点击、能断点、能抓请求、能读 Source Map，还能把现场证据留下。

![License](https://img.shields.io/badge/license-MIT-2563EB?style=for-the-badge)
![DSH](https://img.shields.io/badge/DSH-0.1.5--rc.2-7C3AED?style=for-the-badge)
![Node](https://img.shields.io/badge/Node-%5E22.19.0%20%7C%7C%20%3E%3D24.0.0-16A34A?style=for-the-badge&logo=nodedotjs&logoColor=white)
![Status](https://img.shields.io/badge/status-Release%20Candidate-F97316?style=for-the-badge)

[立即安装](#安装) · [看图了解](#能力展示) · [30 个工具](#功能介绍) · [测试结果](#能力测试结果) · [技术细节](./TECHNICAL.md) · [English](./README.en.md)

</div>

---

![BrowserScope 嵌入 DSH Web 的实况工作台](./assets/browser-scope-hero.png)

## 插件简介

前端调试最头疼的是什么？看不到页面结构、抓不到请求细节、断点打不进去、错误只有一句话。Agent 遇到复杂网页问题时更麻烦——只能截个图、描述几句,然后陷入"刷新试试""清缓存看看"的循环。

BrowserScope 在 DSH Web 右侧栏嵌入一个完整的 Chromium 工作台，配备 30 个专门定制的自动化工具。Agent 现在能直接读页面结构、操作元素、查看 Console、追踪请求、下断点、读调用栈、解析 Source Map、分析性能，并把操作前后的完整现场记录下来。从基础的点击滑动，到深度的断点调试和性能瓶颈定位，全在一个 Session 里完成。

支持多插件共存，适配 DSH `0.1.5-rc.2`。每个正式 Session 第一次使用浏览器前，需要选择 BrowserScope 或当前 Profile 中已有的其他浏览器工具。选定后，该 Session 会一直使用同一套工具；其他 Session 可以独立选择。这样可以避免不同插件的页面、标签、元素引用和登录状态互相混用。

## 目录

- [能力测试结果](#能力测试结果)
- [能力展示](#能力展示)
- [安装](#安装)
- [功能介绍](#功能介绍)
  - [浏览与操作](#浏览与操作)
  - [Console 与请求](#console-与请求)
  - [断点与源码](#断点与源码)
  - [性能与诊断](#性能与诊断)
  - [实况与人工接管](#实况与人工接管)
  - [扩展与浏览器环境](#扩展与浏览器环境)
  - [Session 控制](#session-控制)
- [技术细节](#技术细节)
- [测试报告 (VALIDATION.md)](./VALIDATION.md)
- [English Version (README.en.md)](./README.en.md)
- [兼容范围](#兼容范围)
- [使用反馈](#使用反馈)
- [License](#license)

## 能力测试结果

所有测试在真实 Chromium、真实 DSH Web 和实际生产代码环境中执行,不使用模拟器或简化场景。

**核心能力**

- **30 个浏览器工具**在真实 Chromium 环境中全部跑通
- **9 个原生工作台视图**在真实 DSH Web 中全部验收通过
- **多插件共存**已通过单 Session 单浏览器锁定专项、真实 Agent Scope 集成和 DSH `0.1.5-rc.2` Web 验收
- **4 个 DSH 版本**兼容性测试全线通过
- **长时间高强度运行**(30 分钟 × 3 档),性能稳定,内存不漏

**专项验证**

| 测试项目 | 覆盖范围 | 结果 |
| --- | --- | --- |
| **完整工具链回归** | 30 个工具全覆盖 | **全部通过** |
| **DSH Web 原生工作台** | 9 个视图 + 多 Session + 多 Pane | **全部通过** |
| **多插件共存** | 单 Session 首次选择、锁定、释放、独立选择和重启恢复 | **RC2 实机通过** |
| **复杂网页故障** | 异步 + 跨页 + 生产代码 | **插件能力 PASS** |
| **多版本兼容** | 4 个 DSH 版本 | **全线通过** |
| **性能压力** | 高频操作 × 30 分钟 × 3 档 | **稳定运行** |

完整测试报告见 [VALIDATION.md](./VALIDATION.md)。

## 能力展示

### 一个窗口，完整调试链路

Agent 对话、真实页面、标签栏、地址栏和调试结果全在 DSH 右侧栏。当页面出现异常时，不用在多个窗口来回切换——直接在原位查看 DOM 结构、Console 输出、Network 请求和脚本堆栈。

**真实使用案例**：页面布局突然错乱。Agent 调用 `browser_snapshot` 读取 DOM 结构，发现某个容器的 `display` 被异步脚本改成了 `none`。接着用 `browser_debugger` 在相关脚本里下断点，配合 Source Map 找到原始代码位置，最终定位到一个状态更新时序问题。全程无需人工介入，现场证据完整清晰。

### 首次选择，Session 内保持一致

![正式 Session 首次选择浏览器工具](./assets/browser-scope-session-controller-1.png)

正式 Session 第一次使用浏览器前，需要选择 BrowserScope 或当前 Profile 中已有的其他浏览器工具。选择前，当前 Session 暂时不向 Agent 暴露浏览器工具。

![BrowserScope 选择后在当前 Session 保持锁定](./assets/browser-scope-session-controller-2.png)

选择 BrowserScope 后，当前 Session 只使用 BrowserScope；选择其他浏览器工具后，BrowserScope 不会在该 Session 注册工具或创建浏览器资源。选定后不能中途更换，需要换插件时新建 Session。其他 Session 可以独立选择，第三方插件本身不被停止或修改。

![当前 Session 已仲裁的 BrowserScope 工具](./assets/browser-scope-session-controller-3.png)

释放 BrowserScope 资源只会关闭它自己的页面和调试状态，不会解除当前 Session 的工具选择。DSH 重启或 Agent Scope 替换后，原选择继续保持。

### 线上压缩代码？直接还原

![Debugger、真实调用栈与 Source Map](./assets/browser-scope-debugger.png)

代码被 Webpack 压缩成一行？没关系。连上 CDP Debugger，挂上 Source Map，直接在原始源码里找问题。调用栈、变量作用域、断点位置全都能准确映射回去。

**真实使用案例**：线上报错 `Uncaught TypeError: Cannot read property 'data' of undefined`，但堆栈指向的是压缩后的 `bundle.min.js:1:47392`。Agent 用 `browser_debugger` 暂停脚本，读取 Source Map，把这个位置映射到 `src/api/fetchUser.ts:23:15`，发现是异步请求的错误处理缺失。

### 请求时序，一清二楚

![Network Journal 中的连续布局请求](./assets/browser-scope-network.png)

抓包列表按时间排列，`mode` 和 `generation` 的变化直接标出异步任务的先后顺序。专治状态覆盖、响应迟到这类时序 Bug。

**真实使用案例**：页面偶尔显示错误的用户信息。Agent 用 `browser_network_requests` 捕获所有 `/api/user` 请求，发现同时发出了两个请求，但旧请求的响应比新请求晚 200ms 到达，覆盖了正确结果。定位到根因是组件快速切换时没有取消前一个请求。

### 双页实况，同时盯梢

![BrowserScope 上下双页实况](./assets/browser-scope-split-view.png)

两个真实页面，独立画面，独立焦点。做响应式检查时上下排列，跨页面对比时左右排列。

**真实使用案例**：验证移动端和桌面端的布局一致性。Agent 用 `browser_split_view` 同时加载两个不同 Viewport 的页面，用 `browser_snapshot` 分别读取关键元素的位置和样式，发现移动端某个按钮被遮挡。

### 保护现场，有据可查

![Debug Session、Topology、Recorder 与 Action Timeline](./assets/browser-scope-diagnose-1.png)

Debug Session 把页面身份、操作时间线、Context Topology 和 Build Identity 打包在一起。

![Checkpoint、Compare、Incident 与 Takeover 摘要](./assets/browser-scope-diagnose-2.png)

操作前后各存一个 Checkpoint，直接 Compare 生成 Incident 报告。图中是 BrowserScope 精准识别出演示应用预埋故障的实况。

**真实使用案例**：用户反馈"点击提交后页面没反应"。Agent 用 `browser_diagnose` 在点击前后各保存一个 Checkpoint，Compare 发现提交按钮的 `disabled` 属性被设为 `true` 但从未恢复。结合 Network Journal 发现请求返回了 500 错误，但前端没有处理，导致按钮永久禁用。

### 性能问题，无处藏身

![Performance 工具栏与性能制品](./assets/browser-scope-performance.png)

CPU 飙高？内存泄漏？用 Trace 看主线程阻塞，用 CPU Profile 找热点函数，用 Heap Snapshot 查对象保留。所有大文件自动存入 Session 隔离的 Artifact Store，不会撑爆 AI 的上下文。

**真实使用案例**：页面滚动卡顿。Agent 用 `browser_profile` 采集 CPU Profile，发现某个图片懒加载函数在每次滚动事件中都被调用，且没有节流。定位到性能瓶颈后，建议加入 `debounce` 处理。

## 安装

需要 Node.js `^22.19.0` 或 `>=24.0.0`，以及一个可以正常启动的 DSH Web Profile。

安装插件：

```powershell
dsh plugin --profile web add dsh-browser-scope@1.0.0-rc2 --ignore-scripts --config.auto-install-peers=false
```

或使用本地 tarball：

```powershell
dsh plugin --profile web add ./dsh-browser-scope-1.0.0-rc2.tgz --ignore-scripts --config.auto-install-peers=false
```

在 Profile 的 `cordis.patch.yml` 中启用：

```yaml
- insert:
    - id: browser-tools
      name: dsh-browser-scope
```

启动 DSH Web，新建 Session 并发送一条消息。打开输入区的“浏览器”菜单，选择“使用 DSH BrowserScope”或“使用其他浏览器工具”。确认后，该 Session 的选择会保持锁定。

从历史包 `dsh-browser-tools` 升级时，先移除旧包。保留 `id: browser-tools` 和 `$DSH_HOME/browser-tools`。两个包不要同时安装在同一个 Profile 中。

## 功能介绍

### 浏览与操作

| 功能 | 说明 | 工具 |
| --- | --- | --- |
| 标签管理 | 查看、创建、切换和关闭标签 | `browser_tabs` |
| 页面导航 | 打开 URL、后退、前进和刷新 | `browser_navigate`, `browser_navigate_back` |
| 读取页面 | 读取页面结构、元素位置、属性和查询结果 | `browser_snapshot`, `browser_get_attribute`, `browser_query` |
| 操作页面 | 点击、悬停、滚动、输入文字、按键、选择下拉项和等待变化 | `browser_click`, `browser_hover`, `browser_scroll`, `browser_type`, `browser_press_key`, `browser_select_option`, `browser_wait_for` |
| 处理弹窗 | 接受或拒绝页面弹窗，并填写 Prompt | `browser_handle_dialog` |
| 执行脚本 | 在页面或指定元素中执行 JavaScript | `browser_evaluate` |
| 截图 | 保存当前页面画面 | `browser_take_screenshot` |
| 上传下载 | 上传本地文件，捕获并保存下载文件 | `browser_upload_file`, `browser_download` |

### Console 与请求

| 功能 | 说明 | 工具 |
| --- | --- | --- |
| 读取 Console | 查看日志、警告、错误和重复消息 | `browser_console_messages` |
| 查看请求 | 查看请求地址、方法、状态、资源类型和发生顺序 | `browser_network_requests` |
| 查看请求内容 | 读取请求和响应 Body | `browser_network_requests` |
| 暂停请求 | 在请求或响应阶段拦截流量 | `browser_network_control` |
| 放行或终止 | 对被暂停的请求执行 Continue 或 Abort | `browser_network_control` |
| 模拟响应 | 返回自定义状态、Header 和 Body | `browser_network_control` |
| 重发请求 | 重放已经发生的请求 | `browser_network_control` |
| 自动恢复 | 拦截超时后自动放行，避免页面卡住 | `browser_network_control` |

### 断点与源码

| 功能 | 说明 | 工具 |
| --- | --- | --- |
| 连接调试器 | 连接当前页面的 CDP Debugger | `browser_debugger` |
| 断点控制 | 设置断点、暂停、继续、单步进入、单步跳过和单步跳出 | `browser_debugger` |
| 查看调用栈 | 查看函数调用顺序、脚本位置和暂停原因 | `browser_debugger` |
| 查看变量 | 查看 Local、Closure 和 Global 中的变量 | `browser_debugger` |
| 读取脚本 | 查看页面加载的脚本和运行时源码 | `browser_debugger` |
| 还原源码 | 把压缩代码位置映射回原始文件和行列 | `browser_debugger`, `browser_diagnose` |
| 识别构建版本 | 记录脚本内容和构建身份，避免读错版本 | `browser_diagnose` |
| 区分执行环境 | 区分主世界、隔离世界和暂停帧 | `browser_debugger`, `browser_diagnose` |

### 性能与诊断

| 功能 | 说明 | 工具 |
| --- | --- | --- |
| 记录 Trace | 记录页面主线程、网络和渲染过程 | `browser_profile` |
| 记录操作过程 | 保存页面动作、Snapshot、请求和时间线 | `browser_profile` |
| 分析 CPU | 找到耗 CPU 的函数和调用路径 | `browser_profile` |
| 统计覆盖 | 查看 JavaScript 和 CSS 使用情况 | `browser_profile` |
| 查看内存 | 保存 Heap Snapshot，调查对象保留问题 | `browser_profile` |
| 观察内存增长 | 使用 Heap Sampling 观察长任务中的分配热点 | `browser_profile` |
| 建立诊断会话 | 把页面、操作、上下文和构建信息放在一起 | `browser_diagnose` |
| 保存 Checkpoint | 记录操作前后的页面和身份状态 | `browser_diagnose` |
| 对比变化 | 比较两个 Checkpoint，标出变化和回退 | `browser_diagnose` |
| 生成 Incident | 汇总动作、Console、请求、身份和对比结果 | `browser_diagnose` |
| 记录关键事件 | 按 Off、Rolling、Deep、Metadata-only 和 Incident 模式记录 | `browser_diagnose` |
| 保存大文件 | 把 Trace、Profile、Heap 和报告保存到 Session 目录 | `browser_profile`, `browser_diagnose` |

### 实况与人工接管

| 功能 | 说明 | 工具 |
| --- | --- | --- |
| 查看实况 | 在右侧栏持续查看当前页面 | `browser_live_view` |
| 自动调整尺寸 | 页面跟随面板尺寸变化，避免输入坐标错乱 | `browser_live_view`, `browser_emulate` |
| 上下双页 | 同时查看两个页面 | `browser_split_view` |
| 左右双页 | 横向查看两个页面 | `browser_split_view` |
| 人工点击 | 用鼠标直接操作页面 | `browser_takeover` |
| 人工输入 | 用键盘输入文本和组合键 | `browser_takeover` |
| 中文输入 | 正常输入中文，不会拆成错误按键 | `browser_takeover` |
| 粘贴内容 | 使用最终粘贴事件，不读取剪贴板历史 | `browser_takeover` |
| 人工接管 | 暂时接管页面，完成后把控制权还给 Agent | `browser_takeover` |
| 防止旧输入 | 页面尺寸或画面变化后，拒绝过期坐标输入 | `browser_takeover` |

### 扩展与浏览器环境

| 功能 | 说明 | 工具 |
| --- | --- | --- |
| 安装扩展 | 使用 Chrome Web Store 链接或扩展 ID | `browser_extensions` |
| 安全解包 | 检查压缩包路径、重复文件、符号链接和大小限制 | `browser_extensions` |
| 管理扩展 | 安装、启用、禁用、卸载和重新应用 Manifest V3 扩展 | `browser_extensions` |
| 操作 Popup | 打开并操作真实 `chrome-extension://` Popup | `browser_extensions` |
| 隔离 Popup | Popup 不进入普通标签栏，不影响当前网页 | `browser_extensions` |
| 选择浏览器 | 使用托管、持久或外部 CDP 浏览器 | `browser_provider` |
| 保留登录状态 | 持久保存 Cookie、缓存、权限和扩展状态 | `browser_provider` |
| 连接已有浏览器 | 连接外部 Chromium，断开时不关闭浏览器 | `browser_provider` |
| 模拟设备 | 设置 Viewport、设备、地区、时区、网络、CPU 和离线状态 | `browser_emulate` |
| 模拟权限 | 控制页面权限 | `browser_emulate` |
| 配置代理 | 使用系统代理、直连或自定义 HTTP / HTTPS / SOCKS 代理 | 插件配置 |

### Session 控制

| 功能 | 说明 |
| --- | --- |
| 首次选择 | 正式 Session 第一次使用浏览器前，选择 BrowserScope 或其他浏览器工具 |
| Session 锁定 | 选择后不能在同一个 Session 中更换浏览器插件；需要更换时新建 Session |
| 选择前保护 | 尚未选择时，当前 Session 暂时不向 Agent 暴露识别到的浏览器工具 |
| 按需注册 | 选择 BrowserScope 后，只在当前 Session 注册 30 个工具 |
| 全局模式 | 独占 Profile 可以全局注册 BrowserScope 工具 |
| 安全降级 | 全局模式发现已有浏览器工具时，自动改为按 Session 选择 |
| 工具替换 | 选择 BrowserScope 后，只在当前 Session 中遮蔽同名工具并隐藏第三方独有浏览器工具 |
| 选择其他工具 | BrowserScope 不在该 Session 注册工具或创建浏览器资源，第三方工具恢复可见 |
| 释放资源 | 关闭 BrowserScope 页面和调试状态，但不解除该 Session 的 BrowserScope 锁定 |
| 重启恢复 | DSH 重启或 Agent Scope 替换后，继续恢复该 Session 已保存的选择 |
| 旧状态迁移 | 旧 BrowserScope 激活状态继续锁定；旧 `other` 状态迁移为尚未选择 |
| 隔离 Session | 一个 Session 的选择、标签和调试状态不会改变其他 Session 的选择 |
| 共享网站状态 | Cookie、LocalStorage、IndexedDB、Cache Storage、HTTP 缓存、Service Worker 和权限可以跨 Session 共享 |
| 隔离页面状态 | Page、View、标签、Popup、活动页和双页焦点按 Session 隔离 |
| 隔离调试状态 | Debugger、请求拦截、Ref、Snapshot 和实况画面按 Session 隔离 |
| 隔离文件 | Artifact、Takeover 和 Controller 状态按 Session 隔离 |
| 跟踪页面来源 | `window.open()` 页面继承正确 Owner；无法确认来源的页面不会暴露给其他 Session |
| 恢复页面布局 | 浏览器 Context 重建后，恢复各 Session 的地址、活动标签和双页布局 |
| 生命周期保护 | 支持原子注册、失败回滚、冷恢复、Agent 替换保护和资源释放 |

## 技术细节

完整配置、工具注册模式、状态模型、安全边界、内部标识和工具清单见 [TECHNICAL.md](./TECHNICAL.md)。

## 测试报告

多环境真实工况实测记录见 [VALIDATION.md](./VALIDATION.md)。

## 兼容范围

当前版本 `1.0.0-rc2` 适配 DSH `0.1.5-rc.2`，要求 Cordis `>=4.0.2 <5`、Schemastery `>=3.18.2 <4`。

候选状态以外部 candidate-identity.json 和 tarball 摘要为准。

## 使用反馈

遇到缺陷、兼容问题或有新功能建议，请提交 [GitHub Issue](https://github.com/HakureiMonika/dsh-browser-scope/issues)。带上 DSH 版本、BrowserScope 版本、操作系统、Node.js 版本和同时加载的浏览器插件，可以更快定位问题。

安全漏洞请按 [安全策略](./SECURITY.md) 私密报告。不要把凭据、Cookie、会话数据或未脱敏日志放进公开 Issue。

## License

[MIT](./LICENSE)
