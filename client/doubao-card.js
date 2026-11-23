/**
 * 豆包额度卡片 · 浏览器侧（client bundle）。
 *
 * 加载契约：宿主把本文件内容当脚本执行，它必须**自己**调用
 * `window.__ModuleLoader__.load({ id, factory })` 注册 factory（惰性 CJS：
 * 执行只注册，materialize 发生在首次 require 时）。
 *
 * factory(require) 约定：
 * - `require('react')` / `require('react/jsx-runtime')` 由宿主 baseline externals 提供；
 * - apply(ctx) 收到的 ctx 带 `slots` / `locale`（按 package.json `dsh.client.inject` 等待）。
 *
 * 职责（只读）：
 * - 设置页豆包卡片下渲染额度看板：剩余合计 / 套餐积分 / 活动赠送额度（签到领的那份），带重置倒计时；
 * - 数据来自 Host 半身 loopback 路由 `/plugins/dsh-doubao-signin/quota`；
 * - **豆包 cookie 永不进页面**——卡片只跟本机 Host 说话；
 * - 签到走 `doubao_checkin` 工具（客户端真实 UI 发出），浏览器侧不碰。
 *
 * @module client/doubao-card.js
 */

window.__ModuleLoader__.load({
  id: 'dsh-doubao-signin',
  factory: (require) => {
    const React = require('react')

    /** Host 半身提供的额度路由（同源 fetch，Host 头就是监听器自己）。 */
    const QUOTA_PATH = '/plugins/dsh-doubao-signin/quota'

    /** 刷新间隔：额度不是高频数据，30 秒足够。 */
    const REFRESH_MS = 30_000

    /** 卡片在宿主 slot 里的插件标识。 */
    const PLUGIN_ID = 'dsh-doubao-signin'

    /**
     * 挂载入口。宿主在 inject 的服务就绪后调用。
     * @param {object} ctx - 客户端 cordis 上下文。
     * @returns {void}
     */
    function apply(ctx) {
      try {
        const slots = ctx.get?.('slots') ?? ctx.slots
        if (!slots || typeof slots.inject !== 'function') return
        ctx.effect(() => slots.inject('settings.section', () => DoubaoCard()), PLUGIN_ID + ': quota card')
      } catch (error) {
        console.error('[dsh-doubao-signin] client card failed to load (host tools unaffected):', error)
      }
    }

    /**
     * 额度卡片（无 JSX，纯 createElement——浏览器产物必须是 CJS，无编译步骤）。
     * @returns {object} React 元素。
     */
    function DoubaoCard() {
      const { useState, useEffect } = React
      const [state, setState] = useState({ loading: true, ok: null, summary: '', total: null, windows: [], error: '' })

      useEffect(() => {
        let alive = true
        const load = async () => {
          try {
            const res = await fetch(QUOTA_PATH, { headers: { accept: 'application/json' }, credentials: 'same-origin' })
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
            ? `额度读不出来：${state.error}。豆包客户端可能没在运行（额度读的是客户端会话）。`
            : (state.summary || '额度读不出来（Host 没返回原因）。')))
      } else {
        rows.push(h('div', { key: 'total', style: STYLE.total },
          `剩余额度 ${fmt(state.total)}`))
        for (const [i, w] of (state.windows ?? []).entries()) {
          rows.push(h('div', { key: `w${i}`, style: STYLE.row }, renderWindow(h, w)))
        }
        rows.push(h('div', { key: 'hint', style: STYLE.muted },
          '自动刷新 30s · 签到用 doubao_checkin 工具（走客户端真实 UI，这里不放按钮）'))
      }

      return h('div', { style: STYLE.card, 'data-plugin': PLUGIN_ID },
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
        parts.push(mins >= 1440 ? `重置 ${Math.round(mins / 1440)} 天后`
          : mins >= 60 ? `重置 ${Math.round(mins / 60)} 小时后`
          : `重置 ${mins} 分钟后`)
      }
      return h('span', null, parts.join(' · '))
    }

    /**
     * 数字格式化（千分位；读不出显示 —，不显示 0）。
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

    exports.apply = apply
    exports.inject = ['slots']
    exports.name = PLUGIN_ID
  },
})
