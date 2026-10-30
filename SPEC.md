# @local/session-search — 开发规格（Lead 下发，实现以本文件为准）

> **v2 变更（优先）**：用户要求改成「常驻搜索栏 + 就地浮层结果」，并提速。
> UI 与 API 的冲突处一律以 [`SPEC-v2.md`](./SPEC-v2.md) 为准：删除 `main` / `sidebar.panellist`
> 两个注册，改为 `conversation.header.leading` 常驻搜索栏；Host 首屏搜索只做一次
> `searchSessions`，多命中 / turn / 标题改为 `expand` / `locate` 按需获取。

## 0. 目标

在 DSH Web GUI 里新增一个「会话搜索」插件：

1. 左侧栏 panellist 新增一个放大镜图标（排在 Plugins / Bill / Schedules 之后）。
2. 点开后主区域出现一个整页搜索面板：输入关键词 → 搜索**所有历史会话的消息内容**（user / assistant，可选工具输出）→ 按会话分组展示命中片段。
3. 点击某条结果：打开对应会话，并**尽力滚动定位**到命中的那一轮消息（高亮 2.4s）。定位失败时用 overlay toast 提示，不阻断打开会话。
4. 附加：标题匹配（即使正文没命中，标题包含关键词的会话也列出）、工作区筛选、搜索历史、键盘操作。

已确认的运行时事实（不要再重复调研）：

- 客户端 slot：`sidebar.panellist`（注册字段 `id`/`order`/`label`）与 `main`（注册字段 `key`，key 即 panellist 的 id，侧栏点击会自动切到该 main 面板）。两者由 shell 声明，用 `ctx.slots.inject(name, () => ctx.slots.register(...))` 注册。
- 打开会话：`ctx.get('uiWorkspace').openSession(sessionId)`，会自动切回对话面板（`layout.selectPanel(null)`）。
- 客户端拿 host 数据：**本项目约定用 `ctx.webServer.register` 注册 HTTP 路由 + 浏览器 `fetch`**（profile 里已安装的 `dsh-bill` 插件就是这样工作的，可直接参考 `/Users/qiangbin.hu/.dsh/profiles/desktop/node_modules/dsh-bill/lib/index.js` 与 `lib/client.js`）。不要使用 `host.call`（那是动态 cordis 包专用，持久化 bundle 不可用），也不要试图生成 typert remote。
- 会话全文索引服务：`ctx.get('sessionQuery')`。注意：本 profile 默认挂载的 `session-query-sqlite`
  被上层 bundle 覆盖为 `openAt: never`（内置侧栏的内容搜索因此静默降级为只匹配标题），
  所以本 bundle 的 `cordis.patch.yml` 用 `cordis:group` + `isolate: {sessionQuery: true}`
  自带一个 `path: ':memory:'`、`openAt: first-search` 的隔离索引（与官方
  `@deepseek-ai/dsh-experimental-session-search` 同构）。Host 代码仍然只认 `ctx.get('sessionQuery')`，
  不直接依赖文件路径或 sqlite。
- 会话事件 DOM：对话区的每一行带 `data-chat-turn="<turn>"`（数字）。跳转定位靠它；
  外层会话容器带 `data-conversation-session="<sessionId>"`，定位时必须先把查找范围限定在
  目标会话的容器内（切换会话的一两帧里旧会话行可能还在 DOM 中）。
- 面板组件会收到 `main` slot 的标准 props：`useSessions`、`useWorkspaces`、`usePanelInfo` 等（可能为 undefined，必须容错）。

## 1. 文件与写入范围（严格遵守）

| 文件 | 负责人 |
| --- | --- |
| `session-search/index.js` | host-search teammate（仅此文件） |
| `session-search/client.js` | ui-panel teammate（仅此文件） |
| `package.json` / `cordis.patch.yml` / `locale/*.json` / `icon.svg` / `SPEC.md` | Lead（已创建，不要改） |

- 包名 `@local/session-search`，`"type": "module"`，零第三方依赖。
- 两个文件都必须通过 `node --check`（client.js 是浏览器脚本但语法检查可用）。
- 不要执行安装、不要改 profile、不要重启服务。

## 2. Host 半：`index.js`

```js
/** Host half: authorized full-text search over the session corpus. */
export const inject = ['webServer'];

export function apply(ctx, config) {
  ctx.inject(['webServer'], (scope) => {
    scope.effect(
      () => scope.webServer.register({
        kind: 'exact',
        path: '/dsh-session-search/api',
        handler: (req, res) => handle(ctx, req, res),
      }),
      'session-search: http api',
    );
  });
}
```

