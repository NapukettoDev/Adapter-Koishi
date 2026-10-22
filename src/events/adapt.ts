/**
 * adapt.ts：kernel RawMessage → koishi session 字段（纯函数，docs/internals/events.md）。
 *
 * 链路：IPC event.args（RawMessage）→ kernel toCanonicalElements（canonical 中间层）
 * → toKoishiElements（koishi 元素）→ session 字段。
 *
 * 会话标识映射（napcat/onebot 同构，§9.1）：
 *  - 群聊（chatType=2）：type=message + subtype=group，channelId=guildId=groupCode
 *  - 私聊（chatType=1）：type=message + subtype=private，channelId=private:+senderUin
 *  - 临时会话（chatType=100）：type=message + subtype=private，guildId=groupCode
 */

import type { CanonicalElement, RawMessage } from "@napuketto/kernel";
import { toCanonicalElements } from "@napuketto/kernel";
import { type HFn, toKoishiElements } from "./elements.js";
import type { NapukettoSessionFields } from "./types.js";

/** 私聊 channelId 前缀（napcat 同构）。 */
const PRIVATE_PREFIX = "private:";

/** 会话类型（kernel ChatType 对齐）。 */
const ChatType = { C2C: 1, GROUP: 2, TEMP: 100 } as const;

/** 适配选项。 */
export interface AdaptOptions {
    selfId: string;
    platform: string;
    /** koishi h() 工厂（生产传 bindKoishiH(h)，单测传 mock）。 */
    h: HFn;
    /** 收向元素富化（voice NT silk → WAV 等，异步；缺省直通）。2026-09-08 T6。 */
    enrichElements?: (elements: CanonicalElement[]) => Promise<CanonicalElement[]>;
}

/** RawMessage → koishi session 字段。 */
export function adaptRawMessage(msg: RawMessage, options: AdaptOptions): NapukettoSessionFields {
    const { selfId, platform, h } = options;
    const senderUin = msg.senderUin ?? "";
    const groupCode = msg.peerUin ?? ""; // 群聊时 peerUin = 群号
    const isGroup = msg.chatType === ChatType.GROUP;

    // ⚠️ type 用 "message" + subtype（onebot 同构，2026-08-09 修复）：satorijs
    // Bot.dispatch 按 session.type 匹配 eventAliases 决定 emit 事件名，别名组只有
    // ["message-created","message"] 等，"message.group" 不匹配 → emit 事件名变成
    // "message.group"，koishi 指令系统（监听 "message"）收不到（实测症状：连接绿色、
    // dispatch 被调用但指令无响应）。
    const session: NapukettoSessionFields = {
        type: "message",
        subtype: isGroup ? "group" : "private",
        selfId,
        platform,
        timestamp: Number(msg.msgTime) * 1000,
        userId: senderUin,
        messageId: msg.msgId,
        // 群聊非私聊；私聊/临时会话 isDirect=true（驱动 event.channel.type）
        isDirect: !isGroup,
        ...(isGroup
            ? { channelId: groupCode, guildId: groupCode }
            : { channelId: `${PRIVATE_PREFIX}${senderUin}` }),
    };
    // 临时会话（群内私聊）带 guildId（群号）
    if (msg.chatType === ChatType.TEMP && groupCode !== "") {
        session.guildId = groupCode;
    }

    // NT RawElement → canonical → koishi 元素
    // ⚠️ 只设 elements：satorijs Session.content 是 getter（elements.join("") 派生）；
    // 若直接设 content 字段会走 setter → h.parse(value) 覆盖 elements（结构化元素丢失，
    // 且 content 含特殊字符时 parse 可能抛错导致 dispatch 失败——onebot 实证规避）。
    const elements = toKoishiElements(toCanonicalElements(msg), h);
    session.elements = elements;

    return session;
}

/**
 * RawMessage → koishi session 字段（含收向媒体富化，异步）。
 * 富化（voice silk → WAV 等）在 canonical → koishi 元素之前应用；
 * dispatch 侧异步化（bridge void 消费），失败不阻塞消息派发。
 */
export async function adaptRawMessageWithMedia(
    msg: RawMessage,
    options: AdaptOptions,
): Promise<NapukettoSessionFields> {
    const enrich = options.enrichElements;
    if (enrich === undefined) {
        return adaptRawMessage(msg, options);
    }
    const { h } = options;
    // 富化失败按无富化处理（fail-soft：消息必须派发）
    let canonical: CanonicalElement[];
    try {
        canonical = await enrich(toCanonicalElements(msg));
    } catch {
        return adaptRawMessage(msg, options);
    }
    const session = adaptRawMessage(msg, options);
    session.elements = toKoishiElements(canonical, h);
    return session;
}
