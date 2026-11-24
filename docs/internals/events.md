# 事件桥：QQ → Koishi

收方向链路把子进程转发的 kernel 和 OneBot 11 事件翻译成 Koishi Session，并交给 `bot.dispatch()`。
发送方向见 [动作桥](actions.md)。

```
子进程 event 消息 { service, name, args }
  └─ driver.onEvent → NapukettoEventBridge.handle(payload)
       ├─ service === "Msg" && name === "onRecvMsg"
       │    └─ args[0] = RawMessage | RawMessage[]
       │         → validateRawMessage()（坏条目诊断后跳过，不影响同批其他条目）
       │         → 过滤启动前历史积压并分流撤回、成员变动和戳一戳灰条
       │         → 过滤系统占位消息
       │         → 按账号 + 频道 + 消息 ID 做有限窗口去重
       │         → 按频道进入有界队列（同频道串行，异频道并行）
       │              → adaptRawMessageWithMedia()
       │                   ├─ kernel toCanonicalElements()
       │                   ├─ 收向媒体富化（语音 silk → WAV，失败/超时降级透传）
       │                   └─ toKoishiElements()
       │              → SessionDispatcher.dispatch(fields)
       │                   → 消息预热 channel/user（失败 warn，继续派发）→ Bot.session()
       │                   → applySessionFields → dispatch（同步/异步失败均诊断）
       └─ service === "ob11"
            └─ args[0] → 结构校验 → 成员变动和请求转换，同时保留 bot.onOb11() 原始订阅
```

涉及代码：`src/bridge/events/bridge.ts`、`queue.ts`、`adapt.ts`、`validate.ts`、`notices.ts`、`src/shared.ts`、`voice-decode.ts`、`types.ts`；
`src/bot/dispatcher.ts` 的 `SessionDispatcher`。

## kernel 事件入口

`bridge.handle(payload)` 处理以下事件：

1. `service === "Msg"` 且 `name === "onRecvMsg"`：`args[0]` 是 `RawMessage` 或 `RawMessage[]`
   （QQ 会批量推送）。逐条校验并处理，非对象或结构非法的条目跳过。
2. `service === "ob11"`：`args[0]` 是 OneBot 11 原始事件对象，成员变动和请求可以生成标准事件。
   原始对象仍交给 `onOb11` 订阅者。

3. `Group/onRequest` 使用 loader 公开 schema 转换群邀请及待审批的入群请求，独立于 OB11 桥。

其他 service/name 由子进程透传，适配器不转换。

**结构校验**：元素转换前先确认适配器实际依赖的字段——`msgId` 非空字符串、`chatType` 是
kernel `ChatType` 的整数、`elements` 是数组且每个元素带整数 `elementType`；`senderUin` /
`peerUin` 若出现必须是字符串（缺省时由可验证的同一 UID 身份补足）。校验函数是纯函数（`validate.ts`），读取字段
自身抛错也按无效事件处理。通过后才进入 `toCanonicalElements()`，避免把坏载荷变成未处理异常。

**异常隔离与诊断**：单条坏消息、元素转换失败、富化失败、OB11 转换失败、OB11 订阅者异常以及
会话派发的同步抛错或 Promise 拒绝，都只影响当前事件或当前订阅者。诊断经事件桥的 `onError`
回调（生产接 bot logger 的 warn）上报，错误文本不拼接原始消息内容；后续有效事件继续送达。
会话派发由桥统一处理同步/异步失败，不会留下未处理的 Promise 拒绝。

**系统占位消息过滤**：`senderUin === "0"` 的消息跳过。QQ 在群通知等场景会把无内容的占位消息混在
批量推送里；派发它们只会让 koishi 对无价值消息创建 channel，并放大并发落库竞态。

**历史积压过滤**：每次订阅子进程的 IPC，以及已就绪子进程软重登进入 `sessioning` 时，记录订阅基准。
早于基准（宿主时间按秒取整再减 5 秒）的原始 `Msg/onRecvMsg` 消息会被跳过。5 秒用于容纳服务端与宿主的
时钟偏差。基准在 ready 前确定，启动期暂存的新消息仍会在 ready 后回放。缺失或非法的消息时间保留派发，
时间字段使用宿主当前时间。原始 OB11 订阅和历史查询保持各自的行为。

## 同频道顺序与有界队列

普通消息按 `selfId + channelId` 进入有界队列：同一频道串行完成「媒体富化 → 字段转换 →
dispatch」，因此慢语音不会让同频道后续文本抢先派发；不同频道各自推进，互不等待。
每频道默认最多积压 64 条、全进程 256 条。达到上限时该条消息立即派发（不再等待前序）
并经 `onError` 告警「消息队列饱和（已立即派发，顺序降级）」，队列深度不会无界增长。

软重登、停止、退出与账号不一致拒绝上线时，生命周期层调用 `bridge.cancelPending()`：
递增入站代次、中止运行中的富化/解码、丢弃排队消息并停止撤回回退计时器。旧代次结果在
派发前按代次校验丢弃，不会写入新会话或新去重记录。

## 普通消息去重

