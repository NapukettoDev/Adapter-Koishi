/** raw IPC 和 OB11 事件到 Koishi Session 的分发入口。 */
import { ElementType, type RawMessage } from "@napuketto/kernel";
import { IpcGroupRequestSchema } from "../../runtime/ipc/index.js";
import { normalizeMessageTime } from "../../shared.js";
import { adaptRawMessageWithMedia, messageChannel, messageIdentities } from "./adapt.js";
import {
    type AdaptedEvent,
    adaptGroupRequest,
    adaptOb11Event,
    adaptRecall,
    findSystemTip,
} from "./notices.js";
import { BoundedChannelQueue } from "./queue.js";
import type {
    EventBridge,
    EventBridgeOptions,
    NapukettoSessionFields,
    Ob11EventPayload,
} from "./types.js";
import { validateRawMessage } from "./validate.js";

/** 消息事件名。 */
const MSG_RECV_EVENT = "onRecvMsg";

/** QQ 系统占位消息的发送者 uin（无业务内容，群通知走专门事件）。 */
const SYSTEM_SENDER_UIN = "0";

/** 兼容 QQ 服务端与宿主时钟偏差（Napuketto #122）。 */
const STARTUP_GRACE_SECONDS = 5;
const MAX_RECENT_EVENTS = 4096;
/** 普通消息去重窗口：覆盖软重登重放，同时避免长期占用内存。 */
const MESSAGE_DEDUPE_WINDOW_MS = 10 * 60 * 1000;
const MAX_RECENT_MESSAGES = 4096;
const RECALL_FALLBACK_MS = 500;

/** 普通消息去重登记：提交（已派发）或释放（取消/未派发）。 */
interface MessageReservation {
    readonly key: string;
    readonly token: symbol;
}

/** 安全收窄 OB11 事件外壳（读取字段抛错按非法事件处理）。 */
function asOb11Event(value: unknown): Ob11EventPayload | null {
    try {
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
            return null;
        }
        const postType = (value as Record<string, unknown>)["post_type"];
        return typeof postType === "string" ? (value as Ob11EventPayload) : null;
    } catch {
        return null;
    }
}

/** 事件桥（driver 事件源 → koishi dispatch）。 */
export class NapukettoEventBridge implements EventBridge {
    private readonly options: EventBridgeOptions;
    private readonly ob11Listeners = new Set<(event: Ob11EventPayload) => void>();
    // 软重登会重建上游 OB11 订阅。保留 Bot 的去重记录以吸收未处理请求的重放。
    private readonly recentEvents = new Map<string, number>();
    /**
     * 普通消息去重：进行中登记与已派发窗口分离。只有真正交给 Koishi 的消息
     * 才写入 recentMessages；取消/未派发会释放登记，让重放仍可派发。
     */
    private readonly pendingMessages = new Map<string, symbol>();
    private readonly recentMessages = new Map<string, number>();
    private readonly queue: BoundedChannelQueue;
    private readonly identities = new Map<string, string>();
    private readonly recalls = new Map<
        string,
        { event: AdaptedEvent; timer: NodeJS.Timeout; fromOb11: boolean }
    >();
    private minMessageTime = 0;
    /** 入站代次：软重登/停止/退出后旧的在途工作作废。 */
    private generation = 0;

    private readonly resolveUin = (uid: string) =>
        uid === this.options.selfUid?.() ? this.options.selfId() : this.identities.get(uid);

    constructor(options: EventBridgeOptions) {
        this.options = options;
        this.queue = new BoundedChannelQueue({
            ...(options.maxPendingPerChannel !== undefined
                ? { maxPendingPerChannel: options.maxPendingPerChannel }
                : {}),
            ...(options.maxPendingTotal !== undefined
                ? { maxPendingTotal: options.maxPendingTotal }
                : {}),
            onOverflow: (_key, reason) => {
                this.report(
                    new Error(reason === "channel" ? "频道消息队列已满" : "全局消息队列已满"),
                    "消息队列饱和（已立即派发，顺序降级）",
                );
            },
        });
    }

    private get dedupeWindow(): number {
        return this.options.messageDedupeWindowMs ?? MESSAGE_DEDUPE_WINDOW_MS;
    }

    private get maxRecentMessages(): number {
        return this.options.maxRecentMessages ?? MAX_RECENT_MESSAGES;
    }

