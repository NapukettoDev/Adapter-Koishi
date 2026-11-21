/**
 * internal.ts：NapukettoInternal——koishi bot.internal 封装（docs/internals/actions.md）。
 *
 * 对应 napcat 的 `internal._request` 传输抽象（§9.1）：koishi 动作 → IPC action
 * 请求 → 子进程 kernel API。request 回调由 apply() 层注入（client.request 绑定），
 * 单测用 mock request。
 *
 * koishi 主包不 import（单测崩溃，docs/guides/development.md 单测边界）：方法签名用宽松结构，
 * bot.ts（§6 第 6 步）挂载时与 koishi Internal 类型适配。
 */
import { isRecord } from "@napuketto/kernel";
import type { Universal } from "koishi";
import { IpcError } from "../ipc/errors.js";
import { parseChannelId } from "./channel.js";
import { toCanonicalElements } from "./elements.js";
import { isHistoryMessage, toHistoryMessage } from "./history.js";
import { prepareOutboundMedia } from "./media.js";
import type { MessageListResponse, NapukettoInternalOptions } from "./types.js";

const DEFAULT_HISTORY_LIMIT = 20;
// 将包含锚点和探测条目的 IPC count 限制在有符号 32 位整数范围内。
const MAX_HISTORY_LIMIT = 2 ** 31 - 3;

/** koishi bot.internal 封装（动作方法签名对齐 koishi Internal 惯例）。 */
export class NapukettoInternal {
    constructor(private readonly options: NapukettoInternalOptions) {}

    private resolveMessagePeer(channelId: string, guildId?: string) {
        const peer = parseChannelId(channelId, guildId);
        const self = this.options.getSelfIdentity?.();
        // Linux 原生 getUidByUins 可能没有自己的 UIN 记录，登录已提供同一账号的 UID。
        if (peer.chatType === 1 && peer.peerUin === self?.uin && self.uid !== "") {
            return { chatType: peer.chatType, peerUid: self.uid };
        }
        return peer;
    }

    /**
     * 统一动作调用（napcat internal._request 同构；IPC 动作请求）。
     *
     * 两个动作面（docs/internals/actions.md）：
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

    /** 发消息：koishi 元素 → canonical →（媒体策略及格式归一化）→ msg.sendMessage。返回消息 id 数组。 */
    async sendMessage(channelId: string, content: unknown, guildId?: string): Promise<string[]> {
        const peer = this.resolveMessagePeer(channelId, guildId);
        const elements = toCanonicalElements(content);
        if (elements.length === 0) {
            return []; // 空内容：不发请求
        }
        const prepared = await prepareOutboundMedia(elements, this.options);
        try {
            const result = await this.options.request("msg.sendMessage", {
                ...peer,
                elements: prepared.elements,
            });
            const msgId = (result as { msgId?: string } | null | undefined)?.msgId;
            return msgId === undefined || msgId === "" ? [] : [msgId];
        } finally {
            await prepared.cleanup();
        }
    }

    /** 撤回消息（messageId → msg.recallMessage）。 */
    async deleteMessage(channelId: string, messageId: string): Promise<void> {
        const peer = this.resolveMessagePeer(channelId);
        await this.options.request("msg.recallMessage", {
            ...peer,
            msgIds: [messageId],
        });
    }

    async handleFriendRequest(
        messageId: string,
        approve: boolean,
        comment?: string,
    ): Promise<void> {
        await this.approveOb11Request("set_friend_add_request", {
            flag: messageId,
            approve,
            ...(approve && comment !== undefined ? { remark: comment } : {}),
        });
    }

    async handleGuildMemberRequest(
        messageId: string,
        approve: boolean,
        comment?: string,
    ): Promise<void> {
        await this.approveOb11Request("set_group_add_request", {
            flag: messageId,
            approve,
            ...(comment === undefined ? {} : { reason: comment }),
        });
    }

    private async approveOb11Request(
        action: string,
        params: { flag: string; approve: boolean; remark?: string; reason?: string },
    ): Promise<void> {
        if (params.flag.trim() === "") {
            throw new IpcError("审批需要请求事件的 messageId", "INVALID_PARAM");
        }
        const response = await this._request(action, params);
        const retcode = isRecord(response) ? response["retcode"] : undefined;
        if (retcode !== 0) {
            const code = typeof retcode === "number" ? String(retcode) : "INVALID_RESPONSE";
            throw new IpcError(`OB11 审批失败（${action}, ${code}）`, code);
        }
    }

    /** 拉取比锚点更早的消息；排序只影响单页显示。 */
    async getMessageList(
        channelId: string,
        next?: string,
        limit = DEFAULT_HISTORY_LIMIT,
        direction: Universal.Direction = "before",
        order: Universal.Order = "asc",
    ): Promise<MessageListResponse<Universal.Message>> {
        if (direction !== "before") {
            throw new IpcError(`消息历史暂不支持 ${direction} 方向`, "UNSUPPORTED");
        }
        if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_HISTORY_LIMIT) {
            throw new IpcError("消息历史 limit 超出支持的正整数范围", "INVALID_PARAM");
        }
        const h = this.options.h;
        if (h === undefined) {
            throw new IpcError("消息历史需要 Koishi 元素工厂", "UNSUPPORTED");
        }

        const peer = this.resolveMessagePeer(channelId);
        const anchor = next || undefined;
        const raw = await this.options.request("msg.fetchMessages", {
            ...peer,
            count: limit + (anchor === undefined ? 1 : 2),
            ...(anchor === undefined ? {} : { msgId: anchor }),
        });
        const messages = Array.isArray(raw)
            ? raw.filter(isHistoryMessage).filter((message) => message.msgId !== anchor)
            : [];
        const page = messages.slice(0, limit);
        const cursor = messages.length > limit ? page.at(-1)?.msgId : undefined;
        const channel: Universal.Channel = { id: channelId, type: peer.chatType === 2 ? 0 : 1 };
        const data = (order === "desc" ? page : page.reverse()).map((message) =>
            toHistoryMessage(message, channel, h),
        );
        return { data, ...(cursor === undefined ? {} : { prev: cursor, next: cursor }) };
    }

    /** 标记已读。 */
    async markAsRead(channelId: string): Promise<void> {
        const peer = this.resolveMessagePeer(channelId);
        await this.options.request("msg.markRead", { ...peer });
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
