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

涉及代码：`src/actions/internal.ts`、`elements.ts`、`channel.ts`、`media.ts`、`types.ts`。

## 两个动作面

`NapukettoInternal._request(action, params?)` 是统一入口，可调两类动作：

| 动作面 | 命名 | 返回 |
| :--- | :--- | :--- |
| kernel 动作 | 点分：`msg.sendMessage`、`group.getGroupList` … | kernel API 原始值 |
| OneBot 11 动作 | snake_case：`send_like`、`set_group_ban`、`get_group_msg_history` … | OB11 信封 `{ status, retcode, data, message }`，`retcode === 0` 为成功 |

```ts
const res = await bot.internal._request("send_like", { user_id: 123456, times: 10 })
const info = await bot.internal._request("get_login_info")
```

OB11 动作面由配置 `ob11Actions`（默认 `true`）控制，装配细节见下文。

## 高层方法

| 方法 | IPC 动作 | 参数/返回 |
| :--- | :--- | :--- |
| `sendMessage(channelId, content, guildId?)` | `msg.sendMessage` | `{ chatType, peerUin 或 peerUid, elements }`；返回 `string[]`（0 或 1 个 msgId） |
| `deleteMessage(channelId, messageId)` | `msg.recallMessage` | `{ chatType, peerUin 或 peerUid, msgIds: [messageId] }` |
| `getMessageList(channelId, next?, direction?, limit?, order?)` | `msg.fetchMessages` | `{ chatType, peerUin 或 peerUid, count, msgId? }`；返回 `Universal.BidiList<Universal.Message>` |
| `markAsRead(channelId)` | `msg.markRead` | `{ chatType, peerUin 或 peerUid }` |
| `getGroupList()` | `group.getGroupList` | 群列表（子进程侧走 `groupCache.listGroupsRefreshed()`） |
| `getFriendList()` | `friend.getFriendList` | 好友列表 |
| `getSelf()` | `login.getSelf` | 子进程登录自身信息 |

`sendMessage` 在 canonical 元素为空时直接返回 `[]`，不发请求。

私聊目标是当前已登录账号时，消息动作使用登录返回的 `peerUid`，避开 Linux 自聊缺少 UIN 查找记录的情况。其他频道仍按 `peerUin` 交给 loader。

### 消息历史

