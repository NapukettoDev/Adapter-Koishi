/** 把当前轮次的驱动事件接到登录状态、桥接和 Bot 回调。 */
import type { Logger } from "koishi";
import type { NapukettoEventBridge } from "../bridge/events/bridge.js";
import type { NapukettoLoginState } from "../console/login-state.js";
import type { DriverEvents } from "../runtime/driver/types.js";
import type { IpcLoginPayload } from "../runtime/ipc/index.js";

/** driver events 主机（bot 层提供依赖，避免工厂直接依赖 NapukettoBot 全量）。 */
export interface DriverEventsHost {
    /** 对应账号的 Bot logger。 */
    logger: Pick<Logger, "debug" | "warn">;
    /** 登录状态机（onLogin/onQr/onExit 转发）。 */
    login: Pick<NapukettoLoginState, "onLogin" | "onQr" | "onExit">;
    /** 事件桥（kernel 事件 → koishi session）。 */
    bridge: Pick<NapukettoEventBridge, "handle" | "resetMessageBaseline">;
    /** 是否已主动断开（status === DISCONNECT，onExit 判断是否 offline）。 */
    isDisconnected: () => boolean;
    /** 就绪回调（clientRef 更新 + online + 拉登录信息）。 */
    handleReady: () => void;
    /** 手动重启宿主时更新 Bot 状态与登录快照。 */
    handleLoginRestart: () => void;
    /** 结束当前会话时解除动作桥的客户端绑定。 */
    clearClient: () => void;
    /** 收到登录账号时立即校验，覆盖账号信息晚于 ready 到达的情况。 */
    onLoggedIn?(self: NonNullable<IpcLoginPayload["selfInfo"]>): void;
    /** 下线回调（driver 崩溃/错误时置 offline）。 */
    offline: (error?: Error) => void;
    /** 是否仍属于最近创建的驱动轮次。 */
    isCurrent?: () => boolean;
}

/** 组装 driver 事件回调（生命周期控制器注入 DriverEvents）。 */
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
        onLoginRestart: () => {
            if (current()) {
                host.clearClient();
                host.handleLoginRestart();
            }
        },
        onExit: ({ reason }) => {
            if (!current()) {
                return;
            }
            host.clearClient();
            host.login.onExit();
            // 手动重启从旧宿主退出到新宿主就绪都保持连接中。
            if (reason !== "restart" && !host.isDisconnected()) {
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
