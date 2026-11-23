import {
    type GrayTipElement,
    GrayTipSubType,
    type RawMessage,
    TipGroupElementType,
} from "@napuketto/kernel";
import type { IpcGroupRequest } from "../../runtime/ipc/index.js";
import { nonBlank, normalizeMessageTime, PRIVATE_PREFIX, qqId } from "../../shared.js";
import { groupRequestId } from "../group-request.js";
import { messageChannel, messageSenderId, type ResolveUin } from "./adapt.js";
import type { EventBridgeOptions, NapukettoSessionFields, Ob11EventPayload } from "./types.js";

export interface AdaptedEvent {
    fields: NapukettoSessionFields;
    key: string;
    expiresAt?: number;
}

type EventContext = Pick<EventBridgeOptions, "h"> & { selfId: string; platform: string };

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
    resolveUin?: ResolveUin,
): AdaptedEvent | undefined {
    const revoke = tip.subElementType === GrayTipSubType.REVOKE ? tip.revokeElement : undefined;
    const channel = messageChannel(msg, context.selfId, resolveUin);
    const userId = messageSenderId(msg, resolveUin);
    if (revoke == null || channel === undefined) {
        return undefined;
    }
    const uid = nonBlank(revoke.operatorUid);
    const operatorId =
        revoke.isSelfOperate === true
            ? context.selfId
            : uid === undefined
              ? undefined
              : (qqId(uid) ?? resolveUin?.(uid) ?? (uid === msg.senderUid ? userId : undefined));
    return recalledMessage(context, {
        ...channel,
        ...(userId === undefined ? {} : { userId }),
        messageId: msg.msgId,
        timestamp: timestamp ?? Date.now(),
        ...(operatorId === undefined ? {} : { operatorId }),
    });
}

function recalledMessage(
    context: EventContext,
    message: Required<
        Pick<NapukettoSessionFields, "channelId" | "messageId" | "isDirect" | "timestamp">
    > &
        Pick<NapukettoSessionFields, "guildId" | "operatorId" | "userId">,
): AdaptedEvent {
    return {
        key: JSON.stringify(["message-deleted", message.channelId, message.messageId]),
        fields: {
            type: "message-deleted",
            subtype: message.isDirect ? "private" : "group",
            selfId: context.selfId,
            platform: context.platform,
            ...message,
        },
    };
}

function adaptOb11Recall(
    event: Ob11EventPayload,
    context: EventContext,
    userId: string | undefined,
) {
    const guildId = qqId(event["group_id"]);
    const messageId = nonBlank(event["tip_message_id"]);
    if (guildId === undefined || messageId === undefined) {
        return undefined;
    }
    const operatorId = qqId(event["operator_id"]);
    return recalledMessage(context, {
        channelId: guildId,
        guildId,
        ...(userId === undefined ? {} : { userId }),
        messageId,
        isDirect: false,
        timestamp: normalizeMessageTime(event.time) ?? Date.now(),
        ...(operatorId === undefined ? {} : { operatorId }),
    });
}

export function adaptGroupRequest(
    payload: IpcGroupRequest,
    context: EventContext,
    resolveUin: ResolveUin,
): AdaptedEvent | undefined {
    if (payload.selfUin !== context.selfId) {
        return undefined;
    }
    const { request, initiatorUid, targetUid, comment } = payload;
    const inviter =
        payload.initiatorUin ??
        (initiatorUid === undefined ? undefined : (qqId(initiatorUid) ?? resolveUin(initiatorUid)));
    const invitation = request.kind === "invitation";
    const userId =
        request.kind === "invited_join_request"
            ? targetUid === undefined
                ? undefined
                : (qqId(targetUid) ?? resolveUin(targetUid))
            : inviter;
    // The inviter in a member approval stands for the operator, not the invited member.
    if (!invitation && userId === undefined) {
        return undefined;
    }
    const messageId = groupRequestId(payload);
    return {
        key: messageId,
        fields: {
            type: invitation ? "guild-request" : "guild-member-request",
            selfId: context.selfId,
            platform: context.platform,
            timestamp: Date.now(),
            channelId: request.groupCode,
            guildId: request.groupCode,
            messageId,
            isDirect: false,
            elements: comment === undefined ? [] : [context.h("text", { content: comment })],
            ...(userId === undefined ? {} : { userId }),
            ...(!invitation && userId !== undefined ? { member: { user: { id: userId } } } : {}),
            ...(request.kind === "invited_join_request" && inviter !== undefined
                ? { operatorId: inviter }
                : {}),
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
    if (
        !friend &&
        (event["request_type"] !== "group" ||
            event["sub_type"] !== "add" ||
            event["request_kind"] !== undefined)
    ) {
        return undefined;
    }
    const channelId = friend ? `${PRIVATE_PREFIX}${userId}` : guildId;
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
    if (event.self_id !== undefined && selfId !== context.selfId) {
        return undefined;
    }
    if (event.post_type === "notice" && event["notice_type"] === "group_recall") {
        return adaptOb11Recall(event, context, userId);
    }
    if (userId === undefined) {
        return undefined;
    }
    if (event.post_type === "request") {
        return adaptRequest(event, context, userId);
    }
    if (event.post_type !== "notice") {
        return undefined;
    }
    switch (event["notice_type"]) {
        case "group_increase":
        case "group_decrease":
            return adaptMembership(event, context, userId);
        case "friend_add":
        case "group_card":
        case "group_title":
            return adaptProfileNotice(event, context, userId);
        default:
            return undefined;
    }
}

function adaptProfileNotice(
    event: Ob11EventPayload,
    context: EventContext,
    userId: string,
): AdaptedEvent | undefined {
    const kind = event["notice_type"];
    const guildId = qqId(event["group_id"]);
    const value = kind === "group_title" ? event["title"] : event["card_new"];
    const time = normalizeMessageTime(event.time);
    const timestamp = time ?? Date.now();
    const user = { id: userId };
    const base = { selfId: context.selfId, platform: context.platform, userId, timestamp };
    const expiry = { expiresAt: Date.now() + UNTIMED_NOTICE_WINDOW_MS };
    if (kind === "friend_add") {
        return {
            key: JSON.stringify([kind, userId, time]),
            ...expiry,
            fields: {
                ...base,
                type: "friend-added",
                friend: { user },
                channelId: `${PRIVATE_PREFIX}${userId}`,
                isDirect: true,
            },
        };
    }
    if (guildId === undefined || typeof value !== "string") {
        return undefined;
    }
    return {
        key: JSON.stringify([kind, guildId, userId, value, time]),
        ...expiry,
        fields: {
            ...base,
            type: "guild-member-updated",
            guildId,
            channelId: guildId,
            isDirect: false,
            member: { user, ...(kind === "group_title" ? { title: value } : { nick: value }) },
        },
    };
}
