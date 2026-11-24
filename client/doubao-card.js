/**
 * dsh-doubao-signin Web 设置卡片。
 *
 * **骨架来自 dsh-connect-doubaowork（MIT）** —— 它是本机实测能正常显示的豆包系插件，
 * 这里保留它的全部注册骨架与 slot 约定，只把渲染内容换成豆包额度看板：
 * - 打包为 `window.__ModuleLoader__.load` bundle，由 DSH Web GUI 加载；
 * - `apply(ctx)` 在设置页注册「豆包」区块（settings.section）；
 * - 数据只读：来自插件路由 /plugins/dsh-doubao-signin/quota（同源 fetch，cookie 不进页面）；
 * - 无能力探针：ctx.slots.inject('settings.section', …) 本身就是探针，宿主不声明该 slot 时静默无事。
 */
window.__ModuleLoader__.load({
  id: 'dsh-doubao-signin',
  factory: (require) => {
    const react = require('react')
    const h = react.createElement

    const SECTION_ID = 'dsh-doubao-signin'
    const LOCALE_NAMESPACE = 'settings.doubao-signin'
    const NS_CANDIDATES = ['dsh-doubao-signin']
    const STATUS_PATH = '/plugins/dsh-doubao-signin/quota'
    const KEEPALIVE_RUN_PATH = '/plugins/dsh-doubao-signin/quota'
    const CLI_REFRESH_PATH = '/plugins/dsh-doubao-signin/cli/refresh'
    const SETUP_PATH = '/plugins/dsh-doubao-signin/setup'
    const CHECKIN_RUN_PATH = '/plugins/dsh-doubao-signin/checkin/run'
    const LOGIN_START_PATH = '/plugins/dsh-doubao-signin/login/start'
    const LOGIN_POLL_PATH = '/plugins/dsh-doubao-signin/login/poll'
    const LOGIN_CANCEL_PATH = '/plugins/dsh-doubao-signin/login/cancel'
    /** 登录轮询节奏：1.5s 一轮，扫码成功后最迟这么久就能反馈（对齐 workbuddy 的做法）。 */
    const LOGIN_POLL_INTERVAL_MS = 1500

    /**
     * 卡片样式表。
     *
     * 与 dsh-connect-workbuddy 同构：颜色走宿主 --dsw-alias-* 主题变量并带十六进制
     * 回退（深浅色主题自动适配），尺寸走统一竖向节奏。用 <style> + data-plugin-css
     * 注入到 <head> 并去重，因此本插件仍然零构建：不产出 CSS 文件，也不需要打包器
     * 认识 CSS。
     *
     * `typeof document` 守卫是必须的：客户端单测在无 DOM 的假宿主里加载本 bundle。
     */
    const CARD_CSS = `/* ---------------------------------------------------------------------------
 * 豆包工作模式设置卡片样式。
 *
 * 与 dsh-connect-workbuddy 的 dsm-* 系统同构：颜色全部走宿主 --dsw-alias-*
 * 主题变量并带十六进制回退，因此深浅色主题自动适配；尺寸只用 16px 竖向节奏，
 * 不靠各个区块自带 padding 去凑间距。
 *
 * 类名统一 dsm-doubao-signin-* 前缀，避免与其它插件的卡片互相污染。
 * 样式由模块顶层注入到 <head>（<style data-plugin-css=...>），不走 CSS 文件，
 * 因此本插件保持零构建。
 * ------------------------------------------------------------------------- */
.dsm-doubao-signin-card{
  --dsm-doubao-signin-surface:var(--dsw-alias-bg-layer-1,#17181b);
  display:flex;flex-direction:column;gap:16px;margin:0;padding:16px 0 4px;
  color:var(--dsw-alias-label-primary,#e6e6e6);
  font-size:13px;line-height:1.5;
}

/* ---- 页头 ---- */
.dsm-doubao-signin-head{display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap;margin:0}
.dsm-doubao-signin-head-copy{display:flex;flex-direction:column;gap:4px;flex:1;min-width:200px}
.dsm-doubao-signin-title{margin:0;font-size:17px;font-weight:600;line-height:1.35;color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-doubao-signin-desc{margin:0;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#999)}
.dsm-doubao-signin-badges{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-left:auto}

/* ---- 胶囊 ---- */
.dsm-doubao-signin-badge{
  display:inline-flex;align-items:center;gap:5px;flex:none;
  padding:2px 9px;border-radius:999px;font-size:12px;font-weight:500;line-height:18px;
  color:var(--dsw-alias-brand-primary,#5686fe);
  background:rgba(86,134,254,.12);border:1px solid rgba(86,134,254,.32);
  white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis;
}
.dsm-doubao-signin-badge-ok{
  color:var(--dsw-alias-state-success-primary,#22a06b);
  background:rgba(34,160,107,.12);border-color:rgba(34,160,107,.32);
}
.dsm-doubao-signin-badge-warn{
  color:var(--dsw-alias-state-warn-primary,#f59e0b);
  background:rgba(245,158,11,.1);border-color:rgba(245,158,11,.32);
}
.dsm-doubao-signin-badge-mute{
  color:var(--dsw-alias-label-secondary,#c6c9d0);
  background:transparent;border-color:var(--dsw-alias-border-l2,#3a3d45);
}

/* ---- 面板 tab 栏（吸附在卡片顶部，否则滚到池子就看不清当前所在面板）---- */
.dsm-doubao-signin-panels{
  position:sticky;top:-1px;z-index:2;display:flex;align-items:stretch;gap:2px;margin:0;
  border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));
  background:var(--dsm-doubao-signin-surface,var(--dsw-alias-bg-layer-1,#17181b));
}
.dsm-doubao-signin-panel-tab{
  appearance:none;font:inherit;cursor:pointer;border:0;background:transparent;
  padding:7px 11px;margin-bottom:-1px;border-bottom:2px solid transparent;
  color:var(--dsw-alias-label-tertiary,#999);font-size:13px;font-weight:600;line-height:20px;
  white-space:nowrap;transition:color .15s,border-color .15s;
}
.dsm-doubao-signin-panel-tab:hover:not(.dsm-doubao-signin-panel-tab-active){color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-doubao-signin-panel-tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.dsm-doubao-signin-panel-tab-active{color:var(--dsw-alias-label-primary,#e6e6e6);border-bottom-color:var(--dsw-alias-brand-primary,#5686fe)}
/* hidden 必须能压过上面的 display:flex：ID/类选择器一旦给了 display，UA 的
   [hidden]{display:none} 就失效，面板会永久绘制（workbuddy 5.20.1 踩过）。 */
.dsm-doubao-signin-panel{display:flex;flex-direction:column;gap:18px;margin:0}
.dsm-doubao-signin-panel[hidden]{display:none!important}

/* ---- 分组 ---- */
.dsm-doubao-signin-section{display:flex;flex-direction:column;gap:10px;margin:0}
.dsm-doubao-signin-section-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0}
.dsm-doubao-signin-group-title{margin:0;font-size:15px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-doubao-signin-group-desc{margin:0;font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary,#999)}
.dsm-doubao-signin-note{margin:0;font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-doubao-signin-hint{margin:0;font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary,#999)}
.dsm-doubao-signin-error{margin:0;font-size:12px;line-height:17px;color:var(--dsw-alias-state-error-primary,#ef4444);white-space:pre-line}
.dsm-doubao-signin-ok{color:var(--dsw-alias-state-success-primary,#22a06b)}
.dsm-doubao-signin-warn{margin:0;padding:9px 11px;border-radius:9px;font-size:12px;line-height:17px;
  color:var(--dsw-alias-state-warn-primary,#f59e0b);
  background:rgba(245,158,11,.09);border:1px solid rgba(245,158,11,.3)}
.dsm-doubao-signin-code{
  margin:0;padding:9px 11px;border-radius:9px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-all;
  color:var(--dsw-alias-label-secondary,#c6c9d0);
  background:var(--dsw-alias-bg-layer-1,#17181b);border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));
}

/* ---- 开关行：整行可点，说明文字在标签下方，开关用平台原生控件只上色 ---- */
.dsm-doubao-signin-switchlist{
  display:flex;flex-direction:column;margin:0;padding:0;list-style:none;
  border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:12px;overflow:hidden;
  background:var(--dsw-alias-bg-layer-2,#232529);
}
.dsm-doubao-signin-switchrow{
  display:flex;align-items:flex-start;gap:12px;padding:12px 14px;margin:0;
  border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));
}
.dsm-doubao-signin-switchrow:first-child{border-top:0}
.dsm-doubao-signin-switchrow-copy{display:flex;flex-direction:column;gap:3px;flex:1;min-width:0}
.dsm-doubao-signin-switchrow-label{font-size:13px;font-weight:500;line-height:1.45;color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-doubao-signin-switchrow-desc{font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary,#999)}
.dsm-doubao-signin-switch{
  display:inline-flex;align-items:center;justify-content:center;flex:none;margin-top:2px;cursor:pointer;
}
.dsm-doubao-signin-switch input{margin:0;cursor:pointer;accent-color:var(--dsw-alias-brand-primary,#5686fe)}
.dsm-doubao-signin-switch input:disabled{cursor:default}

/* ---- 字段行 ---- */
.dsm-doubao-signin-fields{
  display:flex;flex-direction:column;margin:0;
  border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:12px;overflow:hidden;
  background:var(--dsw-alias-bg-layer-2,#232529);
}
.dsm-doubao-signin-field{
  display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:10px 14px;margin:0;
  border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));
}
.dsm-doubao-signin-field:first-child{border-top:0}
.dsm-doubao-signin-field-label{flex:1 1 140px;min-width:0;font-size:13px;line-height:1.45}
.dsm-doubao-signin-field-control{flex:0 1 280px;min-width:160px;display:flex;justify-content:flex-end}
.dsm-doubao-signin-select,.dsm-doubao-signin-input{
  appearance:none;font:inherit;font-size:13px;line-height:20px;width:100%;
  padding:5px 10px;border-radius:8px;color:var(--dsw-alias-label-primary,#e6e6e6);
  background:var(--dsw-alias-bg-layer-1,#17181b);
  border:1px solid var(--dsw-alias-border-l2,#3a3d45);
}
.dsm-doubao-signin-select{cursor:pointer;padding-right:26px;
  /* 纯 CSS 箭头：不依赖宿主的图标集（不同 DSH 线图标名不同） */
  background-image:linear-gradient(45deg,transparent 50%,currentColor 50%),linear-gradient(135deg,currentColor 50%,transparent 50%);
  background-position:calc(100% - 15px) 50%,calc(100% - 10px) 50%;
  background-size:5px 5px,5px 5px;background-repeat:no-repeat}
.dsm-doubao-signin-select:focus-visible,.dsm-doubao-signin-input:focus-visible{
  outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.dsm-doubao-signin-input::placeholder{color:var(--dsw-alias-label-dimmed,#777)}

/* ---- 只读测量值行（label + value 两端对齐）---- */
.dsm-doubao-signin-kv{display:flex;align-items:baseline;gap:12px;margin:0;padding:7px 0;min-width:0}
.dsm-doubao-signin-kv-label{flex:0 0 auto;font-size:12px;color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-doubao-signin-kv-value{flex:1 1 auto;min-width:0;font-size:12px;text-align:right;
  color:var(--dsw-alias-label-primary,#e8e9ed);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-doubao-signin-kv-value-wrap{white-space:normal;word-break:break-all;text-align:right}

/* ---- 表格（逐账号）---- */
.dsm-doubao-signin-table{
  display:flex;flex-direction:column;margin:0;padding:0;list-style:none;
  border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:12px;overflow:hidden;
  background:var(--dsw-alias-bg-layer-2,#232529);
}
.dsm-doubao-signin-table-row{
  display:flex;align-items:center;gap:10px;padding:9px 14px;margin:0;
  border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));font-size:13px;
}
.dsm-doubao-signin-table-row:first-child{border-top:0}
.dsm-doubao-signin-table-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-doubao-signin-table-meta{flex:none;font-size:12px;color:var(--dsw-alias-label-tertiary,#999)}
.dsm-doubao-signin-dot{display:inline-block;flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-dimmed,#777)}
.dsm-doubao-signin-dot-ok{background:var(--dsw-alias-state-success-primary,#22a06b)}
.dsm-doubao-signin-dot-bad{background:var(--dsw-alias-state-error-primary,#ef4444)}
.dsm-doubao-signin-dot-warn{background:var(--dsw-alias-state-warn-primary,#f59e0b)}

/* ---- 操作条 ---- */
.dsm-doubao-signin-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0}
.dsm-doubao-signin-bar-status{flex:1 1 auto;min-width:0;font-size:12px;line-height:18px;
  color:var(--dsw-alias-label-tertiary,#999);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-doubao-signin-bar-actions{display:flex;gap:8px;flex:none;margin-left:auto}

/* ---- 按钮原语 ---- */
.dsm-doubao-signin-btn{
  appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;
  padding:5px 14px;font-size:13px;line-height:1.5;white-space:nowrap;
}
.dsm-doubao-signin-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.dsm-doubao-signin-btn:disabled{opacity:.4;cursor:default}
.dsm-doubao-signin-btn-outline{
  border-color:var(--dsw-alias-border-l2,#3a3d45);color:var(--dsw-alias-label-secondary,#c6c9d0);
  background:transparent;font-weight:500;
}
.dsm-doubao-signin-btn-outline:hover:not(:disabled){
  color:var(--dsw-alias-label-primary,#e6e6e6);border-color:var(--dsw-alias-label-dimmed,#777);
  background:rgba(255,255,255,.04);
}
.dsm-doubao-signin-btn-primary{background:var(--dsw-alias-label-primary,#e6e6e6);color:var(--dsw-alias-bg-layer-3,#2a2c33);font-weight:600}
.dsm-doubao-signin-btn-primary:hover:not(:disabled){opacity:.9}
.dsm-doubao-signin-btn-ghost{border-color:transparent;color:var(--dsw-alias-brand-primary,#5686fe);background:transparent;font-weight:500}
.dsm-doubao-signin-btn-ghost:hover:not(:disabled){text-decoration:underline}

/* ---- 引导步骤 ---- */
.dsm-doubao-signin-steps{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;list-style:none}
.dsm-doubao-signin-step{display:flex;align-items:flex-start;gap:9px;margin:0;font-size:13px;line-height:1.5}
.dsm-doubao-signin-step-mark{flex:none;width:16px;text-align:center;font-weight:700}
.dsm-doubao-signin-step-mark-done{color:var(--dsw-alias-state-success-primary,#22a06b)}
.dsm-doubao-signin-step-mark-warn{color:var(--dsw-alias-state-warn-primary,#f59e0b)}
.dsm-doubao-signin-step-mark-blocked{color:var(--dsw-alias-state-error-primary,#ef4444)}
.dsm-doubao-signin-step-mark-todo{color:var(--dsw-alias-label-dimmed,#777)}
.dsm-doubao-signin-step-copy{display:flex;flex-direction:column;gap:4px;flex:1;min-width:0}
.dsm-doubao-signin-step-detail{color:var(--dsw-alias-label-secondary,#c6c9d0)}

/* ---- 扫码登录 ---- */
.dsm-doubao-signin-qr{display:flex;flex-direction:column;align-items:center;gap:8px;margin:0;padding:6px 0}
.dsm-doubao-signin-qr-img{
  width:220px;height:220px;border-radius:10px;background:#fff;padding:8px;box-sizing:content-box;
  border:1px solid var(--dsw-alias-border-l2,#3a3d45);
}
.dsm-doubao-signin-qr-wait{font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary,#c6c9d0);text-align:center}
`

    const CARD_CSS_ID = 'dsh-doubao-signin/client.css'
    if (typeof document !== 'undefined') {
      const existing = document.querySelector(`style[data-plugin-css="${CARD_CSS_ID}"]`)
      if (existing !== null) {
        existing.textContent = CARD_CSS
      } else {
        const styleTag = document.createElement('style')
        styleTag.dataset.plugin = 'dsh-doubao-signin'
        styleTag.dataset.pluginCss = CARD_CSS_ID
        styleTag.textContent = CARD_CSS
        document.head.appendChild(styleTag)
      }
    }

    const COPY = {
      zh: {
        'nav.panel': '豆包',
        'card.title': '豆包额度',
        'card.desc': '豆包账号剩余额度：套餐积分与活动赠送额度（每日签到领的那份），只读，不消耗推理额度。',
        'tab.overview': '额度',
        'tab.gateway': '额度',
        'tab.models': '额度',
        'tab.accounts': '额度',
        'tab.diagnostics': '额度',
        'hint.workMode': '数据来自插件路由 /plugins/dsh-doubao-signin/quota，同源只读 fetch。',
        'hint.flattenHistory': '豆包 cookie 只活在 Host 进程里，永远不进页面。',
        'hint.poolEnabled': '每 30 秒自动刷新一次。',
        'hint.keepaliveEnabled': '读取失败会显示「额度读不出来」，不会静默显示 0。',
        'hint.backend': '想先登录：用 doubao_login 扫码登录一次；或用已登录的豆包桌面客户端。',
        'group.gateway': '额度明细',
        'field.conversationMode': '剩余额度',
        'field.conversationMode.single': '套餐积分与活动赠送额度各自的剩余与重置时间',
        'field.poolEnabled': '自动刷新',
        'field.poolEnabled.true': '开：每 30 秒刷新',
        'field.poolEnabled.false': '关：只在打开页面时读一次',
        'field.keepaliveEnabled': '签到入口',
        'field.keepaliveEnabled.true': '用 doubao_checkin 工具签到（走客户端真实 UI）',
        'field.keepaliveEnabled.false': '不签到，只看额度',
        'field.backend': '凭据来源',
        'field.backend.single': '扫码保存的凭据优先；没有则借已登录的豆包客户端',
        'empty': '暂无额度数据。',
        'loading': '读取中…',
        'unavailable': '额度读不出来',
        'remaining': '剩余',
        'used': '已用',
        'resetIn': '重置',
        'minutes': '分钟后',
        'hours': '小时后',
        'days': '天后',
        'never': '—',
        'source.saved': '来源：扫码保存的凭据',
        'source.client': '来源：豆包桌面客户端',
        'signedOut': '尚未登录。用 doubao_login 扫码登录一次即可看到额度。',
        'clientMissing': '豆包客户端可能没在运行（额度读的是它的会话），或还没登录。',
      },
      en: {
        'nav.panel': 'Doubao',
        'card.title': 'Doubao credits',
        'card.desc': 'Remaining Doubao credits: package points and activity grants (the ones daily check-in earns). Read-only.',
        'tab.overview': 'Credits',
        'tab.gateway': 'Credits',
        'tab.models': 'Credits',
        'tab.accounts': 'Credits',
        'tab.diagnostics': 'Credits',
        'hint.workMode': 'Data comes from the plugin route /plugins/dsh-doubao-signin/quota (same-origin read-only fetch).',
        'hint.flattenHistory': 'Doubao cookies stay in the Host process and never reach this page.',
        'hint.poolEnabled': 'Refreshes every 30 seconds.',
        'hint.keepaliveEnabled': 'A failed read shows "credits unavailable" instead of a silent 0.',
        'hint.backend': 'Sign in once with doubao_login, or use a signed-in Doubao desktop client.',
        'group.gateway': 'Credit breakdown',
        'field.conversationMode': 'Remaining credits',
        'field.conversationMode.single': 'Remaining and reset time of each credit window',
        'field.poolEnabled': 'Auto refresh',
        'field.poolEnabled.true': 'On: refresh every 30s',
        'field.poolEnabled.false': 'Off: read once when the page opens',
        'field.keepaliveEnabled': 'Daily check-in',
        'field.keepaliveEnabled.true': 'Use the doubao_checkin tool (real client UI)',
        'field.keepaliveEnabled.false': 'No check-in, credits view only',
        'field.backend': 'Credential source',
        'field.backend.single': 'Saved scan credentials first, otherwise a signed-in Doubao client',
        'empty': 'No credit data yet.',
        'loading': 'Loading…',
        'unavailable': 'Credits unavailable',
        'remaining': 'remaining',
        'used': 'used',
        'resetIn': 'resets',
        'minutes': 'min',
        'hours': 'h',
        'days': 'd',
        'never': '—',
        'source.saved': 'source: saved scan credentials',
        'source.client': 'source: Doubao desktop client',
        'signedOut': 'Not signed in yet. Run doubao_login once to see credits.',
        'clientMissing': 'The Doubao desktop client may not be running (credits come from its session), or you are not signed in.',
      },
    }

    
    /** Card body: tabbed panels over the same read-only measurements as before. */
    function Doubaocard(props) {
      const { t, settingsScope } = props
      const snapshot = typeof settingsScope?.getSnapshot === 'function' ? settingsScope.getSnapshot() : undefined
      const config = snapshot?.value ?? {}
      const [draft, setDraft] = react.useState(null)
      const [savedAt, setSavedAt] = react.useState(0)
      const [status, setStatus] = react.useState(null)
      const [statusError, setStatusError] = react.useState(false)
      const [probing, setProbing] = react.useState(false)
      const [checkingIn, setCheckingIn] = react.useState(false)
      const [refreshing, setRefreshing] = react.useState(false)
      const [checking, setChecking] = react.useState(false)
      // 当前面板：与 workbuddy 一致用「一个文档的多个面板」而不是二选一开关格。
      // 面板全部保持挂载（hidden 只隐藏不卸载），所以切回来不会重拉数据、
      // 半填的草稿也不会丢。
      const [tab, setTab] = react.useState('overview')
      // 扫码登录本地状态机：idle → starting → waiting → success | error
      // 只放浏览器侧的展示状态，二维码字节与 loginId 都来自 Host 的 start 响应
      const [login, setLogin] = react.useState({ phase: 'idle' })

      const value = draft ?? config
      const dirty = draft !== null

      react.useEffect(() => {
        let alive = true
        fetch(STATUS_PATH, { headers: { accept: 'application/json' } })
          .then(response => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
          .then(data => { if (alive) { setStatus(data); setStatusError(false) } })
          .catch(() => { if (alive) setStatusError(true) })
        return () => { alive = false }
      }, [savedAt])

      const setField = (key, next) => setDraft(current => ({ ...(current ?? config), [key]: next }))

      const save = () => {
        if (draft === null || typeof settingsScope?.set !== 'function') return
        for (const key of [
          'backend', 'conversationMode', 'workMode', 'flattenHistory', 'reasoningEffort', 'timeoutSeconds',
          'poolEnabled', 'keepaliveEnabled', 'cliPath', 'cliWorkspace', 'cliPermissionMode', 'cliEffort',
          'checkinEnabled', 'checkinHour', 'checkinMinute',
        ]) {
          if (draft[key] !== undefined && draft[key] !== config[key]) {
            try {
              settingsScope.set(key, draft[key])
            } catch (error) {
              console.error('[dsh-doubao-signin] failed to save', key, error)
            }
          }
        }
        setDraft(null)
        setSavedAt(Date.now())
      }

      const probeNow = async () => {
        setProbing(true)
        try {
          const response = await fetch(KEEPALIVE_RUN_PATH, { method: 'POST', headers: { accept: 'application/json' } })
          if (response.ok) {
            setStatus(await response.json())
            setStatusError(false)
          }
        } catch {} finally {
          setProbing(false)
        }
      }

      const refreshCli = async () => {
        setRefreshing(true)
        try {
          const response = await fetch(CLI_REFRESH_PATH, { method: 'POST', headers: { accept: 'application/json' } })
          if (response.ok) {
            const data = await response.json()
            setStatus(current => ({ ...(current ?? {}), cli: data }))
            setStatusError(false)
          }
          // CLI 探测结果会改变「当前生效」的后端与模型清单（auto 下登录后切到 cli），
          // 所以顺带重拉整份 status，别让那块只读测量值停在旧值。
          const snapshot2 = await fetch(STATUS_PATH, { headers: { accept: 'application/json' } })
          if (snapshot2.ok) {
            setStatus(await snapshot2.json())
            setStatusError(false)
          }
        } catch {} finally {
          setRefreshing(false)
        }
      }

      /**
       * 立即签到：POST /checkin/run。Host 侧是 force 模式（忽略「今日已签」去重），
       * 所以按钮点一次就真的访问一次豆包——这也是用户手动验证登录态的手段。
       * 返回的是新的 pending state，随后整份 status 重拉以刷新「今日结果」。
       */
      const checkinNow = async () => {
        setCheckingIn(true)
        try {
          const response = await fetch(CHECKIN_RUN_PATH, { method: 'POST', headers: { accept: 'application/json' } })
          if (response.ok) {
            const snapshot2 = await fetch(STATUS_PATH, { headers: { accept: 'application/json' } })
            if (snapshot2.ok) {
              setStatus(await snapshot2.json())
              setStatusError(false)
            }
          }
        } catch {} finally {
          setCheckingIn(false)
        }
      }

      const refreshSetup = async () => {
        setChecking(true)
        try {
          const response = await fetch(SETUP_PATH, { method: 'POST', headers: { accept: 'application/json' } })
          if (response.ok) {
            const data = await response.json()
            setStatus(current => ({ ...(current ?? {}), setup: data }))
            setStatusError(false)
          }
        } catch {} finally {
          setChecking(false)
        }
      }

      /**
       * 开始一次扫码登录：Host 拉起 `doubao login --qr=png` 并回 data URL。
       * 失败（未装 CLI / 已有登录在进行 / 输出不支持）都在这里落地成可读文案。
       */
      const startLogin = async () => {
        setLogin({ phase: 'starting' })
        try {
          const response = await fetch(LOGIN_START_PATH, { method: 'POST', headers: { accept: 'application/json' } })
          const data = await response.json()
          if (data?.ok === true && typeof data.imageDataUrl === 'string' && data.imageDataUrl !== '') {
            setLogin({
              phase: 'waiting',
              loginId: data.loginId,
              imageDataUrl: data.imageDataUrl,
              expiresAt: Date.now() + Math.max(1, Number(data.expiresInSeconds ?? 300)) * 1000,
            })
            return
          }
          setLogin({ phase: 'error', error: String(data?.error ?? t('login.failed')) })
        } catch (error) {
          setLogin({ phase: 'error', error: String(error?.message ?? error) })
        }
      }

      /** 取消进行中的登录（同时杀掉 Host 侧子进程）。 */
      const cancelLogin = async () => {
        const active = login.loginId
        setLogin({ phase: 'idle' })
        if (typeof active !== 'string') return
        try {
          await fetch(LOGIN_CANCEL_PATH, {
            method: 'POST',
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            body: JSON.stringify({ loginId: active }),
          })
        } catch {}
      }

      /**
       * 轮询登录结果。
       *
       * 用 effect + 定时器而不是自己写循环：卸载时 clearInterval 就能停，
       * 不会留下悬空请求。成功后补一次 status 刷新，把 CLI 区块切成已登录。
       */
      react.useEffect(() => {
        if (login.phase !== 'waiting' || typeof login.loginId !== 'string') return undefined
        let alive = true
        let timer = undefined
        const tick = async () => {
          try {
            const response = await fetch(LOGIN_POLL_PATH, {
              method: 'POST',
              headers: { accept: 'application/json', 'content-type': 'application/json' },
              body: JSON.stringify({ loginId: login.loginId }),
            })
            if (!response.ok) return
            const data = await response.json()
            if (!alive) return
            if (data?.done === true) {
              if (data.loggedIn === true) {
                setLogin({ phase: 'success' })
                // 登录态变了：把 CLI 状态与引导一并刷新，卡片即时变成「已登录」
                void refreshCli()
                void refreshSetup()
                return
              }
              setLogin({ phase: 'error', error: String(data?.error ?? t('login.expired')) })
              return
            }
          } catch {
            // 网络抖动不算失败：下一轮继续问
          }
        }
        timer = setInterval(() => { void tick() }, LOGIN_POLL_INTERVAL_MS)
        void tick()
        return () => {
          alive = false
          if (timer !== undefined) clearInterval(timer)
        }
      }, [login.phase, login.loginId])

      /* ------------------------------------------------------------------
       * 渲染原语。
       *
       * 全部走 className（样式在模块顶层注入 <style>），不再用内联 style：
       * 内联样式既没法表达 :hover / :focus-visible，也没法跟随宿主深浅色主题，
       * 这就是旧卡片「一片灰字」的根源。
       * ---------------------------------------------------------------- */

      /** 分组：标题 + 可选描述 + 子元素。 */
      const group = (key, title, children, description) => h('section', { key, className: 'dsm-doubao-signin-section' },
        h('div', { className: 'dsm-doubao-signin-section-head' }, h('h4', { className: 'dsm-doubao-signin-group-title' }, title)),
        description === undefined || description === '' ? null : h('p', { className: 'dsm-doubao-signin-group-desc' }, description),
        ...(Array.isArray(children) ? children : [children]).filter(child => child !== null && child !== undefined && child !== false))

      /** 只读键值行（label 左侧、值右侧，过长省略）。 */
      const kv = (key, label, text, wrap = false) => h('div', { key, className: 'dsm-doubao-signin-kv' },
        h('span', { className: 'dsm-doubao-signin-kv-label' }, label),
        h('span', { className: `dsm-doubao-signin-kv-value${wrap ? ' dsm-doubao-signin-kv-value-wrap' : ''}` }, text))

      /** 可编辑字段行：label + 控件。 */
      const field = (key, label, control) => h('div', { key, className: 'dsm-doubao-signin-field' },
        h('label', { className: 'dsm-doubao-signin-field-label' }, label),
        h('div', { className: 'dsm-doubao-signin-field-control' }, control))

      /** 开关行：整行说明 + 平台原生 checkbox（只给 accent-color，不自己画）。 */
      const switchRow = (key, label, description, checked, onChange, disabled = false) => h('div', { key, className: 'dsm-doubao-signin-switchrow' },
        h('div', { className: 'dsm-doubao-signin-switchrow-copy' },
          h('span', { className: 'dsm-doubao-signin-switchrow-label' }, label),
          description === undefined || description === '' ? null : h('span', { className: 'dsm-doubao-signin-switchrow-desc' }, description)),
        h('label', { className: 'dsm-doubao-signin-switch' },
          h('input', { type: 'checkbox', checked: checked === true, disabled, onChange: event => onChange(event.target.checked) })))

      /** 按钮。variant: primary | outline | ghost。 */
      const button = (key, label, onClick, variant = 'outline', disabled = false) => h('button', {
        key,
        type: 'button',
        className: `dsm-doubao-signin-btn dsm-doubao-signin-btn-${variant}`,
        disabled,
        onClick,
      }, label)

      /** 下拉框（给 out-of-range 值一个稳定的空值 key）。 */
      const select = (options, current, onChange) => h('select', {
        className: 'dsm-doubao-signin-select',
        value: current,
        onChange: event => onChange(event.target.value),
      }, options.map(([optionValue, optionLabel]) => h('option', { key: `o-${optionValue === '' ? 'default' : optionValue}`, value: optionValue }, optionLabel)))

      const input = (type, current, onChange, placeholder) => h('input', {
        className: 'dsm-doubao-signin-input',
        type,
        placeholder,
        value: type === 'number' ? current : String(current ?? ''),
        onChange: event => onChange(type === 'number' ? Number(event.target.value) : event.target.value),
      })

      const note = (key, text) => h('p', { key, className: 'dsm-doubao-signin-note' }, text)
      const hint = (key, text) => h('p', { key, className: 'dsm-doubao-signin-hint' }, text)

      /** 面板容器：不活跃的面板保持挂载，只加 hidden。 */
      const panel = (id, children) => h('div', {
        key: `panel-${id}`,
        className: 'dsm-doubao-signin-panel',
        hidden: tab !== id,
      }, ...children.filter(child => child !== null && child !== undefined && child !== false))

      /* ------------------------------------------------------------------
       * 页头：标题 + 描述 + 右侧状态徽章。
       *
       * 徽章只表达「当前实测状态」，不承担操作：后端徽章来自 status，
       * CLI 徽章来自 status.cli，两者都由 Host 侧探测产生。
       * ---------------------------------------------------------------- */
      const effectiveBackend = status?.effectiveBackend === 'cli' ? 'cli' : 'http'
      const cliInfo = status?.cli
      const badges = []
      if (status !== null && status !== undefined) {
        badges.push(h('span', {
          key: 'badge-backend',
          className: `dsm-doubao-signin-badge${effectiveBackend === 'cli' ? ' dsm-doubao-signin-badge-ok' : ''}`,
        }, t(`effective.backend.${effectiveBackend}`)))
        if (cliInfo !== null && cliInfo !== undefined) {
          badges.push(h('span', {
            key: 'badge-cli',
            className: `dsm-doubao-signin-badge${cliInfo.loggedIn === true ? ' dsm-doubao-signin-badge-ok' : ' dsm-doubao-signin-badge-mute'}`,
          }, cliInfo.loggedIn === true
            ? `CLI v${cliInfo.version === '' || cliInfo.version === undefined ? '' : cliInfo.version}`
            : t('cli.notLoggedIn')))
        }
      } else {
        badges.push(h('span', { key: 'badge-unknown', className: 'dsm-doubao-signin-badge dsm-doubao-signin-badge-mute' },
          statusError ? t('error.fetch') : t('cli.unknown')))
      }

      const header = h('header', { key: 'head', className: 'dsm-doubao-signin-head' },
        h('div', { className: 'dsm-doubao-signin-head-copy' },
          h('h3', { className: 'dsm-doubao-signin-title' }, t('card.title')),
          h('p', { className: 'dsm-doubao-signin-desc' }, t('card.desc'))),
        h('div', { className: 'dsm-doubao-signin-badges' }, ...badges))

      /* ---- 面板一：概览（引导 + 当前生效）---- */
      const overview = []
      overview.push(group('g-setup', t('group.setup'), (() => {
        const setup = status?.setup
        if (setup === undefined || setup === null || setup.pending === true) {
          return [h('p', { key: 'setup-pending', className: 'dsm-doubao-signin-hint' }, t('setup.pending')),
            h('div', { key: 'setup-bar', className: 'dsm-doubao-signin-bar' },
              button('setup-refresh', checking ? t('action.checking') : t('action.refreshSetup'), refreshSetup, 'outline', checking))]
        }
        const items = []
        items.push(h('div', { key: 'setup-head', className: 'dsm-doubao-signin-bar' },
          h('span', {
            className: `dsm-doubao-signin-badge${setup.ready === true ? ' dsm-doubao-signin-badge-ok' : ' dsm-doubao-signin-badge-warn'}`,
          }, setup.ready === true ? t('setup.ready') : t('setup.notReady')),
          h('div', { className: 'dsm-doubao-signin-bar-actions' },
            button('setup-refresh', checking ? t('action.checking') : t('action.refreshSetup'), refreshSetup, 'outline', checking))))

        const steps = Array.isArray(setup.steps) ? setup.steps : []
        if (steps.length > 0) {
          const stepNodes = []
          for (const step of steps) {
            const mark = step.status === 'done' ? '✓' : step.status === 'warn' ? '!' : step.status === 'blocked' ? '✗' : '○'
            const markClass = step.status === 'done' ? 'done' : step.status === 'warn' ? 'warn' : step.status === 'blocked' ? 'blocked' : 'todo'
            const copy = [h('span', { key: 'd', className: 'dsm-doubao-signin-step-detail' }, `${step.title}：${step.detail}`)]
            if (step.warn) copy.push(h('span', { key: 'w', className: 'dsm-doubao-signin-warn' }, `${t('setup.warn')}${step.warn}`))
            if (Array.isArray(step.fix) && step.fix.length > 0) {
              copy.push(h('div', { key: 'f', className: 'dsm-doubao-signin-step-copy' },
                h('span', { className: 'dsm-doubao-signin-hint' }, t('setup.fix')),
                h('pre', { className: 'dsm-doubao-signin-code' }, step.fix.join('\n'))))
            }
            stepNodes.push(h('li', { key: `step-${step.id}`, className: 'dsm-doubao-signin-step' },
              h('span', { className: `dsm-doubao-signin-step-mark dsm-doubao-signin-step-mark-${markClass}` }, mark),
              h('div', { className: 'dsm-doubao-signin-step-copy' }, ...copy)))
          }
          items.push(h('ul', { key: 'steps', className: 'dsm-doubao-signin-steps' }, ...stepNodes))
        }
        return items
      })()))

      const effectiveNodes = []
      if (status === null || status === undefined) {
        effectiveNodes.push(h('p', { key: 'eff-unknown', className: 'dsm-doubao-signin-hint' }, statusError ? t('error.fetch') : t('cli.unknown')))
      } else {
        const liveModels = Array.isArray(status.models) ? status.models : []
        effectiveNodes.push(kv('eff-1', t('effective.backend'), t(`effective.backend.${effectiveBackend}`)))
        effectiveNodes.push(kv('eff-2', t('effective.models'),
          liveModels.length === 0 ? t('effective.noModels') : `${liveModels.length}：${liveModels.join(', ')}`, true))
        effectiveNodes.push(kv('eff-3', t('effective.default'), String(status.defaultModel ?? '')))
      }
      overview.push(group('g-effective', t('group.effective'), effectiveNodes))

      /* ---- 面板二：网关（可编辑配置 + 保存）---- */
      const gateway = []
      if (settingsScope !== undefined) {
        const rows = []
        rows.push(field('f1', t('field.conversationMode'), select([
          ['single', t('field.conversationMode.single')],
          ['per-chat', t('field.conversationMode.per-chat')],
        ], value.conversationMode ?? 'single', next => setField('conversationMode', next))))
        rows.push(field('f2', t('field.reasoningEffort'), select(
          ['0', '1', '2', '3', '4'].map(level => [level, level]),
          String(value.reasoningEffort ?? '4'), next => setField('reasoningEffort', next))))
        rows.push(field('f3', t('field.timeoutSeconds'), input('number', value.timeoutSeconds ?? 300, next => setField('timeoutSeconds', next))))
        gateway.push(h('div', { key: 'gw-fields', className: 'dsm-doubao-signin-fields' }, ...rows))

        const switches = []
        switches.push(switchRow('s1', t('field.workMode'), t('hint.workMode'),
          value.workMode !== false, next => setField('workMode', next)))
        switches.push(switchRow('s2', t('field.flattenHistory'), t('hint.flattenHistory'),
          value.flattenHistory !== false, next => setField('flattenHistory', next)))
        switches.push(switchRow('s3', t('field.poolEnabled'), t('hint.poolEnabled'),
          value.poolEnabled === true, next => setField('poolEnabled', next)))
        switches.push(switchRow('s4', t('field.keepaliveEnabled'), t('hint.keepaliveEnabled'),
          value.keepaliveEnabled === true, next => setField('keepaliveEnabled', next)))
        gateway.push(h('div', { key: 'gw-switches', className: 'dsm-doubao-signin-switchlist' }, ...switches))
      } else {
        gateway.push(note('gw-ro', t('accounts.readonly')))
      }

      /* ---- 面板三：模型（后端选择 + CLI 探测）---- */
      const modelsPanel = []
      if (settingsScope !== undefined) {
        const rows = []
        rows.push(field('b1', t('field.backend'), select([
          ['auto', t('field.backend.auto')],
          ['cli', t('field.backend.cli')],
          ['http', t('field.backend.http')],
        ], value.backend ?? 'auto', next => setField('backend', next))))
        rows.push(field('b2', t('field.cliPath'), input('text', value.cliPath ?? '', next => setField('cliPath', next), 'doubao')))
        rows.push(field('b3', t('field.cliWorkspace'), input('text', value.cliWorkspace ?? '', next => setField('cliWorkspace', next), '~')))
        rows.push(field('b4', t('field.cliPermissionMode'), select([
          ['ask_risky', t('field.cliPermissionMode.ask_risky')],
          ['ask_always', t('field.cliPermissionMode.ask_always')],
          ['always_allow', t('field.cliPermissionMode.always_allow')],
        ], value.cliPermissionMode ?? 'ask_risky', next => setField('cliPermissionMode', next))))
        rows.push(field('b5', t('field.cliEffort'), select(
          [['', t('field.cliEffort.default')], ['none', 'none'], ['minimal', 'minimal'], ['low', 'low'],
            ['medium', 'medium'], ['high', 'high'], ['xhigh', 'xhigh'], ['max', 'max']],
          value.cliEffort ?? '', next => setField('cliEffort', next))))
        // 「上游后端」是一组互相影响的字段（选 cli 才用得到 cliPath/cliPermissionMode），
        // 所以整组包在同一个分组标题下，而不是散落在面板里。
        modelsPanel.push(group('md-backend', t('group.backend'), [
          h('div', { key: 'md-fields', className: 'dsm-doubao-signin-fields' }, ...rows),
          hint('md-hint', t('hint.backend')),
        ]))
      } else {
        modelsPanel.push(note('md-ro', t('accounts.readonly')))
      }

      const cliNodes = []
      if (cliInfo === null || cliInfo === undefined) {
        cliNodes.push(h('p', { key: 'cli-unknown', className: 'dsm-doubao-signin-hint' }, statusError ? t('error.fetch') : t('cli.unknown')))
      } else {
        cliNodes.push(kv('cli-1', t('cli.installed'),
          cliInfo.installed === true ? `✓ ${cliInfo.version === '' || cliInfo.version === undefined ? '' : `v${cliInfo.version}`}`.trim() : t('cli.notInstalled')))
        cliNodes.push(kv('cli-2', t('cli.loggedIn'),
          cliInfo.loggedIn === true ? `✓ ${t('cli.loggedIn')}` : t('cli.notLoggedIn')))
        const cliModels = Array.isArray(cliInfo.models) ? cliInfo.models : []
        cliNodes.push(kv('cli-3', t('cli.models'),
          cliModels.length === 0 ? t('cli.noModels') : `${cliModels.length}：${cliModels.join(', ')}`, true))
      }
      cliNodes.push(h('div', { key: 'cli-bar', className: 'dsm-doubao-signin-bar' },
        h('div', { className: 'dsm-doubao-signin-bar-actions' },
          button('cli-refresh', refreshing ? t('action.refreshing') : t('action.refreshCli'), refreshCli, 'outline', refreshing))))
      modelsPanel.push(group('md-cli', t('group.cli'), cliNodes))

      /* ---- 面板四：账号（池 + 扫码登录 + 签到）---- */
      const accountsPanel = []

      // 扫码登录：只在 Host 提供了 login 能力时渲染（缺席给会失败的按钮更糟）
      const loginState = status?.login
      if (loginState !== null && loginState !== undefined) {
        const loggedIn = cliInfo?.loggedIn === true
        const loginNodes = [h('p', { key: 'login-desc', className: 'dsm-doubao-signin-group-desc' }, t('login.desc'))]
        if (login.phase === 'waiting') {
          const left = Math.max(0, Math.ceil(((login.expiresAt ?? 0) - Date.now()) / 1000))
          loginNodes.push(h('div', { key: 'qr', className: 'dsm-doubao-signin-qr' },
            h('img', {
              className: 'dsm-doubao-signin-qr-img',
              src: login.imageDataUrl,
              alt: t('login.waiting').replace('%s', ''),
              width: 220,
              height: 220,
            }),
            h('p', { className: 'dsm-doubao-signin-qr-wait' }, t('login.waiting').replace('%s', String(left)))))
          loginNodes.push(h('div', { key: 'qr-bar', className: 'dsm-doubao-signin-bar' },
            h('div', { className: 'dsm-doubao-signin-bar-actions' },
              button('qr-cancel', t('login.cancel'), () => { void cancelLogin() }, 'outline'))))
        } else if (login.phase === 'starting') {
          loginNodes.push(h('p', { key: 'qr-starting', className: 'dsm-doubao-signin-hint' }, t('login.starting')))
        } else if (login.phase === 'success') {
          loginNodes.push(h('div', { key: 'qr-ok', className: 'dsm-doubao-signin-bar' },
            h('span', { className: 'dsm-doubao-signin-badge dsm-doubao-signin-badge-ok' }, `✓ ${t('login.success')}`),
            h('div', { className: 'dsm-doubao-signin-bar-actions' },
              button('qr-again', t('action.loginAgain'), () => { void startLogin() }, 'outline'))))
        } else {
          if (login.phase === 'error') {
            loginNodes.push(h('p', { key: 'qr-err', className: 'dsm-doubao-signin-error' }, `${t('login.failed')}：${login.error}`))
          }
          loginNodes.push(h('div', { key: 'qr-bar', className: 'dsm-doubao-signin-bar' },
            h('span', { className: 'dsm-doubao-signin-bar-status' },
              loggedIn ? `${t('login.loggedIn')}（${t('action.loginAgain')}）` : t('login.notLoggedIn')),
            h('div', { className: 'dsm-doubao-signin-bar-actions' },
              button('qr-start', loggedIn ? t('action.loginAgain') : t('action.login'), () => { void startLogin() }, 'primary'))))
        }
        accountsPanel.push(group('g-login', t('group.login'), loginNodes))
      }

      // 账号池健康
      const poolNodes = []
      const list = Array.isArray(status?.accounts) ? status.accounts : []
      if (list.length === 0) {
        poolNodes.push(h('p', { key: 'pool-empty', className: 'dsm-doubao-signin-hint' }, statusError ? t('error.fetch') : t('accounts.empty')))
      } else {
        const rows = []
        for (const account of list) {
          const health = account.health === null || account.health === undefined
            ? t('accounts.health.unknown')
            : account.health.ok === true ? t('accounts.health.ok') : `${t('accounts.health.bad')} (HTTP ${account.health.status})`
          const dotClass = account.health === null || account.health === undefined
            ? '' : account.health.ok === true ? ' dsm-doubao-signin-dot-ok' : ' dsm-doubao-signin-dot-bad'
          rows.push(h('li', { key: `acct-${account.id}`, className: 'dsm-doubao-signin-table-row' },
            h('span', { className: `dsm-doubao-signin-dot${dotClass}` }),
            h('span', { className: 'dsm-doubao-signin-table-name' }, `${account.label} (${account.id})`),
            h('span', { className: 'dsm-doubao-signin-table-meta' }, `${account.enabled ? '' : '· '}${health}`)))
        }
        poolNodes.push(h('ul', { key: 'pool-table', className: 'dsm-doubao-signin-table' }, ...rows))
        const lastRun = status?.lastRun ? new Date(status.lastRun).toLocaleString() : t('accounts.never')
        poolNodes.push(kv('pool-last', t('accounts.lastRun'), lastRun))
      }
      poolNodes.push(h('div', { key: 'pool-bar', className: 'dsm-doubao-signin-bar' },
        h('div', { className: 'dsm-doubao-signin-bar-actions' },
          button('pool-probe', probing ? t('action.checking') : t('action.checkNow'), probeNow, 'outline', probing))))
      accountsPanel.push(group('g-accounts', t('group.accounts'), poolNodes))

      // 每日自动签到
      const checkinNodes = []
      if (settingsScope !== undefined) {
        checkinNodes.push(h('div', { key: 'ck-fields', className: 'dsm-doubao-signin-fields' },
          field('ck1', t('checkin.enabled'), select([
            ['off', t('checkin.enabled.off')],
            ['on', t('checkin.enabled.on')],
          ], value.checkinEnabled === true ? 'on' : 'off', next => setField('checkinEnabled', next === 'on'))),
          field('ck2', t('checkin.time'), h('input', {
            className: 'dsm-doubao-signin-input',
            type: 'time',
            value: `${String(value.checkinHour ?? 8).padStart(2, '0')}:${String(value.checkinMinute ?? 10).padStart(2, '0')}`,
            onChange: event => {
              const [hour, minute] = String(event.target.value ?? '').split(':')
              const h2 = Number(hour)
              const m2 = Number(minute)
              if (Number.isInteger(h2) && h2 >= 0 && h2 <= 23) setField('checkinHour', h2)
              if (Number.isInteger(m2) && m2 >= 0 && m2 <= 59) setField('checkinMinute', m2)
            },
          }))))
      }

      const checkin = status?.checkin
      if (status === null || status === undefined) {
        checkinNodes.push(h('p', { key: 'ck-unknown', className: 'dsm-doubao-signin-hint' }, statusError ? t('error.fetch') : t('cli.unknown')))
      } else if (checkin === undefined || checkin === null) {
        checkinNodes.push(h('p', { key: 'ck-unknown', className: 'dsm-doubao-signin-hint' }, t('cli.unknown')))
      } else {
        checkinNodes.push(kv('ck3', t('checkin.next'),
          typeof checkin.nextRunAt === 'string' && checkin.nextRunAt !== ''
            ? new Date(checkin.nextRunAt).toLocaleString()
            : t('checkin.next.none')))
        checkinNodes.push(kv('ck4', t('checkin.last'),
          typeof checkin.lastRun === 'string' && checkin.lastRun !== ''
            ? `${new Date(checkin.lastRun).toLocaleString()}${checkin.lastDay ? `（${checkin.lastDay}）` : ''}`
            : t('checkin.last.none')))
        checkinNodes.push(kv('ck5', t('checkin.result'),
          `${t('checkin.result.value').replace('%s', String(checkin.signedCount ?? 0))}${Number(checkin.skipped ?? 0) > 0 ? `，${t('checkin.result.skipped').replace('%s', String(checkin.skipped))}` : ''}`))
        const perAccount = Array.isArray(checkin.accounts) ? checkin.accounts : []
        if (perAccount.length > 0) {
          const rows = []
          for (const entry of perAccount) {
            const state = entry.ok === true
              ? t('checkin.account.ok')
              : entry.ok === false
                ? `${t('checkin.account.fail')}${entry.code !== null && entry.code !== undefined && entry.code !== 0 ? `（业务码 ${entry.code}）` : ''}`
                : t('checkin.account.pending')
            const dotClass = entry.ok === true ? ' dsm-doubao-signin-dot-ok' : entry.ok === false ? ' dsm-doubao-signin-dot-bad' : ''
            rows.push(h('li', { key: `ck-${entry.id}`, className: 'dsm-doubao-signin-table-row' },
              h('span', { className: `dsm-doubao-signin-dot${dotClass}` }),
              h('span', { className: 'dsm-doubao-signin-table-name' }, `${entry.id}：${state}`),
              h('span', { className: 'dsm-doubao-signin-table-meta' }, entry.day ? String(entry.day) : '')))
          }
          checkinNodes.push(h('ul', { key: 'ck-table', className: 'dsm-doubao-signin-table' }, ...rows))
        }
        checkinNodes.push(h('div', { key: 'ck-bar', className: 'dsm-doubao-signin-bar' },
          h('div', { className: 'dsm-doubao-signin-bar-actions' },
            button('ck-run', checkingIn ? t('action.checkingIn') : t('action.checkin'), checkinNow, 'outline', checkingIn))))
        checkinNodes.push(h('p', { key: 'ck-hint', className: 'dsm-doubao-signin-hint' }, t('checkin.hint')))
      }
      accountsPanel.push(group('g-checkin', t('group.checkin'), checkinNodes))

      /* ---- 面板五：诊断（留痕 + 说明）---- */
      const diagnostics = []
      const traceNodes = []
      if (status === null || status === undefined) {
        traceNodes.push(h('p', { key: 'trace-unknown', className: 'dsm-doubao-signin-hint' }, statusError ? t('error.fetch') : t('cli.unknown')))
      } else {
        const mode = String(status.conversationMode ?? 'single') === 'per-chat' ? 'perChat' : 'single'
        const bound = Number(status.conversations?.count ?? 0)
        const persisted = status.conversations?.persisted === true
        traceNodes.push(kv('trace-1', t('trace.mode'), t(`trace.mode.${mode}`), true))
        traceNodes.push(kv('trace-2', t('trace.bound'), t('trace.bound.value').replace('%s', String(bound))))
        traceNodes.push(kv('trace-3', t('trace.persisted'),
          persisted ? t('trace.persisted.yes').replace('%s', String(status.conversations?.file ?? '')) : t('trace.persisted.no'), true))
        traceNodes.push(h('p', { key: 'trace-hint', className: 'dsm-doubao-signin-hint' }, t('trace.hint')))
      }
      diagnostics.push(group('g-trace', t('group.trace'), traceNodes))

      diagnostics.push(group('g-hints', t('group.hint'), [
        h('p', { key: 'hint-cli', className: 'dsm-doubao-signin-hint' }, t('hint.cli')),
        h('p', { key: 'hint-keepalive', className: 'dsm-doubao-signin-hint' }, t('hint.keepalive')),
      ]))

      /* ---- tab 栏 + 面板 + 底部保存条 ---- */
      const tabs = [
        ['overview', t('tab.overview')],
        ['gateway', t('tab.gateway')],
        ['models', t('tab.models')],
        ['accounts', t('tab.accounts')],
        ['diagnostics', t('tab.diagnostics')],
      ]
      const tabBar = h('div', { key: 'tabs', className: 'dsm-doubao-signin-panels', role: 'tablist' },
        ...tabs.map(([id, label]) => h('button', {
          key: `tab-${id}`,
          type: 'button',
          role: 'tab',
          'aria-selected': tab === id,
          className: `dsm-doubao-signin-panel-tab${tab === id ? ' dsm-doubao-signin-panel-tab-active' : ''}`,
          onClick: () => setTab(id),
        }, label)))

      const saveBar = settingsScope === undefined ? null : h('div', { key: 'savebar', className: 'dsm-doubao-signin-bar' },
        h('span', { className: 'dsm-doubao-signin-bar-status' }, dirty ? t('hint.saveUnsaved') : ''),
        h('div', { className: 'dsm-doubao-signin-bar-actions' },
          button('save', savedAt > 0 && !dirty ? t('action.saved') : t('action.save'), save, 'primary', !dirty)))

      return h('div', { className: 'dsm-doubao-signin-card' },
        header,
        tabBar,
        panel('overview', overview),
        panel('gateway', gateway),
        panel('models', modelsPanel),
        panel('accounts', accountsPanel),
        panel('diagnostics', diagnostics),
        saveBar)
    }

    /** 设置页导航图标（宿主 settings.section.icon 槽渲染）。 */
    function PluginIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 16
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        style: { borderRadius: '4px', display: 'block', opacity: props?.active === false ? 0.75 : 1 },
      }, h('path', {
        d: 'M12 2.5c-2.2 3.4-5.3 5-9 5 1.9 4.6 4.6 8.1 9 14 4.4-5.9 7.1-9.4 9-14-3.7 0-6.8-1.6-9-5z',
        fill: 'currentColor', opacity: 0.9,
      }))
    }

    function apply(ctx) {
      try {
        ctx.effect(() => ctx.locale.register(LOCALE_NAMESPACE, COPY), 'dsh-doubao-signin: settings copy')
        const t = ctx.locale.bind(LOCALE_NAMESPACE)
        let settingsScope
        let liveDisposers = []

        const registerSlots = () => {
          const disposers = []
          disposers.push(ctx.slots.inject('settings.section', () => {
            const inner = []
            inner.push(ctx.slots.register({
              name: 'settings.section',
              id: SECTION_ID,
              order: 36,
              label: () => t('nav.panel'),
              locale: LOCALE_NAMESPACE,
              inject: () => ({ t, settingsScope, surface: 'settings' }),
            }, Doubaocard))
            try {
              const iconInject = ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
                name: 'settings.section.icon',
                id: SECTION_ID,
                locale: LOCALE_NAMESPACE,
              }, iconProps => PluginIcon(iconProps)))
              if (typeof iconInject === 'function') inner.push(iconInject)
            } catch (error) {
              console.error('[dsh-doubao-signin] settings nav icon failed (page unaffected):', error)
            }
            return () => {
              for (const dispose of inner) try { dispose() } catch {}
            }
          }))
          return disposers
        }

        const rebind = () => {
          for (const dispose of liveDisposers) try { dispose() } catch {}
          liveDisposers = []
          liveDisposers = registerSlots()
        }

        /**
         * 绑定 Host 的配置表单服务。
         *
         * 两个坑都在这里踩过：
         *  1. 只 `ctx.get('configForms')` 探一次。Host 的 configForms 是客户端
         *     插件注册的服务，卡片 apply 时它未必已就绪——拿到 undefined 就再也
         *     不重试，于是「网关选项」「上游后端」两块只剩标题、没有任何输入框
         *     （settingsScope 恒为 undefined，走的是只读降级分支）。
         *  2. 即便拿到服务，命名空间也要等 Host 真正开始 serve 才可读；渲染器按
         *     entry 对象身份缓存 inject 结果，所以晚绑定时必须**先卸载旧注册再
         *     重新注册**，否则页面停在首帧的只读形态。
         *
         * 因此：先用 `ctx.inject(['configForms'], …)` 等这个服务本身出现，再用
         * `whileServed` 跟随命名空间的 served 边沿；两者都就绪前保持只读降级，
         * 让卡片至少能显示状态与按钮。
         */
        const bindForms = (forms) => {
          if (forms === undefined || typeof forms.whileServed !== 'function') {
            // 老宿主（0.1.5 线）只有 settingsScope，没有 configForms
            const legacy = forms?.get?.(NS_CANDIDATES[0]) ?? ctx.get?.('settingsScope')
            if (legacy !== undefined) settingsScope = legacy
            rebind()
            return
          }
          ctx.effect(() => forms.whileServed(NS_CANDIDATES, served => {
            const ns = NS_CANDIDATES.find(candidate => served.has(candidate)) ?? [...served].find(entry => /doubao-signin/i.test(entry))
            settingsScope = ns === undefined ? undefined : forms.get(ns)
            rebind()
            return () => {
              for (const dispose of liveDisposers) try { dispose() } catch {}
              liveDisposers = []
            }
          }), 'dsh-doubao-signin: settings namespace binding')
          rebind()
        }

        const inlineForms = ctx.get?.('configForms')
        if (inlineForms !== undefined) {
          bindForms(inlineForms)
        } else {
          // 服务尚未出现：先按只读形态渲染（卡片至少可用），等它就绪后重建插槽
          rebind()
          if (typeof ctx.inject === 'function') {
            ctx.inject(['configForms'], formsCtx => {
              bindForms(formsCtx?.configForms ?? formsCtx?.get?.('configForms'))
            })
          }
        }
      } catch (error) {
        console.error('[dsh-doubao-signin] client card failed to load (host provider unaffected):', error)
      }
    }

    const exports = { name: 'dsh-doubao-signin-client', inject: ['slots', 'locale'], apply }
    return exports
  },
})