- 群聊使用群号，好友私聊使用 `private:<对端 QQ 号>`。接口没有临时会话所需的群上下文。
- 每条消息使用 QQ NT 的 `msgId`。发送者来自消息本身，频道来自查询目标，因此本人发出的私聊也在对端频道里。
  群聊带 `guild`。内容通过 [收向元素映射](events.md#元素映射canonical--koishi) 生成，引用同时以
  `quote.id` 和引用元素返回。发送时间统一为毫秒，非法或缺失时省略时间字段。
- `direction` 缺省为 `before`。IPC 只支持从最新消息或给定锚点向更早查找，`after` 和 `around`
  返回 `UNSUPPORTED`。`order` 缺省为 `asc`（旧到新），也可用 `desc`（新到旧）。
- `limit` 缺省为 20，须为正整数。适配器会额外读取一条来确认还可翻页，续页也额外留出锚点位置，
  IPC 的请求条数限制在有符号 32 位整数范围内。
  当前页排除锚点。还有更早消息时，`next` 和 `prev` 都是当前页最早的消息 ID，与显示顺序无关。
- 直接构造 `NapukettoInternal` 时，调用历史查询需要传入 Koishi 元素工厂 `h`。Bot 会自动装配该选项。

## channelId 解析

`parseChannelId(channelId, guildId?)`：

| channelId | guildId | chatType | peerUin |
| :--- | :--- | :--- | :--- |
| 群号（不以 `private:` 开头） | 任意 | `2`（GROUP） | channelId |
| `private:<uin>` | 未提供或空 | `1`（C2C） | uin |
| `private:<uin>` | 有值 | `100`（TEMP 临时会话） | uin |

与事件桥的会话映射互为逆运算。

## 元素反向映射

`toCanonicalElements(content)` 接受字符串、数组、单个元素或 `null`/`undefined`：

- `string` → 单个 text（空串 → `[]`）。
- 数组 → 逐项递归并展平。
- 带 `type` 的对象（h 实例）→ 按下表转换。
- 其他非空值 → `String(value)` 作为 text；`null`/`undefined` → `[]`。

| koishi | canonical | 说明 |
| :--- | :--- | :--- |
| `text` | `{ type: "text", text }` | 内容取 `attrs.content` 优先，children join 兜底 |
| `br` | `{ type: "text", text: "\n" }` | |
| `at` | `{ type: "at", target }` | `attrs.id`；`id="all"` 原样；空 id 降级为原元素文本 |
| `img` / `image` | `{ type: "image", path }` | `attrs.src`；`file://` → `fileURLToPath`；本地路径转正斜杠；http(s) 透传，发送前下载 |
| `face` | `{ type: "face", id }` | |
| `audio` | `{ type: "voice", path }` | 与 img 相同的 src 处理 |
| `video` | `{ type: "video", path }` | 发送前补缩略图/宽高/时长 |
| `quote` | `{ type: "reply", messageId }` | |
| 其他（`p`/`file`/…） | `{ type: "text", text: toString() }` | 保内容不丢 |

**路径规范化**：本地媒体路径统一把 `\` 转成 `/`。NT 的 rich media 服务按 URL 语义解析路径，
反斜杠路径会读不到文件（表现为 `rich media transfer failed`）。

## 发送媒体管线

Koishi `sendMessage()` 为图片（`img` / `image`）、语音（`audio`）和视频（`video`）
分别处理 HTTP(S)、调用方本地路径、`file://` 和符合媒体类型的 `data:` URL。

1. 处理调用方的本地路径和 `file://`。启用目录白名单时，在转码、读取或 IPC 之前校验实际路径。
   下载、内联材料和派生文件由适配器管理，使用独立临时目录。
2. HTTP(S) 使用 `@napuketto/media` 流式落盘，单文件上限为图片/语音 30 MiB、视频 100 MiB，
   15 秒覆盖跳转和读取。相同媒体类型及 URL 在一次发送中复用。优先按可识别的文件内容定扩展名，
   其次使用 URL 扩展名。下载失败或出站地址被拒绝会发占位文本及类别告警，其他元素继续发送。白名单拒绝的调用方本地文件会中止本次发送。
3. 图片、语音与视频的 data URL 支持 base64 和百分号编码。格式非法、内容为空或超限会中止发送。
4. 非 SILK 语音在适配器独占目录中调用 `encodePcmToSilk`。转码失败继续使用原音频并记录告警。
   已有的 SILK（含 QQ 的前导字节变体）原样使用。
5. 视频尝试提取缩略图、宽高和时长，再调用 `msg.sendMessage`。探测或抽帧失败会继续尝试发送。
   IPC 完成或失败后回收适配器为本次发送创建的目录，调用方文件由调用方管理。

原始 `bot.internal._request()` 可直接调用子进程的 kernel 与 OB11 动作。OB11 的发送消息、下载、
头像、群公告图和闪传等根据上游动作处理媒体。向低信任调用者开放时，应只暴露 Koishi 的
`sendMessage()`，并把原始动作接口保留给受信任插件。`ob11Actions: false` 关闭 OB11 桥，
原始 kernel 动作仍由 `_request()` 调用。

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
不属于稳定 API。

## OneBot 11 动作面

**装配**（默认开启）：

1. `resolveLaunchOptions` 解析 `@napuketto/adapter` 与 `@napuketto/network` 的磁盘入口
   （`adapterEntry` / `networkEntry`，可用配置覆盖），经 launcher 注入
   `NAPUTO_ADAPTER_ENTRY` / `NAPUTO_NETWORK_ENTRY`。任一入口解析失败 → 记录降级，子进程不挂载。
2. 子进程登录成功后，loader 动态 import adapter 的 `onebot11` / `core` 子路径与 network 入口，
   实例化 `NapukettoOneBot11Adapter`，只调用 `subscribeOnly()`：接收链路生效，**不启动 HTTP/WS**。
3. 全部动作名（79 个实现，含别名变体）平铺进 IPC 动作表；`OB11 动作名` 与 kernel 点分名空间不冲突。
4. OB11 事件经桥适配器 → `event { service: "ob11", name: post_type, args: [event] }`。
5. 动态 import / 构造 / 挂载失败只打日志，保留纯 kernel 动作面，登录链路不受影响。

**调用**：统一走 `bot.internal._request()`，参数与 OneBot 11 规范一致，响应是标准信封。
动作 handler 内部的 zod 校验与 kernel 错误映射在子进程完成，**不会因业务错误抛异常**；调用方看
`status` / `retcode`。

**事件**：`bot.onOb11(listener)`（见 [事件桥](events.md#ob11-原始事件)）。

## 审批好友与入群申请

`bot.handleFriendRequest(messageId, approve, comment?)` 和
`bot.handleGuildMemberRequest(messageId, approve, comment?)` 消费对应请求 Session 的 `messageId`。
适配器将它作为 OB11 `flag` 原样传给 `set_friend_add_request` 或 `set_group_add_request`。
同意好友请求时，`comment` 用作好友备注，拒绝时省略备注。群申请的 `comment` 作为审批说明传递。
这两个方法依赖 OB11 动作桥，子进程返回失败时方法会拒绝 Promise。

**明确不支持**：Satori 动作面、`session.onebot.*` 驼峰兼容糖、网络传输与心跳/生命周期广播。
