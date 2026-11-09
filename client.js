/**
 * dsh-plugin-session-cleaner — Client half.
 *
 * Adds a trash action to each Session row, a "Session cleaner" global panel at
 * the sidebar (its center-column page lists every deletable Session), and one
 * confirmation dialog for both entries. Only the dialog's confirmed POST
 * deletes anything, and the Host refuses every session the running Harness
 * still owns.
 *
 * The page and the dialog copy the shipped Harness page/dialog composition (the
 * page centers a max-width column; the dialog is a mask over the page plus a
 * panel on --dsw-alias-bg-layer-2 with --dsw-radius-panel corners) so both
 * follow the light and dark themes. No native <select> is used: a popup would
 * paint OS colors and square corners.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-session-cleaner',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState, useSyncExternalStore } = React
    // Platform tooltip: its bubble is themed (dark surface in light and dark
    // themes alike), unlike a native title window. Optional so an older Host,
    // whose seed predates it, still loads the plugin.
    let Tooltip
    try {
      Tooltip = require('@deepseek-ai/dsh-client-ui-primitives').Tooltip
    } catch {
      Tooltip = undefined
    }

    const NS = 'session-cleaner'
    const PANEL_ID = 'session-cleaner'
    const ROUTE = '/__dsh-session-cleaner/delete'
    const CATALOG_ROUTE = '/__dsh-session-cleaner/catalog'
    const WORKSPACE_ROUTE = '/__dsh-session-cleaner/workspace'
    const SUBAGENT_ROUTE = '/__dsh-session-cleaner/subagent'
    const CATALOG_ID = '00000000-0000-0000-0000-000000000000'
    const CONFIRM_HEADER = 'x-dsh-session-cleaner'
    const STYLE_ID = 'dsh-plugin-session-cleaner/dialog.css'

    const CSS = `
.dsc-root{pointer-events:auto;position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:max(24px,var(--dsh-frame-overlay-top,24px)) 24px}
.dsc-mask{position:absolute;inset:var(--dsh-frame-chrome-top,0px) 0 0;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.5));backdrop-filter:var(--dsw-mask-blur,blur(8px))}
.dsc-dialog{box-sizing:border-box;position:relative;z-index:1;display:flex;flex-direction:column;gap:20px;width:min(440px,100%);max-height:calc(100dvh - 48px);padding:0 0 24px;overflow:hidden;border:0;outline:none;border-radius:var(--dsw-radius-panel,28px);background:var(--dsw-alias-bg-layer-2,#fff);box-shadow:var(--dsw-elevation-prominent,0 12px 32px rgba(0,0,0,.28));color:var(--dsw-alias-label-primary,inherit);font-size:14px;line-height:22px}
.dsc-content{display:flex;flex-direction:column;width:100%;min-height:0;overflow-y:auto;overscroll-behavior:contain}
.dsc-header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:22px 14px 12px 24px;flex:none}
.dsc-title{margin:0;font-size:16px;line-height:24px;font-weight:500;color:var(--dsw-alias-label-primary,inherit)}
.dsc-close{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:none;border-radius:var(--dsw-radius-sm,8px);background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary,#666)}
.dsc-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
.dsc-description{margin:0;padding:0 24px;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary,inherit)}
.dsc-body{display:flex;flex-direction:column;min-width:0;margin-top:20px;padding:0 24px}
.dsc-warning{display:flex;align-items:flex-start;gap:10px;color:var(--dsw-alias-label-secondary,#777);font-size:14px;line-height:22px}
.dsc-warning-icon{flex:none;margin-top:2px;color:var(--dsw-alias-state-error-primary,#f25a5a)}
.dsc-warning p{margin:0}
.dsc-list{box-sizing:border-box;display:flex;flex-direction:column;gap:2px;margin-top:16px;padding:4px;max-height:232px;overflow-y:auto;overscroll-behavior:contain;border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.2));border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-1,#fff)}
.dsc-option{box-sizing:border-box;display:flex;align-items:flex-start;gap:10px;width:100%;padding:8px;border:none;border-radius:var(--dsw-radius-sm,8px);background:transparent;cursor:pointer;text-align:left;color:var(--dsw-alias-label-primary,inherit);font-family:inherit;font-size:14px;line-height:22px}
.dsc-option:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dsc-option[aria-selected="true"]{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dsc-option[data-static="true"]{cursor:default}
.dsc-radio{box-sizing:border-box;flex:none;display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;margin-top:2px;border-radius:50%;border:1.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.35))}
.dsc-option[aria-selected="true"] .dsc-radio{border-color:var(--dsw-alias-state-business-primary,#4176e6)}
.dsc-option[aria-selected="true"] .dsc-radio::after{content:"";width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-business-primary,#4176e6)}
.dsc-option-text{display:flex;flex-direction:column;min-width:0;gap:1px;flex:1}
.dsc-option-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary,inherit)}
.dsc-option-id{overflow-wrap:anywhere;white-space:normal;font-family:var(--dsw-font-family-code,ui-monospace,SFMono-Regular,Consolas,monospace);font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#999)}
.dsc-option-badge{flex:none;margin-inline-start:auto;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#888)}
.dsc-error{margin:12px 0 0;color:var(--dsw-alias-state-error-primary,#f25a5a);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dsc-warning-list{margin:8px 0 0;padding-left:18px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary,inherit)}
.dsc-warning-list li{overflow-wrap:anywhere}
.dsc-footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:0 24px;flex:none}
.dsc-button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:36px;padding:0 14px;border:none;border-radius:var(--dsw-radius-md,12px);background:transparent;cursor:pointer;font-family:inherit;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary,inherit)}
.dsc-button:disabled{cursor:not-allowed;opacity:.4}
.dsc-button-outline{border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.3))}
.dsc-button-outline:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dsc-button-danger:not(:disabled){color:var(--dsw-alias-state-error-primary,#f25a5a)}
.dsc-action{min-width:72px}
.dsc-confirm{min-width:136px}
.dsc-row-action{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;flex:none;padding:0;border:none;border-radius:var(--dsw-radius-xs,4px);background:transparent;cursor:pointer;color:var(--dsw-alias-label-tertiary,#999)}
.dsc-row-action:hover{color:var(--dsw-alias-label-secondary,#666)}
.dsc-page{box-sizing:border-box;height:100%;overflow:auto;display:flex;flex-direction:column;align-items:center;gap:28px;padding:0 clamp(24px,4vw,48px) 48px;color:var(--dsw-alias-label-primary,inherit)}
.dsc-page>*{box-sizing:border-box;width:100%;max-width:960px}
.dsc-page-head{flex:none;display:flex;flex-direction:column;gap:4px;padding-top:28px}
[data-platform=darwin] .dsc-page-head{padding-top:calc(28px + var(--dsh-frame-top-clearance,0px))}
.dsc-page-title{margin:0;font-size:20px;line-height:28px;font-weight:500}
.dsc-page-body{display:flex;flex-direction:column;gap:16px;min-width:0}
.dsc-page-note{margin:0;display:flex;align-items:flex-start;gap:8px;padding:10px 12px;border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-state-warn-tertiary,#fff8e6);color:var(--dsw-alias-label-secondary,#666);font-size:12.5px;line-height:18px}
.dsc-page-note-icon{flex:none;margin-top:1px;color:var(--dsw-alias-state-warn-primary,#e6a23c)}
.dsc-page-note p{margin:0}
.dsc-page-section{display:flex;flex-direction:column;gap:4px;min-width:0}
.dsc-page-section-head{display:flex;align-items:baseline;gap:10px}
.dsc-page-section-title{margin:0;font-size:14px;line-height:20px;font-weight:500}
.dsc-page-section-count{color:var(--dsw-alias-label-secondary,#666);font-size:12px;line-height:18px}
.dsc-page-list{display:flex;flex-direction:column;margin:0;padding:0;list-style:none}
.dsc-page-row{display:flex;align-items:center;gap:16px;padding:12px 2px;border-bottom:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.2))}
.dsc-page-row:last-child{border-bottom:0}
.dsc-page-row-text{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}
.dsc-page-row-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;line-height:20px;font-weight:500}
.dsc-page-row-id{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary,#999);font-family:var(--dsw-font-family-code,ui-monospace,SFMono-Regular,Consolas,monospace);font-size:11.5px;line-height:16px}
.dsc-page-running{flex:none;padding:0 6px;border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-3,#f2f2f2);color:var(--dsw-alias-label-secondary,#666);font-size:11px;line-height:18px}
.dsc-page-delete{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;flex:none;padding:0;border:none;border-radius:var(--dsw-radius-sm,8px);background:transparent;cursor:pointer;color:var(--dsw-alias-state-error-primary,#f25a5a)}
.dsc-page-delete:hover{background:var(--dsw-alias-interactive-bg-hover-danger,var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12)))}
.dsc-button:focus-visible,.dsc-close:focus-visible,.dsc-option:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4176e6));outline-offset:2px}
.dsc-row-action:focus-visible,.dsc-page-delete:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4176e6));outline-offset:0}
`

    const ZH = {
      'row.delete': '删除会话',
      'panel.title': '会话清理',
      'page.listTitle': '可删除的会话',
      'page.count': '共 {count} 个',
      'page.sessions': '普通会话',
      'page.subagents': '子代理会话',
      'page.workspaces': '工作区',
      'page.empty': '暂无记录',
      'page.loadError': '无法加载分类，请重试。',
      'dialog.workspaceTitle': '移除工作区',
      'dialog.workspaceWarning': '只移除工作区记录，保留磁盘文件和会话。',
      'dialog.workspaceConfirm': '移除工作区',
      'dialog.subagentWarning': '将删除此子代理及其子代理会话和会话中的专属描述，无法撤销。已打开的会话将在下次启动时删除。',
      'dialog.subagentResult': '子代理清理结果：',
      'dialog.subagentQueued': '有 {count} 个会话已安排在下次启动时删除。',
      'dialog.title': '删除会话',
      'dialog.warning': '删除无法撤销。已打开的会话将在下次启动时删除；运行中的会话请先停止任务。',
      'dialog.untitled': '未命名会话',
      'dialog.running': '运行中',
      'dialog.cancel': '取消',
      'dialog.confirm': '永久删除',
      'dialog.busy': '正在删除…',
      'dialog.queue': '下次启动DeepSeek Harness时删除',
      'dialog.queued': '已加入待删除队列。下次启动 Harness 时，会自动删除该会话的日志、缓存记录和工作区引用。',
      'dialog.warningTitle': '会话已删除，但以下善后记录未清理：',
      'dialog.close': '关闭',
      'error.running': '该会话正在运行，请先停止任务。本插件不会自动停止任务。',
      'error.held': '该会话已被本次运行打开过。Harness 运行时会一直持有它直到退出，因此无法在运行中删除。可以点下方按钮安排到下次启动时删除。',
      'error.owned': '另一个 Harness 运行时正在写这个会话，请关闭那个运行时后重试。',
      'error.notFound': '会话不存在或已被删除。',
      'error.changed': '会话在删除过程中发生变化，请关闭对话框后重试。',
      'error.unsupported': '当前会话存储不支持安全删除。',
      'error.filesBusy': 'Windows 拒绝删除会话文件；请关闭占用它的程序后重试。',
      'error.files': '会话文件删除失败，未清理缓存和记账。',
      'error.unavailable': '当前配置下会话持久化不可用。',
      'error.generic': '删除失败。',
    }
    const EN = {
      'row.delete': 'Delete session',
      'panel.title': 'Session cleaner',
      'page.listTitle': 'Sessions you can delete',
      'page.count': '{count} total',
      'page.sessions': 'Sessions',
      'page.subagents': 'Subagent sessions',
      'page.workspaces': 'Workspaces',
      'page.empty': 'No entries',
      'page.loadError': 'Could not load categories. Please retry.',
      'dialog.workspaceTitle': 'Remove workspace',
      'dialog.workspaceWarning': 'Only the workspace registration is removed. Files and sessions are kept.',
      'dialog.workspaceConfirm': 'Remove workspace',
      'dialog.subagentWarning': 'This deletes this subagent and its descendant sessions and their embedded descriptors. Opened sessions are deleted on next start. This cannot be undone.',
      'dialog.subagentResult': 'Subagent cleanup result:',
      'dialog.subagentQueued': '{count} sessions are queued for deletion on next start.',
      'dialog.title': 'Delete session',
      'dialog.warning': 'Deletion cannot be undone. Opened sessions are deleted on next start; stop running tasks first.',
      'dialog.untitled': 'Untitled session',
      'dialog.running': 'Running',
      'dialog.cancel': 'Cancel',
      'dialog.confirm': 'Permanently delete',
      'dialog.busy': 'Deleting…',
      'dialog.queue': 'Delete on next DeepSeek Harness start',
      'dialog.queued': 'Queued for deletion. The session log, cache record and workspace references will be deleted automatically the next time Harness starts.',
      'dialog.warningTitle': 'The session was deleted, but these cleanup records failed:',
      'dialog.close': 'Close',
      'error.running': 'This session is running. Stop its task first; the cleaner never stops work.',
      'error.held': 'This session was opened during the current run, and Harness keeps it live until it exits, so it cannot be deleted now. Use the button below to arrange deletion at the next start.',
      'error.owned': 'Another Harness runtime is writing this session; close that runtime and retry.',
      'error.notFound': 'The session does not exist or is already deleted.',
      'error.changed': 'The session changed while it was being deleted; close the dialog and retry.',
      'error.unsupported': 'The current session store cannot delete safely.',
      'error.filesBusy': 'Windows refused to remove the session files; close anything using them and retry.',
      'error.files': 'The session files could not be removed; caches and bookkeeping were left untouched.',
      'error.unavailable': 'Session persistence is unavailable in this profile.',
      'error.generic': 'The deletion failed.',
    }
    const CODE_KEYS = {
      'running': 'error.running',
      'held': 'error.held',
      'owned': 'error.owned',
      'not-found': 'error.notFound',
      'lineage': 'error.lineage',
      'children': 'error.children',
      'changed': 'error.changed',
      'unsupported': 'error.unsupported',
      'files-busy': 'error.filesBusy',
      'files': 'error.files',
      'unavailable': 'error.unavailable',
    }

    let locale
    let sessionsService
    let request = null
    let token = 0
    const listeners = new Set()

    function notify() {
      for (const listener of [...listeners]) listener()
    }
    function subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
    function getRequest() {
      return request
    }
    function openDialog(next) {
      token += 1
      request = { ...next, token }
      notify()
    }
    function closeDialog() {
      request = null
      notify()
    }

    function t(key, params) {
      let text
      if (locale !== undefined && locale !== null && typeof locale.translate === 'function') {
        try {
          text = locale.translate(NS, key, params)
        } catch {
          text = undefined
        }
      }
      if (typeof text !== 'string' || text === key) {
        const language = typeof navigator !== 'undefined' && typeof navigator.language === 'string' ? navigator.language : 'en'
        const dict = language.toLowerCase().startsWith('zh') ? ZH : EN
        text = dict[key] ?? EN[key] ?? key
      }
      if (params !== undefined && typeof text === 'string') {
        text = text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
      }
      return text
    }

    /** Inject this module's stylesheet once per page; the effect removes it on unload. */
    function ensureStyles() {
      if (typeof document === 'undefined') return () => {}
      if (document.querySelector('style[data-plugin-css=' + JSON.stringify(STYLE_ID) + ']') !== null) return () => {}
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-plugin-session-cleaner'
      tag.dataset.pluginCss = STYLE_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => {
        tag.remove()
      }
    }

    const EMPTY_SESSIONS = Object.freeze({ ids: [], byId: {} })
    const useNoSessions = () => EMPTY_SESSIONS

    /**
     * DSH's own 16-unit `trash-outline` glyph, the geometry the shipped icon set
     * draws. Reusing it (and the built-in weights) keeps this sidebar row from
     * reading heavier than the panel rows beside it.
     */
    const TRASH_GLYPH = [
      'M1.28149 3.88831H14.7187',
      'M5.41602 3.88833V2.47962C5.41602 2.29282 5.52492 2.11366 5.71876 1.98157C5.9126 1.84948 6.17551 1.77527 6.44964 1.77527H9.55053C9.82466 1.77527 10.0876 1.84948 10.2814 1.98157C10.4753 2.11366 10.5842 2.29282 10.5842 2.47962V3.88833',
      'M2.57349 3.88831L3.19366 13.2943C3.21937 13.5502 3.33952 13.7872 3.53065 13.9593C3.72178 14.1313 3.97016 14.2259 4.22729 14.2246H11.7728C12.0299 14.2259 12.2783 14.1313 12.4694 13.9593C12.6605 13.7872 12.7807 13.5502 12.8064 13.2943L13.4266 3.88831',
      'M6.44946 6.98926V11.1238',
      'M9.55054 6.98926V11.1238',
    ]
    /** The built-in icon set's regular (16px) and medium (smaller) stroke widths. */
    const TRASH_STROKE_REGULAR = 1
    const TRASH_STROKE_MEDIUM = 1.3

    function TrashIcon({ size = 14 }) {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: size >= 16 ? TRASH_STROKE_REGULAR : TRASH_STROKE_MEDIUM,
          'aria-hidden': true,
          style: { display: 'block', pointerEvents: 'none' },
        },
        TRASH_GLYPH.map((d, index) => h('path', { key: index, d })),
      )
    }

    function CloseIcon() {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: 14,
          height: 14,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('path', { d: 'M3.5 3.5l9 9' }),
        h('path', { d: 'M12.5 3.5l-9 9' }),
      )
    }

    function WarningIcon() {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: 16,
          height: 16,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('path', { d: 'M8 2.2L1.6 13.2h12.8L8 2.2z' }),
        h('path', { d: 'M8 6.2v3.1' }),
        h('path', { d: 'M8 11.3v.1' }),
      )
    }

    /** One session-row cell: clicking it must stay inside the hover strip (the owner stops propagation). */
    function DeleteSessionRowAction(props) {
      const sessionId = props.sessionId
      const title = props.displayTitle || t('dialog.untitled')
      const button = h(
        'button',
        {
          type: 'button',
          className: 'dsc-row-action',
          'aria-label': t('row.delete'),
          onClick: () => {
            if (typeof sessionId !== 'string' || sessionId === '') return
            openDialog({ mode: 'single', sessionId, title })
          },
        },
        h(TrashIcon, { size: 14 }),
      )
      // A native `title` would open an OS-painted white window on top of the
      // sidebar; the platform tooltip follows both themes.
      return typeof Tooltip === 'function'
        ? h(Tooltip, { label: () => t('row.delete'), side: 'left', delayMs: 500, portal: true }, button)
        : button
    }

    /** Glyph of the global panel row; the sidebar owns the row button and its label. */
    function SessionCleanerPanelIcon({ size = 16 }) {
      return h(TrashIcon, { size })
    }

    /**
     * Center-column panel: every Session the cleaner may delete, each row opening
     * the same confirmation dialog the Session rows and the sidebar use.
     */
    function SessionCleanerPage(props) {
      const useSessionsHook = typeof props.useSessions === 'function' ? props.useSessions : useNoSessions
      const snapshot = useSessionsHook(state => state) ?? EMPTY_SESSIONS
      const [catalog, setCatalog] = useState(null)
      const [loadError, setLoadError] = useState(false)
      const [revision, setRevision] = useState(0)
      useEffect(() => {
        let active = true
        const refresh = () => setRevision(value => value + 1)
        window.addEventListener('dsc-catalog-changed', refresh)
        fetch(CATALOG_ROUTE, {
          method: 'POST', headers: { 'content-type': 'application/json', [CONFIRM_HEADER]: 'confirmed' },
          body: JSON.stringify({ sessionId: CATALOG_ID, confirm: CATALOG_ID }),
        }).then(response => { if (!response.ok) throw new Error('catalog'); return response.json() })
          .then(value => { if (active) { setCatalog(value); setLoadError(false) } })
          .catch(() => { if (active) { setCatalog(null); setLoadError(true) } })
        return () => { active = false; window.removeEventListener('dsc-catalog-changed', refresh) }
      }, [revision])
      const childIds = new Set(catalog?.subagents.map(item => item.id) ?? [])
      const ordinary = []
      for (const id of snapshot.ids ?? []) {
        const row = snapshot.byId?.[id]
        if (row && !childIds.has(id)) ordinary.push({ id, title: row.displayTitle || row.title || t('dialog.untitled'), running: row.running === true })
      }
      const children = (catalog?.subagents ?? []).map(item => {
        const row = snapshot.byId?.[item.id]
        return { id: item.id, title: row?.displayTitle || row?.title || t('dialog.untitled'), running: row?.running === true }
      })
      const workspaces = (catalog?.workspaces ?? []).map(item => ({ ...item, title: item.title || item.path, detail: item.path }))
      const section = (label, rows, workspace = false, subagent = false) => h('section', { className: 'dsc-page-section', key: label },
        h('div', { className: 'dsc-page-section-head' }, h('h2', { className: 'dsc-page-section-title' }, t(label)), h('span', { className: 'dsc-page-section-count' }, t('page.count', { count: rows.length }))),
        rows.length === 0 ? h('p', { className: 'dsc-page-row-id' }, t('page.empty')) : h('ul', { className: 'dsc-page-list' }, rows.map(row => h('li', { key: row.id, className: 'dsc-page-row' },
          h('div', { className: 'dsc-page-row-text' }, h('span', { className: 'dsc-page-row-title' }, row.title), h('span', { className: 'dsc-page-row-id', title: row.detail || row.id }, row.detail || row.id)),
          row.running ? h('span', { className: 'dsc-page-running' }, t('dialog.running')) : null,
          h('button', { type: 'button', className: 'dsc-page-delete', title: t(workspace ? 'dialog.workspaceTitle' : 'row.delete'), 'aria-label': t(workspace ? 'dialog.workspaceTitle' : 'row.delete'), onClick: () => openDialog({ mode: workspace ? 'workspace' : subagent ? 'subagent' : 'single', sessionId: row.id, title: row.title, detail: row.detail }) }, h(TrashIcon, { size: 14 }))
        )))
      )
      return h('div', { className: 'dsc-page' }, h('div', { className: 'dsc-page-head' }, h('h1', { className: 'dsc-page-title' }, t('panel.title'))),
        h('div', { className: 'dsc-page-body' }, loadError ? h('p', { className: 'dsc-error', role: 'alert' }, t('page.loadError')) : catalog === null ? null : [section('page.sessions', ordinary), section('page.subagents', children, false, true), section('page.workspaces', workspaces, true)]))
    }

    function Modal({ title, titleId, closeLabel, onClose, children, footer }) {
      const dialogRef = useRef(null)
      const restoreRef = useRef(null)
      useEffect(() => {
        restoreRef.current = typeof document === 'undefined' ? null : document.activeElement
        const dialog = dialogRef.current
        try {
          dialog?.focus?.()
        } catch {}
        const onKeyDown = event => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            onClose()
            return
          }
          if (event.key !== 'Tab' || dialog === null) return
          const focusables = dialog.querySelectorAll(
            'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex]:not([tabindex="-1"])',
          )
          if (focusables.length === 0) {
            event.preventDefault()
            dialog.focus()
            return
          }
          const first = focusables[0]
          const last = focusables[focusables.length - 1]
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
          }
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => {
          document.removeEventListener('keydown', onKeyDown, true)
          try {
            restoreRef.current?.focus?.()
          } catch {}
        }
      }, [onClose])
      return h(
        'div',
        { className: 'dsc-root' },
        h('div', { className: 'dsc-mask', 'aria-hidden': true, onMouseDown: onClose }),
        h(
          'div',
          {
            ref: dialogRef,
            className: 'dsc-dialog',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': titleId,
            tabIndex: -1,
          },
          h(
            'div',
            { className: 'dsc-content' },
            h(
              'div',
              { className: 'dsc-header' },
              h('h2', { className: 'dsc-title', id: titleId }, title),
              h('button', { type: 'button', className: 'dsc-close', title: closeLabel, 'aria-label': closeLabel, onClick: onClose }, h(CloseIcon)),
            ),
            children,
          ),
          footer === undefined || footer === null ? null : h('div', { className: 'dsc-footer' }, footer),
        ),
      )
    }

    function SessionCleanerDialogBody({ openRequest, useSessions }) {
      const useSessionsHook = typeof useSessions === 'function' ? useSessions : useNoSessions
      const snapshot = useSessionsHook(state => state) ?? EMPTY_SESSIONS
      const target = { sessionId: openRequest.sessionId, title: openRequest.title }
      const workspace = openRequest.mode === 'workspace'
      const subagent = openRequest.mode === 'subagent'
      const [busy, setBusy] = useState(false)
      const [errorText, setErrorText] = useState(null)
      const [warnings, setWarnings] = useState(null)
      const [finished, setFinished] = useState(false)
      const [queued, setQueued] = useState(false)
      const submitting = useRef(false)
      const titleId = `dsc-title-${openRequest.token}`

      const selectedId = target.sessionId ?? ''
      const selectedRow = selectedId === '' ? undefined : snapshot.byId?.[selectedId]
      const title = target.title || selectedRow?.displayTitle || t('dialog.untitled')
      const running = !workspace && selectedRow?.running === true

      const close = useCallback(() => {
        if (submitting.current) return
        closeDialog()
      }, [])

      const refreshList = useCallback(id => {
        try {
          sessionsService?.handleSessionRemoved?.(id)
        } catch {
          // The Host's api-session/removed event still reaches the page; this is a local fast path.
        }
        try {
          const pending = sessionsService?.refresh?.()
          if (pending !== undefined && pending !== null && typeof pending.catch === 'function') pending.catch(() => {})
        } catch {
          // Interface refresh is best-effort; the session is already gone from disk.
        }
      }, [])

      const confirm = async () => {
        if (submitting.current || selectedId === '' || running) return
        submitting.current = true
        setBusy(true)
        setErrorText(null)
        try {
          const response = await fetch(workspace ? WORKSPACE_ROUTE : subagent ? SUBAGENT_ROUTE : ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json', [CONFIRM_HEADER]: 'confirmed' },
            body: JSON.stringify({ sessionId: selectedId, confirm: selectedId }),
          })
          let payload = null
          try {
            payload = await response.json()
          } catch {
            payload = null
          }
          if (response.ok && payload !== null && payload.ok === true) {
            setFinished(true)
            window.dispatchEvent(new Event('dsc-catalog-changed'))
            if (workspace) { closeDialog(); return }
            if (subagent) {
              refreshList(selectedId)
              const resultWarnings = Array.isArray(payload.warnings) ? [...payload.warnings] : []
              if (payload.queuedCount > 0) resultWarnings.unshift(t('dialog.subagentQueued', { count: payload.queuedCount }))
              if (resultWarnings.length) setWarnings(resultWarnings)
              else closeDialog()
              return
            }
            if (payload.queued === true) {
              setQueued(true)
              return
            }
            refreshList(selectedId)
            if (Array.isArray(payload.warnings) && payload.warnings.length > 0) {
              setWarnings(payload.warnings)
              setBusy(false)
            } else {
              closeDialog()
            }
            return
          }
          const code = payload !== null && typeof payload.code === 'string' ? payload.code : null
          const mapped = code === null ? undefined : CODE_KEYS[code]
          let message = mapped === undefined ? null : t(mapped)
          if (message === null || message === mapped) message = payload?.error || t('error.generic')
          setErrorText(message)
        } catch (reason) {
          setErrorText(reason instanceof Error ? reason.message : String(reason))
        } finally {
          submitting.current = false
          setBusy(false)
        }
      }

      const confirmDisabled = busy || finished || selectedId === '' || running

      if (queued) {
        return h(
          Modal,
          {
            title: t('dialog.title'),
            titleId,
            closeLabel: t('dialog.close'),
            onClose: close,
            footer: h('button', { type: 'button', className: 'dsc-button dsc-button-outline dsc-action', onClick: close }, t('dialog.close')),
          },
          h('p', { className: 'dsc-description' }, t('dialog.queued')),
        )
      }

      if (warnings !== null) {
        return h(
          Modal,
          {
            title: t('dialog.title'),
            titleId,
            closeLabel: t('dialog.close'),
            onClose: close,
            footer: h('button', { type: 'button', className: 'dsc-button dsc-button-outline dsc-action', onClick: close }, t('dialog.close')),
          },
          h('p', { className: 'dsc-description' }, t(subagent ? 'dialog.subagentResult' : 'dialog.warningTitle')),
          h('div', { className: 'dsc-body' }, h('ul', { className: 'dsc-warning-list' }, warnings.map((warning, index) => h('li', { key: index }, String(warning))))),
        )
      }

      return h(
        Modal,
        {
          title: t(workspace ? 'dialog.workspaceTitle' : 'dialog.title'),
          titleId,
          closeLabel: t('dialog.close'),
          onClose: close,
          footer: [
            h('button', { key: 'cancel', type: 'button', className: 'dsc-button dsc-button-outline dsc-action', disabled: busy, onClick: close }, t('dialog.cancel')),
            h(
              'button',
              {
                key: 'confirm',
                type: 'button',
                className: 'dsc-button dsc-button-outline dsc-button-danger dsc-confirm',
                disabled: confirmDisabled,
                onClick: confirm,
              },
              busy ? t('dialog.busy') : t(workspace ? 'dialog.workspaceConfirm' : 'dialog.confirm'),
            ),
          ],
        },
        h(
          'div',
          { className: 'dsc-body' },
          h('div', { className: 'dsc-warning' }, h('span', { className: 'dsc-warning-icon' }, h(WarningIcon)), h('p', null, t(workspace ? 'dialog.workspaceWarning' : subagent ? 'dialog.subagentWarning' : 'dialog.warning'))),
          selectedId === ''
            ? null
            : h(
                'div',
                { className: 'dsc-list' },
                h(
                  'div',
                  { className: 'dsc-option', 'data-static': 'true' },
                  h('span', { className: 'dsc-option-text' }, h('span', { className: 'dsc-option-title' }, title), h('span', { className: 'dsc-option-id' }, workspace ? `${openRequest.detail} · ${selectedId}` : selectedId)),
                  running ? h('span', { className: 'dsc-option-badge' }, t('dialog.running')) : null,
                ),
              ),
          errorText === null ? null : h('p', { className: 'dsc-error', role: 'alert' }, errorText),
        ),
      )
    }

    function SessionCleanerDialog(props) {
      const openRequest = useSyncExternalStore(subscribe, getRequest, getRequest)
      if (openRequest === null) return null
      return h(SessionCleanerDialogBody, { key: openRequest.token, openRequest, useSessions: props.useSessions })
    }

    let registered = false

    function apply(ctx) {
      if (registered) return
      registered = true
      locale = ctx.get?.('locale')
      sessionsService = ctx.sessions
      ctx.effect(() => ensureStyles(), 'session-cleaner.styles')
      if (typeof locale?.register === 'function') {
        ctx.effect(() => locale.register(NS, { zh: ZH, en: EN }), 'session-cleaner.locale')
      }
      ctx.slots.inject('sidebar.workspaces.session.row.action', () =>
        ctx.slots.register({ name: 'sidebar.workspaces.session.row.action', id: 'session-cleaner-row', order: 400 }, DeleteSessionRowAction),
      )
      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, SessionCleanerPage),
      )
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 20, locale: NS, label: () => t('panel.title') }, SessionCleanerPanelIcon),
      )
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register({ name: 'shell.overlay', id: 'session-cleaner-dialog', order: 300 }, SessionCleanerDialog),
      )
    }

    return { inject: ['slots', 'sessions'], apply }
  },
})
