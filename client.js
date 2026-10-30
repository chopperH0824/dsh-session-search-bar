/**
 * dsh-session-search-bar —— 浏览器（Client）半（v2：常驻搜索栏 + 就地浮层）。
 *
 * 结构（自上而下）：
 *   1. 主题 token / 字体 ramp：颜色只用 `--dsw-alias-*`，字号只用 `--dsw-font-*`
 *      组合 token（页内以 `--ss-f-*` 二次封装）。
 *   2. i18n：注册中英两份字典到 `locale`，组件里统一取 `props.t || fallbackT`。
 *   3. 样式：一份 `data-plugin-css` 去重的 `<style>`，全部类名 `ss-` 前缀。
 *   4. 模块级 store：`useSyncExternalStore` 订阅。搜索栏常驻在
 *      `conversation.header.leading`，切换会话时组件可能重建；查询词、结果、
 *      浮层开关、展开缓存都放模块级，重建不丢。
 *   5. 数据流：`POST /dsh-session-search/api`
 *        - `search`：一次索引调用快速返回（title/turn 可能为 null），200ms 防抖；
 *          标题从 `props.useSessions` 快照就地补齐，并合并标题命中。
 *        - `expand`：点「更多匹配」时才按需拉某会话的多命中与 turn（带缓存）。
 *        - `locate`：点击首屏结果时按需把 seq 解析成 turn（2s 超时则只打开）。
 *   6. 跳转定位：openSession 后轮询
 *      `[data-conversation-session="<id>"] [data-chat-turn="<turn>"]`；
 *      长时间找不到时用 `sessions.using(loadThrough(seq))` 兜底拉起更早历史
 *      （v1 能力，仅在定位明显迟滞时触发一次），找到后滚动 + 2.4s 描边；
 *      9s 仍找不到就 toast，不阻断。
 *   7. 两个槽位：`conversation.header.leading`（搜索栏，single，无 id/key）与
 *      `shell.overlay`（toast，id `session-search-toast`）。v1 的 `main` 面板与
 *      `sidebar.panellist` 图标已删除。
 *
 * header 整条是窗口拖拽区（data-window-drag），所以栏容器必须 no-drag，
 * 否则输入/点击会拖动窗口。这个文件是普通浏览器 JS：无 JSX / 无 TS / 无 import，
 * 只 `require('react')`。
 */

