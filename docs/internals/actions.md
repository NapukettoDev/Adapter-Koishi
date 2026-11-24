# 动作桥：Koishi → QQ

发方向把 koishi 的动作调用翻译成 IPC 请求，再落到子进程内的 kernel API 或 OneBot 11 动作。
收方向见 [事件桥](events.md)。

```
bot.internal.<method>()
  └─ NapukettoInternal
       ├─ parseChannelId(channelId, guildId)  → { chatType, peerUin }
       ├─ toCanonicalElements(content)        → CanonicalElement[]
       ├─ 媒体归一化（下载 / silk / data URL / 视频补全）
       └─ request("msg.sendMessage", params)  → IPC action → 子进程
```

涉及代码：`src/bridge/actions/internal.ts`、`ob11-resources.ts`、`elements.ts`、`codecs.ts`、`src/bridge/actions/media/`、`types.ts`。

## 动作入口与调用方

| 入口 | 调用方与契约 |
| :--- | :--- |
| Koishi `bot.sendMessage()` 与 `session.send()` | 普通插件和会话回复走消息编码器，再经 `NapukettoInternal.sendMessage()` 处理图片、语音和视频。可由部署入口按权限委托发送，媒体按下述策略处理。 |
| `bot.internal._request(action, params?)` | 受信任的进程内插件调用宿主动作。参数、结果和错误保留原始契约，媒体由对应的上游动作处理。 |

`_request()` 可调两类动作：

| 动作面 | 命名 | 返回 |
| :--- | :--- | :--- |
| kernel 动作 | 点分：`msg.sendMessage`、`group.getGroupList` … | kernel API 原始值 |
| OneBot 11 动作 | snake_case：`send_like`、`set_group_ban`、`get_group_msg_history` … | OB11 信封 `{ status, retcode, data, message }`，`retcode === 0` 为成功 |

```ts
const res = await bot.internal._request("send_like", { user_id: 123456, times: 10 })
const info = await bot.internal._request("get_login_info")
```

