/**
 * 豆包额度卡片 · 浏览器侧（client bundle）。
 *
 * 构建形态：一个 CJS 文件，被 DSH 的 client module loader 以
 * `window.__ModuleLoader__.load({ id, factory })` 形式加载（参考
 * dsh-connect-workbuddy 的 lib/client.js）。
 *
 * 职责：
 * - 在 设置 → 插件页 的豆包卡片下渲染一块**只读额度看板**：
 *   剩余合计 / 套餐积分 / 活动赠送额度（签到领的那份），各带重置倒计时；
 * - 数据来自 Host 半身的 loopback 路由 `/plugins/dsh-plugin-doubao/quota`
 *   （同源 fetch，cookie 不进页面——豆包凭据只活在 Host 进程里）；
 * - 只读。卡片不做任何写操作，不注入签到按钮（签到走 `doubao_checkin`
 *   工具，签名必须由客户端自己算，浏览器侧不碰）。
 *
 * Host 侧配套：见 index.js 的 `registerQuotaRoute`（本文件顶部同名常量）。
 *
 * @module client/doubao-card.js
 */

/* global React */

/** Host 半身提供的额度路由（同源、loopback-only、no-store）。 */
const QUOTA_PATH = '/plugins/dsh-plugin-doubao/quota'

/** 刷新间隔：额度不是高频数据，30 秒足够。 */
const REFRESH_MS = 30_000

/**
 * 挂载入口。宿主以 `inject` 声明的服务就绪后调用。
 * @param {object} ctx - 客户端 cordis 上下文（slots/locale 等）。
 * @returns {void}
 */
function apply(ctx) {
  try {
    const React = ctx.require ? ctx.require('react') : React
    const slots = ctx.get('slots')
    if (!slots || typeof slots.inject !== 'function') return
    ctx.effect(() => slots.inject('settings.section', () => DoubaoCard(React)), 'plugin-doubao: quota card')
  } catch (error) {
    console.error('[dsh-plugin-doubao] client card failed to load (host tools unaffected):', error)
  }
}

/**
 * 额度卡片组件（无 JSX，纯 createElement——CJS 里没有编译步骤）。
 * @param {object} React - React 命名空间。
 * @returns {object} React 元素。
 */
function DoubaoCard(React) {
  const { useState, useEffect } = React
  const [state, setState] = useState({ loading: true, ok: null, summary: '', total: null, windows: [], error: '' })

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const res = await fetch(QUOTA_PATH, { headers: { accept: 'application/json' } })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        if (alive) setState({ loading: false, ...data })
      } catch (error) {
        if (alive) setState({ loading: false, ok: false, summary: '', total: null, windows: [], error: String(error.message ?? error) })
      }
    }
    load()
    const timer = setInterval(load, REFRESH_MS)
    return () => { alive = false; clearInterval(timer) }
  }, [])

  const h = React.createElement
  const rows = []

  if (state.loading) {
    rows.push(h('div', { key: 'loading', style: STYLE.muted }, '豆包额度读取中…'))
  } else if (!state.ok) {
    rows.push(h('div', { key: 'err', style: STYLE.muted },
      state.error
        ? `额度读不出来：${state.error}。Host 侧的豆包客户端可能没在运行。`
        : (state.summary || '额度读不出来（Host 没返回原因）。')))
  } else {
    rows.push(h('div', { key: 'total', style: STYLE.total },
      `剩余额度 ${fmt(state.total)}`))
    for (const [i, w] of (state.windows ?? []).entries()) {
      rows.push(h('div', { key: `w${i}`, style: STYLE.row }, renderWindow(h, w)))
    }
    rows.push(h('div', { key: 'hint', style: STYLE.muted }, '自动刷新 30s · 签到用 doubao_checkin 工具（走客户端真实 UI）'))
  }

  return h('div', { style: STYLE.card, 'data-plugin': 'dsh-plugin-doubao' },
    h('div', { style: STYLE.title }, '豆包额度'),
    ...rows)
}

/**
 * 渲染单个额度窗口行。
 * @param {Function} h - createElement。
 * @param {object} w - { name, remaining, total, usedPercent, resetsAt }。
 * @returns {object} 行内容。
 */
function renderWindow(h, w) {
  const parts = [`${w.name}: 剩 ${fmt(w.remaining)} / ${fmt(w.total)}（已用 ${w.usedPercent}%）`]
  if (w.resetsAt && w.resetsAt > Date.now()) {
    const mins = Math.round((w.resetsAt - Date.now()) / 60000)
    parts.push(mins >= 1440 ? `重置 ${Math.round(mins / 1440)} 天后` : mins >= 60 ? `重置 ${Math.round(mins / 60)} 小时后` : `重置 ${mins} 分钟后`)
  }
  return h('span', null, parts.join(' · '))
}

/**
 * 数字格式化（千分位）。
 * @param {number|null} v - 值。
 * @returns {string} 显示文本。
 */
function fmt(v) {
  return typeof v === 'number' ? v.toLocaleString('zh-CN') : '—'
}

/** 内联样式：不依赖宿主主题 token，浅色深色都不脏。 */
const STYLE = {
  card: {
    margin: '8px 0', padding: '10px 12px', borderRadius: 8,
    border: '1px solid rgba(127,127,127,.28)', background: 'rgba(127,127,127,.06)',
    fontFamily: 'inherit', fontSize: 13, lineHeight: '20px',
  },
  title: { fontWeight: 600, marginBottom: 6 },
  total: { fontWeight: 600, marginBottom: 4 },
  row: { opacity: 0.9 },
  muted: { opacity: 0.65, fontSize: 12 },
}

/** 客户端插件行的服务声明（宿主按此等待就绪）。 */
const inject = ['slots']

exports.apply = apply
exports.inject = inject
exports.name = 'plugin-doubao'
