import { type RawMessage, toCanonicalElements } from "@napuketto/kernel";
import type { Universal } from "koishi";
import { bindKoishiH, toKoishiElements } from "../events/elements.js";
import { normalizeMessageTime } from "../events/message-time.js";
import type { NapukettoInternalOptions } from "./types.js";

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
