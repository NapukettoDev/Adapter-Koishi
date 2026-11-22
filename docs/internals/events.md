# 事件桥：QQ → Koishi

收方向链路把子进程转发的 kernel 和 OneBot 11 事件翻译成 Koishi Session，并交给 `bot.dispatch()`。
发送方向见 [动作桥](actions.md)。

```
子进程 event 消息 { service, name, args }
  └─ driver.onEvent → NapukettoEventBridge.handle(payload)
       ├─ service === "Msg" && name === "onRecvMsg"
       │    └─ args[0] = RawMessage | RawMessage[]
       │         → 过滤启动前历史积压并分流撤回、成员变动和戳一戳灰条
       │         → 过滤系统占位消息
       │         → adaptRawMessageWithMedia()
       │              ├─ kernel toCanonicalElements()
       │              ├─ 收向媒体富化（语音 silk → WAV，可失败透传）
       │              └─ toKoishiElements()
       │         → SessionDispatcher.dispatch(fields)
       │              → 消息预热 channel/user → Bot.session() → applySessionFields → dispatch
       └─ service === "ob11"
            └─ args[0] → 成员变动和请求转换，同时保留 bot.onOb11() 原始订阅
```

涉及代码：`src/events/bridge.ts`、`adapt.ts`、`notices.ts`、`src/shared/protocol.ts`、`voice-decode.ts`、`types.ts`；
`src/bot/dispatcher.ts` 的 `SessionDispatcher`。

## kernel 事件入口

`bridge.handle(payload)` 只处理两类：

1. `service === "Msg"` 且 `name === "onRecvMsg"`：`args[0]` 是 `RawMessage` 或 `RawMessage[]`
   （QQ 会批量推送）。逐条处理，非对象条目跳过。
2. `service === "ob11"`：`args[0]` 是 OneBot 11 原始事件对象，成员变动和请求可以生成标准事件。
   原始对象仍交给 `onOb11` 订阅者。

其他 service/name 由子进程透传，适配器不转换。

**系统占位消息过滤**：`senderUin === "0"` 的消息跳过。QQ 在群通知等场景会把无内容的占位消息混在
批量推送里；派发它们只会让 koishi 对无价值消息创建 channel，并放大并发落库竞态。

**历史积压过滤**：每次订阅子进程的 IPC，以及已就绪子进程软重登进入 `sessioning` 时，记录订阅基准。
早于基准（宿主时间按秒取整再减 5 秒）的原始 `Msg/onRecvMsg` 消息会被跳过。5 秒用于容纳服务端与宿主的
时钟偏差。基准在 ready 前确定，启动期暂存的新消息仍会在 ready 后回放。缺失或非法的消息时间保留派发，
时间字段使用宿主当前时间。原始 OB11 订阅和历史查询保持各自的行为。

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
- `timestamp` 使用毫秒。QQ NT 的秒值乘以 1000，毫秒值保留原精度。
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

`SessionDispatcher.dispatch(fields)` 不是直接给 session 赋所有字段，而是：

1. `bot.session({ type, subtype?, selfId, platform, timestamp, member? })` 创建 session。
2. `applySessionFields(session, fields)`：必填字段直接赋；可选字段（`subtype` / `userId` /
   `channelId` / `guildId` / `messageId` / `operatorId` / `isDirect`）只在有值时赋值，遵守
   `exactOptionalPropertyTypes`。
3. **只赋 `elements`，绝不赋 `content`**。satorijs 的 `content` 是 getter
   （`elements.join("")` 派生），而 setter 会用 `h.parse(value)` 覆盖 `elements`：结构化元素会丢失，
   内容含特殊字符时 `h.parse` 还可能抛错导致 dispatch 失败。
