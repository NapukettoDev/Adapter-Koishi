/** raw IPC 和 OB11 事件到 Koishi Session 的分发入口。 */
import type { RawMessage } from "@napuketto/kernel";
import { adaptRawMessageWithMedia } from "./adapt.js";
import { normalizeMessageTime } from "./message-time.js";
import { type AdaptedEvent, adaptOb11Event, adaptRecall, findSystemTip } from "./notices.js";
import type { EventBridge, EventBridgeOptions, Ob11EventPayload } from "./types.js";

/** 消息事件名。 */
const MSG_RECV_EVENT = "onRecvMsg";

/** QQ 系统占位消息的发送者 uin（无业务内容，群通知走专门事件）。 */
const SYSTEM_SENDER_UIN = "0";

/** 兼容 QQ 服务端与宿主时钟偏差（NapukettoQQ #122）。 */
const STARTUP_GRACE_SECONDS = 5;
const MAX_RECENT_EVENTS = 4096;

/** 事件桥（driver 事件源 → koishi dispatch）。 */
export class NapukettoEventBridge implements EventBridge {
    private readonly options: EventBridgeOptions;
    private readonly ob11Listeners = new Set<(event: Ob11EventPayload) => void>();
    // 软重登会重建上游 OB11 订阅。保留 Bot 的去重记录以吸收未处理请求的重放。
    private readonly recentEvents = new Map<string, number>();
    private minMessageTime = 0;

    constructor(options: EventBridgeOptions) {
        this.options = options;
    }

    /** 在订阅或重新装配时记录基准，ready 回放沿用同一个值。 */
    resetMessageBaseline(): void {
        this.minMessageTime = (Math.floor(Date.now() / 1000) - STARTUP_GRACE_SECONDS) * 1000;
    }

    /** 处理一条 kernel 事件（apply() 层作为 DriverEvents.onEvent 注入）。 */
    handle(payload: { service: string; name: string; args: unknown[] }): void {
        if (payload.service === "ob11") {
            this.dispatchOb11(payload.args[0]);
            return;
        }
        if (payload.service !== "Msg" || payload.name !== MSG_RECV_EVENT) {
            return;
        }
        // onRecvMsg args[0] 为 RawMessage[]（批量推送，运行时实证）
        const messages = payload.args[0];
        const list = Array.isArray(messages) ? messages : [messages];
        for (const msg of list) {
            if (!msg || typeof msg !== "object") {
                continue;
            }
            const raw = msg as RawMessage;
            // ⚠️ 过滤系统占位消息（senderUin=0，2026-08-09 修复）：QQ 在群通知
            // 等系统事件时会把多条无内容占位消息随 onRecvMsg 批量推送（元素为空、
            // 无业务价值，群通知本身走 Group/onGroupNotifiesUpdated 专门事件）。
            // 若 dispatch 成 message 事件，koishi attach 会对无价值消息
            // get-or-create channel，多条同 tick 时撞 koishi get-or-create 的
            // 并发竞态——实测同批 4 条 → 1 成功 + 3 次 `UNIQUE constraint
            // failed: channel.id, channel.platform`（记录本身创建成功后续不复发，
            // 纯日志噪音，但无意义；框架侧根因见 koishijs/koishi#1545，真实消息
            // 批量到达的场景由 database 模块预热规避）。
            const timestamp = normalizeMessageTime(raw.msgTime);
            if (timestamp !== undefined && timestamp < this.minMessageTime) {
                continue;
            }
            const tip = findSystemTip(raw);
            if (tip !== undefined) {
                const recall = adaptRecall(raw, tip, this.eventContext(), timestamp);
                if (recall !== undefined) {
                    this.dispatchOnce(recall);
                }
                continue;
            }
            if (raw.senderUin !== SYSTEM_SENDER_UIN) {
                this.dispatchMessage(raw);
            }
        }
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
        this.options.dispatch(fields);
    }

    /** 单条 RawMessage → session → dispatch（含收向媒体富化，异步 fail-soft）。 */
    private dispatchMessage(msg: RawMessage): void {
        void this.adaptAndDispatch(msg);
    }

    private async adaptAndDispatch(msg: RawMessage): Promise<void> {
        const session = await adaptRawMessageWithMedia(msg, {
            ...this.eventContext(),
            ...(this.options.enrichElements !== undefined
                ? { enrichElements: this.options.enrichElements }
                : {}),
        });
        this.options.dispatch(session);
    }

    /** 订阅原始 OB11 事件（docs/internals/actions.md）；返回退订函数。 */
    onOb11(listener: (event: Ob11EventPayload) => void): () => void {
        this.ob11Listeners.add(listener);
        return () => {
            this.ob11Listeners.delete(listener);
        };
    }

    /** 单条 OB11 事件分发（结构异常静默丢弃，不阻塞其他事件）。 */
    private dispatchOb11(event: unknown): void {
        if (event === null || typeof event !== "object" || !("post_type" in event)) {
            return;
        }
        const typed = event as Ob11EventPayload;
        const adapted = adaptOb11Event(typed, this.eventContext());
        for (const listener of this.ob11Listeners) {
            try {
                listener(typed);
            } catch {
                // 单订阅者异常不中断其他订阅者（与 EventBroadcaster 同款容错）
            }
        }
        if (adapted !== undefined) {
            this.dispatchOnce(adapted);
        }
    }
}
