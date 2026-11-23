/**
 * types.ts：事件桥类型（docs/internals/events.md）。
 *
 * 事件桥做 kernel 事件 → koishi session 翻译。koishi Session 构造由
 * Bot.session(event) 完成（apply() 层注入 dispatch 回调），本层只产字段。
 */
import type { CanonicalElement } from "@napuketto/kernel";
import type { Universal } from "koishi";
import type { IpcEventPayload } from "../../runtime/ipc/index.js";
import type { HFn } from "../../shared.js";

/** koishi session 字段（宽松构造面——Bot.session(event) 接受的 Partial<Event>）。 */
export interface NapukettoSessionFields {
    type: string;
    /** 消息子类型（onebot 同构：群聊 group / 私聊 private；临时会话归 private）。 */
    subtype?: string;
    selfId: string;
    platform: string;
    timestamp: number;
    userId?: string;
    user?: Universal.User;
    friend?: Universal.Friend;
    quote?: Universal.Message;
    operatorId?: string;
    member?: Universal.GuildMember;
    channelId?: string;
    guildId?: string;
    messageId?: string;
    /** 是否私聊（私聊/临时会话 true；驱动 event.channel.type = DIRECT/TEXT）。 */
    isDirect?: boolean;
    /** koishi 元素数组（h[]，经 Element.toElementArray 可解析）。 */
    elements?: unknown[];
    content?: string;
}

/** 事件桥诊断回调（error 可能来自转换、富化、订阅者或会话派发）。 */
export type EventDiagnostic = (error: unknown, context: string) => void;

/** 事件桥选项（apply() 层注入）。 */
export interface EventBridgeOptions {
    /** dispatch 回调（koishi Bot.dispatch(session)）；可返回 Promise，异步失败会被统一收口。 */
    dispatch: (session: NapukettoSessionFields) => void | Promise<void>;
    /** 登录账号 uin（selfId）。 */
    selfId: () => string;
    selfUid?: () => string | undefined;
    ob11Actions?: boolean;
    /** koishi h() 工厂（apply() 层传 bindKoishiH(h)）。 */
    h: HFn;
    /** 平台名（默认 "onebot"）。 */
    platform?: string;
    /** 收向元素富化（voice NT silk → WAV 等，2026-09-08 T6；缺省直通）。 */
    enrichElements?: (elements: CanonicalElement[]) => Promise<CanonicalElement[]>;
    /** 诊断回调（坏事件 / 富化失败 / 订阅者异常 / 会话派发失败）。 */
    onError?: EventDiagnostic;
}

/** 原始 OB11 事件（宽松结构：post_type 定大类，其余字段按 OneBot 11 规范按需断言）。 */
export interface Ob11EventPayload {
    post_type: string;
    time?: number;
    self_id?: number;
    [key: string]: unknown;
}

/** 事件桥（driver 事件源 → dispatch）。 */
export interface EventBridge {
    /** 处理一条 kernel 事件（apply() 层作为 DriverEvents.onEvent 注入）。 */
    handle(payload: IpcEventPayload): void;
    /**
     * 订阅原始 OB11 事件（service="ob11"，docs/internals/actions.md）。
     * 子进程 OB11 动作桥未装配（ob11Actions=false / 降级）时不会有事件到来。
     * 返回退订函数。
     */
    onOb11(listener: (event: Ob11EventPayload) => void): () => void;
}
