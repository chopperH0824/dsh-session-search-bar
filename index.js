/**
 * Host 半 v2：会话全文搜索的「快速首屏 + 按需展开」HTTP API。
 *
 * v1 的瓶颈（已实测定位）：`searchSessions` / `searchEvents` 每次调用都会触发
 * 一次串行 reconcile。v1 对每个入选会话各调一次 `searchEvents`，再加上逐会话
 * `readSession`（算 turn）与 `readTitleSnapshots`（读日志折叠标题），13 个会话
 * 就是十几次 reconcile + 十几次全量日志读取，单次搜索 3~4s。
 *
 * v2 的取舍：把「首屏」做到只剩一次索引调用，其余全部按需。
 *
 *   - `search`   ：listSessions（有 15s 可见性缓存）→ searchSessions 一次
 *                  （最多沿 nextCursor 再翻 1 页）→ 直接返回。**不调**
 *                  `searchEvents` / `readTitleSnapshots` / `readSession`，
 *                  所以 title=null、turn=null、hits 只有 best 一条。
 *   - `expand`   ：用户点「N 处匹配」时才调 `searchEvents(limit 6)` 补多命中，
 *                  并用 turn 缓存回填每条命中的 turn。
 *   - `locate`   ：用户点结果时才把 seq 换算成 turn（turn 缓存 / readSession
 *                  二分），供客户端滚动定位。
 *   - 预热       ：插件激活 2.5s 后后台触发一次最便宜的 `searchSessions`，把
 *                  `openAt:'first-search'` 的索引构建 / 首次 reconcile 前移，
 *                  让用户真正第一次搜索时不用再等 4~6s。
 *
 * 通用约定沿用 SPEC.md §2：HTTP 200 + `{ ok, ... }`、64 KiB body 上限、
 * 非 POST 回 405、`res.on('close')` abort、错误码 bad-request / unavailable /
 * search-failed（v2 新增 not-found）。单文件 ESM，零第三方依赖。
 *
 * @module dsh-session-search-bar
 */

/** 路由路径；必须与 client.js 里的 fetch 地址一致。 */
const API_PATH = '/dsh-session-search/api'

/** 请求体硬上限：64 KiB。 */
const MAX_BODY_BYTES = 64 * 1024

/** 关键词长度上限（按 Unicode 码点计）。 */
const MAX_QUERY_CHARS = 200

/** sessionId 长度上限（uuid 远小于此，纯防御）。 */
const MAX_SESSION_ID_CHARS = 200

/** 首屏返回的会话条数：默认 20，允许 1..30。 */
const DEFAULT_SESSION_LIMIT = 20
const MAX_SESSION_LIMIT = 30

/**
 * 首屏主搜索的单页大小与最多翻页数。
 *
 * v2 的核心约束：一次 search 最多 2 次 `searchSessions` 调用（首页 + 至多
 * 沿 nextCursor 再翻 1 页）。每次调用都是一次 reconcile，翻得越多越慢。
 */
const SESSION_PAGE_LIMIT = 60
const MAX_SESSION_PAGES = 2

/** expand 时单个会话最多补取的事件命中数。 */
const EXPAND_HITS_LIMIT = 6

/**
 * 默认（正文）模式下多收的候选会话数。
 *
 * FTS 的 assistant/message 文档包含 tool-call 参数、附件名等非正文内容，
 * 所以默认模式要读会话日志把「只命中工具/附件」的会话过滤掉；多收几个候选
 * 才能在过滤后仍然凑满 limit。
 */
const EXTRA_CANDIDATES = 6

/** 正文校验（readSession）的并发上限与分批大小。 */
const BODY_VERIFY_CONCURRENCY = 12
const BODY_VERIFY_BATCH = 20

/** 首屏结果缓存：15 秒 / 32 项（吃「改一个字又退回来」的重复查询）。 */
const SEARCH_CACHE_TTL_MS = 15_000
const SEARCH_CACHE_MAX_ENTRIES = 32

/** listSessions 可见性缓存：15 秒。 */
const VISIBILITY_CACHE_TTL_MS = 15_000
const VISIBILITY_CACHE_MAX_ENTRIES = 8
const VISIBILITY_CACHE_KEY = 'corpus'

/** expand 结果缓存：60 秒 / 64 项。 */
const EXPAND_CACHE_TTL_MS = 60_000
const EXPAND_CACHE_MAX_ENTRIES = 64

/** turn 映射缓存：60 秒 / 64 项（readSession 是全量日志读取，必须缓存）。 */
const TURN_MAP_TTL_MS = 60_000
const TURN_MAP_MAX_ENTRIES = 64

/** 后台预热：延迟与查询（只需触发索引构建，结果直接丢弃）。 */
const WARMUP_DELAY_MS = 2_500
const WARMUP_QUERY = 'a'

/** 意外错误的日志节流窗口：同一类问题不要每个请求都刷屏。 */
const WARN_THROTTLE_MS = 60_000

// ── 模块级缓存 ─────────────────────────────────────────────────────────────
//
// SPEC-v2 要求这些缓存是「模块级」的：它们跨请求存活，即使面板反复挂载/卸载
// 也保持热度；插件模块被整体重载时自然清空。

/** 首屏结果缓存：key = query\0includeTools\0cwd\0limit。 */
const searchCache = new Map()

/** 可见性缓存：key 目前只有 'corpus'（保留 Map 形态是为了将来按 scope 分区）。 */
const visibilityCache = new Map()

/** expand 结果缓存：key = sessionId\0query\0includeTools。 */
const expandCache = new Map()

/** turn 映射缓存：sessionId → { ranges, updatedAt }。 */
const turnCache = new Map()

/** 上一次意外错误日志的时间戳（日志节流用）。 */
let lastWarnAt = 0

/**
 * 读缓存（带 TTL + LRU 触摸）。
 * @returns 缓存值；未命中 / 过期返回 undefined。
 */
function cacheRead(cache, key, ttlMs) {
  const entry = cache.get(key)
  if (entry === undefined) return undefined
  if (Date.now() - entry.at >= ttlMs) {
    cache.delete(key)
    return undefined
  }
  // 命中后移到 Map 尾部，维持 LRU 顺序。
  cache.delete(key)
  cache.set(key, entry)
  return entry.value
}

/** 写缓存（覆盖旧值 + 超出上限时淘汰最旧条目）。 */
function cacheWrite(cache, key, value, maxEntries) {
  cache.delete(key)
  cache.set(key, { at: Date.now(), value })
  while (cache.size > maxEntries) {
    const oldestKey = cache.keys().next().value
    if (oldestKey === undefined) break
    cache.delete(oldestKey)
  }
}