window.__ModuleLoader__.load({
  id: 'dsh-session-search-bar',
  factory(require) {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')
    var h = React.createElement
    // 浮层锚点必须在绘制前量好，避免首帧闪到 (0,0)；宿主 React 一般有 useLayoutEffect。
    var useLayoutEffect = typeof React.useLayoutEffect === 'function' ? React.useLayoutEffect : React.useEffect

    var PLUGIN_ID = 'dsh-session-search-bar'
    var NS = 'session-search'
    var API_PATH = '/dsh-session-search/api'
    var CSS_KEY = 'dsh-session-search-bar/client.css'
    var HISTORY_KEY = 'dsh.session-search.history'
    var HISTORY_LIMIT = 8
    var TITLE_MATCH_LIMIT = 10
    var DEBOUNCE_MS = 200
    var TOAST_MS = 3200
    var LOCATE_TIMEOUT_MS = 9000
    var LOCATE_POLL_MS = 150
    var LOCATE_API_TIMEOUT_MS = 2000
    var HIGHLIGHT_MS = 2400
    var HIGHLIGHT_LIMIT = 20

    // ── i18n ────────────────────────────────────────────────────────────────
    var DICT_ZH = {
      'bar.placeholder': '搜索历史会话…',
      'bar.aria': '搜索历史会话',
      'bar.clear': '清除搜索',
      'drop.count': '找到 {n} 个会话 · {t} ms',
      'drop.searching': '搜索中…',
      'drop.empty': '没有找到包含“{q}”的会话',
      'drop.emptyHint': '试试更短的关键词，或打开「包含工具输出」。',
      'drop.retry': '重试',
      'drop.error': '搜索失败',
      'drop.history': '最近搜索',
      'drop.hint': '例如：插件、报错、文件路径…',
      'drop.includeTools': '包含工具输出',
      'drop.includeToolsHint': '默认只搜索消息正文；勾选后包含工具输出、附件名等内容',
      'drop.allWorkspaces': '全部工作区',
      'drop.workspace': '工作区筛选',
      'drop.truncated': '结果较多，仅显示前一部分会话。',
      'row.untitled': '未命名会话',
      'row.unknownWorkspace': '未知工作区',
      'row.turn': '第 {n} 轮',
      'row.source.body': '正文',
      'row.source.title': '标题',
      'row.source.tool': '工具',
      'row.matches': '{n} 处匹配',
      'row.matchesMore': '更多匹配',
      'row.hitsAria': '其他匹配',
      'row.titleOnly': '标题命中，正文未命中。',
      'time.justNow': '刚刚',
      'time.minutesAgo': '{n} 分钟前',
      'time.hoursAgo': '{n} 小时前',
      'time.daysAgo': '{n} 天前',
      'toast.openFailed': '无法打开会话',
      'toast.locateTimeout': '已打开会话，但未能自动定位到第 {n} 轮',
    }
    var DICT_EN = {
      'bar.placeholder': 'Search past sessions…',
      'bar.aria': 'Search past sessions',
      'bar.clear': 'Clear search',
      'drop.count': '{n} sessions · {t} ms',
      'drop.searching': 'Searching…',
      'drop.empty': 'No sessions contain “{q}”',
      'drop.emptyHint': 'Try a shorter keyword, or turn on “Include tool output”.',
      'drop.retry': 'Retry',
      'drop.error': 'Search failed',
      'drop.history': 'Recent searches',
      'drop.hint': 'e.g. plugin, error, file path…',
      'drop.includeTools': 'Include tool output',
      'drop.includeToolsHint': 'Body only by default; also search tool output and attachment names when checked',
      'drop.allWorkspaces': 'All workspaces',
      'drop.workspace': 'Workspace filter',
      'drop.truncated': 'Results are truncated; narrow the range for a more precise search.',
      'row.untitled': 'Untitled session',
      'row.unknownWorkspace': 'Unknown workspace',
      'row.turn': 'Turn {n}',
      'row.source.body': 'Message',
      'row.source.title': 'Title',
      'row.source.tool': 'Tool',
      'row.matches': '{n} matches',
      'row.matchesMore': 'More matches',
      'row.hitsAria': 'Other matches',
      'row.titleOnly': 'Matched in the title; the body does not contain it.',
      'time.justNow': 'just now',
      'time.minutesAgo': '{n} min ago',
      'time.hoursAgo': '{n} hr ago',
      'time.daysAgo': '{n} days ago',
      'toast.openFailed': 'Could not open the session',
      'toast.locateTimeout': 'Opened the session, but could not locate turn {n} automatically',
    }

    /** 把 `{name}` 占位符替换成参数；宿主 locale 的 t 也用同一套语法。 */
    function formatText(text, params) {
      if (!params || typeof text !== 'string') return text
      return text.replace(/\{(\w+)\}/g, function (whole, key) {
        var value = params[key]
        return value === undefined || value === null ? whole : String(value)
      })
    }
    /** 语言服务到达前的兜底：中文 → 英文 → key。 */
    function fallbackT(key, params) {
      var text = DICT_ZH[key]
      if (text === undefined) text = DICT_EN[key]
      if (text === undefined) text = key
      return formatText(text, params)
    }
    /** apply 里替换成 locale.bind(NS)；这里先指向中文兜底。 */
    var translate = fallbackT

    // ── 样式（一次注入，data-plugin-css 去重） ──────────────────────────────
    var CSS = `
      /* 常驻搜索栏。header 是 data-window-drag 拖拽区，容器必须 no-drag。 */
      .ss-bar{
        --ss-f-xxs: var(--dsw-font-xxs-12, 12px/18px var(--dsw-font-family, system-ui));
        --ss-f-xs: var(--dsw-font-xs-13, 13px/20px var(--dsw-font-family, system-ui));
        --ss-f-xs-strong: var(--dsw-font-xs-strong-13, 600 13px/20px var(--dsw-font-family, system-ui));
        display:flex;align-items:center;gap:6px;min-width:0;
        width:clamp(180px,24vw,320px);
        -webkit-app-region:no-drag;
      }
      .ss-field{box-sizing:border-box;display:flex;align-items:center;gap:6px;
        width:100%;height:30px;padding:0 8px;
        border:1px solid var(--dsw-alias-border-l3);border-radius:8px;
        background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-1));
        transition:border-color .12s ease,box-shadow .12s ease}
      .ss-field:focus-within{border-color:var(--dsw-alias-state-business-primary);
        box-shadow:0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary) 18%, transparent)}
      .ss-bar-icon{flex:none;display:inline-flex;color:var(--dsw-alias-label-tertiary)}
      .ss-bar-input{flex:1;min-width:0;height:28px;padding:0;border:none;outline:none;
        background:transparent;color:var(--dsw-alias-label-primary);font:var(--ss-f-xs)}
      .ss-bar-input::placeholder{color:var(--dsw-alias-label-tertiary)}
      .ss-bar-clear{flex:none;display:inline-flex;align-items:center;justify-content:center;
        width:24px;height:24px;padding:0;border:none;border-radius:6px;
        background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;
        transition:background-color .12s ease,color .12s ease}
      .ss-bar-clear:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
      .ss-bar-clear:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}

      /* 结果浮层：fixed 锚定在输入框下方；同样 no-drag。 */
      .ss-drop{position:fixed;z-index:2147482500;box-sizing:border-box;
        display:flex;flex-direction:column;
        border:1px solid var(--dsw-alias-border-l2);border-radius:12px;
        background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1,#222));
        box-shadow:var(--dsw-elevation-panel,0 12px 32px rgba(0,0,0,.24));
        overflow:hidden;color:var(--dsw-alias-label-primary);
        -webkit-app-region:no-drag}
      .ss-drop-top{flex:none;display:flex;align-items:center;gap:10px;min-width:0;
        padding:6px 10px;border-bottom:.5px solid var(--dsw-alias-border-l1);
        color:var(--dsw-alias-label-secondary);font:var(--ss-f-xxs)}
      .ss-drop-status{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .ss-drop-tools{flex:none;display:inline-flex;align-items:center;gap:8px}
      .ss-tool{display:inline-flex;align-items:center;gap:5px;white-space:nowrap;
        color:var(--dsw-alias-label-secondary);font:var(--ss-f-xxs)}
      .ss-tool-toggle{cursor:pointer;user-select:none;-webkit-user-select:none;
        display:inline-flex;align-items:center;gap:6px;min-height:26px;
        padding:2px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;
        background:var(--dsw-alias-bg-layer-2,transparent);
        transition:background-color .12s ease,border-color .12s ease}
      .ss-tool-toggle:hover{background:var(--dsw-alias-interactive-bg-hover);
        border-color:var(--dsw-alias-border-l3)}
      .ss-tool-toggle:active{background:var(--dsw-alias-interactive-bg-hover-solid,var(--dsw-alias-interactive-bg-hover))}
      .ss-check{width:15px;height:15px;margin:0;flex:none;cursor:pointer;
        accent-color:var(--dsw-alias-state-business-primary)}
      .ss-check:focus-visible{outline:2px solid var(--dsw-alias-border-l3);outline-offset:2px}
      .ss-switch{position:relative;box-sizing:border-box;flex:none;width:26px;height:15px;
        padding:2px;border:none;border-radius:999px;background:var(--dsw-alias-border-l3);
        display:inline-flex;align-items:center;cursor:pointer;transition:background-color .12s ease}
      .ss-switch>span{display:block;width:11px;height:11px;border-radius:50%;background:#fff;
        transition:transform .12s ease}
      .ss-switch[aria-checked=true]{background:var(--dsw-alias-state-business-primary)}
      .ss-switch[aria-checked=true]>span{transform:translateX(11px)}
      .ss-switch:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}
      .ss-select{box-sizing:border-box;max-width:160px;height:24px;padding:0 6px;
        border:1px solid var(--dsw-alias-border-l2);border-radius:6px;
        background:var(--dsw-alias-bg-layer-2,transparent);color:var(--dsw-alias-label-secondary);
        font:var(--ss-f-xxs);cursor:pointer}
      .ss-select:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}
      .ss-progress{flex:none;height:2px;overflow:hidden;
        background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent)}
      .ss-progress:after{content:"";display:block;height:2px;width:40%;border-radius:2px;
        background:var(--dsw-alias-state-business-primary);
        animation:ss-slide 1s ease-in-out infinite}
      @keyframes ss-slide{0%{transform:translateX(-100%)}100%{transform:translateX(320%)}}
      .ss-drop-scroll{flex:1 1 auto;min-height:0;overflow-y:auto;padding:4px 6px 6px}

      /* 紧凑结果行 */
      .ss-results{display:flex;flex-direction:column;min-width:0}
      .ss-result{min-width:0}
      .ss-row{position:relative;display:flex;align-items:flex-start;gap:10px;
        min-width:0;padding:7px 8px;border-radius:8px;cursor:pointer;outline:none}
      .ss-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
      .ss-row[data-active=true]{background:var(--dsw-alias-interactive-bg-hover)}
      .ss-row[data-active=true]:before{content:"";position:absolute;left:0;top:6px;bottom:6px;
        width:2px;border-radius:2px;background:var(--dsw-alias-state-business-primary)}
      .ss-row-main{flex:1;min-width:0}
      .ss-row-head{display:flex;align-items:baseline;gap:10px;min-width:0}
      .ss-row-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;
        white-space:nowrap;color:var(--dsw-alias-label-primary);font:var(--ss-f-xs-strong)}
      .ss-row-time{flex:none;color:var(--dsw-alias-label-tertiary);font:var(--ss-f-xxs)}
      .ss-row-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;
        margin-top:2px;min-width:0;color:var(--dsw-alias-label-tertiary);font:var(--ss-f-xxs)}
      .ss-row-workspace{max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .ss-meta-sep{opacity:.7}
      .ss-badge{flex:none;height:17px;line-height:15px;padding:0 5px;box-sizing:border-box;
        border:1px solid var(--dsw-alias-border-l2);border-radius:5px;
        color:var(--dsw-alias-label-secondary);font:var(--ss-f-xxs)}
      .ss-badge-title{color:var(--dsw-alias-state-business-tertiary,var(--dsw-alias-state-business-primary))}
      .ss-badge-tool{border-color:var(--dsw-alias-border-l3)}
      .ss-row-snippet{margin-top:3px;display:-webkit-box;-webkit-line-clamp:2;
        -webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere;white-space:pre-wrap;
        color:var(--dsw-alias-label-secondary);font:var(--ss-f-xxs)}
      .ss-row-snippet.ss-muted{color:var(--dsw-alias-label-tertiary)}
      .ss-mark{background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 20%, transparent);
        color:inherit;border-radius:3px;padding:0 1px}
      .ss-row-more{flex:none;align-self:center;display:inline-flex;align-items:center;gap:2px;
        height:24px;padding:0 6px;border:none;border-radius:6px;background:transparent;
        color:var(--dsw-alias-state-business-primary);cursor:pointer;white-space:nowrap;
        font:var(--ss-f-xxs)}
      .ss-row-more:hover{background:var(--dsw-alias-interactive-bg-hover)}
      .ss-row-more:disabled{opacity:.55;cursor:default}
      .ss-row-more:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}
      .ss-spinner{width:10px;height:10px;border-radius:50%;
        border:1.5px solid var(--dsw-alias-border-l3);
        border-top-color:var(--dsw-alias-state-business-primary);
        animation:ss-spin .8s linear infinite}
      @keyframes ss-spin{to{transform:rotate(360deg)}}
      .ss-hits{margin:0 6px 4px 16px;padding:2px 0 2px 8px;
        border-left:2px solid var(--dsw-alias-border-l2);
        display:flex;flex-direction:column;min-width:0}
      .ss-hit{box-sizing:border-box;display:flex;align-items:flex-start;gap:8px;
        width:100%;min-width:0;padding:5px 6px;border:none;border-radius:6px;
        background:transparent;text-align:left;cursor:pointer;
        color:var(--dsw-alias-label-secondary);font:var(--ss-f-xxs)}
      .ss-hit:hover{background:var(--dsw-alias-interactive-bg-hover)}
      .ss-hit:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}
      .ss-hit-turn{flex:none;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
      .ss-hit-snippet{flex:1;min-width:0;overflow:hidden;display:-webkit-box;
        -webkit-line-clamp:2;-webkit-box-orient:vertical;overflow-wrap:anywhere}
      .ss-hit-more{padding:4px 6px 2px;color:var(--dsw-alias-label-tertiary);font:var(--ss-f-xxs)}

      /* 空 / 错误 / 历史态 */
      .ss-state{padding:16px 12px;text-align:center;color:var(--dsw-alias-label-secondary);
        font:var(--ss-f-xs)}
      .ss-state-hint{margin-top:4px;color:var(--dsw-alias-label-tertiary);
        font:var(--ss-f-xxs);overflow-wrap:anywhere}
      .ss-retry{margin-top:8px;height:24px;padding:0 10px;
        border:1px solid var(--dsw-alias-border-l2);border-radius:6px;
        background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;
        font:var(--ss-f-xxs)}
      .ss-retry:hover{background:var(--dsw-alias-interactive-bg-hover)}
      .ss-retry:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}
      .ss-history{display:flex;flex-wrap:wrap;gap:6px;justify-content:center;margin-top:8px}
      .ss-history-label{margin-top:10px;color:var(--dsw-alias-label-tertiary);font:var(--ss-f-xxs)}
      .ss-chip{height:24px;max-width:240px;padding:0 9px;
        border:1px solid var(--dsw-alias-border-l2);border-radius:999px;
        background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;
        font:var(--ss-f-xxs);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .ss-chip:hover{background:var(--dsw-alias-interactive-bg-hover)}
      .ss-chip:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}
      .ss-truncated{padding:6px 8px 2px;color:var(--dsw-alias-label-tertiary);
        font:var(--ss-f-xxs);text-align:center}

      /* 全局 toast（shell.overlay，点击穿透） */
      .ss-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);
        z-index:2147483000;pointer-events:none;max-width:min(560px,calc(100vw - 32px));
        box-sizing:border-box;padding:8px 14px;border-radius:8px;
        background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1,#222));
        box-shadow:var(--dsw-elevation-panel,0 8px 28px rgba(0,0,0,.22));
        color:var(--dsw-alias-label-primary);
        font:var(--dsw-font-xs-13,13px/20px var(--dsw-font-family, system-ui))}

      @media (prefers-reduced-motion:reduce){
        .ss-field,.ss-bar-clear,.ss-switch,.ss-switch>span,.ss-row,.ss-row-more,.ss-hit,.ss-chip{transition:none}
        .ss-spinner,.ss-progress:after{animation:none}
      }
    `

    /**
     * 注入样式：以 `data-plugin-css` 去重，重复 apply / 热重载不会叠第二份。
     * 返回本次新建的 <style>；已存在时返回 null（调用方据此决定是否在卸载时移除）。
     */
    function ensureCss() {
      if (typeof document === 'undefined' || !document.head) return null
      var selector = 'style[data-plugin-css=' + JSON.stringify(CSS_KEY) + ']'
      if (document.querySelector(selector)) return null
      var tag = document.createElement('style')
      tag.dataset.plugin = PLUGIN_ID
      tag.dataset.pluginCss = CSS_KEY
      tag.textContent = CSS
      document.head.appendChild(tag)
      return tag
    }

    // ── 小工具 ──────────────────────────────────────────────────────────────
    function numberOrNull(value) {
      return typeof value === 'number' && isFinite(value) ? value : null
    }
    function basenameOf(path) {
      if (typeof path !== 'string') return ''
      var trimmed = path.replace(/[\\/]+$/, '')
      var index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
      return index >= 0 ? trimmed.slice(index + 1) : trimmed
    }
    function escapeRegExp(text) {
      return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }
    function sleep(ms) {
      return new Promise(function (resolve) { setTimeout(resolve, ms) })
    }
    function passThrough(snapshot) { return snapshot }
    /**
     * 槽位 standard props 里的 hook 在旧宿主/测试桩里可能不存在。用空 hook 兜底，
     * 保证 SearchBar 每次渲染调用的 hook 数量恒定（不要写 `cond ? props.useX() : null`）。
     */
    function useNoSessions() { return null }
    function useNoWorkspaces() { return null }
    function isAbortError(error) {
      if (!error) return false
      return error.name === 'AbortError' || error.code === 20 || error.code === 'ABORT_ERR'
    }
    function errorMessageOf(error) {
      if (error && typeof error.message === 'string' && error.message) return error.message
      return String(error || '')
    }

    /**
     * 把搜索片段转成「纯文本」再展示。
     *
     * 索引里的 snippet 直接来自消息原文：assistant 的 Markdown（**、`、#、|、链接）、
     * 工具输出里被 JSON 字符串化后残留的 `\n` `\"` 等，都会原样出现。用户需要看到
     * 干净的文字才能判断关键词是否命中，所以这里统一清洗：
     *   1) 还原 `\n` `\t` `\"` 等字面转义为真实字符/空白；
     *   2) 去掉代码围栏、行内反引号、表格分隔行、链接/图片语法、HTML 标签；
     *   3) 去掉行首标题/引用/列表标记与表格竖线；
     *   4) 去掉 `**` `__` `~~` 与成对的 `*强调*`、行内转义反斜杠；
     *   5) 去掉控制字符/零宽字符，把连续空白压成一个空格。
     *
     * 只做展示清洗，不改变搜索结果与高亮匹配的目标（高亮在清洗后的文本上做）。
     */
    function plainText(value) {
      var text = String(value === undefined || value === null ? '' : value)
      if (!text) return ''

      // 1) 字面转义 → 真实字符。先处理 \r\n，再处理其余单字符转义。
      text = text
        .replace(/\\r\\n/g, '\n')
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\n')
        .replace(/\\t/g, ' ')
        .replace(/\\"/g, '"')
        .replace(/\\'/g, "'")
        .replace(/\\\\/g, '\\')

      // 2) 代码围栏整体丢弃（```…``` / ~~~…~~~），行内代码保留内容去掉反引号。
      text = text.replace(/```[\s\S]*?```/g, ' ')
      text = text.replace(/~~~[\s\S]*?~~~/g, ' ')
      text = text.replace(/`([^`\n]*)`/g, '$1')
      text = text.replace(/`+/g, '')

      // 3) 链接/图片语法只留可见文本（URL 里允许一层括号），HTML 标签丢弃；
      //    被片段截断的 [文本 也去掉方括号。
      text = text.replace(/!\[([^\]]*)\]\((?:[^()\s]|\([^()]*\))*\)/g, '$1')
      text = text.replace(/\[([^\]]+)\]\((?:[^()\s]|\([^()]*\))*\)/g, '$1')
      text = text.replace(/\[([^\[\]\n]{1,160})\](?!\()/g, '$1')
      text = text.replace(/<[^>\n]{0,200}>/g, ' ')
      text = text.replace(/[[\]]/g, ' ')

      // 4) 行首结构标记（此时真实换行还在，逐行处理才准确）。
      text = text.replace(/(^|\n)[ \t]{0,3}#{1,6}[ \t]+/g, '$1')
      text = text.replace(/(^|\n)[ \t]{0,3}>[ \t]?/g, '$1')
      text = text.replace(/(^|\n)[ \t]{0,3}(?:[-*+]|\d{1,3}[.)])[ \t]+/g, '$1')
      // 表格分隔行（| --- | :---: |）整行丢弃。
      text = text.replace(/(^|\n)[ \t]*\|?[ \t:|-]{4,}\|?[ \t]*(?=\n|$)/g, '$1')
      // 标题下划线 / 水平线整行丢弃。
      text = text.replace(/(^|\n)[ \t]*(?:={3,}|-{3,}|\*{3,}|_{3,})[ \t]*(?=\n|$)/g, '$1')
      // 片段从行中间开始时，行内标题标记（"... ## 1. xxx"）也去掉。
      text = text.replace(/(^|[\s(（，。；：！？、])(?:#{1,6}|>)[ \t]+/g, '$1')
      // 表格竖线与强调/删除线标记；JSON 花括号也属于噪声。
      text = text.replace(/\|/g, ' ')
      text = text.replace(/[{}]/g, ' ')
      text = text.replace(/\*\*|__|~~/g, '')
      // ASCII 双引号在 Markdown/JSON 原文里几乎都是语法噪声，换成空格避免粘词。
      text = text.replace(/"/g, ' ')
      // 成对的 *强调*：只去掉紧贴文字的单个 *。
      text = text.replace(/(^|[\s(（[【])\*([^\s*][^*\n]*?)\*(?=[\s)）\]】.,，。、；;:：!?！？]|$)/g, '$1$2')
      // 行内转义反斜杠（\* \_ \[ 等）。
      text = text.replace(/\\([\\`*_{}\[\]()#+\-.!>|~])/g, '$1')

      // 5) 控制字符、零宽字符、连续空白；收尾去掉残留的引号/竖线/星号等孤立符号。
      text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b\u200c\u200d\u2060\ufeff]/g, '')
      // 中文标点前不放空格（清洗过程中常留下 "加 。" 这种间隙）。
      text = text.replace(/[ \t]+([，。、；：！？）】」》”’])/g, '$1')
      // 去掉清洗后残留的 JSON 标点噪声："query : 插件"、"a , b"、"… - 列表项"、"3. 项"。
      text = text.replace(/[ \t]+:[ \t]*/g, ' ')
      text = text.replace(/[ \t]+,/g, ',')
      text = text.replace(/…[ \t]*[-*+][ \t]+/g, '… ')
      text = text.replace(/([。；：！？\s])\d{1,3}[.)][ \t]+/g, '$1')
      text = text.replace(/^[\s'"`|*_~#>\-]+/, '')
      text = text.replace(/[\s'"`|*_~#>\-]+$/, '')
      text = text.replace(/\s+/g, ' ').trim()
      return text
    }

    /** 对 query 做不区分大小写的字面切分，最多 HIGHLIGHT_LIMIT 处，返回 React 子节点。 */
    function highlightText(text, query) {
      var source = String(text === undefined || text === null ? '' : text)
      var needle = String(query === undefined || query === null ? '' : query).trim()
      if (!needle || !source) return source
      var re
      try {
        re = new RegExp(escapeRegExp(needle), 'gi')
      } catch (e) {
        return source
      }
      var nodes = []
      var last = 0
      var count = 0
      var match
      while (count < HIGHLIGHT_LIMIT && (match = re.exec(source)) !== null) {
        if (match[0] === '') { re.lastIndex += 1; continue }
        if (match.index > last) nodes.push(source.slice(last, match.index))
        nodes.push(h('mark', { key: 'mark' + count, className: 'ss-mark' }, match[0]))
        last = match.index + match[0].length
        count += 1
      }
      if (!nodes.length) return source
      if (last < source.length) nodes.push(source.slice(last))
      return nodes
    }

    /** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 / 日期。 */
    function relativeTime(ms, t) {
      var value = numberOrNull(ms)
      if (value === null || value <= 0) return ''
      var diff = Date.now() - value
      if (diff < 0) diff = 0
      var minutes = Math.floor(diff / 60000)
      if (minutes < 1) return t('time.justNow')
      if (minutes < 60) return t('time.minutesAgo', { n: minutes })
      var hours = Math.floor(minutes / 60)
      if (hours < 24) return t('time.hoursAgo', { n: hours })
      var days = Math.floor(hours / 24)
      if (days < 7) return t('time.daysAgo', { n: days })
      try {
        return new Date(value).toLocaleDateString()
      } catch (e) {
        return ''
      }
    }

    // ── 搜索历史（localStorage，失败静默） ──────────────────────────────────
    function loadHistory() {
      try {
        if (typeof localStorage === 'undefined') return []
        var raw = localStorage.getItem(HISTORY_KEY)
        if (!raw) return []
        var parsed = JSON.parse(raw)
        if (!Array.isArray(parsed)) return []
        var out = []
        for (var i = 0; i < parsed.length && out.length < HISTORY_LIMIT; i++) {
          var entry = parsed[i]
          if (typeof entry === 'string' && entry.trim()) out.push(entry.trim())
        }
        return out
      } catch (e) {
        return []
      }
    }
    function persistHistory(list) {
      try {
        if (typeof localStorage === 'undefined') return
        localStorage.setItem(HISTORY_KEY, JSON.stringify(list))
      } catch (e) {
        /* 隐私模式 / 配额满：历史只是锦上添花，静默失败 */
      }
    }

    // ── 模块级 store ────────────────────────────────────────────────────────
    var EMPTY_ITEMS = []
    var EMPTY_MAP = {}
    var state = {
      query: '',
      committedQuery: '',
      status: 'idle', // idle | loading | done | error
      error: null,
      items: EMPTY_ITEMS,
      truncated: false,
      tookMs: 0,
      activeIndex: -1,
      open: false,
      expanded: EMPTY_MAP,
      expanding: EMPTY_MAP,
      cachedHits: EMPTY_MAP,
      history: loadHistory(),
      includeTools: false,
      cwd: '',
    }
    var listeners = []
    var debounceTimer = null
    var inflight = null
    var searchToken = 0

    function getStoreSnapshot() { return state }
    function subscribeStore(listener) {
      listeners.push(listener)
      return function () {
        var index = listeners.indexOf(listener)
        if (index >= 0) listeners.splice(index, 1)
      }
    }
    function publishStore() {
      var snapshot = listeners.slice()
      for (var i = 0; i < snapshot.length; i++) {
        try { snapshot[i]() } catch (e) { /* 单个订阅者出错不影响其它 */ }
      }
    }
    /** 整体替换 state（保持引用变化，useSyncExternalStore 才能感知）。 */
    function setState(patch) {
      state = Object.assign({}, state, patch)
      publishStore()
    }

    /** 订阅整个 store；宿主 React 很新，但保留 useState 兜底。 */
    function useStore() {
      if (typeof React.useSyncExternalStore === 'function') {
        return React.useSyncExternalStore(subscribeStore, getStoreSnapshot, getStoreSnapshot)
      }
      var pair = React.useState(getStoreSnapshot())
      React.useEffect(function () {
        return subscribeStore(function () { pair[1](getStoreSnapshot()) })
      }, [])
      return pair[0]
    }

    function pushHistory(query) {
      var value = String(query === undefined || query === null ? '' : query).trim()
      if (!value) return
      var previous = state.history || []
      var next = [value]
      for (var i = 0; i < previous.length && next.length < HISTORY_LIMIT; i++) {
        if (previous[i] !== value) next.push(previous[i])
      }
      setState({ history: next })
      persistHistory(next)
    }

    // ── 请求 ────────────────────────────────────────────────────────────────
    /** POST 一次接口；非 ok / 网络错误都转成 Error，交给调用方落状态。 */
    function callApi(body, signal) {
      return fetch(API_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: signal,
      }).then(function (response) {
        return response.json().catch(function () { return null }).then(function (json) {
          return { response: response, json: json }
        })
      }).then(function (result) {
        var json = result.json
        if (!json || typeof json !== 'object') {
          throw new Error('HTTP ' + result.response.status)
        }
        if (json.ok !== true) {
          var error = json.error && typeof json.error === 'object' ? json.error : {}
          throw new Error(error.message || ('HTTP ' + result.response.status))
        }
        return json.data
      })
    }

    function normalizeHit(raw) {
      if (!raw || typeof raw !== 'object') return null
      return {
        seq: numberOrNull(raw.seq),
        turn: numberOrNull(raw.turn),
        eventType: typeof raw.eventType === 'string' ? raw.eventType : null,
        time: numberOrNull(raw.time),
        snippet: typeof raw.snippet === 'string' ? raw.snippet : '',
      }
    }

    function normalizeHits(raw) {
      var out = []
      if (!Array.isArray(raw)) return out
      for (var i = 0; i < raw.length; i++) {
        var hit = normalizeHit(raw[i])
        if (hit) out.push(hit)
      }
      return out
    }

    /** v2 search 的 item：title/turn 可能为 null，hits 只有一条 bestMatch。 */
    function normalizeItem(raw) {
      if (!raw || typeof raw !== 'object' || typeof raw.sessionId !== 'string' || !raw.sessionId) return null
      var hits = normalizeHits(raw.hits)
      if (!hits.length && typeof raw.snippet === 'string' && raw.snippet) {
        hits.push({
          seq: numberOrNull(raw.seq),
          turn: numberOrNull(raw.turn),
          eventType: typeof raw.eventType === 'string' ? raw.eventType : null,
          time: null,
          snippet: raw.snippet,
        })
      }
      var updatedAt = numberOrNull(raw.updatedAt)
      if (updatedAt === null) updatedAt = numberOrNull(raw.createdAt)
      return {
        sessionId: raw.sessionId,
        title: typeof raw.title === 'string' && raw.title ? raw.title : null,
        cwd: typeof raw.cwd === 'string' ? raw.cwd : null,
        createdAt: numberOrNull(raw.createdAt),
        updatedAt: updatedAt,
        turn: numberOrNull(raw.turn),
        seq: numberOrNull(raw.seq),
        eventType: typeof raw.eventType === 'string' ? raw.eventType : null,
        snippet: typeof raw.snippet === 'string' ? raw.snippet : '',
        matchCount: typeof raw.matchCount === 'number' ? raw.matchCount : hits.length,
        hasMoreHits: raw.hasMoreHits === true,
        hits: hits,
        source: 'body',
      }
    }

    /** 取消进行中的请求 + 防抖（不改变 status，调用方决定落点）。 */
    function cancelSearch() {
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer)
        debounceTimer = null
      }
      searchToken += 1
      if (inflight) {
        try { inflight.abort() } catch (e) { /* 已经结束 */ }
        inflight = null
      }
    }

    /** 防抖排程；delay=0 表示立即（工具行/工作区变更）。 */
    function scheduleSearch(delay) {
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer)
        debounceTimer = null
      }
      debounceTimer = setTimeout(function () {
        debounceTimer = null
        runSearch(state.query)
      }, typeof delay === 'number' ? delay : DEBOUNCE_MS)
    }

    /**
     * 快速首屏搜索：只打一次 `search`（Host 侧只做一次索引调用）。
     * loading 期间保留旧结果，避免整块骨架闪烁。
     */
    function runSearch(rawQuery) {
      var query = String(rawQuery === undefined || rawQuery === null ? '' : rawQuery).trim()
      if (!query) {
        cancelSearch()
        setState({
          committedQuery: '',
          status: 'idle',
          error: null,
          items: EMPTY_ITEMS,
          truncated: false,
          tookMs: 0,
          activeIndex: -1,
          expanded: EMPTY_MAP,
          expanding: EMPTY_MAP,
          cachedHits: EMPTY_MAP,
        })
        return
      }

      if (inflight) {
        try { inflight.abort() } catch (e) { /* 已经结束 */ }
        inflight = null
      }
      var controller = typeof AbortController === 'function' ? new AbortController() : null
      inflight = controller
      var token = ++searchToken

      // 保留旧 items，仅更新“搜索中”状态；清掉与新 query 绑定的展开缓存。
      setState({
        status: 'loading',
        error: null,
        committedQuery: query,
        activeIndex: -1,
        expanded: EMPTY_MAP,
        expanding: EMPTY_MAP,
        cachedHits: EMPTY_MAP,
        open: true,
      })

      var body = { action: 'search', query: query, limit: 12 }
      if (state.includeTools) body.includeTools = true
      if (state.cwd) body.cwd = state.cwd

      callApi(body, controller ? controller.signal : undefined).then(function (data) {
        if (token !== searchToken) return
        inflight = null
        var items = []
        if (data && Array.isArray(data.items)) {
          for (var i = 0; i < data.items.length; i++) {
            var item = normalizeItem(data.items[i])
            if (item) items.push(item)
          }
        }
        setState({
          status: 'done',
          error: null,
          items: items,
          truncated: Boolean(data && data.truncated),
          tookMs: data && typeof data.tookMs === 'number' ? data.tookMs : 0,
          activeIndex: -1,
        })
        pushHistory(query)
      }).catch(function (error) {
        if (token !== searchToken) return
        if (isAbortError(error)) return
        inflight = null
        setState({
          status: 'error',
          error: errorMessageOf(error),
          activeIndex: -1,
        })
      })
    }

    // ── 输入 / 工具行动作 ───────────────────────────────────────────────────
    function resetToIdle(patch) {
      cancelSearch()
      setState(Object.assign({
        committedQuery: '',
        status: 'idle',
        error: null,
        items: EMPTY_ITEMS,
        truncated: false,
        tookMs: 0,
        activeIndex: -1,
        expanded: EMPTY_MAP,
        expanding: EMPTY_MAP,
        cachedHits: EMPTY_MAP,
      }, patch || {}))
    }

    function openDropdown() {
      if (!state.open) setState({ open: true })
    }
    function closeDropdown() {
      if (state.open) setState({ open: false })
    }

    function updateQuery(value) {
      var text = String(value === undefined || value === null ? '' : value)
      if (!text.trim()) {
        resetToIdle({ query: text, open: true })
        return
      }
      setState({ query: text, open: true })
      scheduleSearch(DEBOUNCE_MS)
    }

    /**
     * 清空查询。清除按钮保留浮层（展示历史）；Escape 清空时保持关闭，
     * 这样第三次 Escape 才能继续 blur。
     */
    function clearQuery(keepOpen) {
      resetToIdle({ query: '', open: keepOpen !== false })
    }

    function setIncludeTools(next) {
      var value = Boolean(next)
      if (state.includeTools === value) return
      setState({ includeTools: value, open: true })
      if (state.query.trim()) scheduleSearch(0)
    }

    function setCwd(next) {
      var value = String(next === undefined || next === null ? '' : next)
      if (state.cwd === value) return
      setState({ cwd: value, open: true })
      if (state.query.trim()) scheduleSearch(0)
    }

    function toggleExpanded(sessionId) {
      if (!sessionId) return
      var next = Object.assign({}, state.expanded)
      if (next[sessionId]) delete next[sessionId]
      else next[sessionId] = true
      setState({ expanded: next })
    }

    function moveActive(delta, length) {
      if (!length) return
      var next = state.activeIndex
      if (next < 0) next = delta > 0 ? 0 : length - 1
      else next = Math.max(0, Math.min(length - 1, next + delta))
      setState({ activeIndex: next })
    }

    function searchFromHistory(query) {
      var value = String(query === undefined || query === null ? '' : query)
      if (!value.trim()) return
      setState({ query: value, open: true })
      runSearch(value)
    }

    function retrySearch() {
      runSearch(state.committedQuery || state.query)
    }

    /**
     * 按需展开某会话的多命中：首次调 `expand` 后写入 cachedHits 并自动展开；
     * 同一 query 再次点击只切换展开/收起，不再请求。
     * 并发安全：按 sessionId 的 expanding 标记去重，响应只校验「搜索是否已换代」，
     * 不共享全局 token（否则展开 A 后立刻展开 B 会把 A 的响应丢掉并卡住 spinner）。
     */
    function expandSession(item) {
      if (!item || !item.sessionId) return
      var sessionId = item.sessionId
      var query = state.committedQuery
      if (!query) return
      var cached = state.cachedHits[sessionId]
      if (cached && cached.query === query) {
        toggleExpanded(sessionId)
        return
      }
      if (state.expanding[sessionId]) return
      var searchAtStart = searchToken
      var expanding = Object.assign({}, state.expanding)
      expanding[sessionId] = true
      setState({ expanding: expanding })

      var body = { action: 'expand', sessionId: sessionId, query: query }
      if (typeof item.seq === 'number' && isFinite(item.seq) && item.seq >= 0) body.seq = item.seq
      if (state.includeTools) body.includeTools = true

      callApi(body).then(function (data) {
        if (searchAtStart !== searchToken) return // 新搜索已重置 expanding
        var hits = normalizeHits(data && data.hits)
        var nextCached = Object.assign({}, state.cachedHits)
        nextCached[sessionId] = {
          query: query,
          title: data && typeof data.title === 'string' ? data.title : null,
          updatedAt: data ? numberOrNull(data.updatedAt) : null,
          hits: hits,
          matchCount: data && typeof data.matchCount === 'number' ? data.matchCount : hits.length,
          hasMoreHits: Boolean(data && data.hasMoreHits),
        }
        var nextExpanding = Object.assign({}, state.expanding)
        delete nextExpanding[sessionId]
        var nextExpanded = Object.assign({}, state.expanded)
        nextExpanded[sessionId] = true
        setState({
          cachedHits: nextCached,
          expanding: nextExpanding,
          expanded: nextExpanded,
        })
      }).catch(function (error) {
        if (searchAtStart !== searchToken) return
        var nextExpanding = Object.assign({}, state.expanding)
        delete nextExpanding[sessionId]
        setState({ expanding: nextExpanding })
        if (isAbortError(error)) return
        toast(errorMessageOf(error))
      })
    }

    // ── toast store（shell.overlay） ────────────────────────────────────────
    var toastItem = null
    var toastListeners = []
    var toastTimer = null
    var toastSeq = 0

    function getToastSnapshot() { return toastItem }
    function subscribeToast(listener) {
      toastListeners.push(listener)
      return function () {
        var index = toastListeners.indexOf(listener)
        if (index >= 0) toastListeners.splice(index, 1)
      }
    }
    function publishToast() {
      var snapshot = toastListeners.slice()
      for (var i = 0; i < snapshot.length; i++) {
        try { snapshot[i]() } catch (e) { /* 忽略 */ }
      }
    }
    /** 显示一条 3.2s 的 toast；新 toast 覆盖旧内容并重置计时器。 */
    function toast(text) {
      var value = String(text === undefined || text === null ? '' : text)
      if (!value) return
      toastItem = { id: ++toastSeq, text: value }
      publishToast()
      if (toastTimer !== null) clearTimeout(toastTimer)
      toastTimer = setTimeout(function () {
        toastTimer = null
        toastItem = null
        publishToast()
      }, TOAST_MS)
    }
    function clearToast() {
      if (toastTimer !== null) {
        clearTimeout(toastTimer)
        toastTimer = null
      }
      if (toastItem) {
        toastItem = null
        publishToast()
      }
    }
    function useToast() {
      if (typeof React.useSyncExternalStore === 'function') {
        return React.useSyncExternalStore(subscribeToast, getToastSnapshot, getToastSnapshot)
      }
      var pair = React.useState(getToastSnapshot())
      React.useEffect(function () {
        return subscribeToast(function () { pair[1](getToastSnapshot()) })
      }, [])
      return pair[0]
    }

    // ── 跳转与定位 ──────────────────────────────────────────────────────────
    var appCtx = null
    var jumpToken = 0

    /**
     * 点击结果：先关浮层、打开会话。turn 已知（展开命中）直接定位；
     * turn 未知（首屏卡片）先 POST locate 解析，2s 超时则只打开不定位。
     */
    function openHit(item, hit) {
      if (!item || !item.sessionId) return
      var uiWorkspace = appCtx && typeof appCtx.get === 'function' ? appCtx.get('uiWorkspace') : undefined
      closeDropdown()
      if (!uiWorkspace || typeof uiWorkspace.openSession !== 'function') {
        toast(translate('toast.openFailed'))
        return
      }
      var sessionId = item.sessionId
      var seq = hit ? hit.seq : item.seq
      var turn = hit ? hit.turn : item.turn
      // 用清洗后的片段作为「在目标轮次里找到具体消息行」的线索：
      // 只滚到 turn 容器的话，超长 turn（几十条消息）会停在中间而不是命中处。
      var hint = plainText(hit ? hit.snippet : item.snippet)
      var query = state.committedQuery || state.query || ''
      try {
        uiWorkspace.openSession(sessionId)
      } catch (e) {
        toast(translate('toast.openFailed'))
        return
      }
      var token = ++jumpToken
      if (turn !== null && turn !== undefined) {
        locate(sessionId, seq, turn, token, hint, query).catch(function () { /* 定位是增强项 */ })
        return
      }
      if (seq === null || seq === undefined) return // 标题匹配：只打开
      resolveTurn(sessionId, seq).then(function (resolvedTurn) {
        if (token !== jumpToken) return
        if (resolvedTurn === null || resolvedTurn === undefined) return // 超时/失败：只打开
        return locate(sessionId, seq, resolvedTurn, token, hint, query)
      }).catch(function () { /* 只打开 */ })
    }

    /** `action:'locate'`：把命中 seq 解析成 turn；失败或超时返回 null。 */
    async function resolveTurn(sessionId, seq) {
      var controller = typeof AbortController === 'function' ? new AbortController() : null
      var timer = setTimeout(function () {
        if (controller) {
          try { controller.abort() } catch (e) { /* 已结束 */ }
        }
      }, LOCATE_API_TIMEOUT_MS)
      try {
        var data = await callApi(
          { action: 'locate', sessionId: sessionId, seq: seq },
          controller ? controller.signal : undefined,
        )
        return data && typeof data.turn === 'number' ? data.turn : null
      } catch (e) {
        return null
      } finally {
        clearTimeout(timer)
      }
    }

    /** 轮询目标轮次；超过 9s 放弃并 toast，不阻断打开会话。 */
    async function locate(sessionId, seq, turn, token, hint, query) {
      var deadline = Date.now() + LOCATE_TIMEOUT_MS
      var attempts = 0
      var kicked = false
      while (Date.now() < deadline && token === jumpToken) {
        var rows = turnRows(sessionId, turn)
        if (rows.length > 0) {
          // 先尝试滚到「真正包含命中文字」的文本节点并选中它；
          // 找不到再退回最小的匹配行 / 轮次容器。
          if (!revealMatch(rows, hint, query)) revealRow(rows[0])
          return
        }
        attempts += 1
        // 首屏没有该轮时，补一次“拉起更早历史”的兜底（v1 能力，只在必要时）。
        if (!kicked && attempts >= 4 && seq !== null && seq !== undefined) {
          kicked = true
          kickLoadThrough(sessionId, seq)
        }
        await sleep(LOCATE_POLL_MS)
      }
      if (token !== jumpToken) return
      toast(translate('toast.locateTimeout', { n: turn }))
    }

    /** 尽力让宿主加载到 seq 所在页；失败静默，不影响轮询。 */
    function kickLoadThrough(sessionId, seq) {
      try {
        var sessions = appCtx && typeof appCtx.get === 'function' ? appCtx.get('sessions') : undefined
        if (!sessions || typeof sessions.using !== 'function') return
        Promise.resolve(sessions.using(sessionId, { source: 'controllerOperation' }, function (ref) {
          return ref.binding.session.loadThrough(seq)
        })).catch(function () { /* 定位是增强项 */ })
      } catch (e) {
        /* 服务拒绝/不存在：继续轮询 */
      }
    }

    /** 当前会话的对话区容器；找不到返回 null（避免跨会话误命中）。 */
    function findSessionScope(sessionId) {
      if (typeof document === 'undefined') return null
      var scopes = document.querySelectorAll('[data-conversation-session]')
      for (var i = 0; i < scopes.length; i++) {
        var candidate = scopes[i]
        if (candidate && candidate.getAttribute('data-conversation-session') === sessionId) return candidate
      }
      return null
    }

    /**
     * 找到目标轮次下所有「可见」的 chat 行。
     *
     * 同一个 turn 号会出现在多个行上：轮次容器、分组头、以及每条消息/步骤行。
     * 所以返回数组而不是单行，由调用方按片段挑最具体的一条。
     */
    function turnRows(sessionId, turn) {
      var scope = findSessionScope(sessionId)
      if (!scope) return []
      var candidates = scope.querySelectorAll('[data-chat-turn]')
      var out = []
      for (var i = 0; i < candidates.length; i++) {
        var node = candidates[i]
        if (typeof HTMLElement !== 'undefined' && !(node instanceof HTMLElement)) continue
        if (Number(node.getAttribute('data-chat-turn')) !== turn) continue
        if (node.closest('[hidden]')) continue
        if (node.getClientRects().length === 0) continue
        out.push(node)
      }
      return out
    }

    /** 归一化用于文字比对：小写、折叠空白。 */
    function normalizeForMatch(text) {
      return String(text === undefined || text === null ? '' : text)
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim()
    }

    /**
     * 从清洗后的片段里取几段「足够长、可辨认」的文字，用于在 DOM 里找到命中的消息行。
     * 优先取 query 前后各 24 字符的窗口；其次取片段首/中段。
     */
    function hintFragments(hint, query) {
      var text = String(hint === undefined || hint === null ? '' : hint)
        .replace(/^[…\s]+/, '')
        .replace(/[…\s]+$/, '')
      var fragments = []
      var needle = String(query === undefined || query === null ? '' : query).trim().toLowerCase()
      if (needle) {
        var at = text.toLowerCase().indexOf(needle)
        if (at >= 0) {
          // 围绕 query 开几个相互重叠的窗口：片段与原文之间常夹着 Markdown/换行，
          // 多个窗口能提高在宿主渲染文本里命中的概率。
          var offsets = [-28, -14, 0, 14]
          for (var w = 0; w < offsets.length; w += 1) {
            var left = Math.max(0, at + offsets[w])
            var right = Math.min(text.length, at + offsets[w] + 28 + needle.length)
            if (right - left >= 10) fragments.push(text.slice(left, right))
          }
        }
      }
      if (text.length >= 12) {
        fragments.push(text.slice(0, 36))
        var mid = Math.floor((text.length - 36) / 2)
        if (mid > 0) fragments.push(text.slice(mid, mid + 36))
      }
      var seen = {}
      var out = []
      for (var i = 0; i < fragments.length; i++) {
        var value = normalizeForMatch(fragments[i])
        // 至少要有 6 个非空白字符，避免用标点/短词误命中别的行。
        if (value.replace(/\s+/g, '').length < 6) continue
        if (seen[value]) continue
        seen[value] = true
        out.push(value)
      }
      return out
    }

    /**
     * 在同一个 turn 的多行里，挑选「文字包含命中片段且自身最短」的那一行。
     * 自身越短说明越具体（消息行 vs 包含它的轮次容器/分组头）。
     */
    function matchRowByHint(rows, hint, query) {
      var fragments = hintFragments(hint, query)
      if (!fragments.length) return null
      var best = null
      var bestLength = Infinity
      for (var i = 0; i < rows.length; i++) {
        var node = rows[i]
        var text = normalizeForMatch(node.textContent)
        if (!text || text.length >= bestLength) continue
        for (var f = 0; f < fragments.length; f++) {
          if (text.indexOf(fragments[f]) < 0) continue
          best = node
          bestLength = text.length
          break
        }
      }
      return best
    }

    /** 给任意元素加 2.4s 的描边高亮，之后还原原样式，不改 DOM 结构。 */
    function flashElement(node) {
      if (!node || !node.style) return
      var previous = {
        outline: node.style.outline,
        outlineOffset: node.style.outlineOffset,
        borderRadius: node.style.borderRadius,
        transition: node.style.transition,
        backgroundColor: node.style.backgroundColor,
      }
      node.style.transition = 'outline-color .2s ease, background-color .2s ease'
      node.style.outline = '2px solid var(--dsw-alias-state-business-primary)'
      node.style.outlineOffset = '4px'
      node.style.borderRadius = '10px'
      node.style.backgroundColor = 'color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent)'
      setTimeout(function () {
        node.style.outline = previous.outline
        node.style.outlineOffset = previous.outlineOffset
        node.style.borderRadius = previous.borderRadius
        node.style.transition = previous.transition
        node.style.backgroundColor = previous.backgroundColor
      }, HIGHLIGHT_MS)
    }

    /** 兜底：滚到某一行并描边。 */
    function revealRow(node) {
      try {
        node.scrollIntoView({ block: 'center', behavior: 'auto' })
      } catch (e) {
        if (typeof node.scrollIntoView === 'function') node.scrollIntoView()
      }
      flashElement(node)
    }

    /** 把片段拆成「空白宽松」的正则：片段里的空格允许匹配任意换行/空白。 */
    function fragmentRegExp(fragment) {
      var parts = String(fragment === undefined || fragment === null ? '' : fragment).split(/\s+/).filter(Boolean)
      if (!parts.length) return null
      var pattern = parts.map(function (part) {
        return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      }).join('[\\s\\u00a0]+')
      try {
        return new RegExp(pattern, 'i')
      } catch (e) {
        return null
      }
    }

    /**
     * 在某个行内寻找包含片段的第一段文本节点，返回一个 DOM Range。
     * 比「滚到整行/整轮」精确得多：超长消息或超长 turn 也能定位到命中文字。
     */
    function findTextRange(root, fragments) {
      if (!root || typeof document === 'undefined') return null
      var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null)
      var node = walker.nextNode()
      while (node) {
        var value = node.nodeValue
        if (value && value.trim()) {
          var parent = node.parentElement
          if (!parent || !parent.closest('script, style, [hidden]')) {
            for (var i = 0; i < fragments.length; i++) {
              var re = fragmentRegExp(fragments[i])
              if (!re) continue
              var match = re.exec(value)
              if (!match) continue
              try {
                var range = document.createRange()
                range.setStart(node, match.index)
                range.setEnd(node, match.index + match[0].length)
                return range
              } catch (e) {
                /* 该文本节点不可选：尝试下一个片段 */
              }
            }
          }
        }
        node = walker.nextNode()
      }
      return null
    }

    /** 精确滚到 Range 所在位置（在对话滚动容器内居中），并用系统选中高亮命中文字。 */
    function revealTextRange(range, fallbackNode) {
      var container = range.startContainer && range.startContainer.parentElement
      var scroller = null
      try {
        scroller = (container && container.closest('[data-conversation-scroll]')) ||
          document.querySelector('[data-conversation-scroll]')
      } catch (e) {
        scroller = document.querySelector('[data-conversation-scroll]')
      }
      var scrolled = false
      try {
        var rect = range.getBoundingClientRect()
        // 只有容器真的可滚动（内容高于可视区）时才改 scrollTop，
        // 否则改了个假 scroller，画面不会动。
        var scrollable = scroller && scroller.scrollHeight > scroller.clientHeight + 1
        if (scrollable && rect && (rect.height > 0 || rect.width > 0)) {
          var box = scroller.getBoundingClientRect()
          var delta = (rect.top + rect.height / 2) - (box.top + box.height / 2)
          if (isFinite(delta)) {
            scroller.scrollTop += delta
            scrolled = true
          }
        }
      } catch (e) {
        /* 测量失败：退回 scrollIntoView */
      }
      if (!scrolled) {
        try {
          ;(container || fallbackNode).scrollIntoView({ block: 'center', behavior: 'auto' })
        } catch (e) {
          /* 忽略 */
        }
      }
      flashElement(container || fallbackNode)
      selectRangeTemporarily(range)
    }

    /** 选中命中的文字，让用户一眼看到；2.4s 后若用户没再改动选区就取消选中。 */
    function selectRangeTemporarily(range) {
      if (typeof window === 'undefined' || typeof window.getSelection !== 'function') return
      try {
        var selection = window.getSelection()
        if (!selection) return
        selection.removeAllRanges()
        selection.addRange(range)
        var startContainer = range.startContainer
        var startOffset = range.startOffset
        var endContainer = range.endContainer
        var endOffset = range.endOffset
        setTimeout(function () {
          try {
            var current = window.getSelection()
            if (!current || current.rangeCount === 0) return
            var active = current.getRangeAt(0)
            // 用户中途点了别处/新建了选区：不要抢回来。
            if (active.startContainer !== startContainer || active.startOffset !== startOffset ||
              active.endContainer !== endContainer || active.endOffset !== endOffset) return
            current.removeAllRanges()
          } catch (e) {
            /* 忽略 */
          }
        }, HIGHLIGHT_MS)
      } catch (e) {
        /* 选区失败不影响滚动 */
      }
    }

    /**
     * 在目标 turn 的若干行里精确定位：优先在文本节点里找到片段并选中/滚动；
     * 找不到再退化为「包含片段且自身最短的行」。返回是否已处理。
     */
    function revealMatch(rows, hint, query) {
      var fragments = hintFragments(hint, query)
      var needle = String(query === undefined || query === null ? '' : query).trim()
      var search = fragments.slice()
      if (needle.length >= 2) search.push(needle)
      if (!search.length) return false
      // 行文本越短越具体，优先在短行里找。
      var ordered = rows.slice().sort(function (left, right) {
        return (left.textContent || '').length - (right.textContent || '').length
      })
      for (var i = 0; i < ordered.length; i++) {
        var range = findTextRange(ordered[i], search)
        if (range) {
          revealTextRange(range, ordered[i])
          return true
        }
      }
      var row = matchRowByHint(rows, hint, query)
      if (row) {
        revealRow(row)
        return true
      }
      return false
    }

    /** 来源徽标：工具事件 / 标题匹配 / 正文。 */
    function sourceOf(item) {
      if (item && item.source === 'title') return 'title'
      var type = item && item.eventType
      if (!type && item && item.hits && item.hits.length) type = item.hits[0].eventType
      return typeof type === 'string' && type.indexOf('tool/') === 0 ? 'tool' : 'body'
    }

    // ── 图标（16×16 描边，颜色继承 currentColor） ───────────────────────────
    function SearchIcon(props) {
      props = props || {}
      var size = typeof props.size === 'number' && props.size > 0 ? props.size : 16
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      },
        h('circle', { cx: 7, cy: 7, r: 4.4 }),
        h('path', { d: 'M10.3 10.3 13.8 13.8' }))
    }

    function ClearIcon(props) {
      props = props || {}
      var size = typeof props.size === 'number' && props.size > 0 ? props.size : 14
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      }, h('path', { d: 'M4.5 4.5 11.5 11.5M11.5 4.5 4.5 11.5' }))
    }

    function ChevronIcon(props) {
      props = props || {}
      var size = typeof props.size === 'number' && props.size > 0 ? props.size : 12
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      }, h('path', { d: props.open ? 'M4 6.5 8 10.5 12 6.5' : 'M6.5 4 10.5 8 6.5 12' }))
    }

    /** 一条紧凑结果行（无 hook，纯展示 + 回调）。 */
    function ResultRow(props) {
      props = props || {}
      var item = props.item || {}
      var t = props.t || fallbackT
      var cached = props.cached || null
      var expanded = Boolean(props.expanded)
      var expanding = Boolean(props.expanding)
      var source = item.source || sourceOf(item)
      var hits = cached && Array.isArray(cached.hits) && cached.hits.length
        ? cached.hits
        : (Array.isArray(item.hits) ? item.hits : [])
      var knownTurn = item.turn
      if ((knownTurn === null || knownTurn === undefined) && hits.length
        && hits[0].turn !== null && hits[0].turn !== undefined) {
        knownTurn = hits[0].turn
      }
      var extraHits = cached && hits.length > 1 ? hits.slice(1) : []
      var canExpand = source !== 'title'
        && !(cached && hits.length <= 1 && !cached.hasMoreHits)
      var moreLabel = cached
        ? t('row.matches', { n: cached.matchCount || hits.length })
        : t('row.matchesMore')
      var title = item.title || (cached && cached.title) || t('row.untitled')
      var time = relativeTime(
        (cached && cached.updatedAt) || item.updatedAt || item.createdAt,
        t,
      )
      var workspace = props.workspaceLabel || t('row.unknownWorkspace')

      var meta = [
        h('span', {
          key: 'workspace',
          className: 'ss-row-workspace',
          title: item.cwd || '',
        }, workspace),
      ]
      if (knownTurn !== null && knownTurn !== undefined) {
        meta.push(h('span', { key: 'sep1', className: 'ss-meta-sep', 'aria-hidden': 'true' }, '·'))
        meta.push(h('span', { key: 'turn' }, t('row.turn', { n: knownTurn })))
      }
      meta.push(h('span', { key: 'sep2', className: 'ss-meta-sep', 'aria-hidden': 'true' }, '·'))
      meta.push(h('span', { key: 'badge', className: 'ss-badge ss-badge-' + source }, t('row.source.' + source)))

      var snippet = typeof item.snippet === 'string' && item.snippet
        ? h('div', { key: 'snippet', className: 'ss-row-snippet' },
          highlightText(plainText(item.snippet), props.query))
        : (source === 'title'
          ? h('div', { key: 'snippet', className: 'ss-row-snippet ss-muted' }, t('row.titleOnly'))
          : null)

      var hitList = expanded && cached && extraHits.length
        ? h('div', { key: 'hits', className: 'ss-hits', role: 'group', 'aria-label': t('row.hitsAria') },
          extraHits.map(function (hit, index) {
            return h('button', {
              key: 'hit' + index,
              type: 'button',
              className: 'ss-hit',
              onClick: function (event) {
                event.stopPropagation()
                props.onOpenHit(item, hit)
              },
            },
              hit.turn !== null && hit.turn !== undefined
                ? h('span', { key: 'turn', className: 'ss-hit-turn' }, t('row.turn', { n: hit.turn }))
                : null,
              h('span', { key: 'snippet', className: 'ss-hit-snippet' },
                highlightText(plainText(hit.snippet || ''), props.query)))
          }),
          cached.hasMoreHits
            ? h('div', { key: 'more', className: 'ss-hit-more' }, t('row.matchesMore'))
            : null)
        : null

      return h('div', {
        key: props.rowKey,
        className: 'ss-result',
      },
        h('div', {
          className: 'ss-row',
          role: 'option',
          'aria-selected': props.active ? 'true' : 'false',
          'data-active': props.active ? 'true' : 'false',
          'data-ss-index': props.index,
          onClick: function () { props.onOpen(item) },
          onKeyDown: function (event) {
            if (event.target !== event.currentTarget) return
            var key = event.key
            if (key === 'Enter' || key === ' ' || key === 'Spacebar') {
              event.preventDefault()
              props.onOpen(item)
            }
          },
        },
          h('div', { key: 'main', className: 'ss-row-main' },
            h('div', { key: 'head', className: 'ss-row-head' },
              h('div', { key: 'title', className: 'ss-row-title', title: title }, title),
              time ? h('span', { key: 'time', className: 'ss-row-time' }, time) : null),
            h('div', { key: 'meta', className: 'ss-row-meta' }, meta),
            snippet),
          canExpand
            ? h('button', {
              key: 'more',
              type: 'button',
              className: 'ss-row-more',
              disabled: expanding || Boolean(props.busy),
              'aria-expanded': expanded ? 'true' : 'false',
              'aria-label': moreLabel,
              title: moreLabel,
              onClick: function (event) {
                event.stopPropagation()
                props.onExpand(item)
              },
            },
              expanding
                ? h('span', { key: 'spin', className: 'ss-spinner', 'aria-hidden': 'true' })
                : h(ChevronIcon, { key: 'chev', size: 12, open: expanded }),
              h('span', { key: 'label' }, moreLabel))
            : null),
        hitList)
    }

    /** shell.overlay 里的全局 toast。 */
    function ShellToast() {
      var item = useToast()
      if (!item) return null
      return h('div', {
        key: item.id,
        className: 'ss-toast',
        role: 'status',
        'aria-live': 'polite',
      }, item.text)
    }

    // ── 常驻搜索栏 ──────────────────────────────────────────────────────────
    /**
     * `conversation.header.leading` 里的单行搜索栏 + fixed 结果浮层。
     * 不自动抢焦点；输入 200ms 防抖；浮层开关/结果都在模块级 store。
     */
    function SearchBar(props) {
      props = props || {}
      var t = props.t || fallbackT
      var st = useStore()
      var useSessionsHook = typeof props.useSessions === 'function' ? props.useSessions : useNoSessions
      var useWorkspacesHook = typeof props.useWorkspaces === 'function' ? props.useWorkspaces : useNoWorkspaces
      var sessionsSnap = useSessionsHook(passThrough)
      var workspacesSnap = useWorkspacesHook(passThrough)
      var wrapRef = React.useRef(null)
      var inputRef = React.useRef(null)
      var positionPair = React.useState(null)
      var position = positionPair[0]
      var setPosition = positionPair[1]

      // 工作区 path → 显示名；没有 hook / 空列表时为空。
      var workspaceIndex = React.useMemo(function () {
        var byPath = {}
        var options = []
        var items = workspacesSnap && Array.isArray(workspacesSnap.items) ? workspacesSnap.items : EMPTY_ITEMS
        for (var i = 0; i < items.length; i++) {
          var entry = items[i]
          if (!entry || typeof entry !== 'object') continue
          var path = typeof entry.path === 'string' ? entry.path : ''
          if (!path) continue
          var title = typeof entry.title === 'string' && entry.title ? entry.title : basenameOf(path)
          byPath[path] = title
          options.push({
            key: typeof entry.workspaceId === 'string' ? entry.workspaceId : 'ws' + i,
            path: path,
            title: title,
          })
        }
        return { byPath: byPath, options: options }
      }, [workspacesSnap])

      // 用会话快照给 search 结果补标题（v2 的 search 不读标题）。
      var rows = React.useMemo(function () {
        var out = []
        var byId = sessionsSnap && sessionsSnap.byId ? sessionsSnap.byId : null
        for (var i = 0; i < st.items.length; i++) {
          var item = st.items[i]
          var summary = byId ? byId[item.sessionId] : null
          var title = item.title || (summary && (summary.title || summary.displayTitle)) || null
          var cwd = item.cwd || (summary && summary.cwd) || null
          out.push(Object.assign({}, item, { title: title, cwd: cwd }))
        }
        return out
      }, [st.items, sessionsSnap])

      // 标题匹配合并：正文之外、标题包含关键词的会话，最多 10 个。
      var titleMatches = React.useMemo(function () {
        if (st.status !== 'done' || !st.committedQuery || !sessionsSnap) return EMPTY_ITEMS
        var byId = sessionsSnap.byId
        if (!byId || typeof byId !== 'object') return EMPTY_ITEMS
        var bodyIds = {}
        for (var b = 0; b < st.items.length; b++) {
          if (st.items[b] && st.items[b].sessionId) bodyIds[st.items[b].sessionId] = true
        }
        var needle = st.committedQuery.toLowerCase()
        var ids = Array.isArray(sessionsSnap.ids) ? sessionsSnap.ids : Object.keys(byId)
        var out = []
        for (var i = 0; i < ids.length && out.length < TITLE_MATCH_LIMIT; i++) {
          var id = ids[i]
          if (!id || bodyIds[id]) continue
          var summary = byId[id]
          if (!summary || summary.blank) continue
          if (summary.origin === 'subagent' || summary.parentId) continue
          var title = ''
          if (typeof summary.title === 'string') title = summary.title.trim()
          if (!title && typeof summary.displayTitle === 'string') title = summary.displayTitle.trim()
          if (!title || title.toLowerCase().indexOf(needle) < 0) continue
          out.push({
            sessionId: id,
            title: title,
            cwd: typeof summary.cwd === 'string' ? summary.cwd : null,
            createdAt: null,
            updatedAt: numberOrNull(summary.updatedAt),
            turn: null,
            seq: null,
            eventType: null,
            snippet: '',
            matchCount: 0,
            hasMoreHits: false,
            hits: [],
            source: 'title',
          })
        }
        return out
      }, [st.status, st.committedQuery, st.items, sessionsSnap])

      var displayed = React.useMemo(function () {
        if (!titleMatches.length) return rows
        return rows.concat(titleMatches)
      }, [rows, titleMatches])

      // 卸载（切换会话/离开面板）时收起浮层；搜索结果仍留在模块级 store。
      React.useEffect(function () {
        return function () { closeDropdown() }
      }, [])

      // 打开浮层时测量锚点，并在 resize / scroll 时重算（布局阶段，避免闪到左上角）。
      useLayoutEffect(function () {
        if (!st.open) return
        function measure() {
          var node = wrapRef.current
          if (!node || typeof window === 'undefined') return
          var rect = node.getBoundingClientRect()
          var vw = window.innerWidth || (document.documentElement && document.documentElement.clientWidth) || 0
          var vh = window.innerHeight || (document.documentElement && document.documentElement.clientHeight) || 0
          if (!vw || !vh) {
            // 极端环境（无布局信息）：给一个可见的兜底位置，避免浮层永远不出现。
            setPosition({ top: 0, left: 0, width: 320, maxHeight: 320 })
            return
          }
          var width = Math.min(Math.max(rect.width || 0, 480), Math.max(240, vw - 16))
          var left = Math.min(Math.max(rect.left || 0, 8), Math.max(8, vw - width - 8))
          var maxHeight = Math.min(vh * 0.6, 520)
          var below = vh - (rect.bottom || 0) - 6 - 8
          var top
          if (below < 200 && (rect.top || 0) > below) {
            maxHeight = Math.min(maxHeight, Math.max(120, (rect.top || 0) - 14))
            top = Math.max(8, (rect.top || 0) - 6 - maxHeight)
          } else {
            maxHeight = Math.min(maxHeight, Math.max(120, below))
            top = (rect.bottom || 0) + 6
          }
          setPosition({ top: top, left: left, width: width, maxHeight: maxHeight })
        }
        measure()
        if (typeof window === 'undefined') return
        window.addEventListener('resize', measure)
        window.addEventListener('scroll', measure, true)
        return function () {
          window.removeEventListener('resize', measure)
          window.removeEventListener('scroll', measure, true)
        }
      }, [st.open])

      // 点击浮层外部关闭（wrapper 包含浮层，dropdown 是它的子节点）。
      React.useEffect(function () {
        if (!st.open || typeof document === 'undefined') return
        function onPointerDown(event) {
          var wrapper = wrapRef.current
          if (wrapper && event.target && wrapper.contains(event.target)) return
          closeDropdown()
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        return function () { document.removeEventListener('pointerdown', onPointerDown, true) }
      }, [st.open])

      // 键盘选中项滚动到可视区。
      React.useEffect(function () {
        if (!st.open || st.activeIndex < 0 || typeof document === 'undefined') return
        var node = document.querySelector('[data-ss-index="' + st.activeIndex + '"]')
        if (node && typeof node.scrollIntoView === 'function') {
          node.scrollIntoView({ block: 'nearest' })
        }
      }, [st.activeIndex, st.open])

      function workspaceLabel(cwd) {
        if (!cwd) return t('row.unknownWorkspace')
        var known = workspaceIndex.byPath[cwd]
        if (known) return known
        var base = basenameOf(cwd)
        return base || t('row.unknownWorkspace')
      }

      function onFocus() {
        if (!state.open) setState({ open: true })
      }

      function onInputKeyDown(event) {
        // 中文输入法选词的 Enter 不应触发跳转。
        if (event.isComposing || event.keyCode === 229) return
        var key = event.key
        if (key === 'ArrowDown') {
          event.preventDefault()
          if (!state.open) { openDropdown(); return }
          moveActive(1, displayed.length)
          return
        }
        if (key === 'ArrowUp') {
          event.preventDefault()
          moveActive(-1, displayed.length)
          return
        }
        if (key === 'Enter') {
          event.preventDefault()
          var index = state.activeIndex >= 0 ? state.activeIndex : 0
          var target = displayed[index]
          if (target) openHit(target, null)
          return
        }
        if (key === 'Escape') {
          event.preventDefault()
          if (state.open) closeDropdown()
          else if (state.query) clearQuery(false)
          else if (inputRef.current && typeof inputRef.current.blur === 'function') inputRef.current.blur()
          return
        }
        if (key === 'Tab') {
          // Tab 正常离焦，同时收起浮层。
          if (state.open) closeDropdown()
        }
      }

      /**
       * 只在点击结果行时阻止默认（保持输入框焦点以便继续键盘操作）。
       * 工具栏里的原生 checkbox / select 必须让浏览器自己处理，否则勾选可能不生效。
       */
      function onDropMouseDown(event) {
        var target = event.target
        if (!target || typeof target.closest !== 'function') return
        if (target.closest('[data-ss-index]')) event.preventDefault()
      }

      var statusText = ''
      if (st.status === 'loading') statusText = t('drop.searching')
      else if (st.status === 'done') statusText = t('drop.count', { n: displayed.length, t: st.tookMs })
      else if (st.status === 'error') statusText = t('drop.error')

      // 工作区下拉：始终有「全部工作区」；当前 cwd 不在列表时补一个选项。
      var cwdKnown = false
      for (var w = 0; w < workspaceIndex.options.length; w++) {
        if (workspaceIndex.options[w].path === st.cwd) { cwdKnown = true; break }
      }
      var selectChildren = [h('option', { key: 'all', value: '' }, t('drop.allWorkspaces'))]
      if (st.cwd && !cwdKnown) {
        selectChildren.push(h('option', { key: 'current', value: st.cwd }, basenameOf(st.cwd) || st.cwd))
      }
      for (var o = 0; o < workspaceIndex.options.length; o++) {
        var option = workspaceIndex.options[o]
        selectChildren.push(h('option', { key: option.key, value: option.path }, option.title))
      }

      var idleBlock = h('div', { key: 'idle', className: 'ss-state' },
        h('div', { className: 'ss-state-hint' }, t('drop.hint')),
        st.history.length
          ? h('div', { key: 'label', className: 'ss-history-label' }, t('drop.history'))
          : null,
        st.history.length
          ? h('div', { key: 'chips', className: 'ss-history' }, st.history.map(function (query, index) {
            return h('button', {
              key: 'h' + index,
              type: 'button',
              className: 'ss-chip',
              title: query,
              onClick: function () { searchFromHistory(query) },
            }, query)
          }))
          : null)

      var errorBlock = h('div', { key: 'error', className: 'ss-state' },
        h('div', null, t('drop.error')),
        st.error ? h('div', { className: 'ss-state-hint' }, st.error) : null,
        h('button', {
          type: 'button',
          className: 'ss-retry',
          onClick: retrySearch,
        }, t('drop.retry')))

      var emptyBlock = h('div', { key: 'empty', className: 'ss-state' },
        h('div', null, t('drop.empty', { q: st.committedQuery })),
        h('div', { className: 'ss-state-hint' }, t('drop.emptyHint')))

      var resultsBlock = h('div', {
        key: 'results',
        className: 'ss-results',
        role: 'listbox',
        'aria-label': t('bar.aria'),
      },
        displayed.map(function (item, index) {
          var cached = st.cachedHits[item.sessionId]
          if (cached && cached.query !== st.committedQuery) cached = null
          return h(ResultRow, {
            key: item.sessionId,
            rowKey: item.sessionId,
            item: item,
            index: index,
            active: index === st.activeIndex,
            busy: st.status === 'loading',
            cached: cached,
            expanded: Boolean(st.expanded[item.sessionId]),
            expanding: Boolean(st.expanding[item.sessionId]),
            query: st.committedQuery,
            t: t,
            workspaceLabel: workspaceLabel(item.cwd),
            onOpen: function (target) { openHit(target, null) },
            onOpenHit: function (target, hit) { openHit(target, hit) },
            onExpand: expandSession,
          })
        }),
        st.truncated
          ? h('div', { key: 'truncated', className: 'ss-truncated' }, t('drop.truncated'))
          : null)

      var content
      if (!st.query.trim()) content = idleBlock
      else if (st.status === 'error') content = errorBlock
      else if (st.status === 'done' && !displayed.length) content = emptyBlock
      else content = displayed.length ? resultsBlock : null

      var dropdown = st.open && position
        ? h('div', {
          className: 'ss-drop',
          role: 'dialog',
          'aria-label': t('bar.aria'),
          style: {
            top: position.top,
            left: position.left,
            width: position.width,
            maxHeight: position.maxHeight,
            WebkitAppRegion: 'no-drag',
          },
          onMouseDown: onDropMouseDown,
        },
          h('div', { key: 'top', className: 'ss-drop-top' },
            h('span', { className: 'ss-drop-status', role: 'status', 'aria-live': 'polite' }, statusText),
            h('div', { key: 'tools', className: 'ss-drop-tools' },
              h('label', {
                className: 'ss-tool ss-tool-toggle',
                title: t('drop.includeToolsHint'),
              },
                h('input', {
                  type: 'checkbox',
                  className: 'ss-check',
                  checked: Boolean(st.includeTools),
                  'aria-label': t('drop.includeTools'),
                  onChange: function (event) { setIncludeTools(Boolean(event.target.checked)) },
                }),
                h('span', null, t('drop.includeTools'))),
              h('select', {
                className: 'ss-select',
                'aria-label': t('drop.workspace'),
                value: st.cwd,
                disabled: !workspaceIndex.options.length,
                onChange: function (event) { setCwd(event.target.value) },
              }, selectChildren))),
          st.status === 'loading'
            ? h('div', { key: 'progress', className: 'ss-progress', 'aria-hidden': 'true' })
            : null,
          h('div', { key: 'scroll', className: 'ss-drop-scroll' }, content))
        : null

      return h('div', {
        className: 'ss-bar',
        ref: wrapRef,
        style: { WebkitAppRegion: 'no-drag' },
      },
        h('div', { key: 'field', className: 'ss-field' },
          h('span', { className: 'ss-bar-icon' }, h(SearchIcon, { size: 14 })),
          h('input', {
            ref: inputRef,
            className: 'ss-bar-input',
            type: 'text',
            value: st.query,
            placeholder: t('bar.placeholder'),
            'aria-label': t('bar.aria'),
            autoComplete: 'off',
            spellCheck: false,
            onFocus: onFocus,
            onChange: function (event) { updateQuery(event.target.value) },
            onKeyDown: onInputKeyDown,
          }),
          st.query
            ? h('button', {
              key: 'clear',
              type: 'button',
              className: 'ss-bar-clear',
              'aria-label': t('bar.clear'),
              title: t('bar.clear'),
              onMouseDown: function (event) { event.preventDefault() },
              onClick: clearQuery,
            }, h(ClearIcon, { size: 14 }))
            : null),
        dropdown)
    }

    // ── 插件定义 ────────────────────────────────────────────────────────────
    exports.name = PLUGIN_ID
    // 声明 locale 为必需依赖：保证字典与 `props.t` 在首个搜索栏渲染前就绪。
    exports.inject = ['slots', 'locale']

    exports.apply = function (ctx) {
      appCtx = ctx
      var slots = typeof ctx.get === 'function' ? ctx.get('slots') : undefined
      if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return

      var locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined
      if (locale !== undefined && typeof locale.register === 'function') {
        ctx.effect(function () {
          return locale.register(NS, { zh: DICT_ZH, en: DICT_EN })
        }, 'session-search: dictionaries')
        if (typeof locale.bind === 'function') {
          try {
            translate = locale.bind(NS)
          } catch (e) {
            translate = fallbackT
          }
        }
      }
      var localized = function (options) {
        if (locale !== undefined) options.locale = NS
        return options
      }

      // 样式注入（去重；只在本次新建时于卸载阶段移除，避免误删别的实例）。
      ctx.effect(function () {
        var tag = ensureCss()
        return function () {
          if (tag && tag.parentNode) tag.parentNode.removeChild(tag)
        }
      }, 'session-search: styles')

      // 插件卸载时停掉 toast 计时器与定位轮询。
      ctx.effect(function () {
        return function () {
          jumpToken += 1
          cancelSearch()
          clearToast()
        }
      }, 'session-search: runtime timers')

      // 常驻搜索栏：header leading 是 single 槽，无 id/key。
      slots.inject('conversation.header.leading', function () {
        return slots.register(localized({
          name: 'conversation.header.leading',
        }), SearchBar)
      })

      // 全局 toast：frame 级 overlay，点击穿透。
      slots.inject('shell.overlay', function () {
        return slots.register(localized({
          name: 'shell.overlay',
          id: 'session-search-toast',
          order: 60,
        }), ShellToast)
      })
    }

    return module.exports
  },
})
