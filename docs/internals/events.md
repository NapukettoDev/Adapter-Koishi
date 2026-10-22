# 事件桥：QQ → Koishi

收方向链路把子进程转发出来的 kernel 事件翻译成 koishi session，并交给 `bot.dispatch()`。
发送方向见 [动作桥](actions.md)。

```
子进程 event 消息 { service, name, args }
  └─ driver.onEvent → NapukettoEventBridge.handle(payload)
       ├─ service === "Msg" && name === "onRecvMsg"
       │    └─ args[0] = RawMessage | RawMessage[]
       │         → 过滤系统占位消息
       │         → adaptRawMessageWithMedia()
       │              ├─ kernel toCanonicalElements()
       │              ├─ 收向媒体富化（语音 silk → WAV，可失败透传）
       │              └─ toKoishiElements()
       │         → bot.dispatchSession(fields)
       │              → 预热 channel/user → Bot.session() → applySessionFields → dispatch
       └─ service === "ob11"
            └─ args[0] → 分发给 bot.onOb11() 订阅者（不转 session）
```

涉及代码：`src/events/bridge.ts`、`adapt.ts`、`elements.ts`、`voice-decode.ts`、`types.ts`；
`src/bot/bot.ts` 的 `dispatchSession()` 与 `src/bot/utils/session.ts`。

## kernel 事件入口

`bridge.handle(payload)` 只处理两类：

1. `service === "Msg"` 且 `name === "onRecvMsg"`：`args[0]` 是 `RawMessage` 或 `RawMessage[]`
   （QQ 会批量推送）。逐条处理，非对象条目跳过。
2. `service === "ob11"`：`args[0]` 是 OneBot 11 原始事件对象，直接交给订阅者。

其余 service/name 一律忽略（当前不翻译群通知、加群/好友请求等）。

**系统占位消息过滤**：`senderUin === "0"` 的消息跳过。QQ 在群通知等场景会把无内容的占位消息混在
批量推送里；派发它们只会让 koishi 对无价值消息创建 channel，并放大并发落库竞态。

## 会话字段映射

`adaptRawMessage(msg, { selfId, platform, h })` 的输出：

| 场景 | `type` | `subtype` | `userId` | `channelId` | `guildId` | `isDirect` |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 群聊（`chatType=2`） | `message` | `group` | `senderUin` | `peerUin`（群号） | `peerUin`（群号） | `false` |
| 私聊（`chatType=1`） | `message` | `private` | `senderUin` | `private:<senderUin>` | 无 | `true` |
| 临时会话（`chatType=100`） | `message` | `private` | `senderUin` | `private:<senderUin>` | `peerUin`（群号） | `true` |

公共字段：

- `selfId` = 登录账号（优先登录快照 `self.uin`，缺省用配置 `selfId`）。
- `platform` = `"onebot"`。
- `timestamp` = `Number(msg.msgTime) * 1000`。
- `messageId` = `msg.msgId`。
- `elements` = 见下节。

**为什么 `type` 是 `message` 而不是 `message.group`**：satorijs `Bot.dispatch` 按 `session.type`
匹配事件别名组（如 `message` / `message-created`），再结合 subtype 派生具体事件。直接写
`message.group` 会让 emit 的事件名不落在别名组里，koishi 指令系统（监听 `message`）收不到。

`selfId` 在每条事件上重新求值，因此软重登后无需重建事件桥。

## 元素映射：canonical → koishi

