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
    /**
     * dispatch 回调（koishi Bot.dispatch(session)）。
     * 返回 false 表示会话未真正进入 Koishi（如子进程已退出），事件桥不会提交
     * 消息去重记录，允许软重登后的重放；返回 Promise 时异步失败会被统一收口。
     * 其余返回值（含 undefined）按已送达处理，保持对旧实现的兼容。
     */
    dispatch: (session: NapukettoSessionFields) => unknown;
    /** 登录账号 uin（selfId）。 */
    selfId: () => string;
    selfUid?: () => string | undefined;
    ob11Actions?: boolean;
    /** koishi h() 工厂（apply() 层传 bindKoishiH(h)）。 */
    h: HFn;
    /** 平台名（默认 "onebot"）。 */
    platform?: string;
    /** 收向元素富化（voice NT silk → WAV 等；缺省直通）。signal 用于取消在途解码。 */
    enrichElements?: (
        elements: CanonicalElement[],
        signal?: AbortSignal,
    ) => Promise<CanonicalElement[]>;
    /** 诊断回调（坏事件 / 富化失败 / 订阅者异常 / 会话派发失败 / 队列饱和）。 */
    onError?: EventDiagnostic;
    /** 每频道待派发消息上限（缺省 64）。 */
    maxPendingPerChannel?: number;
    /** 全部频道待派发消息上限（缺省 256）。 */
    maxPendingTotal?: number;
    /** 普通消息去重窗口（毫秒，缺省 10 分钟）。 */
    messageDedupeWindowMs?: number;
    /** 普通消息去重记录上限（缺省 4096）。 */
    maxRecentMessages?: number;
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
    /**
     * 取消当前登录轮次的在途消息适配/派发与待派发队列。
     * 软重登、停止、退出和账号不一致拒绝上线时调用；取消后旧工作不会写入
     * 新轮次的会话或去重状态。旧实现可省略（事件按原样继续处理）。
     */
    cancelPending?(): void;
}