    /** 在订阅或重新装配时记录基准，ready 回放沿用同一个值。 */
    resetMessageBaseline(): void {
        // 真实订阅重置（首订/软重登）意味着旧会话在途的适配与派发都已失效。
        this.cancelPending();
        this.identities.clear();
        this.minMessageTime = (Math.floor(Date.now() / 1000) - STARTUP_GRACE_SECONDS) * 1000;
    }

    /**
     * 取消当前代次的在途与待派发消息，并停止撤回回退计时器。
     * 已派发消息的去重记录保留，用于吸收重登后的重放。
     */
    cancelPending(): void {
        this.generation += 1;
        this.queue.cancelAll();
        for (const { timer } of this.recalls.values()) {
            clearTimeout(timer);
        }
        this.recalls.clear();
    }

    /** 处理一条 kernel 事件（apply() 层作为 DriverEvents.onEvent 注入）。 */
    handle(payload: { service: string; name: string; args: unknown[] }): void {
        if (payload.service === "ob11") {
            this.dispatchOb11(payload.args[0]);
            return;
        }
        if (payload.service === "Group" && payload.name === "onRequest") {
            try {
                const payloadResult = IpcGroupRequestSchema.safeParse(payload.args[0]);
                if (!payloadResult.success) {
                    this.report(new TypeError("群请求结构非法"), "群请求事件已丢弃");
                    return;
                }
                const request = adaptGroupRequest(
                    payloadResult.data,
                    this.eventContext(),
                    this.resolveUin,
                );
                if (request !== undefined) {
                    this.dispatchOnce(request);
                }
            } catch (error) {
                this.report(error, "群请求事件处理失败（已丢弃）");
            }
            return;
        }
        if (payload.service !== "Msg" || payload.name !== MSG_RECV_EVENT) {
            return;
        }
        // onRecvMsg args[0] 为 RawMessage[]（批量推送，运行时实证）
        const messages = payload.args[0];
        const list = Array.isArray(messages) ? messages : [messages];
        for (const item of list) {
            // 单条坏消息只影响自己：结构校验在元素转换之前，后续条目继续处理。
            const validation = validateRawMessage(item);
            if (!validation.ok) {
                this.report(new Error(validation.reason), "消息事件结构非法（已丢弃）");
                continue;
            }
            try {
                this.handleMessage(validation.message);
            } catch (error) {
                this.report(error, "消息事件处理失败（已丢弃）");
            }
        }
    }

    private handleMessage(raw: RawMessage): void {
        const timestamp = normalizeMessageTime(raw.msgTime);
        if (timestamp !== undefined && timestamp < this.minMessageTime) {
            return;
        }
        for (const [uid, uin] of messageIdentities(raw)) {
            this.identities.delete(uid);
            const oldest = this.identities.keys().next().value;
            if (this.identities.size >= MAX_RECENT_EVENTS && oldest !== undefined) {
                this.identities.delete(oldest);
            }
            this.identities.set(uid, uin);
        }
        const tip = findSystemTip(raw);
        if (tip !== undefined) {
            const recall = adaptRecall(raw, tip, this.eventContext(), timestamp, this.resolveUin);
            if (recall !== undefined) {
                this.dispatchRecall(recall, false);
            }
            return;
        }
        const grayOnly =
            raw.elements.length > 0 &&
            raw.elements.every((element) => element.elementType === ElementType.GRAY_TIP);
        if (raw.senderUin !== SYSTEM_SENDER_UIN && !grayOnly) {
            this.acceptMessage(raw);
        }
    }

    /**
     * 普通消息进入按频道有界队列。
     *
     * 去重键使用账号 + 频道 + 原生消息 ID：只对能可靠确定频道的消息登记，
     * 不同消息 ID、不同频道或不同账号不会互相吞掉。命中窗口内重复（含软重登
     * 重放）直接丢弃；取消/未真正派发时释放登记，重放仍可送达。
     */
    private acceptMessage(raw: RawMessage): void {
        const selfId = this.options.selfId();
        const channel = messageChannel(raw, selfId, this.resolveUin);
        const reservation =
            channel === undefined
                ? undefined
                : this.reserveMessage(selfId, channel.channelId, raw.msgId);
        if (reservation === "duplicate") {
            return;
        }
        const key = channel?.channelId ?? "unroutable";
        const generation = this.generation;
        this.queue.enqueue(key, {
            run: (signal) => this.adaptAndDispatch(raw, reservation, generation, signal),
            cancel: () => {
                if (reservation !== undefined) {
                    this.releaseMessage(reservation);
                }
            },
        });
    }

