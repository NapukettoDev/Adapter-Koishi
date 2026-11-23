/**
 * transform.ts：kernel 数据 → koishi Universal 形状翻译（自 bot.ts 拆出）。
 *
 * 纯函数（仅 import type koishi Universal，不 import 运行时）→ 可单测
 * （docs/guides/development.md 单测边界：koishi 运行时 import 会崩单测）。
 *
 * 职责：好友/群/频道/登录信息的形状映射，bot.ts 的 override 方法只做
 * 「internal 调用 + 委托本模块翻译」。
 */
import { isRecord } from "@napuketto/kernel";
import type { Bot, Universal } from "koishi";
import type { NapukettoInternal } from "../bridge/actions/internal.js";
import type { LoginSnapshot } from "../console/login-state.js";
import { nonBlank, PRIVATE_PREFIX, qqId } from "../shared.js";

/** kernel 好友列表 → koishi Universal.Friend 列表。 */
export function toFriendList(raw: unknown): Universal.List<Universal.Friend> {
    if (!Array.isArray(raw)) return { data: [] };
    return {
        data: raw.flatMap((friend: unknown) => {
            if (!isRecord(friend)) return [];
            const id = qqId(friend["uin"]);
            if (id === undefined) return [];
            const name = nonBlank(friend["nickname"]) ?? id;
            return [{ user: { id, name }, nick: nonBlank(friend["remark"]) ?? name }];
        }),
    };
}

/** kernel 群列表 → koishi Universal.Guild 列表。 */
export function toGuildList(raw: unknown): Universal.List<Universal.Guild> {
    if (!Array.isArray(raw)) return { data: [] };
    return {
        data: raw.flatMap((group: unknown) => {
            if (!isRecord(group)) return [];
            const id = qqId(group["groupCode"]);
            return id === undefined ? [] : [{ id, name: nonBlank(group["groupName"]) ?? id }];
        }),
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
    const id = qqId(partial.uin);
    const name = nonBlank(partial.nick);
    if (id !== undefined) fields.id = id;
    if (name !== undefined) fields.name = name;
    return fields;
}

type LoginBot = Pick<Bot, "selfId" | "user" | "toJSON"> & {
    internal: Pick<NapukettoInternal, "getSelf">;
};

/**
 * 登录推送已有自身信息时直接使用，缺省时才向宿主拉取。
 *
 * `isCurrent` 绑定调用时的驱动/登录轮次：异步查询返回后若已经软重登或换轮，
 * 结果必须丢弃，不能把旧账号写回 bot.selfId/user。
 */
export async function resolveBotLogin(
    bot: LoginBot,
    self: LoginSnapshot["self"],
    isCurrent: () => boolean = () => true,
): Promise<Universal.Login> {
    if (self !== undefined) {
        if (isCurrent()) {
            syncUser(bot, { uin: self.uin, nick: self.nick });
            bot.selfId = self.uin;
        }
    } else {
        const data = (await bot.internal.getSelf()) as
            | { uin?: string; nickname?: string }
            | undefined;
        if (!isCurrent()) {
            return bot.toJSON();
        }
        if (data != null) {
            // 查询结果与配置账号不一致时保留既有身份；账号闸门负责拒绝上线。
            const id = qqId(data.uin);
            if (id !== undefined && id !== bot.selfId) {
                return bot.toJSON();
            }
            if (id !== undefined) {
                bot.selfId = id;
            }
            syncUser(bot, { uin: data.uin, nick: data.nickname });
        }
    }
    return bot.toJSON();
}

export function syncUser(
    bot: Pick<Bot, "user">,
    partial: Parameters<typeof toUserFields>[0],
): void {
    bot.user ??= {} as Universal.User;
    Object.assign(bot.user, toUserFields(partial));
}