/** 有并发上限的 map（保持输入顺序）；mapper 自己处理业务失败。 */
async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length)
  let next = 0
  const workerCount = Math.max(1, Math.min(concurrency, items.length))
  const workers = []
  for (let worker = 0; worker < workerCount; worker += 1) {
    workers.push((async () => {
      for (;;) {
        const index = next
        next += 1
        if (index >= items.length) return
        results[index] = await mapper(items[index], index)
      }
    })())
  }
  await Promise.all(workers)
  return results
}

// ── 基础工具 ────────────────────────────────────────────────────────────────

/**
 * 业务错误：`code` 直接进入响应体的 `error.code`。
 * 用它区分「可预期的客户端/环境错误」和「代码缺陷」，最外层 catch 只需
 * `instanceof` 判断即可。
 */
class ApiError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ApiError'
    this.code = code
  }
}

/** 统一错误响应体。 */
function fail(code, message) {
  return { ok: false, error: { code, message } }
}

/** 把任意异常转成可读文本（不泄漏堆栈）。 */
function errorMessage(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/** sessionQuery 抛出的错误都带闭合的 `code`（见 SessionQueryError）。 */
function isSessionQueryCode(error, code) {
  return error !== null && typeof error === 'object' && error.code === code
}

/**
 * 写 JSON 响应：业务响应一律 HTTP 200；连接已关闭时静默丢弃。
 */
function sendJson(res, status, payload) {
  if (res === null || typeof res !== 'object') return
  if (res.writableEnded === true || res.destroyed === true) return
  try {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    res.end(JSON.stringify(payload))
  } catch {
    // 客户端断开后无需任何补偿。
  }
}

/**
 * 读取并解析 JSON 请求体（上限 64 KiB）。
 *
 * 超限时只拒绝、不 destroy（保证错误 JSON 还能写回），并 resume() 抽干剩余
 * 字节，避免 keep-alive 连接因未消费请求体卡住。`signal` 来自 `res` 的 close。
 */
function readJsonBody(req, signal) {
  return new Promise((resolve, reject) => {
    if (req === null || typeof req !== 'object' || typeof req.on !== 'function') {
      reject(new ApiError('bad-request', '请求对象不可读'))
      return
    }

    const chunks = []
    let received = 0
    let settled = false

    const onData = (chunk) => {
      if (settled) return
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      received += buffer.length
      if (received > MAX_BODY_BYTES) {
        settle(reject, new ApiError('bad-request', `请求体超过 ${MAX_BODY_BYTES / 1024} KiB 上限`))
        if (typeof req.resume === 'function') req.resume()
        return
      }
      chunks.push(buffer)
    }
    const onEnd = () => {
      if (settled) return
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') {
        settle(resolve, {})
        return
      }
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        settle(reject, new ApiError('bad-request', '请求体不是合法 JSON'))
        return
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        settle(reject, new ApiError('bad-request', '请求体必须是 JSON 对象'))
        return
      }
      settle(resolve, parsed)
    }
    const onError = () => settle(reject, new ApiError('bad-request', '读取请求体失败'))
    const onAborted = () => settle(reject, new ApiError('aborted', '请求已取消'))

    function settle(fn, value) {
      if (settled) return
      settled = true
      cleanup()
      fn(value)
    }

    function cleanup() {
      if (typeof req.removeListener === 'function') {
        req.removeListener('data', onData)
        req.removeListener('end', onEnd)
        req.removeListener('error', onError)
        req.removeListener('aborted', onAborted)
      }
      if (signal !== undefined && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAborted)
      }
    }

    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
    req.on('aborted', onAborted)
    if (signal !== undefined && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', onAborted, { once: true })
      if (signal.aborted === true) onAborted()
    }
  })
}

// ── 参数校验 ────────────────────────────────────────────────────────────────

/** 校验关键词：trim 后 1..200 码点，禁止 NUL。 */
function normalizeQuery(rawQuery) {
  if (typeof rawQuery !== 'string') throw new ApiError('bad-request', 'query 必须是字符串')
  if (rawQuery.includes('\u0000')) throw new ApiError('bad-request', 'query 不能包含 NUL 字符')
  const query = rawQuery.trim()
  if (query.length === 0) throw new ApiError('bad-request', 'query 不能为空')
  if ([...query].length > MAX_QUERY_CHARS) {
    throw new ApiError('bad-request', `query 不能超过 ${MAX_QUERY_CHARS} 个字符`)
  }
  return query
}

/** 校验会话数上限（1..30，默认 20）。 */
function normalizeLimit(rawLimit) {
  if (rawLimit === undefined || rawLimit === null) return DEFAULT_SESSION_LIMIT
  if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > MAX_SESSION_LIMIT) {
    throw new ApiError('bad-request', `limit 必须是 1..${MAX_SESSION_LIMIT} 的整数`)
  }
  return rawLimit
}

/** 校验 includeTools（可选布尔）。 */
function normalizeIncludeTools(rawIncludeTools) {
  if (rawIncludeTools === undefined || rawIncludeTools === null) return false
  if (typeof rawIncludeTools !== 'boolean') {
    throw new ApiError('bad-request', 'includeTools 必须是布尔值')
  }
  return rawIncludeTools
}

/** 校验 cwd（可选路径字符串；空串按「全部工作区」处理）。 */
function normalizeCwd(rawCwd) {
  if (rawCwd === undefined || rawCwd === null) return undefined
  if (typeof rawCwd !== 'string') throw new ApiError('bad-request', 'cwd 必须是字符串')
  const cwd = rawCwd.trim()
  if (cwd.includes('\u0000')) throw new ApiError('bad-request', 'cwd 不能包含 NUL 字符')
  return cwd === '' ? undefined : cwd
}

/** 校验 sessionId（非空、≤200 码点、不含 NUL）。 */
function normalizeSessionId(rawSessionId) {
  if (typeof rawSessionId !== 'string') throw new ApiError('bad-request', 'sessionId 必须是字符串')
  if (rawSessionId.includes('\u0000')) throw new ApiError('bad-request', 'sessionId 不能包含 NUL 字符')
  const sessionId = rawSessionId.trim()
  if (sessionId === '') throw new ApiError('bad-request', 'sessionId 不能为空')
  if ([...sessionId].length > MAX_SESSION_ID_CHARS) {
    throw new ApiError('bad-request', `sessionId 不能超过 ${MAX_SESSION_ID_CHARS} 个字符`)
  }
  return sessionId
}

/** 归一化 search 请求。 */
function normalizeSearchRequest(body) {
  return {
    query: normalizeQuery(body.query),
    limit: normalizeLimit(body.limit),
    includeTools: normalizeIncludeTools(body.includeTools),
    cwd: normalizeCwd(body.cwd),
  }
}