要点：

- 路由 `kind: 'exact'`、方法只接受 `POST`（其它方法回 `405` 的 JSON）。
- 请求体上限 64 KiB，读超限直接 `{ ok:false, error:{ code:'bad-request', message } }`；非法 JSON 同样。
- 所有业务响应 HTTP 200，JSON 形如 `{ ok:true, data:... }` 或 `{ ok:false, error:{ code, message } }`；`Content-Type: application/json; charset=utf-8`、`Cache-Control: no-store`。
- 用 `req`/`res` 的 abort：监听 `res.on('close')` 生成 `AbortController`，传给 `searchSessions/searchEvents/readSession` 的 signal；`req` 未必有该方法，需容错。
- `ctx.get('sessionQuery')` 不存在时返回 `{ ok:false, error:{ code:'unavailable', message:'当前配置未挂载会话全文索引（@deepseek-ai/dsh-session-query）' } }`。

### 2.1 请求

```jsonc
{
  "action": "search",          // 必填；另有 "ping"
  "query": "关键词",            // 必填，trim 后 1..200 字符，禁止 NUL
  "limit": 20,                 // 可选，会话数 1..30，默认 20
  "includeTools": false,       // 可选，true 时把 tool/call、tool/result 也纳入内容命中
  "cwd": "/abs/workspace/path" // 可选，只搜该工作区（精确等于 SessionHeader.cwd），缺省=全部
}
```

`action:"ping"` 返回 `{ ok:true, data:{ indexed:true, version:1 } }`（`indexed` 表示 sessionQuery 是否可用），供页面自检。

### 2.2 响应

```jsonc
{
  "ok": true,
  "data": {
    "query": "关键词",
    "tookMs": 37,
    "truncated": false,        // 是否还有更多会话命中未返回
    "items": [
      {
        "sessionId": "uuid",
        "title": "会话标题或 null",
        "cwd": "/abs/path 或 null",
        "createdAt": 1760000000000,
        "updatedAt": 1760000000000,   // 该会话最后一条事件时间（拿不到就 createdAt）
        "turn": 12,                    // 最佳命中所属轮次，拿不到给 null
        "seq": 345,                    // 最佳命中的事件 seq（跳转定位用）
        "eventType": "user/message",
        "snippet": "命中片段（纯文本，约 240 字符）",
        "matchCount": 2,               // 本会话返回的命中数（= hits.length）
        "hasMoreHits": false,          // 该会话还有更多命中未展开
        "hits": [
          { "seq": 345, "turn": 12, "eventType": "user/message", "time": 1760000000000, "snippet": "..." }
        ]
      }
    ]
  }
}
```

### 2.3 搜索算法

1. `provider = ctx.get('sessionQuery')`。
2. 可见性：`visible = await provider.listSessions(signal)`；只保留 `header.cwd != null` 且 `header.origin !== 'subagent'` 的会话 id（与侧栏语义一致：不暴露子代理会话；不要额外调用 workspaceRegistry）。
3. 主搜索：
   ```js
   await provider.searchSessions({
     query,
     eventFilters: [
       { kind: 'type', values: includeTools
           ? ['user/message','assistant/message','tool/call','tool/result']
           : ['user/message','assistant/message'] },
       { kind: 'surface', values: ['current'] },
     ],
     limit: 60,
     cursor, // 首页不传
   }, { signal });
   ```
   - 最多翻 3 页（沿 `nextCursor`），按会话去重、保持返回顺序、最多收集 `limit` 个会话（多收 1 个用于 `truncated`）。
   - 过滤：`visibleIds.has(hit.header.id)` 且 `hit.bestMatch.sessionId === hit.header.id`；若传了 `cwd`，再要求 `hit.header.cwd === cwd`。
   - 错误处理：`SESSION_QUERY_INVALID_LIMIT` 时把 limit 减半重试一次；`SESSION_QUERY_STALE_CURSOR` 时清空重来一次；其它错误包装成 `{ ok:false, error:{ code:'search-failed', message } }`。
4. 每个入选会话再取多条命中：
   ```js
   await provider.searchEvents({
     sessionId,
     query,
     filters: [ /* 同上 type + surface */ ],
     limit: 4,
   }, { signal });
   ```
   取 `page.items` 的 `{seq, type, time, snippet}`；`hasMoreHits = Boolean(page.nextCursor)`。`bestMatch` 永远排在 hits 第一位（去重）。searchEvents 失败只让该会话退化为单条 bestMatch，不影响整体。
   - 每会话最多并发 4 个，`searchEvents` 总并发 ≤ 4。
