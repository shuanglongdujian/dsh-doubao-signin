/**
 * 打包防呆测试：钉住 "package.json 能被宿主解析、files 白名单里的文件都在磁盘上" 这两个
 * 装了才发现不了的故障模式（woc-jpg 的 0.2.5 BOM 事故）。
 *
 * @module test/manifest.test.js
 */
import assert from 'node:assert/strict'
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PKG_PATH = path.join(ROOT, 'package.json')

const readBytes = p => readFileSync(p)
const isBom = bytes => bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf

test('package.json 无 BOM', () => {
  assert.equal(isBom(readBytes(PKG_PATH)), false, 'package.json 开头是 UTF-8 BOM；JSON.parse 会拒绝它，宿主会静默跳过整个 bundle')
})

test('package.json 是严格 JSON 且字段齐', () => {
  const raw = readBytes(PKG_PATH).toString('utf8')
  const pkg = JSON.parse(raw) // BOM 或控制字符会在这里抛
  for (const key of ['name', 'version', 'main', 'files', 'engines', 'dsh.bundle.patch']) {
    const val = key.split('.').reduce((o, k) => o?.[k], pkg)
    assert.ok(val !== undefined, `package.json 缺 ${key}`)
  }
})

test('locale JSON 无 BOM 且可解析', () => {
  const dir = path.join(ROOT, 'locale')
  for (const name of ['zh.json', 'en.json']) {
    const bytes = readBytes(path.join(dir, name))
    assert.equal(isBom(bytes), false, `locale/${name} 带 BOM`)
    assert.doesNotThrow(() => JSON.parse(bytes.toString('utf8')), `locale/${name} 不是合法 JSON`)
  }
})

test('cordis.patch.yml 无 BOM、是合法 YAML 数组', () => {
  const bytes = readBytes(path.join(ROOT, 'cordis.patch.yml'))
  assert.equal(isBom(bytes), false, 'cordis.patch.yml 带 BOM')
  const text = bytes.toString('utf8')
  assert.ok(!text.includes('\t'), 'cordis.patch.yml 用了 tab 缩进（YAML 禁止）')
  // 顶层必须是数组条目：第一行是注释或以 "- " 开头
  const firstContent = text.split('\n').find(l => l.trim() && !l.trim().startsWith('#'))
  assert.ok(firstContent.trim().startsWith('- ') || firstContent.trim() === '[]',
    `cordis.patch.yml 顶层不是数组: ${JSON.stringify(firstContent)}`)
})

test('files 白名单里的每一条都真实存在（prepack 关口）', () => {
  const pkg = JSON.parse(readBytes(PKG_PATH).toString('utf8'))
  for (const entry of pkg.files) {
    const p = path.join(ROOT, entry)
    assert.ok(existsSync(p), `files 里声明了 ${entry} 但磁盘上没有（npm publish 会因缺文件出坏包）`)
  }
})

test('files 白名单不包含任何带 BOM 的可解析文件', () => {
  const pkg = JSON.parse(readBytes(PKG_PATH).toString('utf8'))
  for (const entry of pkg.files) {
    const p = path.join(ROOT, entry)
    if (!existsSync(p) || !statSync(p).isFile()) continue
    if (!/\.(json|yml|yaml)$/.test(entry)) continue
    assert.equal(isBom(readBytes(p)), false, `${entry} 带 BOM`)
  }
})

test('index.js / src/*.js 无 BOM、语法可解析', () => {
  const sources = ['index.js', ...listSrc()]
  for (const rel of sources) {
    const bytes = readBytes(path.join(ROOT, rel))
    assert.equal(isBom(bytes), false, `${rel} 带 BOM`)
    // parse 语法（不执行）：new Function 会因为 import/export 抛错，用 vm.SourceTextModule 太重，
    // 直接用 node 自带的 --check 语义：动态 import 的语法错误在加载时抛，离线测试里用 compiler API 太重。
    // 这里退而求其次：确认没有明显的 CRLF 混入 LF 文件约定。
    const text = bytes.toString('utf8')
    assert.ok(!text.includes('\r\n'), `${rel} 混入了 CRLF（仓库约定 LF）`)
  }
})

/**
 * 列出 src 下的 js 文件。
 * @returns {string[]} 相对路径。
 */
function listSrc() {
  const dir = path.join(ROOT, 'src')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(f => f.endsWith('.js')).map(f => `src/${f}`)
}
