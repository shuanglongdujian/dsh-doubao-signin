#!/usr/bin/env node
/**
 * 生成并校验 DSH 插件市场索引（format 1）。
 *
 * 用法：
 *   node scripts/build-index.mjs --commit <40位SHA> [--out market-index.json] [--timestamp <unix秒>]
 *
 * 输出的 commit 应指向一个已推送到 GitHub 的真实提交；索引自身的提交不会改变它，
 * 所以「先 commit 拿 SHA → 生成索引 → 再 commit 索引」的顺序是对的。
 *
 * 校验直接用 DSH 安装目录里的 parseMarketIndex，保证「本地过 = 客户端市场也过」。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** DSH 安装目录：按本机实际情况调整；找不到会明确报错。 */
function findDshModules() {
  const candidates = [
    process.env.DSH_MODULES,
    'D:\\AI工具\\deepseek harness\\harness\\resources\\app\\dsh\\node_modules',
  ].filter(Boolean)
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, '@deepseek-ai', 'dsh-plugin-market-index'))) return c
  }
  throw new Error('找不到 DSH 安装目录的 node_modules，请设置环境变量 DSH_MODULES 指向它')
}

const argv = process.argv.slice(2)
/**
 * 取命令行参数值。
 * @param {string} name - 参数名（不带 --）。
 * @returns {string | undefined} 值。
 */
function arg(name) {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}

const commit = arg('commit')
if (!commit || !/^[0-9a-f]{40}$/.test(commit)) {
  console.error('必须给 --commit <40位小写hex SHA>（先 git commit，再拿 SHA 来生成索引）')
  process.exit(2)
}
const out = arg('out') ?? path.join(root, 'market-index.json')
const timestamp = Number(arg('timestamp') ?? Math.floor(Date.now() / 1000))

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

/**
 * 读 locale/*.json 拼 LocalizedText；en 是必填 fallback。
 * @param {string} field - meta 里的字段名。
 * @returns {string | object} 文本。
 */
function localized(field) {
  /** @type {Record<string, string>} */
  const map = {}
  for (const f of fs.readdirSync(path.join(root, 'locale'))) {
    if (!f.endsWith('.json')) continue
    const lang = path.basename(f, '.json').toLowerCase()
    const meta = JSON.parse(fs.readFileSync(path.join(root, 'locale', f), 'utf8')).meta
    if (meta?.[field]) map[lang] = meta[field]
  }
  if (!map.en) {
    // 没有英文 fallback 时拿包 description 顶，schema 会拒空 en
    map.en = pkg.description
  }
  return Object.keys(map).length === 1 && map.en ? map.en : map
}

const iconPath = path.join(root, 'icon.svg')
const iconBytes = fs.readFileSync(iconPath)
if (iconBytes.length > 32 * 1024) {
  console.error(`icon.svg ${iconBytes.length}B 超过 32KiB 内联上限，改用外链 URL`)
  process.exit(2)
}
const icon = `data:image/svg+xml;base64,${iconBytes.toString('base64')}`

const repoUrl = (pkg.repository?.url ?? '').replace(/^git\+/, '')
if (!/^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(repoUrl)) {
  console.error(`repository.url 不合法或还带着占位符: ${pkg.repository?.url}`)
  process.exit(2)
}

const index = {
  format: 1,
  title: { en: 'shuanglongdujian / dsh 插件', 'zh': 'shuanglongdujian 的 dsh 插件' },
  description: {
    en: 'Community plugins for DeepSeek Harness, installed from GitHub.',
    'zh': 'DeepSeek Harness 社区插件，从 GitHub 直接安装。',
  },
  metadata: {
    categories: {
      'model-proxy': { title: { en: 'Model proxy', 'zh': '模型反代' } },
    },
    labels: {
      'needs-doubao-client': { title: { en: 'Requires the Doubao desktop client', 'zh': '需要豆包桌面客户端' } },
    },
    sortKeys: {},
  },
  plugins: [
    {
      name: pkg.name,
      title: localized('title'),
      description: localized('description'),
      icon,
      author: pkg.author ?? 'shuanglongdujian',
      homepage: pkg.homepage,
      repository: { url: repoUrl },
      metadata: {
        category: 'model-proxy',
        keywords: pkg.keywords ?? [],
        labels: ['needs-doubao-client'],
        sortKeys: {},
      },
      versions: [
        {
          version: pkg.version,
          publishTimestamp: timestamp,
          source: {
            type: 'git',
            url: repoUrl,
            commit,
          },
          engines: {
            dsh: pkg.engines?.dsh ?? '*',
          },
        },
      ],
    },
  ],
}

fs.writeFileSync(out, JSON.stringify(index, null, 2) + '\n')
console.log(`已生成 ${out}`)

// —— 用真校验器过一遍 ——
const modules = findDshModules()
const libUrl = pathToFileURL(
  path.join(modules, '@deepseek-ai', 'dsh-plugin-market-index', 'lib', 'index.js'),
).href
const { parseMarketIndex, marketInstallTarget, MarketIndexError } = await import(libUrl)

const fakeIndexUrl = 'https://raw.githubusercontent.com/shuanglongdujian/dsh-doubao-signin/main/market-index.json'
try {
  const parsed = parseMarketIndex(JSON.parse(fs.readFileSync(out, 'utf8')), fakeIndexUrl)
  const plugin = parsed.plugins[0]
  const target = marketInstallTarget(plugin.name, plugin.versions[0])
  console.log(`✅ parseMarketIndex 通过：${parsed.plugins.length} 个插件，${plugin.name}@${plugin.versions[0].version}`)
  console.log(`   安装命令形状: pnpm add ${target.spec}`)
} catch (error) {
  if (error instanceof MarketIndexError) {
    console.error('❌ 索引未通过官方校验：')
    for (const d of error.diagnostics ?? [error.message]) console.error('  -', typeof d === 'string' ? d : JSON.stringify(d))
  } else {
    console.error('❌ 校验异常：', error)
  }
  process.exit(1)
}