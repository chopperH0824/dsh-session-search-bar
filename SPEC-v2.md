# SPEC v2 —— 就地搜索栏 + 提速（v2 覆盖 SPEC.md 的冲突部分）

> **v3 增补（实现已按此落地）**
> - 默认 `includeTools=false` 改为「只搜正文」：FTS 的 `assistant/message` 文档里包含
>   tool-call 参数（name+arguments），所以搜索后要用会话日志校验命中是否落在 `text` 块里；
>   工具参数、工具结果、附件/文件块、reasoning 一律不算正文。`includeTools=true` 时跳过校验。
> - 正文文档按会话缓存：持久化会话 10 分钟、live 会话 30 秒；`search`/`expand` 共用。
> - `expand` 新增可选 `seq` 作为锚点；正文模式直接扫正文文档生成命中与 turn，不再走
>   `searchEvents`；工具模式仍走 FTS。
> - `ping` 版本升到 3；FTS 观察偶发不稳定时 Host 层重试（最多 3 次）。
> - 「包含工具输出」开关改成原生 `<input type="checkbox">` + `<label>` 的 chip，修掉自定义
>   button + mousedown preventDefault 导致勾不上的问题。
>
> **v4 增补（性能回退修复）**：默认模式不再逐候选读 `readSession`（那是 2–4s 的原因），
> 改为**片段特征过滤**（JSON 痕迹/工具名前缀 → 视为工具参数丢弃）；user/message 直接视为正文。
> `expand` 默认模式同样用 FTS 多命中 + 片段过滤 + `loadTurnEntry` 回填 turn。
> 该路径不再需要 body-doc 缓存（相关代码保留但未使用）。


用户反馈（两条，必须同时满足）：

1. **不要「点开图标弹到独立面板」**：要一个**常驻搜索栏**，直接输入就能搜；结果就地（输入框下方浮层）展示，不离开当前页面。
2. **搜索太慢**：当前一次搜索 3~4s（13 个会话）。目标：**稳态查询 < 1s**（首次索引构建除外）。

## A. 已确认的宿主事实（别再重复调研）

- 头部插槽 `conversation.header.leading`（single，root 作用域，**当前无占用者**）渲染在
  `<header class=…> <div class=headerLeading data-conversation-header-leading>` 里，
  header 是 `grid-template-columns: auto minmax(0,1fr)`、`min-height:76px; padding:10px 28px 0 20px;
  data-window-drag`。**整条 header 是窗口拖拽区**，所以我们的输入区必须设置
  `WebkitAppRegion:'no-drag'`（CSS `-webkit-app-region:no-drag`），否则点击/输入会拖动窗口。
- 没有会话时 header 仍渲染（sessionless/blank 状态），搜索栏应保持可用。
- 旧方案的两个注册（`main` key + `sidebar.panellist` 图标）**全部删除**；`shell.overlay` toast 保留。
- Host 性能根因（已定位）：`searchSessions/searchEvents` 每次调用都会做一次串行 reconcile；
  当前每个入选会话各调一次 `searchEvents`（13 次调用 = 13 次 reconcile），加上每会话
  `readSession`（算 turn）+ `readTitleSnapshots`（读日志折叠标题），所以 300ms/会话。
  提速方向：**一次搜索只调一次 `searchSessions`**；多命中、turn、标题全部改成**按需**（展开/点击时）再做。

## B. 新 API 契约（index.js）

路由不变：`POST /dsh-session-search/api`，其它约定（HTTP 200 + `{ok}`、64KiB、405、res close abort、
错误码、query 1..200 字符、limit 1..30、includeTools、cwd）全部沿用 SPEC.md §2。

### B.1 `action:"ping"` → `{ ok:true, data:{ indexed:true, version:2 } }`

### B.2 `action:"search"`（快速首屏，只做一次索引调用）

请求：`{ action:'search', query, limit?, includeTools?, cwd? }`

