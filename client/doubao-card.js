/**
 * 豆包额度卡片 · 浏览器侧（client bundle）。
 *
 * 形态必须与能正常显示的同类插件一致（dsh-our-free-model / dsh-connect-workbuddy）：
 *   1. 文件是**浏览器 classic script**（不是 ESM）——里面不能出现 import/export 顶层语法；
 *   2. 自己调 `window.__ModuleLoader__.load({ id, factory })` 注册 factory；
 *   3. factory 内部**自建 module/exports**，因为浏览器脚本作用域里没有 CJS 的 `exports`
 *      （直接写 `exports.apply = ...` 会抛 ReferenceError，materialize 失败，
 *        宿主只会报一行 "1 entry did not activate"）；
 *   4. factory 末尾 `return module.exports`；
 *   5. 组件签名是 `props => h(...)`——宿主要把 slot 的 props 传进来。
 *
 * settings 卡片注册：两段式
 *   `ctx.slots.inject('settings.section', () => ctx.slots.register({...}, 组件))`
 *   inject 等挂载点出现；register 注册真正被渲染的组件。
 *
 * 职责（只读）：设置页「豆包」导航项 + 额度看板。
 * 数据来自 Host 半身的 loopback 路由 `/plugins/dsh-doubao-signin/quota`；
 * 豆包 cookie 永不进页面；签到走 `doubao_chat` 之外的 `doubao_checkin` 工具，浏览器侧不碰。
 *
 * @module client/doubao-card.js
 */

window.__ModuleLoader__.load({
  id: 'dsh-doubao-signin',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, useState, useEffect } = React

    /** Host 半身提供的额度路由。 */
    const QUOTA_PATH = '/plugins/dsh-doubao-signin/quota'

    /** 刷新间隔：额度不是高频数据，30 秒足够。 */
    const REFRESH_MS = 30_000

    /** settings.section 里的注册 id（导航项唯一键）。 */
    const SECTION_ID = 'dsh-doubao-signin'

    /** 本插件 settings 文案的 locale 命名空间。 */
    const NS = 'dsh-doubao-signin'

    /** 卡片在设置导航里的排序。 */
    const SECTION_ORDER = 40

    /** 双语文案（跟随宿主界面语言）。 */
    const DICT = {
      zh: {
        nav: '豆包',
        title: '豆包额度',
        total: '剩余额度 {n}',
        signinHint: '签到用 doubao_checkin 工具（走客户端真实 UI，这里不放按钮）',
        refreshHint: '自动刷新 30s',
        loading: '豆包额度读取中…',
        unreadable: '额度读不出来',
        unreadableHost: '豆包客户端可能没在运行（额度读的是客户端会话）。',
        loggedOut: '尚未登录。用 doubao_login 扫码登录一次即可。',
      },
      en: {
        nav: 'Doubao',
        title: 'Doubao credits',
        total: 'Remaining {n}',
        signinHint: 'Daily check-in runs via the doubao_checkin tool (real client UI; no button here)',
        refreshHint: 'Auto-refresh 30s',
        loading: 'Reading Doubao credits…',
        unreadable: 'Credits unavailable',
        unreadableHost: 'The Doubao desktop client may not be running (credits are read from its session).',
        loggedOut: 'Not signed in yet. Run doubao_login once to scan the QR code.',
      },
    }

    /**
     * 卡片组件。
     * @param {object} props - 宿主 slot 传入的 props。
     * @returns {object} React 元素。
     */
    function SettingsPage(props) {
      const [state, setState] = useState({ loading: true, ok: null, summary: '', total: null, windows: [], error: '' })

      useEffect(() => {
        let alive = true
        const load = async () => {
          try {
            const res = await fetch(QUOTA_PATH, { headers: { accept: 'application/json' }, credentials: 'same-origin' })
            if (!res.ok) throw new Error('HTTP ' + res.status)
            const data = await res.json()
            if (alive) setState(Object.assign({ loading: false }, data))
          } catch (error) {
            if (alive) setState({ loading: false, ok: false, summary: '', total: null, windows: [], error: String(error && error.message ? error.message : error) })
          }
        }
        load()
        const timer = setInterval(load, REFRESH_MS)
        return () => { alive = false; clearInterval(timer) }
      }, [])

      const t = key => {
        // 宿主 locale 已绑定时优先用它；否则用内置中文
        try {
          const bound = props && props.t
          if (typeof bound === 'function') {
            const v = bound(key)
            if (typeof v === 'string' && v) return v
          }
        } catch { /* 用内置文案 */ }
        return DICT.zh[key] ?? key
      }

      const rows = []
      if (state.loading) {
        rows.push(h('div', { key: 'loading', style: STYLE.muted }, t('loading')))
      } else if (!state.ok) {
        rows.push(h('div', { key: 'err', style: STYLE.muted },
          state.error
            ? t('unreadable') + '：' + state.error + '。' + t('unreadableHost')
            : (state.summary || t('loggedOut'))))
      } else {
        rows.push(h('div', { key: 'total', style: STYLE.total }, t('total').replace('{n}', fmt(state.total))))
        const windows = state.windows || []
        for (let i = 0; i < windows.length; i++) {
          rows.push(h('div', { key: 'w' + i, style: STYLE.row }, renderWindow(h, windows[i])))
        }
        rows.push(h('div', { key: 'hint', style: STYLE.muted }, t('refreshHint') + ' · ' + t('signinHint')))
      }

      return h('div', { style: STYLE.card, 'data-plugin': 'dsh-doubao-signin' },
        h('div', { style: STYLE.title }, t('title')),
        ...rows)
    }

    /**
     * 渲染单个额度窗口行。
     * @param {Function} h - createElement。
     * @param {object} w - { name, remaining, total, usedPercent, resetsAt }。
     * @returns {object} 行内容。
     */
    function renderWindow(h, w) {
      const parts = [w.name + ': ' + fmt(w.remaining) + ' / ' + fmt(w.total) + '（已用 ' + w.usedPercent + '%）']
      if (w.resetsAt && w.resetsAt > Date.now()) {
        const mins = Math.round((w.resetsAt - Date.now()) / 60000)
        parts.push(mins >= 1440 ? '重置 ' + Math.round(mins / 1440) + ' 天后'
          : mins >= 60 ? '重置 ' + Math.round(mins / 60) + ' 小时后'
          : '重置 ' + mins + ' 分钟后')
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

    /**
     * 挂载入口。
     * @param {object} ctx - 客户端 cordis 上下文。
     * @returns {void}
     */
    function apply(ctx) {
      try {
        // locale 文案：注册命名空间，失败不影响卡片本体
        ctx.effect(() => ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en }), 'dsh-doubao-signin: dictionaries')

        // 设置导航项 + 额度卡片
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: SECTION_ID,
          order: SECTION_ORDER,
          label: () => DICT.zh.nav,
          locale: NS,
        }, props => h(SettingsPage, props)))
      } catch (error) {
        console.error('[dsh-doubao-signin] client card failed to load (host tools unaffected):', error)
      }
    }

    exports.apply = apply
    exports.inject = []
    exports.name = 'dsh-doubao-signin'
    return module.exports
  },
})