5. 标题：`await provider.readTitleSnapshots(sessionIds, signal)`，逐项取 `status==='fulfilled' ? value.title?.title : undefined`，失败回退 `null`。
6. turn 映射（用于客户端定位）：
   - 每个会话 `await provider.readSession(sessionId)`，只遍历一遍事件，记录所有 `turn/start` 的 `{seq, turn}`（升序）；
   - 对 hits 的每个 seq 用二分查找得到最近的不大于该 seq 的 turn；
   - 顺便记录最后一条事件的 `time` 作为 `updatedAt`；
   - 缓存：`Map<sessionId, { at:number, ranges, updatedAt }>`，TTL 60s、最多 64 项，超出删最旧；
   - `readSession` 失败时 turn=null、updatedAt 回退 header.createdAt，不失败整个请求。
7. `tookMs` 用 `Date.now()` 差。
8. 不要读盘、不要绕开 sessionQuery 直接解析 `~/.dsh/sessions`。

### 2.4 代码质量

- 单文件、纯 ESM、无 import（除 node 内置外也不需要）。
- 所有异步路径必须 await/catch，路由 handler 最外层 try/catch 保证有响应。
- 不写日志噪音；错误用 `ctx.logger?.warn`（可选）。

## 3. Client 半：`client.js`

### 3.1 模块外形

```js
window.__ModuleLoader__.load({
  id: '@local/session-search',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    // ...
    return {
      inject: ['slots', 'locale'],
      apply(ctx) { /* ... */ },
    };
  },
});
```

- 只 `require('react')`，**不要** require `@deepseek-ai/dsh-client-ui-primitives`（宿主版本不稳定，自行实现控件，配色用 `--dsw-alias-*` token）。
- `apply(ctx)` 里做：
  1. `locale`：`ctx.effect(() => locale.register('session-search', { zh: DICT_ZH, en: DICT_EN }), 'session-search: dictionaries')`，并用 `locale.bind('session-search')` 得到 `t`；
  2. 注入一份 CSS（`<style data-plugin-css="@local/session-search" data-plugin="@local/session-search">`，先用 `document.querySelector('style[data-plugin-css=...]')` 去重，只注入一次）；
  3. `slots.inject('sidebar.panellist', ...)`、`slots.inject('main', ...)`、`slots.inject('shell.overlay', ...)`；
  4. 保存 `appCtx = ctx` 供跳转函数取服务。

注册参数：

```js
// 侧栏图标
{ name: 'sidebar.panellist', id: 'session-search', order: 20,
  label: () => t('panel.title'), locale: 'session-search' }
// 主面板（key 必须与 panellist 的 id 一致）
{ name: 'main', key: 'session-search', locale: 'session-search' }
// overlay toast
{ name: 'shell.overlay', id: 'session-search-toast', order: 60, locale: 'session-search' }
```

图标组件签名 `({ size, active })`，画 16×16 描边放大镜（`stroke="currentColor"`，`fill="none"`），不要自己写颜色。

### 3.2 状态存放

面板会被卸载/重建（切到会话时 main key 变成 conversation），因此把搜索状态放在 **模块级 store**（`useSyncExternalStore` 订阅）而不是组件 state：

```js
state = { query, committedQuery, status: 'idle'|'loading'|'done'|'error',
          error: null, items: [], truncated: false, tookMs: 0,
          activeIndex: -1, expanded: {}, history: [...], includeTools: false, cwd: '' }
```

`history` 用 `localStorage` 键 `dsh.session-search.history`（最多 8 条，失败静默）。

### 3.3 面板 UI（视觉规范）

整体：整页、可滚动；内容列 `max-width: 920px; margin: 0 auto; padding: 28px 32px 64px;`

1. 页头：标题「会话搜索」（`--dsw-font-l-strong-20` 一类大字号，实际用 `var(--dsw-font-*` 组合 token；若不确定就用 `font-size:17px;font-weight:600`），副标题一行说明（`--dsw-alias-label-tertiary`）。
2. 搜索条：圆角 10px、`1px solid var(--dsw-alias-border-l3)`、`background: var(--dsw-alias-bg-layer-2)`；左侧放大镜图标；`input` 无边框透明背景、`font-size:14px`、`height:44px`；右侧清除按钮（有内容时显示）。
   - 挂载后自动 focus；`placeholder` 走 i18n。
   - 输入防抖 220ms 后搜索；空白查询回到 idle。
   - `Enter` 打开当前选中项（无选中则第一条）；`ArrowDown/ArrowUp` 移动选中；`Escape`：有内容则清空，否则失焦。
