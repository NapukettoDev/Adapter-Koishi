import { ChatType, type RawMessage } from "@napuketto/kernel";
import type { Universal } from "koishi";
import {
    bindKoishiH,
    IpcError,
    nonBlank,
    normalizeMessageTime,
    PRIVATE_PREFIX,
    qqId,
    TEMP_PREFIX,
} from "../../shared.js";
import {
    convertMessage,
    messageIdentities,
    messageSender,
    projectMessage,
} from "../events/adapt.js";
import { validateRawMessage } from "../events/validate.js";
import type { NapukettoInternalOptions, PeerTarget } from "./types.js";

export function parseChannelId(channelId: string, guildId?: string): PeerTarget {
    const temp = channelId.startsWith(TEMP_PREFIX);
    const direct = channelId.startsWith(PRIVATE_PREFIX);
    const id = direct
        ? channelId.slice(temp ? TEMP_PREFIX.length : PRIVATE_PREFIX.length)
        : channelId;
    const peerUin = qqId(id);
    if (peerUin === undefined) {
        throw new IpcError("频道 ID 缺少有效 QQ 号或群号", "INVALID_PARAM");
    }
    const chatType = !direct
        ? ChatType.GROUP
        : temp || nonBlank(guildId) !== undefined
          ? ChatType.C2C_TEMP
          : ChatType.C2C;
    return { chatType, peerUin };
}

export function recentHistory(raw: unknown, anchor?: string): RawMessage[] {
    if (!Array.isArray(raw)) return [];
    const ids = new Set(anchor === undefined ? [] : [anchor]);
    const messages: RawMessage[] = [];
    for (const item of raw) {
        const result = validateRawMessage(item);
        if (result.ok && !ids.has(result.message.msgId)) {
            ids.add(result.message.msgId);
            messages.push(result.message);
        }
    }
    return messages;
}

export function toHistoryMessage(
    raw: RawMessage,
    channel: Universal.Channel,
    h: NonNullable<NapukettoInternalOptions["h"]>,
    self?: { uid: string; uin: string },
): Universal.Message {
    const identities = messageIdentities(raw);
    const resolveUin = (uid: string) => (uid === self?.uid ? qqId(self.uin) : identities.get(uid));
    const canonical = convertMessage(raw, resolveUin, self?.uin);
    const projected = projectMessage(raw, canonical, bindKoishiH(h), resolveUin);
    const timestamp = normalizeMessageTime(raw.msgTime);
    const user = messageSender(raw, resolveUin);
    const nick = channel.type === 0 ? nonBlank(raw.sendMemberName) : undefined;

    return {
        id: raw.msgId,
        channel,
        ...(channel.type === 0 ? { guild: { id: channel.id } } : {}),
        ...(user === undefined
            ? {}
            : { user, ...(nick === undefined ? {} : { member: { user, nick } }) }),
        content: projected.elements.join(""),
        ...projected,
        ...(timestamp !== undefined ? { timestamp, createdAt: timestamp } : {}),
    };
}
