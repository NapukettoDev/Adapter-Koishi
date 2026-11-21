import {
    ChatType,
    type GrayTipElement,
    GrayTipSubType,
    type RawMessage,
    TipGroupElementType,
} from "@napuketto/kernel";
import { normalizeMessageTime } from "./message-time.js";
import type { EventBridgeOptions, NapukettoSessionFields, Ob11EventPayload } from "./types.js";

export interface AdaptedEvent {
    fields: NapukettoSessionFields;
    key: string;
    expiresAt?: number;
}

type EventContext = Pick<EventBridgeOptions, "h"> & { selfId: string; platform: string };

function qqId(value: unknown): string | undefined {
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
        return String(value);
    }
    return typeof value === "string" && /^[1-9]\d*$/.test(value) ? value : undefined;
}

export function findSystemTip(msg: RawMessage): GrayTipElement | undefined {
    if (!Array.isArray(msg.elements)) {
        return undefined;
    }
    return (
        msg.elements.find((element) => {
            const tip = element?.grayTipElement;
            return (
                tip?.subElementType === GrayTipSubType.REVOKE ||
                tip?.aioOpGrayTipElement != null ||
                (tip?.subElementType === GrayTipSubType.GROUP &&
                    (tip.groupElement?.type === TipGroupElementType.MEMBER_ADD ||
                        tip.groupElement?.type === TipGroupElementType.QUIT))
            );
        })?.grayTipElement ?? undefined
    );
}

export function adaptRecall(
    msg: RawMessage,
    tip: GrayTipElement,
    context: EventContext,
    timestamp: number | undefined,
): AdaptedEvent | undefined {
    const revoke = tip.subElementType === GrayTipSubType.REVOKE ? tip.revokeElement : undefined;
    if (revoke == null || (msg.chatType !== ChatType.GROUP && msg.chatType !== ChatType.C2C)) {
        return undefined;
    }
    const { selfId, platform } = context;
    const peerId = qqId(msg.peerUin) ?? qqId(msg.peerUid);
    const isDirect = msg.chatType === ChatType.C2C;
    const userId =
        qqId(msg.senderUin) ??
        qqId(msg.senderUid) ??
        (isDirect && msg.senderUid && msg.senderUid === msg.peerUid ? peerId : undefined);
    const targetId = peerId ?? (isDirect && userId !== selfId ? userId : undefined);
    const messageId = qqId(msg.msgId);
    if (targetId === undefined || messageId === undefined || userId === undefined) {
        return undefined;
    }
    const operatorId =
        qqId(revoke.operatorUid) ??
        (revoke.isSelfOperate === true ? selfId : undefined) ??
        (revoke.operatorUid && revoke.operatorUid === msg.senderUid ? userId : undefined) ??
        (isDirect && revoke.operatorUid && revoke.operatorUid === msg.peerUid ? peerId : undefined);
    const channelId = isDirect ? `private:${targetId}` : targetId;
    return {
        key: JSON.stringify(["message-deleted", channelId, messageId]),
        fields: {
            type: "message-deleted",
            subtype: isDirect ? "private" : "group",
            selfId,
            platform,
            timestamp: timestamp ?? Date.now(),
            channelId,
            messageId,
            isDirect,
            ...(isDirect ? {} : { guildId: targetId }),
            userId,
            ...(operatorId === undefined ? {} : { operatorId }),
        },
    };
}

// 缺少通知时间时，只在短窗口内按成员和群号去重，保留后续真实的进退群。
const UNTIMED_NOTICE_WINDOW_MS = 5_000;

function adaptMembership(
    event: Ob11EventPayload,
    context: EventContext,
    userId: string,
): AdaptedEvent | undefined {
    const guildId = qqId(event["group_id"]);
    if (guildId === undefined) {
        return undefined;
    }
    const added = event["notice_type"] === "group_increase";
    const type = `${userId === context.selfId ? "guild" : "guild-member"}-${added ? "added" : "removed"}`;
    const time = normalizeMessageTime(event.time);
    const timestamp = time ?? Date.now();
    const operatorId = qqId(event["operator_id"]);
    return {
        key: JSON.stringify([type, guildId, userId, time]),
        ...(time === undefined ? { expiresAt: timestamp + UNTIMED_NOTICE_WINDOW_MS } : {}),
        fields: {
            type,
            selfId: context.selfId,
            platform: context.platform,
            timestamp,
            channelId: guildId,
            guildId,
            userId,
            isDirect: false,
            ...(userId === context.selfId ? {} : { member: { user: { id: userId } } }),
            ...(operatorId === undefined ? {} : { operatorId }),
        },
    };
}

function adaptRequest(
    event: Ob11EventPayload,
    context: EventContext,
    userId: string,
): AdaptedEvent | undefined {
    const friend = event["request_type"] === "friend";
    const guildId = qqId(event["group_id"]);
    if (!friend && (event["request_type"] !== "group" || event["sub_type"] !== "add")) {
        return undefined;
    }
    const channelId = friend ? `private:${userId}` : guildId;
    const flag = event["flag"];
    if (
        channelId === undefined ||
        typeof flag !== "string" ||
        !flag.trim() ||
        flag === "undefined" ||
        flag === "null"
    ) {
        return undefined;
    }
    const type = friend ? "friend-request" : "guild-member-request";
    const comment = event["comment"];
    return {
        key: JSON.stringify([type, userId, friend ? null : guildId, flag]),
        fields: {
            type,
            selfId: context.selfId,
            platform: context.platform,
            timestamp: normalizeMessageTime(event.time) ?? Date.now(),
            channelId,
            userId,
            messageId: flag,
            isDirect: friend,
            elements: typeof comment === "string" ? [context.h("text", { content: comment })] : [],
            ...(friend ? {} : { guildId: channelId, member: { user: { id: userId } } }),
        },
    };
}

export function adaptOb11Event(
    event: Ob11EventPayload,
    context: EventContext,
): AdaptedEvent | undefined {
    const selfId = qqId(event.self_id);
    const userId = qqId(event["user_id"]);
    if (userId === undefined || (event.self_id !== undefined && selfId !== context.selfId)) {
        return undefined;
    }
    if (event.post_type === "request") {
        return adaptRequest(event, context, userId);
    }
    if (
        event.post_type === "notice" &&
        (event["notice_type"] === "group_increase" || event["notice_type"] === "group_decrease")
    ) {
        return adaptMembership(event, context, userId);
    }
    return undefined;
}
