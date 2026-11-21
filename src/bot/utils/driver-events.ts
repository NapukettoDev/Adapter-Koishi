/**
 * driver-events.ts：driver 事件接线工厂（自 bot.ts setupDriver 拆出）。
 *
 * NapukettoBot.setupDriver 里 50 行的 events 回调对象 → buildDriverEvents(host)
 * 工厂函数。依赖通过 host 接口注入（logger/login/bridge/offline 等），
 * bot 的 setupDriver 只剩一行组装——接线逻辑独立可读。
 *
 * 运行时仅依赖类型（DriverEvents 来自 driver/types，logger 是 koishi Logger
 * 接口），零 koishi 运行时依赖——可直接单测。
 */
import type { Logger } from "koishi";
import type { DriverEvents } from "../../driver/types.js";
import type { NapukettoEventBridge } from "../../events/index.js";
import type { IpcLoginPayload } from "../../ipc/index.js";
import type { NapukettoLoginState } from "../../login/index.js";

/** driver events 主机（bot 层提供依赖，避免工厂直接依赖 NapukettoBot 全量）。 */
export interface DriverEventsHost {
    /** 对应账号的 Bot logger。 */
    logger: Logger;
    /** 登录状态机（onLogin/onQr/onExit 转发）。 */
    login: Pick<NapukettoLoginState, "onLogin" | "onQr" | "onExit">;
    /** 事件桥（kernel 事件 → koishi session）。 */
    bridge: Pick<NapukettoEventBridge, "handle" | "resetMessageBaseline">;
    /** 是否已主动断开（status === DISCONNECT，onExit 判断是否 offline）。 */
    isDisconnected: () => boolean;
    /** 就绪回调（clientRef 更新 + online + 拉登录信息）。 */
    handleReady: () => void;
    /** 退出时解除动作桥的客户端绑定。 */
    clearClient: () => void;
    /**
     * logged_in 登录消息携带 selfInfo 时的补位校验（2026-09-08 软重登）：
     * driver 的 ready 幂等守卫下，软重登完成后 onReady 不会重触发，账号一致
     * 性校验（checkIdentity）需在登录消息面补位——换账号登录在此拒绝上线。
     */
    onLoggedIn?(self: NonNullable<IpcLoginPayload["selfInfo"]>): void;
    /** 下线回调（driver 崩溃/错误时置 offline）。 */
    offline: (error?: Error) => void;
    /**
     * 回调是否仍属于当前轮次。Bot 每次 start/stop 都递增轮次，旧 driver 在
     * 停止边界上的迟到回调（onExit/onError/onReady 等）据此丢弃。
     */
    isCurrent?: () => boolean;
}

/** 组装 driver 事件回调（bot.setupDriver 注入 DriverEvents）。 */
export function buildDriverEvents(host: DriverEventsHost): DriverEvents {
    const current = () => host.isCurrent?.() ?? true;
    return {
        onStatus: (status) => {
            if (!current()) {
                return;
            }
            host.logger.debug("[napuketto] 引导阶段: %s", status.phase);
        },
        onLogin: (payload) => {
            if (!current()) {
                return;
            }
            host.login.onLogin(payload.state, payload.selfInfo, payload.message);
            // 软重登换账号检测：logged_in 携带 selfInfo 时立即校验（初次引导
            // 也会经此早于 ready 触发一次——同账号幂等通过，见 checkIdentity）
            if (payload.state === "logged_in" && payload.selfInfo !== undefined) {
                host.onLoggedIn?.(payload.selfInfo);
            }
        },
        onQr: (qr) => {
            if (current()) {
                host.login.onQr(qr);
            }
        },
        onEventSubscription: () => {
            if (current()) {
                host.bridge.resetMessageBaseline();
            }
        },
        onEvent: (payload) => {
            if (!current()) {
                return;
            }
            // 事件桥入口（debug：Group 等高频事件在 info 下不刷屏；
            // 用户配 debug 可见全量事件转发，便于排查）
            host.logger.debug(
                "[napuketto] 收到事件: %s/%s args=%d",
                payload.service,
                payload.name,
                payload.args.length,
            );
            host.bridge.handle(payload);
        },
        onReady: () => {
            if (current()) {
                host.handleReady();
            }
        },
        onExit: () => {
            if (!current()) {
                return;
            }
            host.clearClient();
            host.login.onExit();
            // 非主动停止的退出 → offline（driver 内部会重启；达上限 onError）
            if (!host.isDisconnected()) {
                host.offline();
            }
        },
        onError: (error) => {
            if (!current()) {
                return;
            }
            host.logger.warn("[napuketto] 驱动错误: %o", error);
            host.offline(error instanceof Error ? error : new Error(String(error)));
        },
        onIpcWriteError: (error) => {
            if (current()) {
                host.logger.warn("[napuketto] IPC stdin 写入失败: %o", error);
            }
        },
        onLog: (log) => {
            if (current()) {
                host.logger.debug("[napuketto 子进程] %s", log.message);
            }
        },
    };
}
