/**
 * login-actions.ts：重新登录/强制扫码的动作决策与执行。
 *
 * 两条可用通道：
 *  - control login（原地，不重启子进程）：
 *    · 登录期（idle/waiting_scan/scanned）——loader 端成功结果抢占初始登录
 *      竞速（bootstrap-core LoginControl），装配链用新结果继续；
 *    · logged_in（ready 态）——**软重登**：loader 端清理旧装配面后用新结果
 *      重跑装配链（relogin.ts 相位机 ②），不重启进程；换账号登录会被
 *      checkIdentity 拒绝上线（期望行为，防数据目录/assignee 污染）。
 *  - control restart（整进程重启）：failed 态有连接时发送；强制扫码重启会置一次性标记，
 *    无连接时也会保留标记，供下次 launch 消费。
 */

import type { LoginState } from "@napuketto/kernel";
import type { IpcControlPayload } from "@napuketto/loader";

/** control login 可用状态（登录期抢占 + ready 态软重登）。 */
const CONTROL_LOGIN_STATES: ReadonlySet<string> = new Set([
    "idle",
    "waiting_scan",
    "scanned",
    "logged_in",
]);

/** 重新登录/扫码登录计划。 */
export type ReloginPlan =
    | { kind: "control-login"; uin: string; qr: boolean; soft: boolean }
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

/** 决策重新登录/强制扫码走哪条通道（纯函数）。soft = ready 态软重登。 */
export function planRelogin(input: ReloginPlanInput): ReloginPlan {
    if (CONTROL_LOGIN_STATES.has(input.state)) {
        return {
            kind: "control-login",
            uin: input.uin,
            qr: input.qrOnly,
            soft: input.state === "logged_in",
        };
    }
    return { kind: "restart", forceQr: input.qrOnly };
}

/** 计划执行器（login-panel 传入 IPC 能力；单测 mock 验证指令发出）。 */
export interface ReloginExecutor {
    /** 发送 IPC 控制指令（client 未就绪返回 false）。 */
    sendControl: (payload: IpcControlPayload) => boolean;
    /** 强制扫码重启（置 qrOnly 标记 + control restart；client 未就绪返回 false）。 */
    forceQrRestart: () => boolean;
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
                    : plan.soft
                      ? "[napuketto] 控制台请求软重登（control login 原地重登 + 重装配）"
                      : "[napuketto] 控制台请求重新登录（control login 原地重登）",
            );
            return;
        }
        // client 不可用回落整进程重启路径
    }
    if (plan.kind === "restart" ? plan.forceQr : plan.qr) {
        if (exec.forceQrRestart()) {
            exec.logger.info("[napuketto] 控制台请求强制扫码（qrOnly 标记 + 重启子进程）");
            return;
        }
        exec.logger.warn("[napuketto] 子进程未就绪，已标记下次启动时扫码");
        return;
    }
    if (exec.sendControl({ command: "restart" })) {
        exec.logger.info("[napuketto] 控制台请求重新登录（重启子进程）");
    } else {
        exec.logger.warn("[napuketto] 子进程未就绪，无法重新登录");
    }
}