    private reserveMessage(
        selfId: string,
        channelId: string,
        messageId: string,
    ): MessageReservation | "duplicate" {
        // U+0000 不会出现在 QQ 号、频道 ID 或消息 ID 中，避免拼接歧义。
        const key = `${selfId}\u0000${channelId}\u0000${messageId}`;
        const now = Date.now();
        const seenUntil = this.recentMessages.get(key);
        if (seenUntil !== undefined) {
            if (seenUntil >= now) {
                return "duplicate";
            }
            this.recentMessages.delete(key);
        }
        if (this.pendingMessages.has(key)) {
            return "duplicate";
        }
        const token = Symbol(key);
        this.pendingMessages.set(key, token);
        return { key, token };
    }

    private commitMessage(reservation: MessageReservation): void {
        if (this.pendingMessages.get(reservation.key) !== reservation.token) {
            return;
        }
        this.pendingMessages.delete(reservation.key);
        const now = Date.now();
        this.recentMessages.delete(reservation.key);
        this.recentMessages.set(reservation.key, now + this.dedupeWindow);
        if (this.recentMessages.size <= this.maxRecentMessages) {
            return;
        }
        for (const [key, expiresAt] of this.recentMessages) {
            if (expiresAt <= now) {
                this.recentMessages.delete(key);
            }
        }
        while (this.recentMessages.size > this.maxRecentMessages) {
            const oldest = this.recentMessages.keys().next().value;
            if (oldest === undefined) {
                break;
            }
            this.recentMessages.delete(oldest);
        }
    }

    private releaseMessage(reservation: MessageReservation): void {
        if (this.pendingMessages.get(reservation.key) === reservation.token) {
            this.pendingMessages.delete(reservation.key);
        }
    }

    private dispatchRecall(event: AdaptedEvent, fromOb11: boolean): void {
        const { key, fields } = event;
        if (fields.timestamp < this.minMessageTime || this.recentEvents.has(key)) {
            return;
        }
        const pending = this.recalls.get(key);
        if (pending !== undefined) {
            const higher = fromOb11 ? fields : pending.event.fields;
            const lower = fromOb11 ? pending.event.fields : fields;
            const mixedSources = pending.fromOb11 !== fromOb11;
            pending.event = { key, fields: { ...lower, ...higher } };
            pending.fromOb11 ||= fromOb11;
            if (
                (mixedSources || fromOb11) &&
                pending.event.fields.userId !== undefined &&
                pending.event.fields.operatorId !== undefined
            ) {
                clearTimeout(pending.timer);
                this.recalls.delete(key);
                this.dispatchOnce(pending.event);
            }
            return;
        }
        // 启用 OB11 时，给异步通知短暂留出补齐作者或操作者的时间。
        if (
            fields.isDirect ||
            (fromOb11 && fields.userId !== undefined && fields.operatorId !== undefined) ||
            !this.options.ob11Actions ||
            this.recalls.size >= MAX_RECENT_EVENTS
        ) {
            if (fields.userId !== undefined) this.dispatchOnce(event);
            return;
        }
        const timer = setTimeout(() => {
            const current = this.recalls.get(key);
            this.recalls.delete(key);
            if (current?.event.fields.userId !== undefined) this.dispatchOnce(current.event);
        }, RECALL_FALLBACK_MS);
        timer.unref();
        this.recalls.set(key, { event, timer, fromOb11 });
    }

    private eventContext() {
        return {
            selfId: this.options.selfId(),
            platform: this.options.platform ?? "onebot",
            h: this.options.h,
        };
    }

    private dispatchOnce({ fields, key, expiresAt }: AdaptedEvent): void {
        const seenUntil = this.recentEvents.get(key);
        if (seenUntil !== undefined && seenUntil >= Date.now()) {
            return;
        }
        this.recentEvents.delete(key);
        if (this.recentEvents.size >= MAX_RECENT_EVENTS) {
            const oldest = this.recentEvents.keys().next().value;
            if (oldest !== undefined) {
                this.recentEvents.delete(oldest);
            }
        }
        this.recentEvents.set(key, expiresAt ?? Infinity);
        this.dispatchSafely(fields);
    }

