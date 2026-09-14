import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageName = 'dsh-browser-scope'
const expectedVersion = '1.0.0-rc2'
const expectedFiles = [
  'LICENSE',
  'README.en.md',
  'README.md',
  'SECURITY.en.md',
  'SECURITY.md',
  'TECHNICAL.en.md',
  'TECHNICAL.md',
  'VALIDATION.en.md',
  'VALIDATION.md',
  'assets/browser-scope-debugger.png',
  'assets/browser-scope-diagnose-1.png',
  'assets/browser-scope-diagnose-2.png',
  'assets/browser-scope-hero.png',
  'assets/browser-scope-network.png',
  'assets/browser-scope-performance.png',
  'assets/browser-scope-session-controller-1.png',
  'assets/browser-scope-session-controller-2.png',
  'assets/browser-scope-session-controller-3.png',
  'assets/browser-scope-split-view.png',
  'cordis.patch.yml',
  'lib/client.js',
  'lib/client.js.map',
  'lib/index.d.mts',
  'lib/index.mjs',
  'package.json',
].sort()

function fail(message) {
  throw new Error(message)
}

function resolveNpmCommand() {
  // 优先复用 npm 的 JavaScript 入口；直接使用 Node 启动检查器时，
  // Windows 必须通过 shell 执行 npm.cmd，Linux/macOS 则使用 PATH 中的 npm。
  const npmCli = [
    process.env.npm_execpath,
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(value => typeof value === 'string' && value !== '')
    .find(existsSync)

  return npmCli === undefined
    ? {
        command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
        prefix: [],
        shell: process.platform === 'win32',
      }
    : {
        command: process.execPath,
        prefix: [npmCli],
        shell: false,
      }
}

function runPack(args) {
  const npm = resolveNpmCommand()
  const result = spawnSync(npm.command, [...npm.prefix, 'pack', '--ignore-scripts', ...args, '--json'], {
    cwd: projectRoot,
    env: process.env,
    encoding: 'utf8',
    windowsHide: true,
    shell: npm.shell,
  })
  if (result.error !== undefined || result.status !== 0) {
    fail(`npm pack failed\nspawnError=${result.error?.message ?? 'none'}\nstdout=${result.stdout ?? ''}\nstderr=${result.stderr ?? ''}`)
  }
  const parsed = JSON.parse(result.stdout)
  return Array.isArray(parsed) ? parsed[0] : parsed
}

function assertMetadata(metadata, stage) {
  const files = metadata.files.map(entry => entry.path).sort()
  if (JSON.stringify(files) !== JSON.stringify(expectedFiles)) {
    fail(`${stage} contains unexpected files: ${JSON.stringify(files)}`)
  }
  if (metadata.name !== packageName || metadata.version !== expectedVersion) {
    fail(`${stage} has unexpected identity: ${metadata.name}@${metadata.version}`)
  }
  return files
}

function readTarFiles(tarballBytes) {
  // 直接解析 npm 生成的 gzip tar，避免把 dry-run 清单误当成真实归档字节。
  const tar = gunzipSync(tarballBytes)
  const files = new Map()
  let offset = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '')
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '')
    const path = prefix === '' ? name : `${prefix}/${name}`
    const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/s, '').trim()
    const size = sizeText === '' ? 0 : Number.parseInt(sizeText, 8)
    if (!Number.isSafeInteger(size) || size < 0) fail(`invalid tar entry size: ${path}`)
    const contentStart = offset + 512
    const contentEnd = contentStart + size
    if (contentEnd > tar.length) fail(`truncated tar entry: ${path}`)
    const type = header[156]
    if (type === 0 || type === 48) files.set(path, tar.subarray(contentStart, contentEnd))
    offset = contentStart + Math.ceil(size / 512) * 512
  }
  return files
}

const preview = runPack(['--dry-run'])
const previewFiles = assertMetadata(preview, 'npm pack preview')
const temporaryRoot = mkdtempSync(join(tmpdir(), 'dsh-browser-scope-pack-'))

try {
  const packed = runPack(['--pack-destination', temporaryRoot])
  assertMetadata(packed, 'npm tarball metadata')
  const tarballPath = join(temporaryRoot, basename(packed.filename))
  const tarballBytes = readFileSync(tarballPath)
  const tarFiles = readTarFiles(tarballBytes)
  const actualFiles = [...tarFiles.keys()]
    .filter(name => name.startsWith('package/'))
    .map(name => name.slice('package/'.length))
    .sort()
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    fail(`actual npm tarball contains unexpected files: ${JSON.stringify(actualFiles)}`)
  }

  for (const name of expectedFiles) {
    const packedBytes = tarFiles.get(`package/${name}`)
    if (packedBytes === undefined || packedBytes.length === 0) fail(`actual npm tarball file is missing or empty: ${name}`)
    const worktreeBytes = readFileSync(join(projectRoot, ...name.split('/')))
    if (!packedBytes.equals(worktreeBytes)) fail(`actual npm tarball differs from worktree: ${name}`)
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    package: packed.name,
    version: packed.version,
    previewEntryCount: previewFiles.length,
    actualEntryCount: actualFiles.length,
    tarballBytes: tarballBytes.length,
    worktreeBytesMatched: true,
  }, null, 2)}\n`)
} finally {
  // 临时 tarball 只用于发布前门禁，不得残留或被误当成正式候选。
  rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
}
