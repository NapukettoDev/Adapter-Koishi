/**
 * channel.ts：channelId → Peer 参数（纯函数，docs/internals/actions.md）。
 *
 * 与事件桥 §5.9 会话标识映射对称：
 *  - 群号（纯数字）→ chatType=2（GROUP），peerUin=群号
 *  - `private:` + uin → chatType=1（C2C），peerUin=uin
 *  - `private:` + uin + guildId → chatType=100（TEMP 临时会话），peerUin=uin
 */
import { ChatType } from "@napuketto/kernel";
import { PRIVATE_PREFIX } from "../shared/protocol.js";
import type { PeerTarget } from "./types.js";

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
