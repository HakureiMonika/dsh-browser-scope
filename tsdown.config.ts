import { readFile } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { UserConfig } from 'tsdown'
import { transform } from 'lightningcss'

const PROJECT_ROOT =
  dirname(fileURLToPath(import.meta.url))
const PLUGIN_ID = 'dsh-browser-scope'
const CSS_VIRTUAL_PREFIX = '\0dsh-browser-scope-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'
const productionDependencies = new Set([
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-attachment',
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-layout',
  '@deepseek-ai/dsh-client-ui-renderer',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/schemastery',
  'playwright-core',
  'react',
  'yauzl-promise',
])
const clientExternals = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
])

function packageMatches(specifier: string, name: string): boolean {
  return specifier === name || specifier.startsWith(`${name}/`)
}

function isProductionDependency(specifier: string): boolean {
  return [...productionDependencies].some(name => packageMatches(specifier, name))
}

const host: UserConfig = {
  name: PLUGIN_ID,
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: true,
  fixedExtension: true,
  clean: true,
  deps: {
    // Host 必须复用 DSH 安装提供的 Cordis、Agent 和 Tool 单例，不能把这些运行时身份打进插件包。
    neverBundle: isProductionDependency,
    alwaysBundle: specifier => !isBuiltin(specifier) && !isProductionDependency(specifier),
  },
}

const client: UserConfig = {
  name: `${PLUGIN_ID}/client`,
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'node22.19.0',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    // 各目标DSH代际的动态Client Bundle都只共享冻结模块表中的基础模块，其余实现全部内联到插件自己的工厂函数。
    neverBundle: specifier => clientExternals.has(specifier),
    alwaysBundle: specifier => !clientExternals.has(specifier),
  },
  inputOptions: {
    resolve: {
      conditionNames: ['production', 'browser', 'import', 'module', 'default'],
    },
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    'import.meta.env.MODE': JSON.stringify('production'),
    'import.meta.env': JSON.stringify({ MODE: 'production' }),
  },
  plugins: [{
    name: 'dsh-browser-tools-client-purity',
    resolveId(source: string) {
      if (!source.startsWith('@deepseek-ai/')) return null
      if (clientExternals.has(source)) return null
      throw new Error(`client bundle purity: ${source} is not available from the supported DSH client module tables`)
    },
  }, {
    name: 'dsh-browser-tools-css-modules',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.module.css') || importer === undefined) return null
      const file =
        resolve(importer, '..', source)
      // 虚拟模块 ID 会进入生成代码的区域标记和 Source Map；必须使用稳定仓库相对路径，禁止泄露维护者绝对目录。
      const stablePath =
        relative(PROJECT_ROOT, file)
          .replaceAll('\\', '/')
      return `${CSS_VIRTUAL_PREFIX}${stablePath}${CSS_VIRTUAL_SUFFIX}`
    },
    async load(virtualId: string) {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const stablePath =
        virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      const file =
        resolve(PROJECT_ROOT, stablePath)
      this.addWatchFile(file)
      const result = transform({
        filename: file,
        code: await readFile(file),
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      const classMap = Object.fromEntries(
        Object.entries(result.exports ?? {})
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([local, value]) => [local, value.name]),
      )
      const css = result.code.toString()
      const tagId = `${PLUGIN_ID}/panel.module.css`
      return [
        `const css = ${JSON.stringify(css)};`,
        `const tagId = ${JSON.stringify(tagId)};`,
        'if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {',
        '  const tag = document.createElement("style");',
        `  tag.dataset.plugin = ${JSON.stringify(PLUGIN_ID)};`,
        '  tag.dataset.pluginCss = tagId;',
        '  tag.textContent = css;',
        '  document.head.appendChild(tag);',
        '}',
        `export default ${JSON.stringify(classMap)};`,
      ].join('\n')
    },
  }],
  outputOptions: {
    entryFileNames: 'client.js',
    sourcemapExcludeSources: false,
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default [host, client]
