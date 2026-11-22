import type { Bot, Logger } from "koishi";
import type { NapukettoSessionFields } from "../bridge/events/types.js";
import type { NapukettoIpcClient } from "../runtime/ipc/index.js";
import type { NapukettoDatabase } from "./database.js";

interface DispatchHost {
    bot: Pick<Bot, "session" | "dispatch">;
    logger: Pick<Logger, "info" | "warn">;
    database: Pick<NapukettoDatabase, "ensureChannel" | "ensureUser">;
    autoAssign: boolean;
    autoAuthorize: number;
    getClient(): NapukettoIpcClient | null;
}

export class SessionDispatcher {
    constructor(private readonly host: DispatchHost) {}

    /** kernel 事件 session 字段 → koishi session → dispatch。 */
    async dispatch(fields: NapukettoSessionFields): Promise<void> {
        const client = this.host.getClient();
        if (client === null) {
            return;
        }
        // 预热避免 Koishi 并发创建同一 channel 或 binding 时触发唯一键冲突。
        // 预热失败只影响落库优化，不能阻断消息派发（见 docs/internals/bot.md）。
        if (fields.type === "message") {
            try {
                await this.preheat(fields);
            } catch (error) {
                this.host.logger.warn("[napuketto] 会话预热失败（继续派发）: %o", error);
            }
        }
        if (this.host.getClient() !== client) {
            return; // 预热期间子进程已退出或被替换
        }
        const session = this.host.bot.session({
            type: fields.type,
            // exactOptionalPropertyTypes：可选字段条件展开，不显式赋 undefined
            ...(fields.subtype !== undefined ? { subtype: fields.subtype } : {}),
            selfId: fields.selfId,
            platform: fields.platform,
            timestamp: fields.timestamp,
            ...(fields.member === undefined ? {} : { member: fields.member }),
        });
        applySessionFields(session, fields);
        // 消息路径关键日志（info，默认可见）：session 字段 + 渲染后文本
        this.host.logger.info(
            "[napuketto] dispatch: type=%s self=%s channel=%s user=%s isDirect=%s msg=%s",
            fields.type,
            fields.selfId,
            fields.channelId ?? "?",
            fields.userId ?? "?",
            fields.isDirect,
            fields.type === "message" ? (fields.elements?.join("") ?? "") : "",
        );
        this.host.bot.dispatch(session);
    }

    private async preheat(fields: NapukettoSessionFields): Promise<void> {
        if (this.host.autoAssign && fields.channelId !== undefined) {
            await this.host.database.ensureChannel({
                platform: fields.platform,
                id: fields.channelId,
                ...(fields.guildId !== undefined ? { guildId: fields.guildId } : {}),
                // assignee 仅非空 selfId（koishi autoAssign 语义：空串不落库）
                ...(fields.selfId !== "" ? { assignee: fields.selfId } : {}),
            });
        }
        if (fields.userId !== undefined && fields.userId !== "") {
            await this.host.database.ensureUser({
                platform: fields.platform,
                userId: fields.userId,
                authority: this.host.autoAuthorize,
            });
        }
    }
}

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
