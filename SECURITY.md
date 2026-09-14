# 安全策略

## 支持范围

当前支持的公开候选版本是 `1.0.0-rc2`。

这是 Release Candidate，不承诺稳定版兼容周期。安全修复优先进入最新候选版本或后续正式版本。

## 报告普通问题

普通缺陷、兼容问题和功能建议提交到 [GitHub Issues](https://github.com/HakureiMonika/dsh-browser-scope/issues)。

提交时提供：

- DSH 版本
- DSH BrowserScope 版本
- 操作系统和 Node.js 版本
- `toolRegistrationMode`
- 同时加载的其他浏览器插件及其精确版本
- 可以公开的最小复现步骤
- 已脱敏的错误信息

不要在公开 Issue 中提交以下内容：

- API Key
- Cookie
- Authorization
- 浏览器会话
- 验证码
- 个人数据
- 私有源码
- 完整 Profile
- 未脱敏日志

## 报告安全漏洞

仓库启用 GitHub Private Vulnerability Reporting 时，优先使用私密报告入口。进入仓库的 `Security` 页面，选择私密漏洞报告入口。不要把敏感漏洞细节提交到公开 Issue。

辅助身份地址：

`107752645+HakureiMonika@users.noreply.github.com`

这是 GitHub noreply 身份地址，可能无法接收外部邮件。不要把它作为唯一的安全报告通道。

私密报告入口尚未启用时，可以先创建一个公开 Issue。Issue 中不要包含漏洞细节，只说明需要维护者提供私密沟通方式。

## 安全边界

DSH BrowserScope 遵守以下边界：

- 不读取或记录 API Key、Cookie、Authorization、密码、验证码或 Passkey 内容
- 不尝试绕过 CAPTCHA、人机验证、设备确认或其他安全挑战
- 只允许 HTTP/HTTPS 页面导航，拒绝 URL 内嵌凭据
- 对 Network、Console、Debugger 和诊断输出执行有界脱敏
- 不接管、卸载、重配或关闭第三方浏览器插件
- `session-select` 只仲裁当前 Agent Session 的模型工具面

发现实现违反这些边界时，按安全漏洞方式报告。