4. 普通消息先做 channel/user 预热（见 [Bot 集成的数据库预热](bot.md#数据库预热)），失败不阻断派发。
5. 输出 info 级 dispatch 日志，再 `this.dispatch(session)`。只有普通消息的日志包含渲染文本。

`isDirect` 必须设置：它驱动 `event.channel.type`（DIRECT/TEXT）；不设置时私聊会被当群聊路由。

## 收向语音解码

`enrichReceiveVoice(elements, dataRoot)` 在 canonical → koishi 之前异步执行。语音路径来自
`RawMessage.elements[].pttElement.filePath`，kernel 转成 canonical 时保留该值。Windows 和 Linux
均可能收到绝对路径，相对路径以宿主的 QQ `nt_qq/global` 目录为基准。

1. 只处理本地路径的 `voice` 元素（跳过 `http(s)://` 与 `data:`）。
2. Linux 自建宿主和调试沙箱复用传给子进程的数据根，经 kernel 的 `resolveQqGlobalPath` 得到基准。
   普通 Windows 宿主通过 QQ 获取实际目录（可由用户自定义），当前 loader IPC 不传递该值，适配器原样派发语音元素。
3. `resolveQqVoiceFile` 统一相对路径的分隔符，拒绝父目录跳转，并解析基准和候选文件的真实路径。
   解析符号链接或 Windows 目录联接后，只有基准目录内的普通文件才会交给解码器。
4. 每次解码使用独占临时目录，避免并发时同名 QQ 文件覆盖彼此。WAV 供 Koishi 消费 10 分钟，
   期满后清理。进程最多保留 64 个解码中或等待消费的 WAV，达到上限时新语音原样透传。
   Bot 停止后，已派发的 WAV 仍可能被 Koishi 消费，继续由 TTL 清理。进程非正常退出留下的目录由系统临时目录策略清理。
5. 目录未知、路径校验失败或解码失败时原样返回原路径，消息继续派发。

事件桥对富化做了异步化：`adaptRawMessageWithMedia()` 失败时回退到普通 `adaptRawMessage()`；
`dispatch()` 回调不等待 Promise。

## OB11 原始事件

子进程 OB11 动作桥装配成功时，事件以 `{ service: "ob11", name: <post_type>, args: [event] }`
透出。`NapukettoEventBridge` 将收到的原始事件交给 `bot.onOb11(listener)`，原始回调仍逐条触发。

```ts
const off = bot.onOb11((event) => {
  // event.post_type: message | notice | request | meta_event
})
```

- 结构异常（非对象 / 无 `post_type`）静默丢弃。
- 单个订阅者抛错不影响其他订阅者。
- `ob11Actions: false`、入口解析失败或子进程降级时，不会有这类事件。

## 标准通知与请求

| Koishi 事件 | 输入 | `userId` | `channelId` / `guildId` | `messageId` | `ob11Actions: false` |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `message-deleted` | raw `Msg/onRecvMsg` 的撤回灰条 | 原消息发送者 QQ 号 | 群号 / 群号，或 `private:<对端 QQ 号>` | 原生 `msgId` | 可用 |
| `guild-member-added` / `guild-member-removed` | OB11 `group_increase` / `group_decrease` | 加入或退出的成员 QQ 号 | 群号 / 群号 | 无 | 不可用 |
| `guild-added` / `guild-removed` | 上述通知的目标是登录账号 | 登录账号 QQ 号 | 群号 / 群号 | 无 | 不可用 |
| `friend-request` | OB11 `request_type=friend` | 申请人 QQ 号 | `private:<申请人 QQ 号>` | `flag`（`BuddyReq.reqTime`） | 不可用 |
| `guild-member-request` | OB11 `request_type=group`、`sub_type=add` | 申请人 QQ 号 | 群号 / 群号 | `flag`（`GroupNotify.seq`） | 不可用 |

- 撤回使用 raw `msgId`，与实时消息和历史消息共享 ID。OB11 撤回的 `message_id` 是 `msgSeq`，
  继续交给原始订阅者。私聊使用对端 QQ 号定位频道，包括机器人自己撤回的情况。
  只能依据 raw 载荷确认操作者 QQ 号时才填写 `operatorId`，无法确认时省略。缺少原消息发送者、
  频道或原生消息 ID 时跳过。
- 群成员变动使用 OB11 已回填为 QQ 号的 `operator_id`。零值和无效 QQ 号视为缺失。
  成员相关 Session 同时携带 `event.member.user.id`。Koishi 4.18.11 同时会分发 `guild-member-deleted` 和 `guild-deleted` 旧别名。
- 请求留言使用文本元素承载，缺失时使用空串。将 `session.messageId` 原样传给
  [审批方法](actions.md#审批好友与入群申请)。缺必要 ID 的事件只留在适用的原始入口。
  OB11 的 `invite` 混合机器人受邀和需管理员批准的成员邀请，继续由原始订阅消费。
- 每类标准事件只从一个入口产生。同一 Bot 的有界去重记录跨软重登保留。撤回按频道和原生消息 ID，
  成员变动按事件类型、群号、成员及上游时间，请求按类型、申请人、群号（如有）和 flag。
  标准去重不影响原始订阅。调用 `onOb11` 返回的函数可随时退订，进程更换无需重新注册。
- 戳一戳针对用户，没有消息 ID，仅通过原始 OB11 订阅提供（桥装配成功时）。表情回应的 raw `732:16`
  载荷包含群号、消息序号和表情，但缺可用的实际操作者。当前发布的 OB11 仅声明 `msg_emoji_like`，
  没有该通知的接线。因此这两类载荷均不产生 Koishi `reaction-added` 或 `reaction-removed`。
