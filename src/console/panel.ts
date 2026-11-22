import type { LoginState } from "@napuketto/kernel";
import type { IpcControlPayload } from "@napuketto/loader";
import type { Context, Logger } from "koishi";
import { registerConsoleEntry } from "./entry.js";
import type { LoginSnapshot } from "./login-state.js";
import { toLoginPanelPayload } from "./model.js";
import type { bindLoginProvider } from "./provider.js";

/** 面板装配依赖（bot 层注入，职责解耦：面板不直接持有 IPC client）。 */
export interface LoginPanelDeps {
    /** 登录账号（QQ 号，serviceId 隔离）。 */
    selfId: string;
    /** 登录快照 getter（每次推送时取最新）。 */
    getSnapshot: () => LoginSnapshot;
    /** 发送 IPC 控制指令（重新登录；client 未就绪返回 false）。 */
    sendControl: (payload: IpcControlPayload) => boolean;
    /** IPC 动作请求（刷新二维码；client 未就绪时 reject 由调用方处理）。 */
    request: (action: string, params?: Record<string, unknown>) => Promise<unknown>;
    /** 请求重启宿主，需要时为下次启动标记强制扫码。 */
    restart: (forceQr: boolean) => boolean;
    /** 对应账号的 Bot logger。 */
    logger: Logger;
}

/** 控制台登录面板装配（每 bot 实例一份）。 */
export class NapukettoLoginPanel {
    private publish: (() => void) | undefined;

    constructor(
        private readonly deps: LoginPanelDeps,
        private readonly bindProvider: typeof bindLoginProvider,
    ) {}

    /** console 服务就绪后装配（bot 构造时调用）。 */
    setup(ctx: Context): void {
        ctx.inject(["console"], (fork) => {
            this.deps.logger.info("[napuketto] console 服务就绪，开始装配控制台登录面板");
            registerConsoleEntry(fork);
            const publish = this.bindProvider(fork, this.deps.selfId, {
                getPayload: () => toLoginPanelPayload(this.deps.getSnapshot(), this.deps.selfId),
                logger: this.deps.logger,
                onRelogin: () => this.requestRelogin(),
                onQrLogin: () => this.requestQrLogin(),
                onRefreshQr: () => void this.requestRefreshQr(),
            });
            this.publish = publish;
            fork.on("dispose", () => {
                if (this.publish === publish) {
                    this.publish = undefined;
                }
            });
            this.push();
        });
    }

    /** 通知 Provider 推送当前登录快照。 */
    push(): void {
        this.publish?.();
    }

    /** 重新登录（引导期原地重登，已登录时重启宿主）。 */
    requestRelogin(): void {
        this.relogin(false);
    }

    /** 强制扫码登录，必要时留下一次性扫码标记。 */
    requestQrLogin(): void {
        this.relogin(true);
    }

    private relogin(qrOnly: boolean): void {
        const plan = planRelogin({
            state: this.deps.getSnapshot().state,
            uin: this.deps.selfId,
            qrOnly,
        });
        executeRelogin(plan, this.deps);
    }

    /** 刷新二维码：IPC 直达子进程内 kernel 的 QrLoginSession.refresh()（不重启子进程）。 */
    async requestRefreshQr(): Promise<void> {
        try {
            const triggered = await this.deps.request("login.refreshQr");
            this.deps.logger.info(
                "[napuketto] 刷新二维码: %s",
                triggered === true ? "已触发新二维码" : "当前不在扫码态（忽略）",
            );
        } catch (error) {
            this.deps.logger.warn("[napuketto] 刷新二维码失败: %o", error);
        }
    }
}

/**
 * 重新登录/强制扫码的动作决策与执行。
 *
 * 两条可用通道：
 *  - control login（原地，不重启子进程）：
 *    · 登录期（idle/waiting_scan/scanned）——loader 端成功结果抢占初始登录
 *      竞速（bootstrap-core LoginControl），装配链用新结果继续；
 *  - 重启宿主：logged_in / failed 态结束旧宿主，再启动新一轮登录。强制扫码时
 *    置一次性标记，无连接时也会保留标记，供下次 launch 消费。
 */

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

/** 计划执行器（面板传入 IPC 能力）。 */
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
