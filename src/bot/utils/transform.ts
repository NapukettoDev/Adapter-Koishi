/**
 * transform.ts：kernel 数据 → koishi Universal 形状翻译（自 bot.ts 拆出）。
 *
 * 纯函数（仅 import type koishi Universal，不 import 运行时）→ 可单测
 * （docs/guides/development.md 单测边界：koishi 运行时 import 会崩单测）。
 *
 * 职责：好友/群/频道/登录信息的形状映射，bot.ts 的 override 方法只做
 * 「internal 调用 + 委托本模块翻译」。
 */
import type { Universal } from "koishi";
import { PRIVATE_PREFIX } from "../../constants.js";

/** kernel 好友原始形状（宽松结构，来自 IPC 响应）。 */
export interface RawFriend {
    uin?: string;
    nickname?: string;
}

/** kernel 群原始形状（宽松结构，来自 IPC 响应）。 */
export interface RawGroup {
    groupCode?: string;
    groupName?: string;
}

/** kernel 好友列表 → koishi Universal.Friend 列表。 */
export function toFriendList(raw: RawFriend[] | undefined): Universal.List<Universal.Friend> {
    return {
        data: (raw ?? []).map((friend) => ({
            user: {
                id: friend.uin ?? "",
                name: friend.nickname ?? friend.uin ?? "",
            },
            nick: friend.nickname ?? friend.uin ?? "",
        })),
    };
}

/** kernel 群列表 → koishi Universal.Guild 列表。 */
export function toGuildList(raw: RawGroup[] | undefined): Universal.List<Universal.Guild> {
    return {
        data: (raw ?? []).map((group) => ({
            id: group.groupCode ?? "",
            name: group.groupName ?? group.groupCode ?? "",
        })),
    };
}

/** 私聊频道（`private:<uin>`，napcat 同款）。 */
export function toDirectChannel(userId: string): Universal.Channel {
    return {
        id: `${PRIVATE_PREFIX}${userId}`,
        type: 1, // Channel.Type.DIRECT（const enum，verbatimModuleSyntax 禁访问）
        name: userId,
    } satisfies Universal.Channel;
}

/** 群聊频道（channelId = 群号）。 */
export function toTextChannel(channelId: string, guildName?: string): Universal.Channel {
    return {
        id: channelId,
        type: 0, // Channel.Type.TEXT（const enum，verbatimModuleSyntax 禁访问）
        name: guildName ?? channelId,
    } satisfies Universal.Channel;
}

/**
 * 登录信息 → koishi Universal.User 字段增量。
 *
 * 返回「非空字段」增量（uin/nick 为空或缺失时不产出），调用方合并到
 * this.user——保持「selfId 可能为空的场景下保留既有值」语义。
 */
export function toUserFields(partial: {
    uin?: string | undefined;
    nick?: string | undefined;
}): Partial<Universal.User> {
    const fields: Partial<Universal.User> = {};
    if (partial.uin !== undefined && partial.uin !== "") {
        fields.id = partial.uin;
    }
    if (partial.nick !== undefined && partial.nick !== "") {
        fields.name = partial.nick;
    }
    return fields;
}
