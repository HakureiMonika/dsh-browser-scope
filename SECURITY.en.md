# Security Policy

[简体中文](./SECURITY.md) | English Version

## Supported Versions

The currently supported public release candidate is `1.0.0-rc2`.

This is a Release Candidate and does not follow a stable-release compatibility cycle. Security fixes will be prioritized for the latest release candidate or a later stable release.

## Reporting Regular Issues

Report general bugs, compatibility problems, and feature requests through [GitHub Issues](https://github.com/HakureiMonika/dsh-browser-scope/issues).

Please include:

- DSH version
- DSH BrowserScope version
- Operating system and Node.js version
- `toolRegistrationMode`
- Exact versions of any other browser plugins loaded at the same time
- A minimal reproduction that is safe to share publicly
- Redacted error information

Do not include any of the following in a public Issue:

- API keys
- Cookies
- Authorization headers or tokens
- Browser sessions
- Verification codes
- Personal data
- Private source code
- Complete browser profiles
- Unredacted logs

## Reporting Security Vulnerabilities

When GitHub Private Vulnerability Reporting is available for this repository, use it as the preferred reporting channel. Open the repository's `Security` page and select the private vulnerability reporting option. Do not submit sensitive vulnerability details through a public Issue.

Secondary identity address:

`107752645+HakureiMonika@users.noreply.github.com`

This is a GitHub noreply identity address and may not receive external email. Do not use it as the only security reporting channel.

If private reporting is not available, create a public Issue without vulnerability details and ask the maintainer to provide a private communication channel.

## Security Boundaries

DSH BrowserScope follows these boundaries:

- It does not read or record API keys, cookies, Authorization data, passwords, verification codes, or Passkey contents.
- It does not attempt to bypass CAPTCHA, human verification, device confirmation, or other security challenges.
- It only allows navigation to HTTP and HTTPS pages, and rejects credentials embedded in URLs.
- It applies bounded redaction to Network, Console, Debugger, and diagnostic output.
- It does not take over, uninstall, reconfigure, or stop third-party browser plugins.
- `session-select` only arbitrates the model-facing tool surface of the current Agent Session.

If the implementation violates any of these boundaries, report it as a security vulnerability.
