import type { Bot, Computed, Logger } from "koishi";
import type { NapukettoSessionFields } from "../bridge/events/types.js";
import type { NapukettoIpcClient } from "../runtime/ipc/index.js";
import type { NapukettoDatabase } from "./database.js";
import { isAssignPolicy, isAuthorizePolicy, resolvePolicy } from "./policy.js";

interface DispatchHost {
    bot: Pick<Bot, "session" | "dispatch">;
    logger: Pick<Logger, "info" | "warn">;
    database: Pick<NapukettoDatabase, "ensureChannel" | "ensureUser">;
    /**
     * 原始 autoAssign 配置：boolean 为静态值；函数只在仅读取不可变 session
     * 字段时于预热阶段求值，Eval 表达式交给 Koishi（见 policy.ts）。
     */
    autoAssign: Computed<boolean>;
    /** 原始 autoAuthorize 配置，语义同 autoAssign。 */
    autoAuthorize: Computed<number>;
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
        // 先建 session：动态 Computed 需要用真实 session 求值（见 policy.ts）。
        // session 字段在 dispatch 前不会变，求值结果与 Koishi 后续求值一致。
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
        // 预热避免 Koishi 并发创建同一 channel 或 binding 时触发唯一键冲突。
        // 预热失败只影响落库优化，不能阻断消息派发（见 docs/internals/bot.md）。
        if (fields.type === "message") {
            try {
                await this.preheat(fields, session);
            } catch (error) {
                this.host.logger.warn("[napuketto] 会话预热失败（继续派发）: %o", error);
            }
        }
        if (this.host.getClient() !== client) {
            return; // 预热期间子进程已退出或被替换
        }
        this.host.logger.info(
            "[napuketto] dispatch: type=%s self=%s channel=%s user=%s isDirect=%s elements=%d",
            fields.type,
            fields.selfId,
            fields.channelId ?? "?",
            fields.userId ?? "?",
            fields.isDirect,
            fields.elements?.length ?? 0,
        );
        this.host.bot.dispatch(session);
    }

    private async preheat(fields: NapukettoSessionFields, session: object): Promise<void> {
        // 动态 Computed 只在「仅读取不可变 session 字段」时可安全等价求值；读取
        // user/channel 等延迟字段、调用 session 方法或抛错时，policy.ts 返回
        // deferred，对应预热跳过，由 Koishi 在 dispatch 时按真实 session 求值。
        const assign = resolvePolicy(this.host.autoAssign, session, isAssignPolicy);
        if (
            assign.kind === "resolved" &&
            assign.value &&
            fields.channelId !== undefined &&
            // koishi getChannel：assignee 为空串时返回 detached，不落库。
            fields.selfId !== ""
        ) {
            await this.host.database.ensureChannel({
                platform: fields.platform,
                id: fields.channelId,
                ...(fields.guildId !== undefined ? { guildId: fields.guildId } : {}),
                assignee: fields.selfId,
            });
        }
        const authorize = resolvePolicy(this.host.autoAuthorize, session, isAuthorizePolicy);
        if (
            authorize.kind === "resolved" &&
            // 0 与 Koishi 一致：不落库（detached user），无需预热。
            authorize.value !== 0 &&
            fields.userId !== undefined &&
            fields.userId !== ""
        ) {
            await this.host.database.ensureUser({
                platform: fields.platform,
                userId: fields.userId,
                authority: authorize.value,
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
