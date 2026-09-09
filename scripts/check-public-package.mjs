import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const expectedFiles = [
  'LICENSE',
  'README.md',
  'cordis.patch.yml',
  'lib/client.js',
  'lib/client.js.map',
  'lib/index.d.mts',
  'lib/index.mjs',
  'package.json',
].sort()

// 优先复用 npm 提供的 CLI 入口；直接通过 Node 启动脚本时，则回退到系统 PATH 中的 npm。
// Windows 的 npm 是 .cmd 包装器，必须经 shell 启动；Linux/macOS 可直接执行 npm。
const npmCli = [
  process.env.npm_execpath,
  join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
].filter(value => typeof value === 'string' && value !== '')
  .find(existsSync)
const packArgs = [
  'pack',
  '--ignore-scripts',
  '--dry-run',
  '--json',
]
const npmCommand = npmCli === undefined
  ? process.platform === 'win32'
    ? 'npm.cmd'
    : 'npm'
  : process.execPath
const npmArgs = npmCli === undefined
  ? packArgs
  : [npmCli, ...packArgs]
const preview = spawnSync(npmCommand, npmArgs, {
  cwd: projectRoot,
  env: process.env,
  encoding: 'utf8',
  windowsHide: true,
  shell: npmCli === undefined && process.platform === 'win32',
})
if (preview.error !== undefined || preview.status !== 0) {
  throw new Error(`npm pack preview failed\nspawnError=${preview.error?.message ?? 'none'}\nstdout=${preview.stdout ?? ''}\nstderr=${preview.stderr ?? ''}`)
}
const parsed = JSON.parse(preview.stdout)
const metadata = Array.isArray(parsed) ? parsed[0] : parsed
const files = metadata.files
  .map(entry => entry.path)
  .sort()
if (JSON.stringify(files) !== JSON.stringify(expectedFiles)) {
  throw new Error(`unexpected npm package files: ${JSON.stringify(files)}`)
}
if (metadata.name !== 'dsh-browser-scope' || metadata.version !== '0.11.0-alpha.1') {
  throw new Error(`unexpected npm package identity: ${metadata.name}@${metadata.version}`)
}
process.stdout.write(`${JSON.stringify({
  ok: true,
  package: metadata.name,
  version: metadata.version,
  entryCount: files.length,
}, null, 2)}\n`)