OB11 动作面由配置 `ob11Actions`（默认 `true`）控制，装配细节见下文。
适配器的控制台只提供登录控制。部署若向低信任调用方提供消息发送，应在该入口校验调用方和目标，
只委托标准发送。聊天指令、Webhook 或第三方 API 的权限和目标限制由部署者负责，禁止把用户输入直接转交原始动作接口。按 [配置指南](../guides/configuration.md#出站媒体策略) 设置文件与下载策略。

## 高层方法

| 方法 | IPC 动作 | 参数/返回 |
| :--- | :--- | :--- |
| `sendMessage(channelId, content, guildId?)` | `msg.sendMessage` | `{ chatType, peerUin 或 peerUid, elements }`；返回 `string[]`，每条确认发送的消息保留其 msgId |
| `deleteMessage(channelId, messageId)` | `msg.recallMessage` | `{ chatType, peerUin 或 peerUid, msgIds: [messageId] }` |
| `getMessageList(channelId, next?, direction?, limit?, order?)` | `msg.fetchMessages` | `{ chatType, peerUin 或 peerUid, count, msgId? }`；返回 `Universal.BidiList<Universal.Message>` |
| `markAsRead(channelId)` | `msg.markRead` | `{ chatType, peerUin 或 peerUid }` |
| `getGroupList()` | `group.getGroupList` | 群列表（子进程侧走 `groupCache.listGroupsRefreshed()`） |
| `getFriendList()` | `friend.getFriendList` | 好友列表 |
| `getSelf()` | `login.getSelf` | 子进程登录自身信息 |

`sendMessage` 在 canonical 元素为空时直接返回 `[]`，不发请求。

私聊目标是当前已登录账号时，消息动作使用登录返回的 `peerUid`，避开 Linux 自聊缺少 UIN 查找记录的情况。其他频道仍按 `peerUin` 交给 loader。

### Koishi 用户、群成员与频道

| Bot 方法 | IPC 动作 | 契约 |
| :--- | :--- | :--- |
| `getUser(userId, guildId?)` | `get_stranger_info` / `get_group_member_info` | 无群上下文时查 QQ 资料，传入群号时使用该群的成员资料。返回 `Universal.User`，昵称缺失时使用 QQ 号。 |
| `getGuildMember(guildId, userId)` | `get_group_member_info` | 返回 `Universal.GuildMember`，包含用户以及可用的群名片、头衔、角色和入群时间（毫秒）。 |
| `getGuildMemberList(guildId, next?)` | `get_group_member_list` | 一次返回 `{ data }`。上游无法解析 QQ 号的成员不会出现在结果里。 |
| `kickGuildMember(guildId, userId, permanent?)` | `set_group_kick` | 返回 `void`。仅 `permanent: true` 请求拒绝该成员再次入群。 |
| `muteGuildMember(guildId, userId, duration, reason?)` | `set_group_ban` | 返回 `void`。非负整数毫秒向上取整为秒，`0` 解除禁言。QQ 动作没有说明字段，`reason` 不传给宿主。 |
| `getChannelList(guildId, next?)` | `group.getGroupList` | 验证 Bot 所在群，返回 `{ data: [channel] }`。普通 QQ 群只有一个文本频道，频道 ID 和名称沿用群号和群名。群不存在时返回 `NOT_FOUND`。 |

成员列表和频道列表均无下一页，非空 `next` 返回 `INVALID_PARAM`。OB11 用户和群管理方法接受正整数形式的 QQ 号字符串，
IPC 参数使用 OB11 要求的安全整数。查询响应的数据或标识不匹配时返回 `INVALID_RESPONSE`。

用户、成员查询和群管理依赖默认启用的 OB11 动作桥。QQ 根据已登录机器人的群权限和目标成员角色决定是否允许踢人、禁言或审批，
适配器不会预先假定权限或把失败当成成功。OB11 业务失败时 `IpcError.code` 保留数字 `retcode` 的字符串，
例如 `"101"` 表示上游明确报告权限不足，`"102"` 表示上游报告资源或请求不存在。原生群管理也可能以通用错误 `"999"` 报告拒绝。
动作桥关闭或降级时由 IPC 返回动作不可用错误，频道查询继续使用 kernel。

### 消息历史

- 群聊使用群号，好友私聊使用 `private:<对端 QQ 号>`，临时会话使用 `private:temp:<对端 QQ 号>`。历史、撤回、标记已读共用同一会话寻址。
- 每条消息使用 QQ NT 的 `msgId`。发送者来自消息本身，频道来自查询目标，因此本人发出的私聊也在对端频道里。
  群聊带 `guild`。内容通过 [收向元素映射](events.md#元素映射canonical--koishi) 生成，引用通过结构化 `quote` 返回。发送时间统一为毫秒，非法或缺失时省略时间字段。
- `direction` 缺省为 `before`。IPC 只支持从最新消息或给定锚点向更早查找，`after` 和 `around`
  返回 `UNSUPPORTED`。`order` 缺省为 `asc`（旧到新），也可用 `desc`（新到旧）。
- `limit` 缺省为 20，须为正整数。适配器会额外读取一条来确认还可翻页，续页也额外留出锚点位置，
  IPC 的请求条数限制在有符号 32 位整数范围内。
  当前页排除锚点和重复 ID。还有更早消息时，`next` 和 `prev` 都是当前页最早的消息 ID，与显示顺序无关。
- 直接构造 `NapukettoInternal` 时，调用历史查询需要传入 Koishi 元素工厂 `h`。Bot 会自动装配该选项。

当前标准 Bot 没有接入 `getMessage` 和 `createReaction`。`msg.fetchMessages` 按锚点读历史，
没有按 ID 精确取回锚点消息的契约。OB11 `get_msg` 和 `set_msg_emoji_like` 使用子进程分配的 `message_id`；
Koishi 实时消息、历史和撤回使用原生 `msgId`。表态的原生调用还需要该消息的 `msgSeq` 和 QQ 表情 ID。
上游分别跟进[按原生 ID 查消息](https://github.com/NapukettoDev/Napuketto/issues/172)
和[按原生 ID 添加表态](https://github.com/NapukettoDev/Napuketto/issues/173)。

## channelId 解析

`parseChannelId(channelId, guildId?)`：

| channelId | guildId | chatType | peerUin |
| :--- | :--- | :--- | :--- |
| 群号（不以 `private:` 开头） | 任意 | `2`（GROUP） | channelId |
| `private:<uin>` | 未提供或空 | `1`（C2C） | uin |
| `private:temp:<uin>` | 任意 | `100`（TEMP 临时会话） | uin |
| `private:<uin>` | 有值（仅发送兼容） | `100`（TEMP 临时会话） | uin |

临时路由按 loader 的 `chatType` 与对端 UIN 寻址。当前公开 `Peer` 未提供临时来源群字段；能否按同一对端区分多个来源群需上游与真机确认。旧调用方可迁移到 `private:temp:<uin>`。

## 元素反向映射

`toCanonicalElements(content)` 接受字符串、数组、单个元素或 `null`/`undefined`：

- `string` → 单个 text（空串 → `[]`）。
- 数组 → 逐项递归并展平。
- 带 `type` 的对象（h 实例）→ 按下表转换。
- 数字和布尔值转换成文本；其余非元素值跳过。

| koishi | canonical | 说明 |
| :--- | :--- | :--- |
| `text` | `{ type: "text", text }` | 内容取 `attrs.content` 优先，children join 兜底 |
| `br` | `{ type: "text", text: "\n" }` | |
| `at` | `{ type: "at", target }` | `type="all"` 与旧 `id="all"` 都映射为全体，用户提及使用 `id` |
| `img` / `image` | `{ type: "image", path }` | `attrs.src`；`file://` → `fileURLToPath`；本地路径转正斜杠；http(s) 透传，发送前下载 |
| `face` | `{ type: "face", id }` | |
| `audio` | `{ type: "voice", path }` | 与 img 相同的 src 处理 |
| `video` | `{ type: "video", path }` | 发送前补缩略图/宽高/时长 |
| `quote` | `{ type: "reply", messageId }` | |
| `p` | 子元素 | 与相邻内容之间补一处换行 |
| `message` | 消息边界 | 先发送前面的内容，再递归处理容器里的独立消息，空容器只分隔消息 |
| 其他 | 文本、子元素或类型占位 | 保留格式容器的子元素，不序列化未知标签或属性。转发元信息不作为普通消息重放。 |

发向的图片、音频及视频必须有非空字符串 `src`，否则返回 `INVALID_PARAM`。

**路径规范化**：本地媒体路径统一把 `\` 转成 `/`。NT 的 rich media 服务按 URL 语义解析路径，
反斜杠路径会读不到文件（表现为 `rich media transfer failed`）。

## 发送媒体管线

Koishi `sendMessage()` 为图片（`img` / `image`）、语音（`audio`）和视频（`video`）
分别处理 HTTP(S)、调用方本地路径、`file://` 和符合媒体类型的 `data:` URL。

1. 处理调用方的本地路径和 `file://`。启用目录白名单时，解析实际路径并核对打开句柄的普通文件身份。
   从该句柄将内容复制到本次发送的独占临时目录，转码、探测和 IPC 都使用副本。图片和语音最多 30 MiB，视频最多 100 MiB。
   检查失败或复制时检测到源文件变化会中止发送。`legacy` 保留原路径行为。
2. HTTP(S) 使用 `@napuketto/media` 流式落盘，单文件上限为图片/语音 30 MiB、视频 100 MiB，
   15 秒覆盖跳转和读取。相同媒体类型及 URL 在一次发送中复用。优先按可识别的文件内容定扩展名，
   其次使用 URL 扩展名。下载失败或出站地址被拒绝会发占位文本及类别告警，其他元素继续发送。白名单拒绝的调用方本地文件会中止本次发送。
3. 图片、语音与视频的 data URL 支持 base64 和百分号编码。格式非法、内容为空或超限会中止发送。
4. 非 SILK 语音在适配器独占目录中调用 `encodePcmToSilk`。转码失败继续使用原音频并记录告警。
   已有的 SILK（含 QQ 的前导字节变体）原样使用。
5. 视频尝试提取缩略图、宽高和时长，再调用 `msg.sendMessage`。探测或抽帧失败会继续尝试发送。
   标准发送一次最多 16 项媒体（重复引用也计入），媒体输入、转码和缩略图合计最多 120 MiB。
   文件在账号目录下的 `outbound-media` 独占子目录中准备，宿主确认结果后清理。IPC 超时或连接断开时为宿主留出
   2 分钟消费窗口，再尝试清理。后续创建工作目录时回收已退出进程留下超过 24 小时的目录。调用方文件由调用方管理。

OB11 的发送消息、下载、头像、群公告图和闪传等由上游动作执行媒体授权、单文件限制及缓存管理。
标准发送的单消息预算只用于 Koishi 媒体准备。OB11 的单消息预算由[上游跟踪](https://github.com/NapukettoDev/Napuketto/issues/181)。
`ob11Actions: false` 关闭 OB11 桥，原始 kernel 动作仍由 `_request()` 调用。

## 子进程侧的动作实现

kernel 动作面（launch 已就绪）：

| 动作 | 行为 |
| :--- | :--- |
| `msg.sendMessage` | 解析 peer（`peerUid` 直通；否则群号直用 / 私聊 `uinToUid`），群聊 `at` 目标批量转 uid 并补显示名，再调 `msgApi.sendMessage` |
| `msg.recallMessage` | 过滤空 msgId 后 `msgApi.recallMessage` |
| `msg.fetchMessages` | `{ count = 20, msgId? }` → `msgApi.fetchMessages` |
| `msg.markRead` | `msgApi.markRead` |
| `group.getGroupList` | `groupCache.listGroupsRefreshed()`（列表来自缓存，刷新由内核事件维护） |
| `friend.getFriendList` | `friendApi.getFriendList()` |
| `login.getSelf` | 返回登录自身信息 |
| `login.refreshQr` | 登录期即可用；调用 kernel `refreshQr()`，返回是否触发了新码 |

`diag.*` 动作是原生调用诊断入口（`diag.sessionCall`、`diag.engineCall`、`diag.richMediaTmpPaths` 等），
默认关闭，`_request()` 始终拒绝它们。受信任的进程内插件可在指定账号开启 `diagnostics: true`，
再迁移到 `bot.internal.requestDiagnostic()`。宿主另行限制可调用的原生方法；不要把这个方法暴露给部署入口。
包括原始 `msg.sendMessage` 在内的 kernel 动作按原始参数执行，可绕过标准发送的媒体准备。保留给受信任的进程内集成。

## OneBot 11 动作面

**装配**（默认开启）：

1. `resolveLaunchOptions` 解析 `@napuketto/adapter` 与 `@napuketto/network` 的磁盘入口
   （`adapterEntry` / `networkEntry`，可用配置覆盖），经 launcher 注入
   `NAPUTO_ADAPTER_ENTRY` / `NAPUTO_NETWORK_ENTRY`。任一入口解析失败 → 记录降级，子进程不挂载。
2. 子进程登录成功后，loader 动态 import adapter 的 `onebot11` / `core` 子路径与 network 入口，
   实例化 `NapukettoOneBot11Adapter`，只调用 `subscribeOnly()`：接收链路生效，**不启动 HTTP/WS**。
3. loader 将已安装的 OneBot 11 注册表（含别名）挂到 IPC，并读取当前 QQ 账号的 `onebot11.media`。
   适配器用 Koishi 的远程策略和显式目录生成该账号配置。OB11 保留上游按文件限制及缓存生命周期。`OB11 动作名` 与 kernel 点分名空间分开。
4. OB11 事件经桥适配器 → `event { service: "ob11", name: post_type, args: [event] }`。
5. 动态 import / 构造 / 挂载失败只打日志，保留纯 kernel 动作面，登录链路不受影响。

**调用**：统一走 `bot.internal._request()`，参数与 OneBot 11 规范一致，响应是标准信封。
动作 handler 内部的 zod 校验与 kernel 错误映射在子进程完成，**不会因业务错误抛异常**；调用方看
`status` / `retcode`。

**事件**：`bot.onOb11(listener)`（见 [事件桥](events.md#ob11-原始事件)）。

## 审批好友与入群申请

| 标准事件 | 审批方法 |
| :--- | :--- |
| `friend-request` | `bot.handleFriendRequest(messageId, approve, comment?)` 调用 OB11 `set_friend_add_request`，同意时可设置好友备注。 |
| `guild-request` | `bot.handleGuildRequest(messageId, approve, comment?)` 处理当前 Bot 收到的群邀请。 |
| `guild-member-request` | `bot.handleGuildMemberRequest(messageId, approve, comment?)` 处理管理员队列里的入群请求。 |

调用方应原样传入对应事件的 `session.messageId`。新版群请求的 ID 是不透明引用，记录发布事件的账号、群号、类型、队列和原始字符串序号。
适配器按 [loader 的公开 IPC 契约](https://github.com/NapukettoDev/Napuketto/blob/da84db076c1bdfadb97faca041cb869e01d42eea/packages/loader/docs/design.md#ipc-群请求与好友身份)
调用 `group.respondToRequest`，由宿主校验当前账号并执行审批。旧的裸 flag 继续可传给 `handleGuildMemberRequest`，经 OB11 审批。
原始 OB11 订阅的集成继续使用 OB11 的原始请求字段，多个队列匹配同一序号时同时传入 `doubt`、`group_id` 和 `request_kind`。
