/**
 * 豆包额度卡片 · 浏览器侧（client bundle）。
 *
 * 加载契约：宿主把本文件内容当脚本执行，它必须**自己**调用
 * `window.__ModuleLoader__.load({ id, factory })` 注册 factory（惰性 CJS）。
 *
 * settings 卡片的注册是**两段式**（参考 dsh-connect-workbuddy 实测可用的形态）：
 * 1. `ctx.slots.inject('settings.section', () => disposer)` —— 等挂载点出现；
 * 2. 回调里 `ctx.slots.register({ name:'settings.section', id, order, label, locale, inject }, 组件)`
 *    —— 注册真正渲染的卡片。只做第 1 步而不 register，宿主没有东西可渲染。
 *
 * 职责（只读）：设置页「豆包」导航项 + 额度看板。
 * 数据来自 Host 半身 loopback 路由 `/plugins/dsh-doubao-signin/quota`；
 * 豆包 cookie 永不进页面；签到走 `doubao_checkin` 工具，浏览器侧不碰。
 *
 * @module client/doubao-card.js
 */

window.__ModuleLoader__.load({
  id: 'dsh-doubao-signin',
  factory: (require) => {
    const React = require('react')

    /** Host 半身提供的额度路由。 */
    const QUOTA_PATH = '/plugins/dsh-doubao-signin/quota'

    /** 刷新间隔：额度不是高频数据，30 秒足够。 */
    const REFRESH_MS = 30_000

    /** settings.section 里的注册 id（导航项唯一键）。 */
    const SECTION_ID = 'dsh-doubao-signin'

    /** 本插件 settings 文案的 locale 命名空间。 */
    const LOCALE_NS = 'dsh-doubao-signin'

    /** 卡片在设置导航里的排序（排在官方项后面、靠近其它 connect 类插件）。 */
    const SECTION_ORDER = 40

    /** 双语文案（跟随宿主界面语言）。 */
    const LOCALES = {
      zh: { nav: '豆包', title: '豆包额度', total: (n) => `剩余额度 ${n}`, signinHint: '签到用 doubao_checkin 工具（走客户端真实 UI，这里不放按钮）', refreshHint: '自动刷新 30s', loading: '豆包额度读取中…', unreadable: '额度读不出来', unreadableHost: '豆包客户端可能没在运行（额度读的是客户端会话）。' },
      en: { nav: 'Doubao', title: 'Doubao credits', total: (n) => `Remaining ${n}`, signinHint: 'Daily check-in runs via the doubao_checkin tool (real client UI; no button here)', refreshHint: 'Auto-refresh 30s', loading: 'Reading Doubao credits…', unreadable: 'Credits unavailable', unreadableHost: 'The Doubao desktop client may not be running (credits are read from its session).' },
    }

    /**
     * 挂载入口。
     * @param {object} ctx - 客户端 cordis 上下文。
     * @returns {void}
     */
    function apply(ctx) {
      // —— 诊断探针：与 Host 半身共用 ~/.dsh/doubao-signin-debug.log ——
      // factory 执行 + apply 进入 + slots 注册，三个时间点各记一行。
      // 浏览器侧没有 fs，用 fetch 打到 Host 的 quota 路由带 X-Debug-Mark 头？不行——quota
      // 路由 GET-only 且按清单构造。改用 localStorage + console，用户可在 DevTools 里看。
      try {
        localStorage.setItem('dsh-doubao-signin-debug', JSON.stringify({
          at: new Date().toISOString(), phase: 'apply-entered',
          slotsType: typeof ctx.get?.('slots'), localeType: typeof ctx.get?.('locale'),
        }))
        console.info('[dsh-doubao-signin] apply entered; slots/locale =',
          typeof ctx.get?.('slots'), typeof ctx.get?.('locale'))
      } catch { /* 探针失败不影响功能 */ }
      try {
        // locale：注册命名空间（zh 必有；en 兜底），失败不影响卡片本体
        let t = null
        try {
          ctx.locale?.register?.(LOCALE_NS, { zh: LOCALES.zh, en: LOCALES.en })
          t = ctx.locale?.bind?.(LOCALE_NS) ?? null
        } catch { /* locale 服务缺席时走内置文案 */ }
        const text = (key, fallback) => {
          try { return t ? t(key) : (LOCALES.zh[key] ?? fallback) } catch { return LOCALES.zh[key] ?? fallback }
        }

        const registerSection = () => {
          try {
            return ctx.slots.inject('settings.section', () => {
              const disposers = []
              // 卡片组件：闭包持 fetch 状态
              const Card = () => DoubaoCard(text)
              const registered = ctx.slots.register({
                name: 'settings.section',
                id: SECTION_ID,
                order: SECTION_ORDER,
                label: () => text('nav', '豆包'),
                locale: LOCALE_NS,
                // inject 回调给宿主 slot 传渲染上下文（surface 标记，与 workbuddy 一致）
                inject: () => ({ surface: 'settings' }),
              }, Card)
              try {
                const prev = JSON.parse(localStorage.getItem('dsh-doubao-signin-debug') ?? '{}')
                localStorage.setItem('dsh-doubao-signin-debug', JSON.stringify({
                  ...prev, phase: 'slots-registered', registeredType: typeof registered,
                }))
                console.info('[dsh-doubao-signin] slots.register returned:', typeof registered)
              } catch { /* 探针失败不影响功能 */ }
              disposers.push(registered)
              return () => {
                for (const dispose of disposers) { try { dispose() } catch { /* 已卸载 */ } }
              }
            })
          } catch (error) {
            console.error('[dsh-doubao-signin] settings section failed to register (host tools unaffected):', error)
          }
        }
        const disposer = registerSection()
        if (typeof disposer === 'function') ctx.effect(() => disposer, SECTION_ID + ': quota card')
      } catch (error) {
        console.error('[dsh-doubao-signin] client card failed to load (host tools unaffected):', error)
      }
    }

    /**
     * 额度卡片（无 JSX，纯 createElement——浏览器产物必须是 CJS）。
     * @param {(key: string, fallback?: string) => string} text - 文案函数。
     * @returns {object} React 元素。
     */
    function DoubaoCard(text) {
      const { useState, useEffect } = React
      const [state, setState] = useState({ loading: true, ok: null, summary: '', total: null, windows: [] })

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
        rows.push(h('div', { key: 'loading', style: STYLE.muted }, text('loading')))
      } else if (!state.ok) {
        rows.push(h('div', { key: 'err', style: STYLE.muted },
          state.error
            ? `${text('unreadable')}：${state.error}。${text('unreadableHost')}`
            : (state.summary || text('unreadable'))))
      } else {
        rows.push(h('div', { key: 'total', style: STYLE.total }, text('total', '剩余额度')(fmt(state.total))))
        for (const [i, w] of (state.windows ?? []).entries()) {
          rows.push(h('div', { key: `w${i}`, style: STYLE.row }, renderWindow(h, w)))
        }
        rows.push(h('div', { key: 'hint', style: STYLE.muted },
          `${text('refreshHint')} · ${text('signinHint')}`))
      }
      return h('div', { style: STYLE.card, 'data-plugin': 'dsh-doubao-signin' },
        h('div', { style: STYLE.title }, text('title')),
        ...rows)
    }

    /**
     * 渲染单个额度窗口行。
     * @param {Function} h - createElement。
     * @param {object} w - { name, remaining, total, usedPercent, resetsAt }。
     * @returns {object} 行内容。
     */
    function renderWindow(h, w) {
      const parts = [`${w.name}: ${fmt(w.remaining)} / ${fmt(w.total)}（已用 ${w.usedPercent}%）`]
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
    exports.inject = ['slots', 'locale']
    exports.name = 'dsh-doubao-signin'
  },
})
