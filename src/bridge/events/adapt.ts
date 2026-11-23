import {
    type CanonicalElement,
    ChatType,
    type RawMessage,
    toCanonicalElements,
} from "@napuketto/kernel";
import type { Universal } from "koishi";
import {
    type HFn,
    nonBlank,
    normalizeMessageTime,
    PRIVATE_PREFIX,
    qqId,
    TEMP_PREFIX,
    toKoishiElements,
} from "../../shared.js";
import type { EventDiagnostic, NapukettoSessionFields } from "./types.js";

// RawMessage.TextElement 公开字段 atType 的 AT_ME 值。
const AT_ME = 4;

export type ResolveUin = (uid: string) => string | undefined;

interface AdaptOptions {
    selfId: string;
    platform: string;
    h: HFn;
    resolveUin?: ResolveUin;
    enrichElements?: (elements: CanonicalElement[]) => Promise<CanonicalElement[]>;
    onError?: EventDiagnostic;
}

export function messageIdentities(raw: RawMessage): Map<string, string> {
    const ids = new Map<string, string>();
    const add = (rawUid: unknown, rawUin: unknown) => {
        const uid = nonBlank(rawUid);
        const uin = qqId(rawUin);
        if (uid !== undefined && uin !== undefined) {
            ids.set(uid, uin);
        }
    };
    add(raw.senderUid, raw.senderUin);
    if (raw.chatType === ChatType.C2C || raw.chatType === ChatType.C2C_TEMP) {
        add(raw.peerUid, raw.peerUin);
    }
    for (const element of raw.elements) {
        add(element.replyElement?.senderUid, element.replyElement?.senderUin);
    }
    return ids;
}

export function messageChannel(raw: RawMessage, selfId: string, resolveUin?: ResolveUin) {
    if (raw.chatType === ChatType.GROUP) {
        const id = qqId(raw.peerUin) ?? qqId(raw.peerUid);
        return id === undefined ? undefined : { channelId: id, guildId: id, isDirect: false };
    }
    if (raw.chatType !== ChatType.C2C && raw.chatType !== ChatType.C2C_TEMP) {
        return undefined;
    }
    const senderId = messageSenderId(raw, resolveUin);
    const peerId =
        qqId(raw.peerUin) ??
        qqId(raw.peerUid) ??
        resolveUin?.(raw.peerUid) ??
        (senderId === selfId ? undefined : senderId);
    const prefix = raw.chatType === ChatType.C2C_TEMP ? TEMP_PREFIX : PRIVATE_PREFIX;
    return peerId === undefined ? undefined : { channelId: `${prefix}${peerId}`, isDirect: true };
}

export function messageSenderId(raw: RawMessage, resolveUin?: ResolveUin) {
    return qqId(raw.senderUin) ?? qqId(raw.senderUid) ?? resolveUin?.(raw.senderUid);
}

export function messageSender(
    raw: RawMessage,
    resolveUin?: ResolveUin,
): Universal.User | undefined {
    const id = messageSenderId(raw, resolveUin);
    const name = nonBlank(raw.sendNickName) ?? nonBlank(raw.sendMemberName);
    return id === undefined ? undefined : { id, ...(name === undefined ? {} : { name }) };
}

export function convertMessage(
    raw: RawMessage,
    resolveUin: ResolveUin,
    selfId?: string,
): CanonicalElement[] {
    return toCanonicalElements(raw).map((element, index) => {
        const native = raw.elements[index];
        if (element.type === "image") {
            const width = native?.picElement?.picWidth;
            const height = native?.picElement?.picHeight;
            return typeof width === "number" &&
                typeof height === "number" &&
                Number.isSafeInteger(width) &&
                Number.isSafeInteger(height) &&
                width > 0 &&
                height > 0
                ? { ...element, size: { width, height } }
                : element;
        }
        const text = native?.textElement;
        if (text?.atType === AT_ME && selfId !== undefined) {
            const display = nonBlank(text.content)?.replace(/^@/, "");
            return { type: "at", target: selfId, ...(display ? { display } : {}) };
        }
        if (element.type !== "at" || element.target === "all") {
            return element;
        }
        const target = qqId(element.target) ?? resolveUin(element.target);
        if (target !== undefined) {
            return { ...element, target };
        }
        const original = nonBlank(text?.content);
        return original === undefined ? element : { type: "text", text: original };
    });
}

export function projectMessage<Element>(
    raw: RawMessage,
    canonical: CanonicalElement[],
    h: HFn<Element>,
    resolveUin?: ResolveUin,
): { elements: Element[]; quote?: Universal.Message } {
    const index = canonical.findIndex((item) => item.type === "reply" && nonBlank(item.messageId));
    const reply = canonical[index];
    if (reply?.type !== "reply") {
        return { elements: toKoishiElements(canonical, h) };
    }
    const details = raw.elements.find(
        (item) => item.replyElement?.replayMsgId === reply.messageId,
    )?.replyElement;
    const id =
        qqId(reply.senderUin) ??
        qqId(reply.senderUid) ??
        (reply.senderUid === undefined ? undefined : resolveUin?.(reply.senderUid));
    const timestamp = normalizeMessageTime(details?.replayMsgTime);
    return {
        elements: toKoishiElements(
            canonical.filter((_, i) => i !== index),
            h,
        ),
        quote: {
            id: reply.messageId,
            ...(id === undefined ? {} : { user: { id } }),
            ...(timestamp === undefined ? {} : { timestamp, createdAt: timestamp }),
        },
    };
}

function messageContext(raw: RawMessage, options: AdaptOptions) {
    const local = messageIdentities(raw);
    const resolveUin: ResolveUin = (uid) => local.get(uid) ?? options.resolveUin?.(uid);
    const channel = messageChannel(raw, options.selfId, resolveUin);
    const user = messageSender(raw, resolveUin);
    if (channel === undefined || user === undefined || qqId(options.selfId) === undefined) {
        throw new TypeError("消息缺少可确认的账号、发送者或频道");
    }
    const nick = channel.isDirect ? undefined : nonBlank(raw.sendMemberName);
    const fields: NapukettoSessionFields = {
        type: "message",
        subtype: channel.isDirect ? "private" : "group",
        selfId: options.selfId,
        platform: options.platform,
        timestamp: normalizeMessageTime(raw.msgTime) ?? Date.now(),
        messageId: raw.msgId,
        userId: user.id,
        user,
        ...(nick === undefined ? {} : { member: { user, nick } }),
        ...channel,
    };
    return { fields, resolveUin };
}

/** Pure conversion with optional media enrichment at the caller boundary. */
export async function adaptRawMessageWithMedia(
    raw: RawMessage,
    options: AdaptOptions,
): Promise<NapukettoSessionFields> {
    const { fields, resolveUin } = messageContext(raw, options);
    const canonical = convertMessage(raw, resolveUin, options.selfId);
    let enriched = canonical;
    try {
        if (options.enrichElements !== undefined) {
            enriched = await options.enrichElements(canonical);
        }
    } catch (error) {
        try {
            options.onError?.(error, "收向元素富化失败（回退原始元素）");
        } catch {
            // 诊断回调自身异常不影响原始消息派发。
        }
    }
    return { ...fields, ...projectMessage(raw, enriched, options.h, resolveUin) };
}

export function adaptRawMessage(raw: RawMessage, options: AdaptOptions): NapukettoSessionFields {
    const { fields, resolveUin } = messageContext(raw, options);
    return {
        ...fields,
        ...projectMessage(
            raw,
            convertMessage(raw, resolveUin, options.selfId),
            options.h,
            resolveUin,
        ),
    };
}