对能可靠确定频道的普通消息，事件桥使用 `selfId + channelId + msgId` 做有限窗口去重
（默认 10 分钟，最多保留 4096 条）。接收时先登记「进行中」；只有真正交给
`bot.dispatch()` 才提交到去重窗口，取消或未派发（`SessionDispatcher.dispatch` 返回
`false`）会释放登记，因此软重登后的重放仍可送达。不同消息 ID、不同频道或不同账号不会
互相吞掉；窗口内的重复（含上游重放）直接丢弃。撤回、成员变动等通知继续使用各自的事件
key 去重。

## 会话字段映射

`adaptRawMessage(msg, { selfId, platform, h })` 的输出：

| 场景 | `type` | `subtype` | `userId` | `channelId` | `guildId` | `isDirect` |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 群聊（`chatType=2`） | `message` | `group` | `senderUin` | `peerUin`（群号） | `peerUin`（群号） | `false` |
| 私聊（`chatType=1`） | `message` | `private` | `senderUin` | `private:<对端 QQ 号>` | 无 | `true` |
| 临时会话（`chatType=100`） | `message` | `private` | `senderUin` | `private:temp:<对端 QQ 号>` | 未知，省略 | `true` |

公共字段：

- `selfId` = 登录账号（优先登录快照 `self.uin`，缺省用配置 `selfId`）。
- `platform` = `"onebot"`。
- `timestamp` 使用毫秒。QQ NT 的秒值乘以 1000，毫秒值保留原精度。
- `messageId` = `msg.msgId`。
- 元素按下表映射。发送者昵称优先采用 `sendNickName`，Linux 昵称缺失时采用已观测的 `sendMemberName`，群消息也单独记录已知群名片。缺少可确认的发送者 QQ 号或频道时跳过。
- 临时会话 `peerUin` 是对端账号。普通消息没有已确认的来源群字段，戳一戳的 `fromGrpCodeOfTmpChat` 仅属于对应通知。
- 保留收到的自身消息及 `bot.onOb11()` 原始订阅。Koishi 4.18.11 的命令中间件过滤 `session.selfId === session.userId`。

**为什么 `type` 是 `message` 而不是 `message.group`**：satorijs `Bot.dispatch` 按 `session.type`
匹配事件别名组（如 `message` / `message-created`），再结合 subtype 派生具体事件。直接写
`message.group` 会让 emit 的事件名不落在别名组里，koishi 指令系统（监听 `message`）收不到。

`selfId` 在每条事件上重新求值，因此软重登后无需重建事件桥。

## 元素映射：canonical → koishi

| canonical | Koishi | 说明 |
| :--- | :--- | :--- |
| `text` | `text` | 通过 `attrs.content` 交给元素工厂转义 |
| `at` | `at` | 全体用 `type="all"`。用户 ID 使用 QQ 号，从本条载荷的 UID/UIN 配对、登录身份及同一宿主已观察的配对确认。未解析的 UID 降级为提及文本。 |
| `image` / `voice` / `video` / `file` | `img` / `audio` / `video` / `file` | 优先使用有效 URL，随后使用非空路径；本地绝对路径转为 `file:` URL。保留已知图片尺寸、媒体时长及附件名称。无来源的媒体显示类型占位文本。 |
| `face` | `face` | QQ 表情码 |
| `reply` | `session.quote` / `Message.quote` | 保留原生消息 ID、可确认的作者 QQ 号与引用时间；正文保留其余元素。 |
| `forward` / `json` / `xml` / `unknown` | `text` | 固定类型占位文本，避免把卡片内容或未知标签当作标记渲染。 |

`h` 通过 `HFn` 接口注入（生产 `bindKoishiH(koishiH)`，单测 `mockH()`），事件层不直接 import
koishi 运行时。

当前 loader 没有公开的任意 UID 批量查 UIN 动作。未观察到的第三方 UID 会保留原提及文本；需要上游发布该动作或在原生消息公开载荷中提供已解析的 QQ 号。

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
5. 输出 info 级 dispatch 日志，再 `this.dispatch(session)`。日志只记录会话元数据。

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
4. 解码并发（默认 2）与可消费缓存（默认 64 个目录）是两个独立名额：并发名额限制同时运行的
   SILK Worker，缓存名额限制供 Koishi 消费的 WAV。等待解码的队列最多 32 条，排队到解码完成
   的总截止时间为 10 秒；队列满、缓存满或超过截止时间时语音原样透传。
5. 每次解码使用独占临时目录，避免并发时同名 QQ 文件覆盖彼此。WAV 在解码完成后保留 10 分钟
   供 Koishi 消费，期满清理。清理失败最多重试 2 次（间隔 60 秒）；仍失败时释放缓存名额并保留
   受控残留（最多 32 个目录），避免反复失败让后续语音永久无法解码，也不删除消费期内的文件。
   进程非正常退出留下的目录由系统临时目录策略清理。
6. 目录未知、路径校验失败、解码失败或队列/缓存饱和时原样返回原路径，消息继续派发。
7. 软重登、停止或退出时，事件桥把取消信号传入富化器；`@napuketto/media` 会终止实际运行
   SILK WASM 的 Worker，取消产生的临时目录按上述清理规则处理。

