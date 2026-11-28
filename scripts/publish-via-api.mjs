/**
 * 用 GitHub REST API 发布仓库内容（git 传输被网络挡了时的兜底通道）。
 *
 * 走 Blobs API：每个文件先 POST 成 blob（base64 只在这里用），
 * 再用 blob sha 组 tree。Trees API 的 content 字段要原始文本，别往那儿塞 base64
 * ——那样会把文件写成一坨 base64。
 *
 * token 只在内存里从 git credential helper 拿，不落盘、不打日志。
 *
 * 跑：node scripts/publish-via-api.mjs
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const t = (spawnSync('git', ['credential', 'fill'], {
  input: 'protocol=https\nhost=github.com\n\n',
  encoding: 'utf8',
}).stdout.match(/^password=(.*)$/m) || [])[1]
if (!t) throw new Error('git credential helper 没给 token')

const OWNER = 'shuanglongdujian'
const REPO = 'dsh-doubao-signin'
const API = 'https://api.github.com'

/**
 * 调 GitHub API。
 * @param {string} method - HTTP 方法。
 * @param {string} route - 路径。
 * @param {object} [body] - JSON body。
 * @returns {Promise<{status: number, json: any}>} 状态码与解析后的 body。
 */
async function gh(method, route, body) {
  const r = await fetch(API + route, {
    method,
    headers: {
      Authorization: 'Bearer ' + t,
      'User-Agent': 'dsh-publish',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      Accept: 'application/vnd.github+json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const json = await r.json().catch(() => null)
  return { status: r.status, json }
}

/** 要发布的文件（不含 market-index.json，它单独一个提交）。 */
const PLUGIN_FILES = [
  '.gitattributes', '.gitignore', 'LICENSE', 'README.md', 'cordis.patch.yml',
  'icon.svg', 'index.js', 'package.json',
  'locale/en.json', 'locale/zh.json',
  'scripts/build-index.mjs', 'scripts/publish-via-api.mjs',
  'src/checkin.js', 'src/protocol.js', 'src/signer.js',
  'test/live-mount.mjs', 'test/protocol.test.js', 'test/registration.test.js',
]

/**
 * 把本地文件做成 blob。
 * @param {string} rel - 仓库相对路径。
 * @returns {Promise<string>} blob sha。
 */
async function putBlob(rel) {
  const content = fs.readFileSync(path.join(ROOT, rel))
  const r = await gh('POST', `/repos/${OWNER}/${REPO}/git/blobs`, {
    content: content.toString('base64'),
    encoding: 'base64',
  })
  if (r.status !== 201) throw new Error(`blob ${rel} 失败 ${r.status}: ${JSON.stringify(r.json)}`)
  return r.json.sha
}

const IDENTITY = { name: 'shuanglongdujian', email: '250778146+shuanglongdujian@users.noreply.github.com' }

/**
 * 带时间戳的作者对象。
 * @returns {object} author/committer。
 */
function person() {
  return { ...IDENTITY, date: new Date().toISOString() }
}

const MSG1 = 'feat: dsh-doubao-signin v0.1.0 — Doubao web proxy + daily check-in as a self-inserting DSH bundle'
const MSG2 = 'chore: market index pinned to plugin commit (validated with parseMarketIndex)'

/**
 * 读当前 main 的 sha。
 * @returns {Promise<string>} commit sha。
 */
async function headSha() {
  const r = await gh('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/main`)
  if (r.status !== 200) throw new Error(`读 main 失败 ${r.status}: ${JSON.stringify(r.json)}`)
  return r.json.object.sha
}

async function main() {
  const base = await headSha()
  console.log('当前 main:', base)

  // —— 1. 逐个文件建 blob ——
  /** @type {Array<object>} */
  const treeEntries = []
  for (const f of PLUGIN_FILES) {
    treeEntries.push({ path: f, mode: '100644', type: 'blob', sha: await putBlob(f) })
    process.stdout.write('.')
  }
  console.log('\nblobs 完成')

  // —— 2. 组 tree + commit ——
  const tree1 = await gh('POST', `/repos/${OWNER}/${REPO}/git/trees`, { base_tree: base, tree: treeEntries })
  if (tree1.status !== 201) throw new Error(`tree1 失败 ${tree1.status}: ${JSON.stringify(tree1.json)}`)

  const c1 = await gh('POST', `/repos/${OWNER}/${REPO}/git/commits`, {
    tree: tree1.json.sha,
    message: MSG1,
    parents: [base],
    author: person(),
    committer: person(),
  })
  if (c1.status !== 201) throw new Error(`commit1 失败 ${c1.status}: ${JSON.stringify(c1.json)}`)
  const commit1 = c1.json.sha

  const upd1 = await gh('PATCH', `/repos/${OWNER}/${REPO}/git/refs/heads/main`, { sha: commit1, force: false })
  if (upd1.status !== 200) throw new Error(`ref 前进失败 ${upd1.status}: ${JSON.stringify(upd1.json)}`)
  console.log('commit1', commit1)

  // —— 3. 用真实远端 SHA 生成索引，单独一个提交 ——
  const gen = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts', 'build-index.mjs'),
    '--commit', commit1,
    '--out', path.join(ROOT, 'market-index.json'),
  ], { cwd: ROOT, encoding: 'utf8' })
  if (gen.status !== 0) throw new Error(`build-index 失败: ${gen.stderr || gen.stdout}`)
  console.log((gen.stdout ?? '').trim())

  const idxSha = await putBlob('market-index.json')
  const tree2 = await gh('POST', `/repos/${OWNER}/${REPO}/git/trees`, {
    base_tree: commit1,
    tree: [{ path: 'market-index.json', mode: '100644', type: 'blob', sha: idxSha }],
  })
  if (tree2.status !== 201) throw new Error(`tree2 失败 ${tree2.status}: ${JSON.stringify(tree2.json)}`)

  const c2 = await gh('POST', `/repos/${OWNER}/${REPO}/git/commits`, {
    tree: tree2.json.sha,
    message: MSG2,
    parents: [commit1],
    author: person(),
    committer: person(),
  })
  if (c2.status !== 201) throw new Error(`commit2 失败 ${c2.status}: ${JSON.stringify(c2.json)}`)
  const commit2 = c2.json.sha

  const upd2 = await gh('PATCH', `/repos/${OWNER}/${REPO}/git/refs/heads/main`, { sha: commit2, force: false })
  if (upd2.status !== 200) throw new Error(`ref 更新失败 ${upd2.status}: ${JSON.stringify(upd2.json)}`)
  console.log('commit2', commit2)

  console.log('\n✅ 已发布')
  console.log('  仓库:        https://github.com/' + OWNER + '/' + REPO)
  console.log('  插件提交:    ' + commit1)
  console.log('  索引源文件:  ' + path.join(ROOT, 'market-index.json'))
  console.log('  直装命令:    pnpm add git+https://github.com/' + OWNER + '/' + REPO + '.git#' + commit1)
}

main().catch(e => { console.error('❌', e.message); process.exit(1) })