    /** 单条 RawMessage → 富化 → session → dispatch（同一频道按队列顺序）。 */
    private async adaptAndDispatch(
        msg: RawMessage,
        reservation: MessageReservation | undefined,
        generation: number,
        signal: AbortSignal,
    ): Promise<void> {
        let session: NapukettoSessionFields;
        try {
            session = await adaptRawMessageWithMedia(msg, {
                ...this.eventContext(),
                resolveUin: this.resolveUin,
                signal,
                ...(this.options.enrichElements !== undefined
                    ? { enrichElements: this.options.enrichElements }
                    : {}),
                onError: (error, context) => this.report(error, context),
            });
        } catch (error) {
            if (reservation !== undefined) {
                this.releaseMessage(reservation);
            }
            if (generation === this.generation && !signal.aborted) {
                this.report(error, "消息事件转换失败（已丢弃）");
            }
            return;
        }
        // 旧登录轮次的适配结果不得写入新轮次的去重/会话状态。
        if (generation !== this.generation || signal.aborted) {
            if (reservation !== undefined) {
                this.releaseMessage(reservation);
            }
            return;
        }
        await this.dispatchMessage(session, reservation);
    }

    private async dispatchMessage(
        fields: NapukettoSessionFields,
        reservation: MessageReservation | undefined,
    ): Promise<void> {
        let result: unknown;
        try {
            result = this.options.dispatch(fields);
        } catch (error) {
            if (reservation !== undefined) {
                this.releaseMessage(reservation);
            }
            this.report(error, "会话派发失败（同步）");
            return;
        }
        try {
            const delivered = await result;
            if (delivered === false) {
                if (reservation !== undefined) {
                    this.releaseMessage(reservation);
                }
                return;
            }
            if (reservation !== undefined) {
                this.commitMessage(reservation);
            }
        } catch (error) {
            if (reservation !== undefined) {
                this.releaseMessage(reservation);
            }
            this.report(error, "会话派发失败（异步）");
        }
    }

    /** 会话派发（非消息事件）：同步抛错与 Promise 拒绝都收敛为诊断，后续事件继续。 */
    private dispatchSafely(fields: NapukettoSessionFields): void {
        try {
            const result = this.options.dispatch(fields);
            if (result !== undefined) {
                void Promise.resolve(result).catch((error: unknown) => {
                    this.report(error, "会话派发失败（异步）");
                });
            }
        } catch (error) {
            this.report(error, "会话派发失败（同步）");
        }
    }

    /** 订阅原始 OB11 事件（docs/internals/actions.md）；返回退订函数。 */
    onOb11(listener: (event: Ob11EventPayload) => void): () => void {
        this.ob11Listeners.add(listener);
        return () => {
            this.ob11Listeners.delete(listener);
        };
    }

    /** 单条 OB11 事件分发（结构异常丢弃并诊断，不阻塞其他事件）。 */
    private dispatchOb11(event: unknown): void {
        const typed = asOb11Event(event);
        if (typed === null) {
            this.report(new Error("缺少 post_type 或不是对象"), "OB11 事件结构非法（已丢弃）");
            return;
        }
        let adapted: AdaptedEvent | undefined;
        try {
            adapted = adaptOb11Event(typed, this.eventContext());
        } catch (error) {
            this.report(error, "OB11 事件转换失败（原始订阅继续）");
        }
        // 快照遍历：订阅者在回调内退订不影响本轮其余订阅者。
        for (const listener of [...this.ob11Listeners]) {
            try {
                listener(typed);
            } catch (error) {
                // 单订阅者异常不中断其他订阅者（与 EventBroadcaster 同款容错）
                this.report(error, "OB11 订阅者异常（已隔离）");
            }
        }
        if (adapted?.fields.type === "message-deleted") {
            this.dispatchRecall(adapted, true);
        } else if (adapted !== undefined) {
            this.dispatchOnce(adapted);
        }
    }

    /** 诊断回调自身异常不得反向影响事件处理。 */
    private report(error: unknown, context: string): void {
        try {
            this.options.onError?.(error, context);
        } catch {
            // 忽略诊断通道故障，优先保证后续事件送达。
        }
    }
}