/** 归一化 expand 请求（`seq` 是客户端首屏命中的事件位置，用于兜底锚点）。 */
function normalizeExpandRequest(body) {
  let seq = null
  if (body.seq !== undefined && body.seq !== null) {
    if (!Number.isInteger(body.seq) || body.seq < 0) {
      throw new ApiError('bad-request', 'seq 必须是非负整数或 null')
    }
    seq = body.seq
  }
  return {
    sessionId: normalizeSessionId(body.sessionId),
    query: normalizeQuery(body.query),
    includeTools: normalizeIncludeTools(body.includeTools),
    seq,
  }
}

/**
 * 搜索结果只取「当前可见表面」的事件，并可选纳入工具调用/结果。
 * `surface: current` 保证不会把已被替换/压缩掉的影子事件算作命中。
 */
function buildEventFilters(includeTools) {
  const types = includeTools
    ? ['user/message', 'assistant/message', 'tool/call', 'tool/result']
    : ['user/message', 'assistant/message']
  return [
    { kind: 'type', values: types },
    { kind: 'surface', values: ['current'] },
  ]
}

// ── 服务与错误包装 ──────────────────────────────────────────────────────────

/** 取 sessionQuery 服务；缺失时返回 null（cordis 的 get 可能抛错，一并兜住）。 */
function getSessionQuery(ctx) {
  try {
    return ctx.get('sessionQuery') ?? null
  } catch {
    return null
  }
}

/** 是否是可用的全文搜索实现（防止只挂载了基类、没有 FTS 后端）。 */
function hasSearchApi(provider) {
  return provider !== null
    && typeof provider === 'object'
    && typeof provider.listSessions === 'function'
    && typeof provider.searchSessions === 'function'
    && typeof provider.searchEvents === 'function'
}

/** 取 provider，缺失时抛出 SPEC 约定的 unavailable。 */
function requireProvider(ctx) {
  const provider = getSessionQuery(ctx)
  if (provider === null || !hasSearchApi(provider)) {
    throw new ApiError(
      'unavailable',
      '当前配置未挂载会话全文索引（@deepseek-ai/dsh-session-query）',
    )
  }
  return provider
}

/** 把搜索链路上的任意异常包装成稳定的错误码。 */
function wrapSearchFailure(error, signal) {
  if (error instanceof ApiError) return error
  if (signal.aborted === true) return new ApiError('aborted', '请求已取消')
  return new ApiError('search-failed', errorMessage(error))
}

/** 简单延迟（重试退避用）。 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 会话日志观察偶发不稳定（live 会话正在被写入）时重试整个 FTS 操作。
 * 索引后端只内部重试一次；这里再补几次，避免用户在一次正在生成的会话里
 * 搜索时偶尔报错。
 */
async function withPersistenceRetry(operation) {
  let lastError
  for (let attempt = 0; attempt < PERSISTENCE_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (!isSessionQueryCode(error, 'SESSION_QUERY_PERSISTENCE_FAILED') || attempt === PERSISTENCE_RETRY_ATTEMPTS - 1) {
        throw error
      }
      await delay(PERSISTENCE_RETRY_DELAY_MS * (attempt + 1))
    }
  }
  throw lastError
}

/**
 * 意外错误日志节流：60 秒内最多一条。
 * 预期内的 ApiError（bad-request / not-found / search-failed 等）不记录，
 * 避免客户端重试把日志刷屏。
 */
function warnThrottled(ctx, error) {
  const now = Date.now()
  if (now - lastWarnAt < WARN_THROTTLE_MS) return
  lastWarnAt = now
  try {
    const logger = ctx.logger
    if (logger !== null && logger !== undefined && typeof logger.warn === 'function') {
      logger.warn(error instanceof Error ? error : new Error(String(error)))
    }
  } catch {
    // 日志失败无所谓。
  }
}

// ── 可见性 ──────────────────────────────────────────────────────────────────

/**
 * 从 `listSessions()` 的语料里筛出可见会话。
 *
 * 与侧栏语义一致：没有 cwd 的会话（匿名/内部会话）不展示；origin 为 subagent
 * 的子代理会话不展示。搜索索引返回的 header 是精简列、不含 origin，所以
 * 可见性必须以语料列表为准（它也是输出字段和 cwd 过滤的权威来源）。
 */
function collectVisibleSessions(records) {
  const visibleIds = new Set()
  const headers = new Map()
  const liveIds = new Set()
  if (!Array.isArray(records)) return { visibleIds, headers, liveIds }
  for (const record of records) {
    const header = record !== null && typeof record === 'object' ? record.header : null
    if (header === null || typeof header !== 'object') continue
    if (typeof header.id !== 'string' || header.id === '') continue
    if (header.cwd === null || header.cwd === undefined) continue
    if (header.origin === 'subagent') continue
    visibleIds.add(header.id)
    headers.set(header.id, header)
    if (record.live === true) liveIds.add(header.id)
  }
  return { visibleIds, headers, liveIds }
}

/**
 * 带 15 秒缓存的可见性读取。
 *
 * `search` / `expand` / `locate` 共用同一份缓存（同一个语料，key 固定为
 * 'corpus'），所以一次 search 之后紧跟的 expand/locate 不会再列一次语料。
 * 缓存只在 listSessions 成功返回后写入（abort / 失败不写）。
 */
async function getVisibleSessions(provider, signal) {
  const cached = cacheRead(visibilityCache, VISIBILITY_CACHE_KEY, VISIBILITY_CACHE_TTL_MS)
  if (cached !== undefined) return cached

  let records
  try {
    records = await provider.listSessions(signal)
  } catch (error) {
    throw wrapSearchFailure(error, signal)
  }
  if (signal.aborted === true) throw new ApiError('aborted', '请求已取消')

  const visible = collectVisibleSessions(records)
  cacheWrite(visibilityCache, VISIBILITY_CACHE_KEY, visible, VISIBILITY_CACHE_MAX_ENTRIES)
  return visible
}

// ── 首屏搜索（只碰一次索引） ────────────────────────────────────────────────

/**
 * 首屏主搜索翻页。
 *
 * 沿 `nextCursor` 最多翻 `MAX_SESSION_PAGES - 1` 次（v2 总共 ≤2 次调用）；
 * 按会话去重并保持索引顺序；收集到 `sessionLimit + 1` 个会话就停（多出的
 * 那个只用于判 `truncated`）。`SESSION_QUERY_STALE_CURSOR`（索引在翻页期间
 * 变化）时清空游标和已收集结果、从头再来一次。
 */
