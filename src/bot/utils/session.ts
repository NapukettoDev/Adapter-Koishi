/**
 * session.ts：koishi session 字段构建（自 bot.ts dispatchSession 拆出）。
 *
 * dispatchSession 原 69 行/17 cyclomatic——核心复杂度在「可选字段条件赋值 +
 * elements 特殊处理」两段。本模块抽出纯函数 applySessionFields（宽松结构，
 * 不依赖 koishi 具体 Session 类型，可单测），bot 层只做预热 + 构造 + 派发。
 */
import type { NapukettoSessionFields } from "../../events/index.js";

/** session 宽松结构（本模块消费的字段子集，避免依赖 koishi Session 全类型）。 */
export interface SessionLike {
    type?: string;
    subtype?: string;
    selfId?: string;
    platform?: string;
    timestamp?: number;
    userId?: string;
    operatorId?: string;
    channelId?: string;
    guildId?: string;
    messageId?: string;
    isDirect?: boolean;
    elements?: unknown[] | undefined;
}

/**
 * 把会话字段应用到 session 对象。
 *
 * ⚠️ exactOptionalPropertyTypes：可选字段条件展开，不显式赋 undefined。
 * ⚠️ elements 特殊处理：satorijs content 是 getter（elements.join("") 派生）；
 * 若直接赋 content 会走 setter → h.parse(value) 覆盖 elements（结构化元素
 * 丢失，含特殊字符时 parse 可能抛错 → dispatch 失败）。
 */
export function applySessionFields(session: SessionLike, fields: NapukettoSessionFields): void {
    // 必填字段
    session.type = fields.type;
    session.selfId = fields.selfId;
    session.platform = fields.platform;
    session.timestamp = fields.timestamp;
    // 可选字段（条件展开，不赋 undefined）
    if (fields.subtype !== undefined) {
        session.subtype = fields.subtype;
    }
    if (fields.userId !== undefined) {
        session.userId = fields.userId;
    }
    if (fields.operatorId !== undefined) {
        session.operatorId = fields.operatorId;
    }
    if (fields.channelId !== undefined) {
        session.channelId = fields.channelId;
    }
    if (fields.guildId !== undefined) {
        session.guildId = fields.guildId;
    }
    if (fields.messageId !== undefined) {
        session.messageId = fields.messageId;
    }
    // 私聊/群聊判定（event.channel.type = DIRECT/TEXT；不设则 isDirect 恒 false，
    // 私聊消息会被当群聊路由——onebot 实证）
    if (fields.isDirect !== undefined) {
        session.isDirect = fields.isDirect;
    }
    // 只设 elements：content 由 satorijs getter 派生（见文件头 ⚠️）
    if (fields.elements !== undefined) {
        session.elements = fields.elements;
    }
}