3. 工具行（搜索条下方，12px 字号、`--dsw-alias-label-secondary`）：
   - 开关「包含工具输出」（checkbox 样式自绘，`role="switch"` 或原生 input 均可，但要有可见 focus ring）；
   - 工作区下拉（原生 `<select>` 也行，样式贴合 token）：`全部工作区` + 来自 `props.useWorkspaces` 的 `(snapshot.items||[]).map(w => ({id:w.workspaceId, title:w.title, path:w.path}))`；无 hook 或为空时只显示「全部工作区」；
   - 右侧统计：「找到 N 个会话 · X ms」/「搜索中…」。
4. 结果列表：每个会话一张卡片（`background: var(--dsw-alias-bg-layer-1)`，圆角 12px，`border: 1px solid var(--dsw-alias-border-l1)`，hover 时 `background: var(--dsw-alias-interactive-bg-hover)`，`margin-bottom: 8px`）。
   - 第一行：标题（14px 600，单行省略；空标题用「未命名会话」）；右侧时间（相对时间：刚刚/N 分钟前/N 小时前/N 天前/日期，12px tertiary）。
   - 第二行 meta：工作区名（来自 useWorkspaces 的 path→title，失败则 cwd basename 或「未知工作区」）· `第 N 轮`（turn 有值时）· 来源徽标（`正文` / `标题` / `工具`）。
   - 第三行：snippet，最多 3 行，命中关键词用 `<mark>` 高亮（`background: color-mix(...)` 或 `background: var(--dsw-alias-state-business-primary)` 低透明度 + `color: inherit`，不要用刺眼黄色）。高亮实现：对 query 做不区分大小写的字面切分（正则转义），最多高亮 20 处。
   - 若 `hits.length > 1` 或 `hasMoreHits`：显示「还有 N 处匹配」按钮，展开后逐条列出其他命中（同一样式，点击直接跳该条）。
   - 点击卡片 = 跳最佳命中；点击展开里的某条 = 跳该条。
   - 键盘选中项要有明显背景/描边（用 `--dsw-alias-interactive-bg-hover` + 左侧 2px 品牌色条）。
5. 空/加载/错误态：
   - idle：搜索历史 chips（点击即搜）+ 一行提示「例如：插件、报错、文件路径…」。
   - loading：3 个骨架行（`--dsw-alias-bg-skeleton`，轻量脉冲动画）。
   - done 且 0 条：「没有找到包含 “xxx” 的会话」，并提示可尝试更短的关键词 / 打开「包含工具输出」。
   - error：错误文案 + 「重试」按钮。
6. 标题匹配合并：若 `props.useSessions` 可用，取 `useSessions(s => s)` 的 `ids/byId`，把 `title`（或 `displayTitle`）包含关键词、且不在正文结果里的会话，追加到列表尾部（`source:'title'`、`seq:null`、`hits:[]`）。最多 10 个。点击只打开会话（不定位）。
   - 注意 hook 只能在组件内调用：`const sessionsSnap = useSessions ? useSessions((s) => s) : undefined;` 再用 `useMemo` 派生。
7. 无障碍：`input[aria-label]`、结果容器 `role="list"`、卡片 `role="listitem" tabindex="0"`、`aria-selected`、toast `role="status" aria-live="polite"`。

### 3.4 请求

```js
const controller = new AbortController();
fetch('/dsh-session-search/api', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action:'search', query, limit:20, includeTools, ...(cwd?{cwd}:{}) }),
  signal: controller.signal,
})
```
- 新搜索/卸载时 abort 旧请求；被 abort 的请求静默丢弃。
- 非 `ok` 或网络失败 → error 态（文案用服务端 message）。
- `action:'ping'` 在首次挂载时调用一次可省略；不需要。

### 3.5 跳转与定位（关键）

模块级函数，`appCtx` 已在 apply 中保存：

