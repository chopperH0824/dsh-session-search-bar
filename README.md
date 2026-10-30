# 会话搜索栏 · dsh-session-search-bar

**DeepSeek Harness 插件**：一个常驻在对话页顶部的搜索栏。输入关键词即可搜索所有历史会话的
**消息正文**，结果就地弹在输入框下方；点击结果会打开对应会话，并把对话滚动到**命中的那段文字**。

A persistent **session search bar** for DeepSeek Harness: keyword-search message bodies across past
sessions and jump straight to the matched text — no separate panel, no full-text index maintenance.

## 安装

```bash
# macOS Desktop 自带 CLI
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop add dsh-session-search-bar@1.0.0
```

把 `dsh-session-search-bar` 加入 `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles`，
然后**完全退出并重启** DeepSeek Harness。

本地开发 / tarball：

```bash
npm pack
dsh plugin --profile desktop add /absolute/path/to/dsh-session-search-bar-1.0.0.tgz
```

要求：Node.js ≥ 20，DSH 0.2.x（Web GUI）。插件无第三方运行时依赖、无构建步骤。

## 使用

- 对话页顶部、会话标题左侧有一个常驻搜索框（放大镜 +「搜索历史会话…」），点进去直接输入，**不需要打开任何独立面板**。
- 输入后 200ms 自动搜索，结果显示在输入框下方的浮层里：
  会话标题、工作区、相对时间、命中片段（关键词高亮）、来源（正文 / 工具 / 标题）。
- **默认只搜索消息正文**：用户消息本身就是正文；assistant 消息会过滤掉
  「工具调用参数」形态的命中（`bash {"command":...}`、JSON/转义片段等），
  工具输出（`tool/result`）、文件/附件块、reasoning 默认都不参与。
  点浮层顶部的「包含工具输出」chip 后，才会一并搜索 `tool/call`、`tool/result`
  以及 assistant 消息里的工具调用参数。过滤在 Host 侧按片段特征完成，**不额外读会话日志**。
- 片段以**纯文本**展示：会先去掉 Markdown / JSON 格式字符（`**`、反引号、`#` 标题、表格 `|`、
  链接/图片语法、花括号、字面 `\n` `\"` 转义、零宽字符等），再压掉多余空白，便于直接核对关键词是否命中。
- 浮层顶部可以切换「包含工具输出」和「工作区」筛选；右侧显示「找到 N 个会话 · X ms」。
- 点击某行：打开该会话，并把对话区**滚动到命中的那段文字**、用系统选中高亮它（2.4s）；
  目标是一个超长轮次/超长消息时也不会只停在轮次中间。
- 某会话有多处命中时，行右侧「N 处匹配 ›」可展开其余命中（展开时才向 Host 请求，不拖慢首屏）；
  点击展开里的某条 = 直接定位到那一条。
- 焦点在空输入框时显示最近搜索（localStorage，最多 8 条）。
- 键盘：`↑/↓` 选择、`Enter` 打开、`Esc` 关闭浮层/清空；点击浮层外部关闭。

## 性能（本机实测，13~20 个会话命中）

| 操作 | 耗时 |
| --- | --- |
| 正文搜索（新关键词） | **~0.8–2 s** |
| 同一查询重复（15s 结果缓存） | **< 100 ms**（`cached:true`） |
| 勾选「包含工具输出」后的搜索 | **~0.3–1 s** |
| 展开某会话的多处命中 | ~330 ms（之后 60s 缓存） |
| 点击结果取命中轮次（locate） | 0 ms（turn 缓存命中时） |

> 延迟主要来自 FTS 索引对「正在写入的当前会话」的 reconcile：搜索发生在一个很大的
> live 会话里时每次都要重新索引它；在其它会话/空闲时通常更快。

应用启动/插件重载后，Host 会在空闲约 2.5s 时**后台预热**索引，把首次构建（数秒）挪到空闲时；
用户第一次搜索通常不用再等构建。

## 工作原理

```
浏览器 (client.js)                          Host (index.js)
 conversation.header.leading 常驻搜索栏       ctx.webServer 路由
   search  ── POST {action:'search'}  ──────►  listSessions（15s 可见性缓存）
   expand  ── POST {action:'expand'}  ──────►  searchSessions 一次（≤2 页）
   locate  ── POST {action:'locate'}  ──────►  searchEvents / readSession（按需）
   uiWorkspace.openSession(id)               title / turn / 多命中只在 expand/locate 时读
   轮询 [data-conversation-session] [data-chat-turn] → 滚动 + 高亮
```

- 首屏 `search` **只调用一次** `searchSessions`（每次索引调用都会触发一次 reconcile，这是旧版慢的根因）；
  标题由浏览器端 `sessions` 快照补齐，轮次在点击时才用 `locate` 算。
- 搜索走后端 `@deepseek-ai/dsh-session-query`。本插件在补丁里自带一个隔离的
  `session-query-sqlite` 索引（`path: ':memory:'`、`openAt: first-search`），因为 profile
  默认挂载的索引被上层配置成 `openAt: never`（内置侧栏的内容搜索因此只匹配标题）。
  索引纯内存、随插件卸载释放，不写磁盘。
- 只有当前工作区可见、非子代理的会话会出现在结果里。
- 定位依赖宿主对话行的 `data-chat-turn` 与容器 `data-conversation-session`；目标轮次太旧时
  会先用 `loadThrough(seq)` 把历史拉起来。9 秒内没找到就只提示、不阻断打开会话。
- Host 路由和其它本地插件路由一样只绑定 loopback；它返回会话消息内容，请按本地文件的
  信任级别对待（不要在不可信的本机环境里暴露 DSH 端口）。

## 已知限制

- 搜索栏位于**对话页头部**：切到 Plugins / Settings 等非对话面板时不显示（回到对话页即恢复）。
- 首屏标题靠浏览器端会话快照补齐；不在任何已注册工作区里的历史会话会显示「未命名会话」。
- 正文模式下，如果 assistant 在**消息正文里**写了文件名/路径（例如交付物清单、Markdown 链接），
  它仍会被搜到——那是真正的正文文本，不是工具输出。
- assistant 正文过滤是片段特征启发式：极少数没有 JSON/转义痕迹的工具参数片段可能漏过；
  若发现漏网的工具输出，可以改成读日志的严格校验（会慢一些）。
- `search` 结果缓存 15s、展开缓存 60s、turn 缓存 60s：这期间新消息/新会话可能不会立刻出现。
- 定位是「尽力而为」：命中文字在折叠的工具调用分组里、或宿主未来改掉
  `data-chat-turn` / `data-conversation-session` 属性时，会退化为滚动到该消息行/轮次，仍不会阻断打开会话。
- 索引为内存索引：应用重启后第一次搜索需要重建（已用后台预热尽量掩盖）。
- 搜索按 FTS token/phrase 匹配（不是任意子串匹配）：`AI` 不会命中 `BRAID`。

## 开发

- `index.js` / `client.js` 均为普通 ESM / 浏览器 JS，无构建步骤、无第三方依赖。
- [SPEC-v2.md](SPEC-v2.md) 是当前接口契约与 UI 规范；[SPEC.md](SPEC.md) 是 v1 历史版本。
- 语法与打包检查：`npm run check`、`npm run pack:check`。

## License

MIT © [chopperH0824](https://github.com/chopperH0824)
