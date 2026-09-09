import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const checked = []

function collect(path) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const target = join(path, entry.name)
    if (entry.isDirectory()) collect(target)
    else if (['.ts', '.tsx', '.mjs', '.css'].some(extension => entry.name.endsWith(extension))) checked.push(target)
  }
}

collect(join(root, 'src'))
collect(join(root, 'tests'))
for (const path of [
  'README.md',
  'LICENSE',
  'SECURITY.md',
  'RELEASE_NOTES.md',
]) checked.push(join(root, path))

const issues = []
for (const path of checked) {
  const text = readFileSync(path, 'utf8')
  if (/[ \t]+$/m.test(text)) issues.push({ path, issue: 'trailing-whitespace' })
  if (text.length > 0 && !text.endsWith('\n')) issues.push({ path, issue: 'missing-final-newline' })
  if (/^(<<<<<<< |>>>>>>> |=======$)/m.test(text)) issues.push({ path, issue: 'conflict-marker' })
}
assert.deepEqual(issues, [])

const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
assert.equal(packageJson.name, 'dsh-browser-scope')
assert.equal(packageJson.version, '0.11.0-alpha.1')
assert.equal(packageJson.description, 'Agent-native browser DevTools workbench with session-scoped controller arbitration for DeepSeek Harness')
assert.equal(packageJson.homepage, 'https://github.com/HakureiMonika/dsh-browser-scope#readme')
assert.equal(packageJson.bugs?.url, 'https://github.com/HakureiMonika/dsh-browser-scope/issues')
assert.equal(packageJson.repository?.url, 'git+https://github.com/HakureiMonika/dsh-browser-scope.git')
assert.equal(packageJson.author?.name, 'HakureiMonika')
assert.equal(packageJson.author?.email, '107752645+HakureiMonika@users.noreply.github.com')
assert.equal(packageJson.license, 'MIT')
assert.deepEqual(packageJson.files, ['lib', 'cordis.patch.yml', 'README.md', 'LICENSE'])
// 公开默认门禁只能依赖仓库安装产物；真实 Alpha 1 与 Chromium 集成必须留在显式维护者入口。
assert.equal(packageJson.scripts.typecheck, 'tsc --noEmit -p tsconfig.json')
assert.equal(packageJson.scripts['typecheck:alpha1'], 'tsc --noEmit -p tsconfig.alpha1.json')
assert.equal(packageJson.scripts['typecheck:all'], 'npm run typecheck:alpha1 && npm run typecheck:rc8')
assert.equal(packageJson.scripts.build, 'npm run typecheck && tsdown')
assert.equal(packageJson.scripts['build:release'], 'npm run typecheck:all && tsdown')
assert.equal(packageJson.scripts.test, 'npm run test:public')
assert.equal(packageJson.scripts['test:full'], 'npm run test:public && node tests/session-controller-integration.mjs && node tests/integration.mjs && node tests/final-hygiene.mjs')

const readPublic = path => readFileSync(join(root, path), 'utf8')
const readme = readPublic('README.md')
const license = readPublic('LICENSE')
const security = readPublic('SECURITY.md')
const releaseNotes = readPublic('RELEASE_NOTES.md')
const cordisPatch = readPublic('cordis.patch.yml')
const hostSource = readPublic('src/index.ts')
const controllerSource = readPublic('src/browser-controller.ts')
const clientSource = readPublic('src/client/index.tsx')
const policySource = readPublic('src/policy.ts')
const protocolSource = readPublic('src/protocol.ts')
const buildConfig = readPublic('tsdown.config.ts')
const publicTypeScriptConfig = JSON.parse(readPublic('tsconfig.json'))
const alpha1TypeScriptConfig = JSON.parse(readPublic('tsconfig.alpha1.json'))
const sessionControllerIntegration = readPublic('tests/session-controller-integration.mjs')
const browserIntegration = readPublic('tests/integration.mjs')

assert.ok(readme.includes('# DSH BrowserScope')
  && readme.includes('0.11.0-alpha.1')
  && readme.includes('toolRegistrationMode: session-select')
  && readme.includes('dsh-builtin-browser')
  && readme.includes('version: 0.1.21')
  && readme.includes('Controller mode/id: dsh-browser-tools')
  && readme.includes('RPC: /browser-tools')
  && readme.includes('$DSH_HOME/browser-tools')
  && readme.includes('npm run test:full')
  && readme.includes('DSH_ALPHA1_ROOT')
  && readme.includes('DSH_BROWSER_SCOPE_CHROMIUM_ROOT'))