| canonical | koishi | 说明 |
| :--- | :--- | :--- |
| `{ type: "text", text }` | `h("text", { content: text })` | **content 必须放 attrs**：`Element.toString()` 对 `text + attrs.content` 返回纯文本；放 children 会渲染成 `<text>…</text>`，导致 `content` getter 返回 XML，指令系统提取不到文本 |
| `{ type: "at", target }` | `h("at", { id: target })` | `target === "all"` 原样保留 |
| `{ type: "image", url?, path }` | `h("img", { src: url ?? path })` | koishi 标准元素是 `img`；url 优先，path 兜底 |
| `{ type: "face", id }` | `h("face", { id })` | QQ 表情码 |
| `{ type: "voice", path, url? }` | `h("audio", { src: url ?? path })` | 收向会先把可解析的 silk 路径替换为 WAV |
| `{ type: "reply", messageId }` | `h("quote", { id: messageId })` | |
| 其他（video/file/forward/json/xml/unknown） | `h("text", { content: "[type]" })` | 占位，保证消息仍可派发 |

`h` 通过 `HFn` 接口注入（生产 `bindKoishiH(koishiH)`，单测 `mockH()`），事件层不直接 import
koishi 运行时。

## session 写入规则

`dispatchSession(fields)` 不是直接给 session 赋所有字段，而是：

1. `bot.session({ type, subtype?, selfId, platform, timestamp })` 创建 session。
2. `applySessionFields(session, fields)`：必填字段直接赋；可选字段（`subtype` / `userId` /
   `channelId` / `guildId` / `messageId` / `isDirect`）只在有值时赋值，遵守
   `exactOptionalPropertyTypes`。
3. **只赋 `elements`，绝不赋 `content`**。satorijs 的 `content` 是 getter
   （`elements.join("")` 派生），而 setter 会用 `h.parse(value)` 覆盖 `elements`：结构化元素会丢失，
   内容含特殊字符时 `h.parse` 还可能抛错导致 dispatch 失败。
4. 先做 channel/user 预热（见 [Bot 集成的数据库预热](bot.md#数据库预热)），失败不阻断派发。
5. 输出一条 info 级 dispatch 日志（type/self/channel/user/isDirect/渲染文本），再 `this.dispatch(session)`。

`isDirect` 必须设置：它驱动 `event.channel.type`（DIRECT/TEXT）；不设置时私聊会被当群聊路由。

## 收向语音解码

`enrichReceiveVoice(elements)` 在 canonical → koishi 之前异步执行：

1. 只处理本地路径的 `voice` 元素（跳过 `http(s)://` 与 `data:`）。
2. `resolveNtFile(path)`：绝对路径存在则直用；否则把反斜杠转正斜杠，拼到
   `<home>/Documents/Tencent Files/nt_qq/global` 下探测。
3. `decodeSilkToWav(silk, { outDir: <tmpdir>/napuketto-voice })` 输出 WAV，供 koishi 侧播放。
4. 任何一步失败都原样返回原路径（fail-soft，不阻塞消息）。

WAV 落在系统临时目录，**不主动清理**：消费方（平台适配器/控制台）拉取时机不确定，交给 OS
临时目录回收。高频语音场景需要注意磁盘占用。

事件桥对富化做了异步化：`adaptRawMessageWithMedia()` 失败时回退到普通 `adaptRawMessage()`；
`dispatch()` 回调不等待 Promise。

## OB11 原始事件

子进程 OB11 动作桥装配成功时，事件以 `{ service: "ob11", name: <post_type>, args: [event] }`
透出。`NapukettoEventBridge` 把它们分发给 `onOb11` 订阅者（`bot.onOb11(listener)`），
**不翻译成 koishi session**：

```ts
const off = bot.onOb11((event) => {
  // event.post_type: message | notice | request | meta_event
})
```

- 结构异常（非对象 / 无 `post_type`）静默丢弃。
- 单个订阅者抛错不影响其他订阅者。
- `ob11Actions: false`、入口解析失败或子进程降级时，不会有这类事件。

## 当前不翻译的事件

- 群通知（成员增减、禁言、撤回通知等）→ 不会产生 koishi `notice`。
- 加群 / 加好友请求 → 不会产生 koishi `request`。
- 消息撤回 / 已读等状态事件 → 不派发。

需要这些信息时，通过 OB11 事件面或 `bot.internal._request()` 直接调用对应动作。