事件桥对富化做了异步化与按频道串行化：`adaptRawMessageWithMedia()` 富化失败时先经 `onError`
诊断，再回退到普通元素；同频道消息等待前一条完成派发后才继续，异频道并行。`dispatch()` 回调
返回 Promise 时由事件桥接管拒绝，不留下未处理的 Promise。元素转换失败与富化失败分开处理，
前者丢弃当前事件并诊断，后者保留透传降级。

## OB11 原始事件

子进程 OB11 动作桥装配成功时，事件以 `{ service: "ob11", name: <post_type>, args: [event] }`
透出。`NapukettoEventBridge` 将收到的原始事件交给 `bot.onOb11(listener)`，原始回调仍逐条触发。

```ts
const off = bot.onOb11((event) => {
  // event.post_type: message | notice | request | meta_event
})
```

- 结构异常（非对象 / 缺字符串 `post_type`）诊断后丢弃；OB11 事件转换失败只影响标准事件生成，
  原始订阅继续。
- 单个订阅者抛错不影响其他订阅者，并通过事件桥的 `onError` 留下诊断。
- `ob11Actions: false`、入口解析失败或子进程降级时，不会有这类事件。

## 标准通知与请求

| Koishi 事件 | 证据与身份 |
| :--- | :--- |
| `message-deleted` | 群聊优先使用 OB11 `group_recall.tip_message_id` 与 `operator_id`，原生灰条提供可证实的回退。好友及临时会话使用可证实作者和对端的灰条。所有入口按频道与原生消息 ID 去重。 |
| `guild-member-added` / `guild-member-removed` | OB11 `group_increase` / `group_decrease` 给出群号、成员及可解析的操作者。目标为当前账号时派发 `guild-added` / `guild-removed`。 |
| `friend-added` | OB11 `friend_add` 来自好友快照差异，使用通知中的 QQ 号构造 `friend.user`。 |
| `guild-member-updated` | 收到 OB11 `group_card` 或 `group_title` 时，使用通知提供的成员名片或头衔。上游只在已有对应通知源时产生此类事件。 |
| `friend-request` | 原始 OB11 `friend` 请求，审批保留字符串 `flag`。 |
| `guild-request` | `Group/onRequest` 中的 `invitation`，邀请当前账号加入群。 |
| `guild-member-request` | `Group/onRequest` 中的 `join_request` 或 `invited_join_request`，等待本账号审批成员加入。 |

`Group/onRequest` 同时携带发起人、目标和审批引用。成员邀请使用目标成员作为 `member.user`，有可确认邀请人时写入 `operator`；
缺成员 QQ 号且无法从同一宿主已知 UID/UIN 解析时，保留原始 OB11 订阅。新版群请求仍完整进入原始 OB11 回调。审批方式见 [动作桥](actions.md#审批好友与入群申请)。

群撤回的 OB11 `message_id` 属于 OB11 消息表。Koishi 只消费可与原生消息 ID 合并的群撤回；缺少 OB11 时使用灰条，启用 OB11 时最多等待 500 毫秒以接纳可能补足的操作者。好友撤回 OB11 `user_id` 表示对端，缺少原作者及操作者语义，仍由原始订阅消费。无法关联的 ID 留在原始事件。标准事件去重独立于 `onOb11()`。

### 仅原始入口的通知

依据 [Satori 事件资源](https://satori.chat/zh-CN/protocol/events.html) 和 [上游 OB11 通知类型](https://github.com/NapukettoDev/Napuketto/blob/da84db076c1bdfadb97faca041cb869e01d42eea/packages/adapter/src/onebot11/event/notice.ts)：

| 来源 | 保持原始的依据 |
| :--- | :--- |
| `group_admin` | 只提供一项 QQ 管理员资格变化。标准 `guild-role-*` 描述角色资源变更，成员角色列表也无法从该通知重建。 |
| `group_ban` | 提供 QQ 禁言或解禁时长；标准成员资源没有对应禁言状态和时长字段。 |
| `group_upload` | 上传属于 QQ 群文件记录，通知缺少标准事件可表示的文件资源或可消费地址。普通消息含可靠文件路径时映射为文件元素。 |
| `offline_file` | 提供 QQ 离线文件通知；缺少标准消息所需的原生消息 ID 及消息关系。 |
| `group_essence` | QQ 加精与消息置顶是不同操作；OB11 消息 ID 也无法直接用于 Koishi 消息资源。 |
| `notify.poke` / `notify.lucky_notify` / `notify.honor` | 分别是用户动作、红包结果和荣誉；标准事件没有对应资源。戳一戳的临时来源只保留在这个通知中。 |
| `group_sign` | QQ 签到没有对应标准事件。 |
| `msg_emoji_like` / raw `Msg/onRecvSysMsg` `732:16` | OB11 发布类型只有声明，当前无接线。已知 raw 格式缺可确认的操作者，无法生成标准表态。 |
| 其他灰条及非请求群通知 | 缺少可验证的标准事件语义；已处理的群通知也不能作为新请求。 |
