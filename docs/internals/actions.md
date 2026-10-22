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
| `sendMessage(channelId, content, guildId?)` | `msg.sendMessage` | `{ chatType, peerUin, elements }`；返回 `string[]`（0 或 1 个 msgId） |
| `deleteMessage(channelId, messageId)` | `msg.recallMessage` | `{ chatType, peerUin, msgIds: [messageId] }` |
| `getMessageList(channelId, before?, limit?)` | `msg.fetchMessages` | `{ chatType, peerUin, count, msgId? }`；返回 `{ data, next? }`，`next` = 末条 `msgId` |
| `markAsRead(channelId)` | `msg.markRead` | `{ chatType, peerUin }` |
| `getGroupList()` | `group.getGroupList` | 群列表（子进程侧走 `groupCache.listGroupsRefreshed()`） |
| `getFriendList()` | `friend.getFriendList` | 好友列表 |
| `getSelf()` | `login.getSelf` | 子进程登录自身信息 |

`getMessageList` 的 `count` 缺省 20；`before` 为空时不带 `msgId`。`sendMessage` 在 canonical 元素为空时
直接返回 `[]`，不发请求。

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

`sendMessage()` 按固定顺序处理元素，任一步生成临时文件都登记 cleanup，最后在 `finally` 中**逆序清理**：

1. **远程下载** `downloadRemoteMedia`：处理 `image` / `voice` / `video` 的 `http(s)` URL。
   - 单文件上限：图片/语音 30MB，视频 100MB；超时 15s；流式读取时再次校验总大小。
   - 相同 URL 只下载一次；非 2xx、空响应、超限或网络错误 → 替换为占位文本
     `[图片: <url>]` / `[语音: <url>]` / `[视频: <url>]` 并 `warn`，不阻断其他元素。
2. **语音转 silk** `ensureVoiceSilk`：读文件头 8 字节，`#!SILK` 前缀原样保留；否则用
   `@napuketto/media` 的 `encodePcmToSilk` 转成 silk v3。转码失败原样返回，由 kernel 兜底。
   原因：QQ 语音协议只接受 silk；直接上传 ogg/mp3 会“发送成功但对方无法播放”。
3. **图片 data URL 落盘** `materializeDataUrlImages`：`data:image/*`（支持 base64 与百分号编码）
   写入临时文件，供子进程按路径读取。格式非法会抛错并中止本次发送。
4. **视频 data URL 落盘** `materializeDataUrlVideos`：`data:video/*`，按 MIME 选扩展名，
   未知回落 `.bin` 交给 ffprobe 识别。
5. **视频补全** `enrichVideoElements`：对本地且尚无 `thumbPath` 的视频调用
   `getVideoInfo`（ffprobe）与 `extractVideoFrame`（ffmpeg 抽首帧 PNG），补
   `thumbPath` / `width` / `height` / `durationSec`（时长四舍五入，且至少 1 秒）。
   ffmpeg/ffprobe 缺失或处理失败 → 打 `warn`，去掉缩略图继续发送，不阻塞其他元素。
6. 调用 `msg.sendMessage`，从返回值取 `msgId`。

注意：下载失败是“降级为文本”，data URL 解析失败是“抛错”；后者通常意味着上游传入了损坏的 data URI。

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

**明确不支持**：Satori 动作面、`session.onebot.*` 驼峰兼容糖、网络传输与心跳/生命周期广播。
