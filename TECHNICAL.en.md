# DSH BrowserScope Technical Specifications

[简体中文](./TECHNICAL.md) | English Version

This document describes the configuration options, browser state model, and security boundaries of BrowserScope. For general installation and feature overviews, see [README.en.md](./README.en.md). For test credentials, see [VALIDATION.en.md](./VALIDATION.en.md).

## Configuration

Complete configuration example:

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

| Option | Default | Description |
| --- | --- | --- |
| `toolRegistrationMode` | `session-select` | Selects a browser toolset per formal Session on first use, then permanently locks it. `global` is reserved for standalone profiles and automatically degrades when other browser tools are detected. |
| `sessionController.includeTools` | `[]` | Explicit tool names to include in browser tool selection arbitration. |
| `sessionController.excludeTools` | `[]` | Explicit tool names to exclude from browser tool selection arbitration. |
| `executablePath` | Auto-detect | Explicit path to a Chromium or Chrome binary. |
| `headless` | `true` | Runs Chromium headless. Set to `false` when manual user verification or Captchas require a window. |
| `proxy.mode` | `system` | `system` follows OS/Chromium proxy settings; `direct` disables proxies; `custom` uses a dedicated proxy server. |
| `proxy.server` | None | Proxy server address supporting HTTP, HTTPS, SOCKS4, or SOCKS5. |
| `proxy.bypass` | None | Comma-separated domains bypassing the proxy. |
| `proxy.username` / `proxy.password` | None | Credentials for authenticated proxies (omitted from diagnostic outputs). |
| `artifactRoot` | `$DSH_HOME/browser-tools` | Root path for profiles, extensions, managed Chromium, and artifacts. |
| `allowedOrigins` | `[]` | Restricts navigations to explicit origins when non-empty. |
| `allowLoopback` | `true` | Allows navigations to `127.0.0.1` and `localhost`. |
| `allowPrivateNetwork` | `true` | Allows navigations to private RFC 1918 IPv4 ranges. |
| `uploadRoots` | Current process CWD | Approved directories from which local files can be uploaded. |
| `chromiumDownloadSource` | `auto` | Origin for downloading Chrome for Testing (`auto`, `npmmirror`, or `official`). |
| `subagentInteractive` | `false` | Whether Subagents are allowed to invoke interactive and write actions. |

## Tool Registration Modes

BrowserScope supports two modes. `session-select` is recommended for multi-plugin environments.

### 1. Global Mode (`global`)
```yaml
- id: browser-tools
  config:
    toolRegistrationMode: global
```
Registers all 30 tools into DSH globally. If pre-existing `browser_*` tools are detected at bootstrap, BrowserScope automatically degrades to `session-select` to prevent cordis registration conflicts.

### 2. Session-Select Mode (`session-select`)
```yaml
- id: browser-tools
  config:
    toolRegistrationMode: session-select
```
- **Concealed State**: Prior to selection, browser tools are concealed from the Agent to prevent premature invocation.
- **Provider Choice**: On first browser use, the user or model selects either DSH BrowserScope or pre-existing third-party browser tools.
- **Session Locking**: Selection permanently binds that Session. Switching plugins requires creating a new Session.
- **Shadowing & Masking**: When BrowserScope is selected, identical tool names from third parties are shadowed, and exclusive third-party browser tools are restricted for that Session only.
- **Non-Interference**: If third-party tools are chosen, BrowserScope steps aside without allocating pages or registering tools.

## State Models & Isolation

BrowserScope implements a dual-layer state model:

### Shared Across Sessions
- Cookies, LocalStorage, SessionStorage, IndexedDB, Cache Storage.
- HTTP caches and Service Workers.
- Installed extensions and web permissions.

### Isolated Per Session
- Browser pages, tabs, popups, and tab navigation history.
- Active viewport focus and split-view geometry.
- CDP debugger sessions, network interception journal, and action timeline.
- Takeover input locks and diagnostic artifacts.

## Security & Isolation Invariants

1. **Path Traversal Protection**: Uploads and downloads are bound to explicit directories. Path escaping or symlink traversal attempts are rejected.
2. **Credential Sanitization**: Debugger scopes, network logs, and console entries automatically redact tokens, passwords, and authorization headers.
3. **Takeover Exclusivity**: When manual takeover is active, Agent write interactions are halted with `USER_TAKEOVER_ACTIVE` to prevent conflicting actions.
4. **Graceful Degradation**: If browser resources are disposed, the session lock remains recorded in schema v2 persistence, safely resuming upon DSH restarts.