实现：

1. `provider = ctx.get('sessionQuery')`；`visible = await provider.listSessions(signal)`，
   可见性规则同 v1（cwd 非空、`origin !== 'subagent'`）。
2. **只调用一次** `provider.searchSessions({ query, eventFilters, limit: 60, cursor? }, {signal})`；
   最多沿 `nextCursor` 再翻 **1** 页（总共 ≤2 次调用）；按会话去重、保序、过滤可见性/cwd、
   收集 `limit+1` 个会话判 `truncated`。
3. **不要**调用 `searchEvents`、`readTitleSnapshots`、`readSession`。
4. 响应（字段与 v1 兼容，值可为 null）：

```jsonc
{ "ok":true, "data": {
  "query":"…", "tookMs": 420, "truncated": false,
  "items":[{
    "sessionId":"…", "title":null, "cwd":"/abs", "createdAt":1760000000000,
    "updatedAt":1760000000000,          // bestMatch.time ?? header.createdAt
    "turn":null, "seq":345, "eventType":"assistant/message",
    "snippet":"…", "matchCount":1, "hasMoreHits":null,
    "hits":[{ "seq":345, "turn":null, "eventType":"assistant/message", "time":1760000000000, "snippet":"…" }]
  }]}}
```

5. **结果缓存**：模块级 `Map<string,{at,data}>`，key=`query\0includeTools\0cwd\0limit`，
   TTL **15s**、最多 32 项，命中直接返回（`tookMs` 可写 0 并加 `"cached":true`）。
   客户端会做 200ms 防抖，缓存主要吃「改一个字再退回来」的重复查询。
6. 目标：13~20 个会话时 **tookMs < 800ms**（本会话在跑、live 会话不断变更时会略高）。

### B.3 `action:"expand"`（按需展开某会话的多命中）

请求：`{ action:'expand', sessionId, query, includeTools? }`

实现：

1. 校验 `sessionId` 为非空字符串（长度 ≤200、不含 NUL）；`query` 校验同 search。
2. **可见性校验**：`listSessions` 结果里存在该 id、`cwd != null`、非 subagent；不可见 →
   `{ ok:false, error:{ code:'not-found', message:'会话不存在或不可见' } }`。
   （可用模块级 15s 可见性缓存，避免每次 expand/locate 都列语料。）
3. `readTitleSnapshots([sessionId], signal)` 取标题（单会话，可接受）。
4. `searchEvents({ sessionId, query, filters, limit: 6 }, {signal})` 取多命中
   （type/tool/surface 过滤同 v1；失败只降级为单条 bestMatch）。
5. turn 映射沿用 v1 的 `readSession` + 60s/64 项 LRU 缓存；为每个 hit 回填 `turn`。
6. 响应：

```jsonc
{ "ok":true, "data": {
  "sessionId":"…", "title":"标题或 null", "updatedAt":1760000000000,
  "hits":[{ "seq":345, "turn":12, "eventType":"user/message", "time":…, "snippet":"…" }],
  "matchCount":4, "hasMoreHits":false, "tookMs": 180 }}
```

7. 缓存：`Map` key=`sessionId\0query\0includeTools`，TTL 60s、最多 64 项。

### B.4 `action:"locate"`（点击结果时才需要的 turn）

请求：`{ action:'locate', sessionId, seq }`

实现：可见性校验（同 expand）→ turn 缓存/`readSession` → 找到 `seq` 所属 turn（二分，同 v1）；
找不到给 `turn:null`。响应 `{ ok:true, data:{ sessionId, seq, turn: 12, tookMs: 40 } }`。
允许 `seq` 为 null/缺省时直接返回 `turn:null`（标题命中场景）。

### B.5 其它