```js
function openHit(item, hit) {
  const uiWorkspace = appCtx.get('uiWorkspace');
  const sessions = appCtx.get('sessions');
  if (!uiWorkspace || typeof uiWorkspace.openSession !== 'function') { toast('无法打开会话'); return; }
  const seq = hit ? hit.seq : item.seq;
  const turn = hit ? hit.turn : item.turn;
  uiWorkspace.openSession(item.sessionId);
  if (turn == null) return;            // 标题匹配等无定位目标
  const token = ++jumpToken;
  locate(item.sessionId, seq, turn, token).catch(() => {});
}

async function locate(sessionId, seq, turn, token) {
  const deadline = Date.now() + 9000;
  let loaded = false;
  while (Date.now() < deadline && token === jumpToken) {
    const row = findTurnRow(turn);
    if (row) { revealRow(row); return; }
    if (!loaded) {
      loaded = true;
      try {
        const sessions = appCtx.get('sessions');
        if (sessions && typeof sessions.using === 'function' && seq != null) {
          await sessions.using(sessionId, { source: 'controllerOperation' },
            (ref) => ref.binding.session.loadThrough(seq));
        }
      } catch (e) { /* 定位是增强项 */ }
    }
    await sleep(150);
  }
  // 超时：不打断会话，仅提示
  toast('已打开会话，但未能自动定位到第 ' + turn + ' 轮');
}

function findTurnRow(turn, sessionId) {
  const scope = document.querySelector(
    `[data-conversation-session="${sessionId.replace(/["\\]/g, '\\$&')}"]`);
  if (scope === null) return null;           // 目标会话还没挂载：继续轮询
  for (const node of scope.querySelectorAll('[data-chat-turn]')) {
    if (!(node instanceof HTMLElement)) continue;
    if (Number(node.getAttribute('data-chat-turn')) !== turn) continue;
    if (node.closest('[hidden]')) continue;
    if (node.getClientRects().length === 0) continue;
    return node;
  }
  return null;
}

function revealRow(node) {
  const prev = { outline: node.style.outline, outlineOffset: node.style.outlineOffset,
                 borderRadius: node.style.borderRadius, transition: node.style.transition };
  node.scrollIntoView({ block: 'center', behavior: 'auto' });
  node.style.transition = 'outline-color .2s ease';
  node.style.outline = '2px solid var(--dsw-alias-state-business-primary)';
  node.style.outlineOffset = '4px';
  node.style.borderRadius = '10px';
  setTimeout(() => { node.style.outline = prev.outline; node.style.outlineOffset = prev.outlineOffset;
                     node.style.borderRadius = prev.borderRadius; node.style.transition = prev.transition; }, 2400);
}
```

- `jumpToken` 每次跳转自增，避免旧任务与新跳转互相干扰。
- 若 `sessions.using` 的 source 值被拒（抛错），catch 掉继续轮询即可。
- 这是宿主 DOM 的只读查询 + 短暂描边，**不要**改结构、不要查带 hash 的类名（`.Kjh-*` 之类禁止依赖），只依赖 `data-chat-turn`。

### 3.6 Toast overlay

- 模块级 `toastStore`：`{ id, text } | null`；`toast(text)` 设置并在 3200ms 后清空（新 toast 覆盖旧 timer）。
- `ShellToast` 组件订阅它，渲染：

```css
.ss-toast { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%);
  z-index: 2147483000; pointer-events: none; padding: 8px 14px; border-radius: 8px;
  background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1));
  box-shadow: var(--dsw-elevation-panel, 0 8px 28px rgba(0,0,0,.22));
  color: var(--dsw-alias-label-primary); font-size: 13px; }
```
- 没有 toast 时组件返回 `null`。

### 3.7 i18n 字典（必须中英齐全，键名自由但要一致）

至少包含：panel.title、panel.subtitle、input.placeholder、toolbar.includeTools、toolbar.allWorkspaces、status.count、status.searching、status.empty、status.emptyHint、status.error、status.retry、result.untitled、result.unknownWorkspace、result.turn、result.source.body/title/tool、result.moreHits、idle.history、idle.hint、toast.openFailed、toast.locateTimeout。

- 组件里取文案：`const t = props.t || fallbackT;`，`fallbackT` 绑定到 zh 字典。
- `label` thunk 用 `() => t('panel.title')`。

### 3.8 不要做的事

- 不要 require 宿主其它包（除 `react`）；不要 new React 副本；不要挂第二个 app。
- 不要持久化除 localStorage 历史以外的任何东西；不要后台轮询。
- 不要给结果卡片写死颜色/字体（用 token），不要改全局 CSS。
- 不要假定 `props.useSessions`/`useWorkspaces` 一定存在。

## 4. 验收

- `node --check index.js`、`node --check client.js` 均通过。
- host：`curl -X POST http://127.0.0.1:63712/dsh-session-search/api -H 'Content-Type: application/json' -d '{"action":"search","query":"插件"}'`（需带鉴权）能返回 `ok:true` 且 `items[].turn` 有值。
- client：安装后侧栏出现图标、点开有面板、搜索出结果、点击结果打开会话并滚动到对应轮次。
- 交付时报告：改动文件、关键决策、未覆盖/风险点。