async function paginateSessionHits(provider, options) {
  const {
    query, eventFilters, sessionLimit, cwd, visibleIds, headers, pageLimit, signal,
  } = options

  const collected = []
  const seen = new Set()
  let cursor
  let pages = 0
  let restarted = false
  let truncated = false

  while (pages < MAX_SESSION_PAGES) {
    pages += 1
    if (signal.aborted === true) throw new ApiError('aborted', '请求已取消')

    let page
    try {
      page = await provider.searchSessions({
        query,
        eventFilters,
        limit: pageLimit,
        // 首页不传 cursor（传 undefined 会被后端当成非法游标）。
        ...(cursor === undefined ? {} : { cursor }),
      }, { signal })
    } catch (error) {
      if (isSessionQueryCode(error, 'SESSION_QUERY_STALE_CURSOR') && !restarted) {
        // 索引在翻页期间发生变化：游标作废，清空后完整重来一次。
        restarted = true
        cursor = undefined
        collected.length = 0
        seen.clear()
        pages = 0
        continue
      }
      throw error
    }

    const items = Array.isArray(page?.items) ? page.items : []
    let reachedLimit = false

    for (const hit of items) {
      const hitHeader = hit !== null && typeof hit === 'object' ? hit.header : null
      const sessionId = hitHeader !== null && typeof hitHeader === 'object' ? hitHeader.id : null
      // 1) 只保留可见会话；2) bestMatch 必须属于该会话，避免索引串线。
      if (typeof sessionId !== 'string' || !visibleIds.has(sessionId)) continue
      if (hit.bestMatch === null || typeof hit.bestMatch !== 'object') continue
      if (hit.bestMatch.sessionId !== sessionId) continue

      // header 以语料列表为准（索引 header 缺 origin 等字段）。
      const header = headers.get(sessionId) ?? hitHeader
      if (cwd !== undefined && header.cwd !== cwd) continue
      if (seen.has(sessionId)) continue

      seen.add(sessionId)
      collected.push({ header, bestMatch: hit.bestMatch })
      if (collected.length > sessionLimit) {
        reachedLimit = true
        break
      }
    }

    if (reachedLimit) {
      truncated = true
      break
    }

    cursor = typeof page?.nextCursor === 'string' && page.nextCursor !== '' ? page.nextCursor : undefined
    if (cursor === undefined) break
  }

  // 翻页次数用尽但仍有下一游标：保守判定「还有更多会话命中未返回」。
  if (!truncated && cursor !== undefined && pages >= MAX_SESSION_PAGES) truncated = true

  return {
    items: collected.slice(0, sessionLimit),
    truncated,
  }
}

/**
 * 主搜索入口：单页 limit 固定 60；若后端配置的 maxLimit 更小会抛
 * `SESSION_QUERY_INVALID_LIMIT`，此时减半并从第一页重试一次（游标指纹包含
 * limit，不能续翻页）。这是 v1 保留下来的错误降级路径，属异常分支。
 */
async function collectSessions(provider, options) {
  let pageLimit = SESSION_PAGE_LIMIT
  let lastError = null
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await paginateSessionHits(provider, { ...options, pageLimit })
    } catch (error) {
      lastError = error
      if (isSessionQueryCode(error, 'SESSION_QUERY_INVALID_LIMIT') && pageLimit > 1) {
        pageLimit = Math.max(1, Math.floor(pageLimit / 2))
        continue
      }
      throw error
    }
  }
  throw lastError ?? new ApiError('search-failed', '会话搜索失败')
}

/** 把索引/事件命中归一化成响应里的 hit 形状；turn 由 expand/locate 回填。 */
function toHit(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  return {
    seq: Number.isInteger(source.seq) ? source.seq : null,
    turn: null,
    eventType: typeof source.type === 'string' ? source.type : null,
    time: Number.isFinite(source.time) ? source.time : null,
    snippet: typeof source.snippet === 'string' ? source.snippet : '',
  }
}

/** 转义正则元字符（query 一律按字面匹配）。 */
function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * query 是否按「字面短语」出现在文本里（空白宽松、大小写不敏感）。
 * 与 FTS 的短语语义对齐：单 token 查询等价于子串匹配。
 */
function literalMatches(text, query) {
  if (typeof text !== 'string' || text === '') return false
  const parts = String(query).trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return false
  try {
    const pattern = parts.map(escapeRegExp).join('[\\s\\u00a0]+')
    return new RegExp(pattern, 'i').test(text)
  } catch {
    return false
  }
}

/**
 * 一条事件的「正文」文本。
 *
 * 默认模式（includeTools=false）只把 user/assistant 消息里的 text 内容块算正文：
 * 模型的 tool-call 参数、工具结果、reasoning、附件文件名（file/image 块）都不算。
 * 这些内容仍会进入 FTS 的 assistant/message 文档（assistant 消息里含 tool-call
 * 块），所以搜索后必须用会话日志再校验一次，否则默认会搜到工具输出/附件名。
 */
function bodyTextOfEvent(event) {
  if (event === null || typeof event !== 'object') return ''
  if (event.type !== 'user/message' && event.type !== 'assistant/message') return ''
  const blocks = event.data?.message?.content
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n')
}

/**
 * 片段是否像「工具调用参数」而不是正文。
 *
 * 默认（只搜正文）模式下用它快速过滤：FTS 的 assistant/message 文档把
 * tool-call 的 name+arguments 也算进去了，而 arguments 是 JSON —— 片段里
 * 几乎必然出现 { " / \" / \n / "\s*: 等 JSON 痕迹，或“工具名 + {”前缀。
 * 这样不需要读会话日志就能把工具输出挡在默认结果之外（保持搜索速度）。
 */
