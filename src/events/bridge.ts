/**
 * bridge.ts：NapukettoEventBridge——kernel 事件 → koishi session（docs/internals/events.md）。
 *
 * 订阅 driver.onEvent（kernel 事件 { service, name, args }）→ 翻译 → dispatch。
 * 本轮实现消息事件（Msg/onRecvMsg，args 为 RawMessage[] 运行时实证）——
 * 群通知/请求类（notice/request 系列）后续轮次。
 * 2026-08-27：service="ob11"（子进程 OB11 动作桥透出的 OneBot 11 原始事件，
 * §5.14）不经 koishi session 翻译，直接分发到 onOb11 订阅者（poke 类通知
 * 未来可用；args[0] 为完整事件对象）。
 */
import type { RawMessage } from "@napuketto/kernel";
import { adaptRawMessageWithMedia } from "./adapt.js";
import type { EventBridge, EventBridgeOptions, Ob11EventPayload } from "./types.js";

/** 消息事件名。 */
const MSG_RECV_EVENT = "onRecvMsg";

/** QQ 系统占位消息的发送者 uin（无业务内容，群通知走专门事件）。 */
const SYSTEM_SENDER_UIN = "0";

/** 事件桥（driver 事件源 → koishi dispatch）。 */
export class NapukettoEventBridge implements EventBridge {
    private readonly options: EventBridgeOptions;
    private readonly ob11Listeners = new Set<(event: Ob11EventPayload) => void>();

    constructor(options: EventBridgeOptions) {
        this.options = options;
    }

    /** 处理一条 kernel 事件（apply() 层作为 DriverEvents.onEvent 注入）。 */
    handle(payload: { service: string; name: string; args: unknown[] }): void {
        if (payload.service === "ob11") {
            this.dispatchOb11(payload.args[0]);
            return;
        }
        if (payload.service !== "Msg" || payload.name !== MSG_RECV_EVENT) {
            return; // 本轮只处理消息事件
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
            if (raw.senderUin === SYSTEM_SENDER_UIN) {
                continue;
            }
            this.dispatchMessage(raw);
        }
    }

    /** 单条 RawMessage → session → dispatch（含收向媒体富化，异步 fail-soft）。 */
    private dispatchMessage(msg: RawMessage): void {
        void this.adaptAndDispatch(msg);
    }

    private async adaptAndDispatch(msg: RawMessage): Promise<void> {
        const session = await adaptRawMessageWithMedia(msg, {
            selfId: this.options.selfId(),
            platform: this.options.platform ?? "onebot",
            h: this.options.h,
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
        for (const listener of this.ob11Listeners) {
            try {
                listener(typed);
            } catch {
                // 单订阅者异常不中断其他订阅者（与 EventBroadcaster 同款容错）
            }
        }
    }
}