- `listSessions` 可见性结果缓存：TTL 15s、最多 8 项（按 signal 结束时写入）。
- 保持 v1 的 abort/错误包装/日志节流（错误不要每请求刷屏）。
- v1 的 `searchEvents/readSession/readTitleSnapshots` 逐会话循环、`titlesPromise` 并发等代码可删除。

## C. 搜索栏 UI（client.js）

### C.1 注册（只保留两个）

```js
// 1) 常驻搜索栏
slots.inject('conversation.header.leading', () =>
  slots.register({ name: 'conversation.header.leading', locale: 'session-search' }, SearchBar))
// 2) 全局 toast（保留 v1 的 ShellToast 与 store）
slots.inject('shell.overlay', () => slots.register({ name:'shell.overlay', id:'session-search-toast', order:60, locale:'session-search' }, ShellToast))
```

删除 `sidebar.panellist` 与 `main` 的注册、对应的整页面板组件、以及只服务整页布局的 CSS。

### C.2 搜索栏（在 header leading 内）

```
[🔍 搜索历史会话…            ×]
```
- 外层：`display:flex; align-items:center; gap:6px; min-width:0; width:clamp(180px, 24vw, 320px);`
  **`WebkitAppRegion:'no-drag'`**，并给 CSS `-webkit-app-region:no-drag`。
- 胶囊输入：高 30px，`border:1px solid var(--dsw-alias-border-l3)`，`border-radius:8px`，
  `background:var(--dsw-alias-bg-layer-2)`；focus 时边框 `--dsw-alias-state-business-primary` +
  `box-shadow:0 0 0 2px color-mix(... 18%, transparent)`；左侧 14px 放大镜（currentColor，`--dsw-alias-label-tertiary`）；
  输入 13px、无边框透明背景、`::placeholder` 用 tertiary；有内容时右侧出现清除按钮（24px）。
- 输入变化 200ms 防抖后请求 `search`；空白回到 idle。挂载后不自动 focus（避免抢焦点）；
  `Escape`：先关浮层，再清空，再 blur。
- 键盘：`ArrowDown/ArrowUp` 在结果间移动高亮；`Enter` 打开当前项；`Tab` 正常离焦并关闭浮层。

### C.3 结果浮层（不离开当前页面）

- 用 `position:fixed` 渲染，锚定在输入框下方：打开时读 wrapper `getBoundingClientRect()`，
  `top = rect.bottom + 6`，`left = rect.left`，`width = clamp(rect.width, 480px, calc(100vw-16px))`，
  并夹在视口内（右/下不越界）；监听 window `resize` 与 `scroll`（capture）重算；浮层最大高
  `min(60vh, 520px)`。
- 容器：`background:var(--dsw-alias-bg-overlay)`、`border:1px solid var(--dsw-alias-border-l2)`、
  `border-radius:12px`、`box-shadow:var(--dsw-elevation-panel, 0 12px 32px rgba(0,0,0,.24))`、
  `z-index:2147482500`、`overflow:hidden`；内部结果区 `overflow-y:auto`。
- 浮层顶部信息行（12px，`--dsw-alias-label-secondary`）：
  - 左：「找到 N 个会话 · X ms」/「搜索中…」；
  - 右：`包含工具输出` 小开关（role=switch）+ 工作区下拉（原生 select，最大宽 160px）。
- 结果行（不是卡片，紧凑列表）：
  - 第一行：标题（13px 600，省略；空标题「未命名会话」）+ 右侧相对时间（12px tertiary）；
  - 第二行：工作区 · 来源徽标（正文/标题/工具）；命中 turn 已知时加「第 N 轮」；
  - 第三行：snippet 2 行截断 + 关键词 `<mark>` 高亮（最多 20 处，样式同 v1）；
  - 右侧一个「N 处匹配 ›」按钮（若 expand 后 >1 命中）；点击**只展开**，不打开会话；
    展开后列出其余命中（每条带「第 N 轮」+ 2 行片段），点击命中 = 打开并定位到该条；
  - 行 hover/active：`background:var(--dsw-alias-interactive-bg-hover)`；active 左侧 2px 品牌色条；
    整行可点击（打开会话）。
