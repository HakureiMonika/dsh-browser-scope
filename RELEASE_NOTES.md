# DSH BrowserScope 0.11.0-alpha.1 — Developer Preview

## 发布定位

`0.11.0-alpha.1` 是 DSH BrowserScope 的开发者预览版本，重点交付同一 DSH Profile 下的 Session 级浏览器控制器选择。

本版本适合希望在日常 Session 中继续使用其他浏览器插件，同时在前端开发 Session 中单独启用 DSH BrowserScope 的开发者。

本版本不是 Beta 或稳定版，也不宣称已经完成新的 L3 8/8 正式验收。

## 主要变化

### Session 级浏览器控制器

新增两种工具注册模式：

```yaml
toolRegistrationMode: global | session-select
```

- `global`：默认值，保持历史行为；30 个浏览器工具全局注册。
- `session-select`：本插件只在用户为当前正式 Agent Session 激活后注册 30 个工具。

`session-select` 使用 DSH Agent Scope 原生能力：

- 同名第三方工具由本插件在当前 Agent Scope 遮蔽；
- 第三方独有浏览器工具仅在当前 Agent Scope 被限制；
- 兄弟 Session 不受影响；
- 退出后第三方工具自动恢复；
- 不卸载、不重配、不停止第三方插件或其浏览器进程。

### Controller 生命周期

新增：

- 原子注册与回滚；
- `agent.whenIdle()` 和维护队列；
- 持久 Session 模式与 generation；
- Agent 原地替换的 `bindingGeneration` 防竞态；
- 冷恢复等待门；
- 安全退出与显式资源释放；
- Controller Identity 与 Compare 可比性保护。

### Web UI

- 空白 Hero Session 不允许提前激活 Controller；
- 用户发送首条消息形成正式 Agent Session 后，才可启用 DSH BrowserScope；
- 提供“退出并保留页面”和“退出并释放资源”；
- Session 切换时 Controller 快照、确认框和右侧面板不会串到其他 Session；
- 迟到的尽力清理 RPC 不再形成页面未处理 Promise rejection。

## 真实兼容验证

已验证第三方插件：

```text
dsh-builtin-browser@0.1.21
repository=wqty123/dsh-browser
gitHead=b26bab0f732ab6300447345a17e6cc42739fa9cc
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

真实 Electron 验收使用实际解析版本 `44.2.0`，确认普通 Session 的两个标签、Cookie 和第三方 Session ID 在另一 Session 激活与退出本插件期间保持不变；隔离 Profile Dispose 后无 Electron 残留。

## Web 验收

单正式 Session 已验证：

- 空白 Session 激活门禁；
- 正式 Session 激活；
- 完整九视图；
- 面板内关闭；
- 退出并保留页面；
- 重新激活；
- 退出并释放资源。

双正式 Session 已验证：

- Session A 启用 BrowserScope；
- Session B 保持 `other`；
- A 的右侧分屏不投影到 B；
- A/B 双向切换后状态保持；
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

覆盖 DSH `0.1.2-alpha.1` 与最低类型基线 `0.1.0-rc.8`、30 工具真实集成、Controller 竞态、Persistent Context、扩展、分屏、Debugger、Network、Profile、Recorder、L3 Controller Identity 和资源清理。

## 品牌与包名

公开包名从历史 `dsh-browser-tools` 更名为：

```text
dsh-browser-scope
```

产品名称为：

```text
DSH BrowserScope — Agent-Native Browser DevTools Workbench
```

为保持旧 Session、Controller Evidence、数据目录和用户偏好兼容，以下内部协议标识暂时保留：

```text
Controller mode/id: dsh-browser-tools
RPC: /browser-tools
数据目录: $DSH_HOME/browser-tools
Cordis 节点 id: browser-tools
```

目标 Profile 不能同时安装 `dsh-browser-tools` 和 `dsh-browser-scope`。

## 已知限制

- `session-select` 仍是实验性 Developer Preview 能力；
- 不承诺兼容所有第三方浏览器插件；
- 第三方标签、Cookie、Storage、ref 和页面状态不会迁移到本插件；
- 空白 Hero Session 必须先发送首条消息形成正式 Session；
- 当前只对 `dsh-builtin-browser@0.1.21` 完成真实运行时组合验证；
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

该历史结论没有被本版本覆盖。本版本只声明 Session Controller、真实第三方兼容、Web UI 和确定性回归已经通过。

## 安全与反馈

普通问题：

https://github.com/HakureiMonika/dsh-browser-scope/issues

安全报告请参阅 `SECURITY.md`，敏感漏洞细节不要直接发布到公开 Issue。
