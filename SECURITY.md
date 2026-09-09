# 安全策略

## 支持范围

当前公开预览版本为 `0.11.0-alpha.1`。它属于 Developer Preview，不承诺稳定版兼容周期；安全修复优先进入最新预发布版本。

## 报告普通问题

普通缺陷、兼容问题和功能建议请提交到：

https://github.com/HakureiMonika/dsh-browser-scope/issues

请提供：

- DSH 版本；
- DSH BrowserScope 版本；
- 操作系统与 Node.js 版本；
- `toolRegistrationMode`；
- 是否同时加载其他浏览器插件及其精确版本；
- 可公开的最小复现步骤；
- 已脱敏的错误信息。

不要在公开 Issue 中粘贴 API Key、Cookie、Authorization、浏览器会话、验证码、个人数据、私有源码、完整 Profile 或未脱敏日志。

## 报告安全漏洞

如果仓库已启用 GitHub Private Vulnerability Reporting，请优先使用仓库 Security 页面中的私密报告入口。敏感漏洞细节不要直接提交到公开 Issue。

辅助身份地址：

`107752645+HakureiMonika@users.noreply.github.com`

该地址是 GitHub noreply 身份地址，可能无法接收外部邮件，因此不能作为唯一安全报告通道。若私密报告入口尚未启用，请先创建不包含漏洞细节的公开 Issue，说明需要维护者提供私密沟通方式。

## 安全边界

DSH BrowserScope：

- 不应读取或记录 API Key、Cookie、Authorization、密码、验证码或 Passkey 内容；
- 不应尝试绕过 CAPTCHA、人机验证、设备确认或其他安全挑战；
- 只允许 HTTP/HTTPS 页面导航，并拒绝 URL 内嵌凭据；
- 对 Network、Console、Debugger 和诊断输出执行有界脱敏；
- 不接管、卸载、重配或关闭第三方浏览器插件；
- `session-select` 只仲裁当前 Agent Session 的模型工具面。

如果发现实现违反上述边界，请按安全漏洞方式报告。
