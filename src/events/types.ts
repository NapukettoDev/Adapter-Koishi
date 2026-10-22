/**
 * types.ts：事件桥类型（docs/internals/events.md）。
 *
 * 事件桥做 kernel 事件 → koishi session 翻译。koishi Session 构造由
 * Bot.session(event) 完成（apply() 层注入 dispatch 回调），本层只产字段。
 */
import type { CanonicalElement } from "@napuketto/kernel";
import type { IpcEventPayload } from "../ipc/index.js";
import type { HFn } from "./elements.js";

/** koishi session 字段（宽松构造面——Bot.session(event) 接受的 Partial<Event>）。 */
export interface NapukettoSessionFields {
    type: string;
    /** 消息子类型（onebot 同构：群聊 group / 私聊 private；临时会话归 private）。 */
    subtype?: string;
    selfId: string;
    platform: string;
    timestamp: number;
    userId?: string;
    channelId?: string;
    guildId?: string;
    messageId?: string;
    /** 是否私聊（私聊/临时会话 true；驱动 event.channel.type = DIRECT/TEXT）。 */
    isDirect?: boolean;
    /** koishi 元素数组（h[]，经 Element.toElementArray 可解析）。 */
    elements?: unknown[];
    content?: string;
}

/** 事件桥选项（apply() 层注入）。 */
export interface EventBridgeOptions {
    /** dispatch 回调（koishi Bot.dispatch(session)）。 */
    dispatch: (session: NapukettoSessionFields) => void;
    /** 登录账号 uin（selfId）。 */
    selfId: () => string;
    /** koishi h() 工厂（apply() 层传 bindKoishiH(h)）。 */
    h: HFn;
    /** 平台名（默认 "onebot"）。 */
    platform?: string;
    /** 收向元素富化（voice NT silk → WAV 等，2026-09-08 T6；缺省直通）。 */
    enrichElements?: (elements: CanonicalElement[]) => Promise<CanonicalElement[]>;
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
