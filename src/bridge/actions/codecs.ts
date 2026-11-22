import { ChatType, type RawMessage, toCanonicalElements } from "@napuketto/kernel";
import type { Universal } from "koishi";
import {
    bindKoishiH,
    normalizeMessageTime,
    PRIVATE_PREFIX,
    toKoishiElements,
} from "../../shared.js";
import type { NapukettoInternalOptions, PeerTarget } from "./types.js";

/**
 * channelId → Peer 参数（纯函数，docs/internals/actions.md）。
 *
 * 与事件桥 §5.9 会话标识映射对称：
 *  - 群号（纯数字）→ chatType=2（GROUP），peerUin=群号
 *  - `private:` + uin → chatType=1（C2C），peerUin=uin
 *  - `private:` + uin + guildId → chatType=100（TEMP 临时会话），peerUin=uin
 */

/** channelId（+ guildId）→ Peer 目标参数。 */
export function parseChannelId(channelId: string, guildId?: string): PeerTarget {
    if (channelId.startsWith(PRIVATE_PREFIX)) {
        const uin = channelId.slice(PRIVATE_PREFIX.length);
        return {
            chatType: guildId !== undefined && guildId !== "" ? ChatType.C2C_TEMP : ChatType.C2C,
            peerUin: uin,
        };
    }
    return { chatType: ChatType.GROUP, peerUin: channelId };
}

export function isHistoryMessage(value: unknown): value is RawMessage {
    return (
        typeof value === "object" &&
        value !== null &&
        "msgId" in value &&
        typeof value.msgId === "string" &&
        value.msgId !== "" &&
        "elements" in value &&
        Array.isArray(value.elements)
    );
}

/** 将原生历史记录转换为可直接交给 Koishi 的消息。 */
export function toHistoryMessage(
    raw: RawMessage,
    channel: Universal.Channel,
    h: NonNullable<NapukettoInternalOptions["h"]>,
): Universal.Message {
    const canonical = toCanonicalElements(raw);
    const elements = toKoishiElements(canonical, bindKoishiH(h));
    const reply = canonical.find((element) => element.type === "reply" && element.messageId);
    const timestamp = normalizeMessageTime(raw.msgTime);
    const senderId = raw.senderUin || raw.senderUid;
    const name = raw.sendNickName || raw.sendMemberName;

    return {
        id: raw.msgId,
        channel,
        ...(channel.type === 0 ? { guild: { id: channel.id } } : {}),
        ...(senderId ? { user: { id: senderId, ...(name ? { name } : {}) } } : {}),
        content: elements.join(""),
        elements,
        ...(reply?.type === "reply" ? { quote: { id: reply.messageId } } : {}),
        ...(timestamp !== undefined ? { timestamp, createdAt: timestamp } : {}),
    };
}