- 状态：
  - 焦点进入且 query 为空 → 历史 chips（最多 8 条，点击即搜）+ 一行提示；
  - loading 时**保留旧结果**，顶部显示 2px 不确定进度条或「搜索中…」，不要整块骨架闪烁；
  - done 且空 → 「没有找到包含 “xxx” 的会话」+ 提示；
  - error → 错误文案 + 「重试」。
- 点击浮层外部（document `pointerdown`，不在 wrapper 内）关闭；`Escape` 关闭。
- 浮层不抢焦点：输入框始终 focus，`onMouseDown` 阻止默认以保持焦点。

### C.4 数据流与缓存

- store 在 v1 基础上增加：`open:boolean`、`cachedHits:{ [sessionId]: { query, hits, hasMoreHits, title, updatedAt } }`、
  `expanding:{ [sessionId]: true }`、`activeIndex`、`expanded:{ [sessionId]: true }`。
- `search` 成功后，用 `props.useSessions` 的 `byId` 给每条填标题（`summary.title || summary.displayTitle`），
  标题包含关键词但正文没命中的会话继续合并（source='title'，seq/turn=null，点击只打开不定位）。
- 展开某会话：调用 `expand`；结果写入 `cachedHits[sessionId]`；同一 query 再次展开直接用缓存。
- 点击打开：
  1. 立即关闭浮层并 `ctx.get('uiWorkspace').openSession(sessionId)`；
  2. 若 turn 已知（展开命中里已有）→ 直接轮询 `[data-conversation-session="<id>"] [data-chat-turn="<turn>"]`；
  3. 若 turn 未知（首屏卡片）→ POST `{action:'locate', sessionId, seq}` 拿 turn（失败/超时 2s 就只打开），
     再轮询同一个选择器；找到 → `scrollIntoView({block:'center'})` + 2.4s 描边（沿用 v1 `revealRow`）；
  4. 9s 仍没找到 → toast「已打开会话，但未能自动定位…」，不阻断。
- 其余沿用 v1：模块级 store + `useSyncExternalStore`、AbortController/token、localStorage 历史（8 条）、
  toast store、i18n 中英、全部 `ss-` 类名、只用主题 token（除了 `#fff` 滑块与 `rgba` 兜底）。

### C.5 i18n

保留 v1 键，新增/替换：
`bar.placeholder`（搜索历史会话…）、`bar.aria`、`bar.clear`、`drop.count`、`drop.searching`、`drop.empty`、
`drop.emptyHint`、`drop.retry`、`drop.error`、`drop.history`、`drop.hint`、`drop.includeTools`、
`drop.allWorkspaces`、`row.untitled`、`row.unknownWorkspace`、`row.turn`、`row.source.body|title|tool`、
`row.matches`（N 处匹配）、`row.matchesMore`、`toast.openFailed`、`toast.locateTimeout`。

## D. 验收

- 语法：两文件 `node --check` 通过。
- Host（curl 实测）：
  - `search` 13+ 会话时 `tookMs < 1000`（首搜索引构建除外）；`items[].title=null`、`turn=null`、`hits` 只有 1 条。
  - 同一 query 立即重复 → `cached:true` 且 < 50ms。
  - `expand` 返回带 turn 的 2~6 条命中；`locate` 对已知 seq 返回正确 turn；不可见 id 返回 not-found。
  - 旧 v1 错误路径（空 query/405/超长 body/未知 action）保持。
- Client：`conversation.header.leading` 出现占用者；`main#session-search` 与 `sidebar.panellist#session-search` **消失**；
  `shell.overlay#session-search-toast` 仍在；`node --check` 通过；桩测试覆盖 search→expand→locate→打开会话全链路。
- 不要安装/重启/改 profile（Lead 负责）。
