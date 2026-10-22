/**
 * channel.ts：channelId → Peer 参数（纯函数，docs/internals/actions.md）。
 *
 * 与事件桥 §5.9 会话标识映射对称：
 *  - 群号（纯数字）→ chatType=2（GROUP），peerUin=群号
 *  - `private:` + uin → chatType=1（C2C），peerUin=uin
 *  - `private:` + uin + guildId → chatType=100（TEMP 临时会话），peerUin=uin
 */
import type { PeerTarget } from "./types.js";

/** 私聊 channelId 前缀（与事件桥 adapt.ts 对齐）。 */
const PRIVATE_PREFIX = "private:";

/** 会话类型（kernel ChatType 对齐）。 */
const ChatType = { C2C: 1, GROUP: 2, TEMP: 100 } as const;

/** channelId（+ guildId）→ Peer 目标参数。 */
export function parseChannelId(channelId: string, guildId?: string): PeerTarget {
    if (channelId.startsWith(PRIVATE_PREFIX)) {
        const uin = channelId.slice(PRIVATE_PREFIX.length);
        return {
            chatType: guildId !== undefined && guildId !== "" ? ChatType.TEMP : ChatType.C2C,
            peerUin: uin,
        };
    }
    return { chatType: ChatType.GROUP, peerUin: channelId };
}