// 公开 TypeScript 配置必须可在净化仓库独立安装后复现；相邻 Alpha 1 源码只允许出现在维护者专用配置中。
const publicTypePaths = Object.values(publicTypeScriptConfig.compilerOptions?.paths ?? {}).flat()
const alpha1TypePaths = Object.values(alpha1TypeScriptConfig.compilerOptions?.paths ?? {}).flat()
assert.ok(publicTypePaths.length > 0 && publicTypePaths.every(path => path.startsWith('./node_modules/')))
assert.ok(alpha1TypePaths.length > 0 && alpha1TypePaths.every(path => path.startsWith('../../../deepseek-harness-alpha1/')))
assert.equal(JSON.stringify(publicTypeScriptConfig).includes('deepseek-harness-alpha1'), false)
// 完整集成必须显式注入外部根目录，不得保留维护者盘符或项目内部 .acceptance 缓存作为回退。
assert.ok(sessionControllerIntegration.includes('process.env.DSH_ALPHA1_ROOT')
  && sessionControllerIntegration.includes('const packageSourceRoot = resolve(')
  && sessionControllerIntegration.includes('process.env.DSH_BROWSER_SCOPE_PACKAGE_ROOT')
  && !/[A-Za-z]:\\deepseek-harness-alpha1/i.test(sessionControllerIntegration))
assert.ok(browserIntegration.includes('process.env.DSH_ALPHA1_ROOT')
  && browserIntegration.includes('process.env.DSH_BROWSER_SCOPE_CHROMIUM_ROOT')
  && browserIntegration.includes('const packageSourceRoot = resolve(')
  && browserIntegration.includes('process.env.DSH_BROWSER_SCOPE_PACKAGE_ROOT')
  && !/[A-Za-z]:\\deepseek-harness-alpha1/i.test(browserIntegration)
  && !browserIntegration.includes("join(root, '.acceptance'"))
assert.ok(license.startsWith('MIT License\n') && license.includes('Copyright (c) 2026 dsh-browser-scope contributors'))
assert.ok(security.includes('https://github.com/HakureiMonika/dsh-browser-scope/issues')
  && security.includes('Private Vulnerability Reporting')
  && security.includes('users.noreply.github.com'))
assert.ok(releaseNotes.includes('0.11.0-alpha.1')
  && releaseNotes.includes('Developer Preview')
  && releaseNotes.includes('releaseQualified=false'))
assert.equal(cordisPatch.startsWith('\uFEFF'), false)
const normalizedCordisPatch = cordisPatch
  .replace(/\r\n?/g, '\n')
  .trimEnd()
assert.equal(normalizedCordisPatch, '- insert:\n    - id: browser-tools\n      name: dsh-browser-scope')
assert.ok(hostSource.includes("export const name = 'dsh-browser-scope'")
  && buildConfig.includes("const PLUGIN_ID = 'dsh-browser-scope'"))
assert.ok(controllerSource.includes('DSH BrowserScope')
  && clientSource.includes("? 'DSH BrowserScope'"))
// 品牌改名不得破坏已有 Session Controller、RPC、数据目录和用户偏好协议。
assert.ok(protocolSource.includes("'other' | 'dsh-browser-tools'")
  && controllerSource.includes("id: 'dsh-browser-tools'")
  && hostSource.includes("registerLoopbackRpc(connectionCtx.connection, '/browser-tools'")
  && policySource.includes("join(dshHome, 'browser-tools')")
  && clientSource.includes("'dsh-browser-tools.live-view-mode'")
  && clientSource.includes("'dsh-browser-tools.outer-browser-ratio'"))
assert.equal(existsSync(join(root, '.runtime')), false)

const outputs = ['client.js', 'client.js.map', 'index.d.mts', 'index.mjs'].map(name => join(root, 'lib', name))
assert.equal(outputs.every(existsSync), true)
// CI 在卫生检查前明确运行构建；这里验证产物内容边界。不可变候选一致性由冻结器逐字节校验，不能依赖打包器可能保留的 mtime。
for (const path of outputs) {
  const text = readFileSync(path, 'utf8')
  assert.equal(/[A-Za-z]:\\(?:Users|deepseek-harness|DSH|Temp|Windows)\\/i.test(text), false, `${path} contains a Windows absolute path`)
  assert.equal(/(?:^|[\\/])\.(?:acceptance|runtime|dbg)(?:[\\/]|$)/im.test(text), false, `${path} contains an internal directory`)
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  checkedFiles: checked.length,
  issues: 0,
  packageName: packageJson.name,
  version: packageJson.version,
  publicReleaseMetadata: true,
  rootRuntime: false,
  buildOutputsVerified: true,
}, null, 2)}\n`)