function looksLikeToolText(snippet) {
  const text = String(snippet === undefined || snippet === null ? '' : snippet)
  if (text === '') return false
  if (/\{\s*"|"\s*:|\\n|\\t|\\"|\\u[0-9a-fA-F]{4}/.test(text)) return true
  if (/(?:^|[^A-Za-z0-9_])(?:bash|read|write|edit|grep|glob|python3?|officecli|create_goal|session_search|session_event_read|session_event_search|skill|terminal_open|terminal_send|terminal_read)\s*[\{\[]/.test(text)) return true
  return false
}

/**
 * 构造 query 的字面匹配正则：按「字母/数字/CJK 连续段」切 token，token 之间
 * 允许任意非字母数字分隔（空格、换行、标点、Markdown 标记），大小写不敏感。
 * 这比 FTS 的 tokenizer 宽松一点，但只用于「验证 FTS 已命中的候选是否在正文里」，
 * 不会凭空把没命中的会话拉进来。
 */
function queryMatcher(query) {
  const tokens = String(query).match(/[\p{L}\p{N}]+/gu)
  if (tokens === null || tokens.length === 0) return null
  try {
    return new RegExp(tokens.map(escapeRegExp).join('[^\\p{L}\\p{N}]+'), 'iu')
  } catch {
    return null
  }
}

/** 在正文文本里围绕命中词生成纯文本片段（前后各 ~100 字符，约 240 字符上限）。 */
function buildSnippet(text, query) {
  const matcher = queryMatcher(query)
  if (matcher === null) return ''
  const match = matcher.exec(text)
  if (match === null) return ''
  const start = Math.max(0, match.index - 100)
  const end = Math.min(text.length, match.index + match[0].length + 120)
  const body = text.slice(start, end).replace(/\s+/g, ' ').trim()
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`
}

// ── 正文文档缓存（默认模式的校验/摘要来源） ─────────────────────────────────

/**
 * 每个会话只保留「正文 text 块」（排除 tool-call 参数、工具结果、附件名、
 * reasoning），用于默认模式的正文校验和片段生成。
 *
 * 首次搜索每个候选会话读一次 readSession；之后 60 秒内的搜索/展开直接复用，
 * 避免反复读大日志。按会话数 + 总字符数双重上限做 LRU 淘汰，防止大日志
 * 无限占用内存。
 */
// 已持久化（非 live）的会话日志不会再变，正文文档可长期缓存；
// live 会话仍在写入，用短 TTL 避免搜不到最近内容。
const BODY_DOCS_TTL_PERSISTED_MS = 10 * 60_000
const BODY_DOCS_TTL_LIVE_MS = 30_000
const BODY_DOCS_MAX_SESSIONS = 40
const BODY_DOCS_MAX_CHARS = 128 * 1024 * 1024

/** 会话日志观察偶发不稳定（live 会话正在写入）时的重试次数与退避。 */
const PERSISTENCE_RETRY_ATTEMPTS = 3
const PERSISTENCE_RETRY_DELAY_MS = 250
const bodyDocsCache = new Map()
let bodyDocsChars = 0

function readBodyDocsEntry(sessionId, ttlMs) {
  const entry = bodyDocsCache.get(sessionId)
  if (entry === undefined) return undefined
  if (Date.now() - entry.at >= ttlMs) {
    bodyDocsCache.delete(sessionId)
    bodyDocsChars -= entry.chars
    return undefined
  }
  bodyDocsCache.delete(sessionId)
  bodyDocsCache.set(sessionId, entry)
  return entry
}

function writeBodyDocsEntry(sessionId, entry) {
  const existing = bodyDocsCache.get(sessionId)
  if (existing !== undefined) {
    bodyDocsCache.delete(sessionId)
    bodyDocsChars -= existing.chars
  }
  bodyDocsCache.set(sessionId, entry)
  bodyDocsChars += entry.chars
  while (bodyDocsCache.size > BODY_DOCS_MAX_SESSIONS || bodyDocsChars > BODY_DOCS_MAX_CHARS) {
    const oldestKey = bodyDocsCache.keys().next().value
    if (oldestKey === undefined) break
    const old = bodyDocsCache.get(oldestKey)
    bodyDocsChars -= old.chars
    bodyDocsCache.delete(oldestKey)
  }
}

/** 取（或构建）一个会话的正文文档；同时把 turn 区间写进 turn 缓存。 */
async function getBodyDocs(provider, sessionId, live) {
  const ttlMs = live === true ? BODY_DOCS_TTL_LIVE_MS : BODY_DOCS_TTL_PERSISTED_MS
  const cached = readBodyDocsEntry(sessionId, ttlMs)
  if (cached !== undefined) return cached

  const snapshot = await readSessionSnapshot(provider, sessionId)
  const docs = []
  let chars = 0
  for (const event of snapshot.events) {
    if (event.type !== 'user/message' && event.type !== 'assistant/message') continue
    const text = bodyTextOfEvent(event)
    if (text === '' || text.trim() === '') continue
    docs.push({ seq: event.seq, type: event.type, time: event.time, text })
    chars += text.length
  }
  const entry = { at: Date.now(), docs, ranges: snapshot.ranges, updatedAt: snapshot.updatedAt, chars }
  writeBodyDocsEntry(sessionId, entry)
  rememberTurnEntry(sessionId, snapshot)
  return entry
}

/**
 * 默认模式：在一个会话的正文文档里为 query 找一条命中。
 * 优先使用 FTS 的 bestMatch（若它确实是正文命中，保留其排序/片段），
 * 否则取正文文档里第一条匹配并自行生成片段。
 */
async function findBodyHit(provider, sessionId, ftsHit, query, live) {
  const matcher = queryMatcher(query)
  if (matcher === null) return null
  const entry = await getBodyDocs(provider, sessionId, live)
  let chosen = null
  for (const doc of entry.docs) {
    if (matcher.test(doc.text)) {
      chosen = doc
      break
    }
  }
  if (chosen === null) return null

  const ftsSeq = ftsHit !== null && ftsHit !== undefined && Number.isInteger(ftsHit.seq) ? ftsHit.seq : null
  if (ftsSeq !== null) {
    const ftsDoc = entry.docs.find((doc) => doc.seq === ftsSeq)
    if (ftsDoc !== undefined && matcher.test(ftsDoc.text)) chosen = ftsDoc
  }
  const useFtsSnippet = ftsSeq !== null && chosen.seq === ftsSeq
    && typeof ftsHit.snippet === 'string' && ftsHit.snippet !== ''

  return {
    seq: chosen.seq,
    eventType: chosen.type,
    time: chosen.time,
    snippet: useFtsSnippet ? ftsHit.snippet : buildSnippet(chosen.text, query),
    turn: turnForSeq(entry.ranges, chosen.seq),
    updatedAt: entry.updatedAt,
  }
}

/**
 * readSession 一次，返回：事件数组、turn 区间表、最后事件时间。
 * 默认模式用它同时完成「正文校验 + turn 回填」，避免二次读日志。
 */
async function readSessionSnapshot(provider, sessionId) {
  const loaded = await provider.readSession(sessionId)
  const events = Array.isArray(loaded?.events) ? loaded.events : []
  const ranges = []
  let updatedAt = null
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    if (event.type === 'turn/start') {
      const turn = event.data?.turn
      if (Number.isInteger(turn) && turn >= 0 && Number.isInteger(event.seq)) {
        ranges.push({ seq: event.seq, turn })
      }
    }
    if (Number.isFinite(event.time) && (updatedAt === null || event.time > updatedAt)) {
      updatedAt = event.time
    }
  }
  return { events, ranges, updatedAt }
}

/** 把一次 readSession 的结果写进 turn 缓存（locate / 后续 expand 直接复用）。 */
function rememberTurnEntry(sessionId, snapshot) {
  cacheWrite(turnCache, sessionId, { ranges: snapshot.ranges, updatedAt: snapshot.updatedAt }, TURN_MAP_MAX_ENTRIES)
}

// ── expand 的辅助：标题 / 多命中 / 降级锚点 ────────────────────────────────

/**
 * 读取单会话标题（expand 用）。
 * `readTitleSnapshots([id])` 会读一次该会话日志来折叠标题；失败只是没有标题。
 */
async function readSessionTitle(provider, sessionId, signal) {
  if (typeof provider.readTitleSnapshots !== 'function') return null
  try {
    const results = await provider.readTitleSnapshots([sessionId], signal)
    const result = Array.isArray(results) ? results[0] : undefined
    const title = result?.status === 'fulfilled' ? result.value?.title?.title : undefined
    return typeof title === 'string' && title !== '' ? title : null
  } catch (error) {
    if (signal.aborted === true) throw new ApiError('aborted', '请求已取消')
    return null
  }
}

/**
 * 补取某会话的多命中（工具模式 expand 用）。
 * 失败返回 `degraded: true` 与空 hits；调用方会用首屏结果缓存兜底。
 */
async function collectExpandedHits(provider, sessionId, query, eventFilters, signal) {
  let page
  try {
    page = await provider.searchEvents({
      sessionId,
      query,
      filters: eventFilters,
      limit: EXPAND_HITS_LIMIT,
    }, { signal })
  } catch (error) {
    if (signal.aborted === true) throw new ApiError('aborted', '请求已取消')
    return { hits: [], hasMoreHits: false, degraded: true }
  }

  const hits = []
  const seenSeqs = new Set()
  const items = Array.isArray(page?.items) ? page.items : []
  for (const item of items) {
    const hit = toHit(item)
    if (!Number.isInteger(hit.seq) || seenSeqs.has(hit.seq)) continue
    seenSeqs.add(hit.seq)
    hits.push(hit)
  }

  return {
    hits,
    hasMoreHits: typeof page?.nextCursor === 'string' && page.nextCursor !== '',
    degraded: false,
  }
}

/**
 * 从首屏结果缓存里找出该会话的最佳命中（降级兜底 / expand 锚点）。
 * search 缓存 key 以 `query\0includeTools\0` 开头，先按前缀筛选再扫 items。
 */
function findCachedBestHit(sessionId, query, includeTools) {
  const prefix = `${query}\u0000${String(includeTools)}\u0000`
  for (const [key, entry] of searchCache) {
    if (!key.startsWith(prefix)) continue
    const items = entry.value?.items
    if (!Array.isArray(items)) continue
    for (const item of items) {
      if (item.sessionId !== sessionId) continue
      const first = Array.isArray(item.hits) ? item.hits[0] : undefined
      return toHit({
        seq: item.seq,
        type: item.eventType,
        time: first !== undefined && first !== null ? first.time : item.updatedAt,
        snippet: item.snippet,
      })
    }
  }
  return null
}

// ── 首屏搜索 ────────────────────────────────────────────────────────────────

/**
 * 首屏 search：可见性 → 结果缓存 → 一次 searchSessions（最多 2 页）→ 组响应。
 *
 * 仍然**不调用** `searchEvents` / `readTitleSnapshots`。默认（正文）模式会对
 * 候选会话读一次会话日志（带 60s 正文文档缓存）：FTS 的 assistant/message 文档
 * 包含 tool-call 参数、附件名等非正文内容，必须确认命中文字落在 text 块里，
 * 否则默认会搜到工具输出（用户明确要求默认只搜正文）。这次读取同时回填 turn。
 * `includeTools=true` 时不校验，走快速路径。
 */
async function search(ctx, body, signal) {
  const startedAt = Date.now()
  const provider = requireProvider(ctx)
  const request = normalizeSearchRequest(body)

  // 先取可见性（有 15s 缓存），命中缓存时这一步只是内存查表。
  const { visibleIds, headers } = await getVisibleSessions(provider, signal)

  const cacheKey = [
    request.query,
    String(request.includeTools),
    request.cwd ?? '',
    String(request.limit),
  ].join('\u0000')

  const cachedData = cacheRead(searchCache, cacheKey, SEARCH_CACHE_TTL_MS)
  if (cachedData !== undefined) {
    return { ...cachedData, tookMs: 0, cached: true }
  }

  if (visibleIds.size === 0) {
    const empty = {
      query: request.query,
      tookMs: Date.now() - startedAt,
      truncated: false,
      items: [],
    }
    cacheWrite(searchCache, cacheKey, empty, SEARCH_CACHE_MAX_ENTRIES)
    return empty
  }

  // 默认（正文）模式会过滤「只命中工具输出/附件名」的会话，所以多收几个候选。
  const candidateLimit = request.includeTools
    ? request.limit
    : Math.min(MAX_SESSION_LIMIT + EXTRA_CANDIDATES, request.limit + EXTRA_CANDIDATES)

  let collection
  try {
    collection = await withPersistenceRetry(() => collectSessions(provider, {
      query: request.query,
      eventFilters: buildEventFilters(request.includeTools),
      sessionLimit: candidateLimit,
      cwd: request.cwd,
      visibleIds,
      headers,
      signal,
    }))
  } catch (error) {
    throw wrapSearchFailure(error, signal)
  }

  let entries
  if (request.includeTools) {
    // 工具模式：不做任何过滤，工具输出/附件名也算命中。
    entries = collection.items.map((session) => ({
      session,
      best: toHit(session.bestMatch),
      turn: null,
      updatedAt: null,
    }))
  } else {
    // 正文模式（快速）：不读会话日志，按片段特征排除 assistant 消息里的
    // 工具调用参数（JSON 痕迹/工具名前缀）。user/message 的索引文本只来自
    // text 块，本身就是正文。
    entries = []
    for (const session of collection.items) {
      const bestMatch = session.bestMatch
      if (bestMatch.type === 'assistant/message' && looksLikeToolText(bestMatch.snippet)) continue
      entries.push({ session, best: toHit(bestMatch), turn: null, updatedAt: null })
    }
  }

  const items = entries.slice(0, request.limit).map((entry) => {
    const header = entry.session.header
    const best = entry.best
    const createdAt = Number.isFinite(header.createdAt) ? header.createdAt : null
    return {
      sessionId: header.id,
      title: null,
      cwd: typeof header.cwd === 'string' ? header.cwd : null,
      createdAt,
      updatedAt: best.time ?? entry.updatedAt ?? createdAt,
      turn: entry.turn ?? null,
      seq: best.seq,
      eventType: best.eventType,
      snippet: best.snippet,
      matchCount: 1,
      hasMoreHits: null,
      hits: [best],
    }
  })

  const data = {
    query: request.query,
    tookMs: Date.now() - startedAt,
    truncated: collection.truncated || entries.length > request.limit,
    items,
  }
  cacheWrite(searchCache, cacheKey, data, SEARCH_CACHE_MAX_ENTRIES)
  return data
}

// ── expand：按需补多命中 + turn ─────────────────────────────────────────────

/**
 * expand：可见性校验 → 缓存 → 标题 + 多命中/正文文档 → 组响应。
 *
 * 默认模式直接扫正文文档（不需要 FTS 的 per-session 查询，也不含工具输出）；
 * 工具模式沿用 FTS 多命中并用会话日志回填 turn。
 */
async function expand(ctx, body, signal) {
  const startedAt = Date.now()
  const provider = requireProvider(ctx)
  const request = normalizeExpandRequest(body)

  const { visibleIds, headers } = await getVisibleSessions(provider, signal)
  // 不可见（不存在 / 无 cwd / 子代理）一律 not-found，不泄漏会话存在性。
  if (!visibleIds.has(request.sessionId)) {
    throw new ApiError('not-found', '会话不存在或不可见')
  }

  const cacheKey = [request.sessionId, request.query, String(request.includeTools)].join('\u0000')
  const cachedData = cacheRead(expandCache, cacheKey, EXPAND_CACHE_TTL_MS)
  if (cachedData !== undefined) {
    return { ...cachedData, tookMs: 0, cached: true }
  }

  const header = headers.get(request.sessionId) ?? {}
  const titlePromise = readSessionTitle(provider, request.sessionId, signal)

  let hits = []
  let hasMoreHits = false
  let updatedAt = null
  let title = null
  let degraded = false

  if (request.includeTools) {
    // 工具模式：沿用 FTS 的多命中 + 会话日志回填 turn。
    const [resolvedTitle, hitInfo, snapshot] = await Promise.all([
      titlePromise,
      withPersistenceRetry(() => collectExpandedHits(provider, request.sessionId, request.query, buildEventFilters(true), signal)),
      readSessionSnapshot(provider, request.sessionId).catch(() => ({ events: [], ranges: [], updatedAt: null })),
    ])
    title = resolvedTitle
    rememberTurnEntry(request.sessionId, snapshot)
    let rawHits = hitInfo.hits
    if (hitInfo.degraded) {
      degraded = true
      const fallback = findCachedBestHit(request.sessionId, request.query, true)
      rawHits = fallback === null ? [] : [fallback]
    }
    for (const hit of rawHits) hit.turn = turnForSeq(snapshot.ranges, hit.seq)
    hits = rawHits
    hasMoreHits = hitInfo.hasMoreHits
    updatedAt = snapshot.updatedAt
  } else {
    // 正文模式（快速）：用 FTS 多命中 + 片段特征过滤工具参数，不额外读日志。
    const [resolvedTitle, hitInfo, turnEntry] = await Promise.all([
      titlePromise,
      withPersistenceRetry(() => collectExpandedHits(provider, request.sessionId, request.query, buildEventFilters(false), signal)),
      loadTurnEntry(provider, request.sessionId),
    ])
    title = resolvedTitle
    let rawHits = hitInfo.hits
    if (hitInfo.degraded) {
      degraded = true
      const fallback = findCachedBestHit(request.sessionId, request.query, false)
      rawHits = fallback === null ? [] : [fallback]
    }
    rawHits = rawHits.filter((hit) => !(hit.eventType === 'assistant/message' && looksLikeToolText(hit.snippet)))
    // 首屏最佳命中（客户端带上来的 seq）排第一，保证展开列表与点击目标一致。
    const anchor = findCachedBestHit(request.sessionId, request.query, false)
    if (anchor !== null && Number.isInteger(request.seq) && anchor.seq === request.seq
      && !(anchor.eventType === 'assistant/message' && looksLikeToolText(anchor.snippet))) {
      rawHits = [anchor].concat(rawHits.filter((hit) => hit.seq !== anchor.seq))
    }
    for (const hit of rawHits) hit.turn = turnForSeq(turnEntry.ranges, hit.seq)
    hits = rawHits.slice(0, EXPAND_HITS_LIMIT)
    hasMoreHits = (hitInfo.hasMoreHits || rawHits.length > hits.length) && !hitInfo.degraded
    updatedAt = turnEntry.updatedAt
  }

  const createdAt = Number.isFinite(header.createdAt) ? header.createdAt : null
  const data = {
    sessionId: request.sessionId,
    title,
    // 最后一条事件时间；readSession 失败时回退 header.createdAt。
    updatedAt: updatedAt ?? createdAt,
    hits,
    matchCount: hits.length,
    hasMoreHits,
    tookMs: Date.now() - startedAt,
  }

  // 降级结果不缓存：给下一次重试留机会。
  if (!degraded) {
    cacheWrite(expandCache, cacheKey, data, EXPAND_CACHE_MAX_ENTRIES)
  }
  return data
}

// ── turn 映射 ───────────────────────────────────────────────────────────────

/**
 * 读取一个会话的 turn 区间表（`turn/start` 的 `{seq, turn}`，升序）与最后
 * 事件时间，带 60 秒 / 64 项 LRU 缓存。
 *
 * `readSession()` 是一次全量日志读取且没有 signal 形参（sessionQuery 契约），
 * 所以无法中途取消；失败不写缓存，本轮返回空 ranges（turn 全部为 null）。
 */
async function loadTurnEntry(provider, sessionId) {
  const cached = cacheRead(turnCache, sessionId, TURN_MAP_TTL_MS)
  if (cached !== undefined) return cached

  let value
  try {
    const loaded = await provider.readSession(sessionId)
    const ranges = []
    let updatedAt = null
    const events = Array.isArray(loaded?.events) ? loaded.events : []

    // 只遍历一遍：turn/start 的 seq 天然升序（按日志顺序 append），可直接
    // 作为二分查找的区间表；最后一条事件的时间即 updatedAt。
    for (const event of events) {
      if (event === null || typeof event !== 'object') continue
      if (event.type === 'turn/start') {
        const turn = event.data?.turn
        if (Number.isInteger(turn) && turn >= 0 && Number.isInteger(event.seq)) {
          ranges.push({ seq: event.seq, turn })
        }
      }
      if (Number.isFinite(event.time) && (updatedAt === null || event.time > updatedAt)) {
        updatedAt = event.time
      }
    }
    value = { ranges, updatedAt }
  } catch {
    return { ranges: [], updatedAt: null }
  }

  cacheWrite(turnCache, sessionId, value, TURN_MAP_MAX_ENTRIES)
  return value
}

/**
 * 二分查找「不大于 seq 的最近一个 turn」。
 *
 * 命中事件本身不是 turn/start 时（比如 assistant/message），它属于前面最近的
 * 那个 turn/start；seq 小于第一个 turn/start 时返回 null。
 */
function turnForSeq(ranges, seq) {
  if (!Array.isArray(ranges) || ranges.length === 0) return null
  if (!Number.isInteger(seq)) return null

  let low = 0
  let high = ranges.length - 1
  let best = null
  while (low <= high) {
    const mid = (low + high) >> 1
    if (ranges[mid].seq <= seq) {
      best = ranges[mid].turn
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return best
}

// ── locate：点击时才把 seq 换算成 turn ─────────────────────────────────────

/**
 * locate：可见性校验 → turn 缓存/readSession 二分 → `{ turn }`。
 * `seq` 缺省或为 null 时（标题命中场景）直接返回 turn=null，不读日志。
 */
async function locate(ctx, body, signal) {
  const startedAt = Date.now()
  const provider = requireProvider(ctx)
  const sessionId = normalizeSessionId(body.sessionId)

  let seq = null
  if (body.seq !== undefined && body.seq !== null) {
    if (!Number.isInteger(body.seq) || body.seq < 0) {
      throw new ApiError('bad-request', 'seq 必须是非负整数或 null')
    }
    seq = body.seq
  }

  const { visibleIds } = await getVisibleSessions(provider, signal)
  if (!visibleIds.has(sessionId)) {
    throw new ApiError('not-found', '会话不存在或不可见')
  }

  let turn = null
  if (seq !== null) {
    const turnEntry = await loadTurnEntry(provider, sessionId)
    turn = turnForSeq(turnEntry.ranges, seq)
  }

  return { sessionId, seq, turn, tookMs: Date.now() - startedAt }
}

// ── HTTP 入口 ───────────────────────────────────────────────────────────────

/**
 * 路由入口。
 *
 * - 只接受 POST；其它方法回 405 JSON（唯一非 200 的业务响应）。
 * - 监听 `res` 的 close 生成 AbortController，把 signal 一路传给 sessionQuery。
 * - 所有异常收敛成 `{ ok:false, error:{ code, message } }`，永不向上抛；
 *   意外错误按 60 秒窗口节流记一条日志。
 */
async function handleRequest(ctx, req, res) {
  if (req === null || typeof req !== 'object' || req.method !== 'POST') {
    sendJson(res, 405, fail('method-not-allowed', '该接口只接受 POST 请求'))
    return
  }

  const controller = new AbortController()
  const signal = controller.signal
  if (typeof res?.on === 'function') {
    res.on('close', () => {
      // 正常响应结束也会触发 close，writableEnded 用来排除这一种。
      if (res.writableEnded !== true) controller.abort()
    })
  }

  let body
  try {
    body = await readJsonBody(req, signal)
  } catch (error) {
    if (error instanceof ApiError && error.code !== 'aborted') {
      sendJson(res, 200, fail(error.code, error.message))
    }
    return
  }

  const action = body.action
  if (typeof action !== 'string' || action === '') {
    sendJson(res, 200, fail('bad-request', '缺少 action 字段'))
    return
  }

  try {
    switch (action) {
      case 'ping': {
        // version 2：客户端据此判断 Host 半是否已升级（v1 为 1）。
        const provider = getSessionQuery(ctx)
        sendJson(res, 200, {
          ok: true,
          data: { indexed: provider !== null && hasSearchApi(provider), version: 3 },
        })
        return
      }
      case 'search': {
        const data = await search(ctx, body, signal)
        sendJson(res, 200, { ok: true, data })
        return
      }
      case 'expand': {
        const data = await expand(ctx, body, signal)
        sendJson(res, 200, { ok: true, data })
        return
      }
      case 'locate': {
        const data = await locate(ctx, body, signal)
        sendJson(res, 200, { ok: true, data })
        return
      }
      default: {
        sendJson(res, 200, fail('bad-request', `未知 action：${action}`))
        return
      }
    }
  } catch (error) {
    // 客户端已断开：没有可写的连接，直接结束。
    if (error instanceof ApiError) {
      if (error.code === 'aborted') return
      sendJson(res, 200, fail(error.code, error.message))
      return
    }
    warnThrottled(ctx, error)
    sendJson(res, 200, fail('internal-error', errorMessage(error)))
  }
}

// ── Cordis 入口 ─────────────────────────────────────────────────────────────

/**
 * Cordis 插件入口。
 *
 * `inject` 声明 webServer 为硬依赖：没有 HTTP 载体的构建里本插件保持不激活。
 * 路由通过子 fiber 的 `effect` 挂载，插件卸载/热重载时 disposer 会移除路由，
 * 不会留下重复注册。
 */
export const inject = ['webServer']

export function apply(ctx, config) {
  void config // 当前没有可调参数；配置项留给后续需要时再加。

  ctx.inject(['webServer'], (scope) => {
    scope.effect(
      () => scope.webServer.register({
        kind: 'exact',
        path: API_PATH,
        handler: (req, res) => {
          // 返回 Promise，让 webServer 的 `await route.handler(...)` 等到本次
          // 请求处理完；内部再兜一层 catch，保证任何意外都尝试写回 JSON。
          return handleRequest(ctx, req, res).catch((error) => {
            warnThrottled(ctx, error)
            sendJson(res, 200, fail('internal-error', errorMessage(error)))
          })
        },
      }),
      'session-search: http api',
    )
  })

  // ── 后台预热 ──────────────────────────────────────────────────────────────
  //
  // 索引配置为 `openAt: 'first-search'` 时，第一次 searchSessions 会同步构建
  // 索引并做首次 reconcile（4~6s）。这里在插件激活 2.5s 后用最便宜的请求
  // （query:'a', limit:1）把这份成本前移到空闲时，用户真正搜索时命中已建好的
  // 索引。要求：
  //   - 定时器 + AbortController 都注册在 ctx.effect 里，插件卸载/重载时清理；
  //   - 不 await、不阻塞 apply 主链路（异常静默，绝不 throw）；
  //   - sessionQuery 不存在时直接跳过（headless 构建没有索引服务）。
  ctx.effect(() => {
    const controller = new AbortController()
    const timers = new Set()

    const attemptWarmup = (attempt) => {
      if (controller.signal.aborted) return
      const provider = getSessionQuery(ctx)
      if (provider === null || typeof provider.searchSessions !== 'function') return
      // 先包一层 Promise.resolve，连同步 throw 也落进 catch。
      Promise.resolve()
        .then(() => provider.searchSessions(
          { query: WARMUP_QUERY, limit: 1 },
          { signal: controller.signal },
        ))
        .catch(() => {
          // 索引构建/观察偶发失败（例如 live 会话正在写入）：稍后重试，别让
          // 用户第一次搜索承担冷启动 + 失败。
          if (attempt >= 2) return
          const retry = setTimeout(() => {
            timers.delete(retry)
            attemptWarmup(attempt + 1)
          }, 2000)
          if (typeof retry.unref === 'function') retry.unref()
          timers.add(retry)
        })
    }

    const timer = setTimeout(() => attemptWarmup(0), WARMUP_DELAY_MS)
    // 不阻止进程退出（headless/测试场景）；正常服务进程里不会走到这里。
    if (typeof timer.unref === 'function') timer.unref()

    return () => {
      clearTimeout(timer)
      for (const pending of timers) clearTimeout(pending)
      timers.clear()
      // 卸载时取消在途的首次 reconcile（signal 会传进后端）。
      controller.abort()
    }
  }, 'session-search: warm index')
}
