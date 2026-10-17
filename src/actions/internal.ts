/**
 * internal.ts：NapukettoInternal——koishi bot.internal 封装（design.md §5.10）。
 *
 * 对应 napcat 的 `internal._request` 传输抽象（§9.1）：koishi 动作 → IPC action
 * 请求 → 子进程 kernel API。request 回调由 apply() 层注入（client.request 绑定），
 * 单测用 mock request。
 *
 * koishi 主包不 import（单测崩溃，HANDOVER §7 坑 1）：方法签名用宽松结构，
 * bot.ts（§6 第 6 步）挂载时与 koishi Internal 类型适配。
 */
import { parseChannelId } from "./channel.js";
import { toCanonicalElements } from "./elements.js";
import {
    downloadRemoteMedia,
    enrichVideoElements,
    ensureVoiceSilk,
    materializeDataUrlImages,
    materializeDataUrlVideos,
} from "./media.js";
import type { MessageListResponse, NapukettoInternalOptions } from "./types.js";

/** koishi bot.internal 封装（动作方法签名对齐 koishi Internal 惯例）。 */
export class NapukettoInternal {
    constructor(private readonly options: NapukettoInternalOptions) {}

    /**
     * 统一动作调用（napcat internal._request 同构；IPC 动作请求）。
     *
     * 两个动作面（design.md §5.14）：
     * - kernel 动作（点分命名）：`msg.sendMessage` 等，返回 kernel API 原始值；
     * - OB11 动作（snake_case，2026-08-27 起）：`send_like` / `set_group_ban` /
     *   `get_group_msg_history` 等全部 79 个（含别名变体），参数与 OneBot 11
     *   规范一致，返回 OB11 标准信封 `{ status, retcode, data, message }`
     *   （retcode=0 / status="ok" 为成功，业务数据在 data）——例：
     *   `const res = await internal._request("send_like", { user_id, times })`。
     */
    _request(action: string, params?: Record<string, unknown>): Promise<unknown> {
        return this.options.request(action, params);
    }

    /** 发消息：koishi 元素 → canonical →（远程媒体下载 → silk 归一化 → data URL 落盘 → 视频补全）→ msg.sendMessage。返回消息 id 数组。 */
    async sendMessage(channelId: string, content: unknown, guildId?: string): Promise<string[]> {
        const peer = parseChannelId(channelId, guildId);
        const elements = toCanonicalElements(content);
        if (elements.length === 0) {
            return []; // 空内容：不发请求
        }
        const loggerOptions =
            this.options.logger !== undefined ? { logger: this.options.logger } : {};
        // 远程媒体（http/https）先下载到本地临时文件（2026-09-08 T3）：失败
        // 回退占位文本（media.ts downloadRemoteMedia 内打 warn），不阻塞发送
        const downloaded = await downloadRemoteMedia(elements, loggerOptions);
        // 逐级派生临时文件（下载解压 / data URL 落盘 / 视频抽帧），统一逆序清理
        const cleanups: Array<() => Promise<void>> = [downloaded.cleanup];
        try {
            // 语音段统一转 silk（QQ 语音协议；2026-08-23 修复：非 silk 音频原样
            // 上传 QQ 播放器无法解码——线上实证语音发送成功但收件人无法播放）
            const silk = await ensureVoiceSilk(downloaded.elements);
            const images = await materializeDataUrlImages(silk);
            cleanups.push(images.cleanup);
            const videos = await materializeDataUrlVideos(images.elements);
            cleanups.push(videos.cleanup);
            // 视频缩略图/宽高/时长（ffmpeg/ffprobe，失败降级无缩略图并 warn）
            const enriched = await enrichVideoElements(videos.elements, loggerOptions);
            cleanups.push(enriched.cleanup);
            const result = await this.options.request("msg.sendMessage", {
                chatType: peer.chatType,
                peerUin: peer.peerUin,
                elements: enriched.elements,
            });
            const msgId = (result as { msgId?: string } | null | undefined)?.msgId;
            return msgId === undefined || msgId === "" ? [] : [msgId];
        } finally {
            for (const cleanup of cleanups.reverse()) {
                await cleanup();
            }
        }
    }

    /** 撤回消息（messageId → msg.recallMessage）。 */
    async deleteMessage(channelId: string, messageId: string): Promise<void> {
        const peer = parseChannelId(channelId);
        await this.options.request("msg.recallMessage", {
            chatType: peer.chatType,
            peerUin: peer.peerUin,
            msgIds: [messageId],
        });
    }

    /** 拉取消息历史：RawMessage[] → koishi MessageList 形状 { data, next? }。 */
    async getMessageList(
        channelId: string,
        before?: string,
        limit?: number,
    ): Promise<MessageListResponse<unknown>> {
        const peer = parseChannelId(channelId);
        const params: Record<string, unknown> = {
            chatType: peer.chatType,
            peerUin: peer.peerUin,
            count: limit ?? 20,
        };
        if (before !== undefined && before !== "") {
            params["msgId"] = before;
        }
        const data = await this.options.request("msg.fetchMessages", params);
        const list: unknown[] = Array.isArray(data) ? data : [];
        const last = list.at(-1) as { msgId?: unknown } | undefined;
        return {
            data: list,
            ...(last !== undefined && typeof last["msgId"] === "string"
                ? { next: last["msgId"] }
                : {}),
        };
    }

    /** 标记已读。 */
    async markAsRead(channelId: string): Promise<void> {
        const peer = parseChannelId(channelId);
        await this.options.request("msg.markRead", {
            chatType: peer.chatType,
            peerUin: peer.peerUin,
        });
    }

    /** 群列表。 */
    getGroupList(): Promise<unknown> {
        return this.options.request("group.getGroupList");
    }

    /** 好友列表。 */
    getFriendList(): Promise<unknown> {
        return this.options.request("friend.getFriendList");
    }

    /** 登录账号自身信息。 */
    getSelf(): Promise<unknown> {
        return this.options.request("login.getSelf");
    }
}
