/**
 * login-actions.ts：重新登录/强制扫码的动作决策与执行。
 *
 * 两条可用通道：
 *  - control login（原地，不重启子进程）：
 *    · 登录期（idle/waiting_scan/scanned）——loader 端成功结果抢占初始登录
 *      竞速（bootstrap-core LoginControl），装配链用新结果继续；
 *  - 重启宿主：logged_in / failed 态结束旧宿主，再启动新一轮登录。强制扫码时
 *    置一次性标记，无连接时也会保留标记，供下次 launch 消费。
 */

import type { LoginState } from "@napuketto/kernel";
import type { IpcControlPayload } from "@napuketto/loader";

/** 重新登录/扫码登录计划。 */
export type ReloginPlan =
    | { kind: "control-login"; uin: string; qr: boolean }
    | { kind: "restart"; forceQr: boolean };

/** 决策入参。 */
export interface ReloginPlanInput {
    /** 当前登录状态快照。 */
    state: LoginState;
    /** 登录账号（quickUin 透传给 control login）。 */
    uin: string;
    /** 是否强制扫码（false = 普通重新登录）。 */
    qrOnly: boolean;
}

/** 决策重新登录/强制扫码走哪条通道（纯函数）。 */
export function planRelogin(input: ReloginPlanInput): ReloginPlan {
    if (input.state === "logged_in" || input.state === "failed") {
        return { kind: "restart", forceQr: input.qrOnly };
    }
    return { kind: "control-login", uin: input.uin, qr: input.qrOnly };
}

/** 计划执行器（login-panel 传入 IPC 能力；单测 mock 验证指令发出）。 */
export interface ReloginExecutor {
    /** 发送 IPC 控制指令（client 未就绪返回 false）。 */
    sendControl: (payload: IpcControlPayload) => boolean;
    /** 请求重启宿主，需要时为下次启动标记强制扫码。 */
    restart: (forceQr: boolean) => boolean;
    /** 日志（info/warn 最小面）。 */
    logger: { info(message: string): void; warn(message: string): void };
}

/** 执行计划：按 kind 发对应指令（control-login 失败回落 restart）。 */
export function executeRelogin(plan: ReloginPlan, exec: ReloginExecutor): void {
    if (plan.kind === "control-login") {
        if (exec.sendControl({ command: "login", uin: plan.uin, qr: plan.qr })) {
            exec.logger.info(
                plan.qr
                    ? "[napuketto] 控制台请求强制扫码（control login qr）"
                    : "[napuketto] 控制台请求重新登录（control login 原地重登）",
            );
            return;
        }
        // client 不可用回落整进程重启路径
    }
    const forceQr = plan.kind === "restart" ? plan.forceQr : plan.qr;
    if (exec.restart(forceQr)) {
        exec.logger.info(
            forceQr
                ? "[napuketto] 控制台请求强制扫码（重启子进程）"
                : "[napuketto] 控制台请求重新登录（重启子进程）",
        );
    } else if (forceQr) {
        exec.logger.warn("[napuketto] 子进程未就绪，已标记下次启动时扫码");
    } else {
        exec.logger.warn("[napuketto] 子进程未就绪，无法重新登录");
    }
}
