import type { IpcControlPayload } from "@napuketto/loader";
import type { Context, Logger } from "koishi";
import { bindLoginProvider, toLoginPanelPayload } from "../console/index.js";
import type { LoginSnapshot } from "../login/types.js";
import { executeRelogin, planRelogin } from "./login-actions.js";
import { registerConsoleEntry } from "./utils/console-entry.js";

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
    /** 置一次性扫码标记，有连接时发 control restart；无连接时返回 false。 */
    forceQrRestart: () => boolean;
    /** 日志对象（bot 的 logger，namespace 已含 napuketto）。 */
    logger: Logger;
}

/** 控制台登录面板装配（每 bot 实例一份）。 */
export class NapukettoLoginPanel {
    private publish: (() => void) | undefined;

    constructor(private readonly deps: LoginPanelDeps) {}

    /** console 服务就绪后装配（bot 构造时调用）。 */
    setup(ctx: Context): void {
        ctx.inject(["console"], (fork) => {
            this.deps.logger.info("[napuketto] console 服务就绪，开始装配控制台登录面板");
            registerConsoleEntry(fork);
            const publish = bindLoginProvider(fork, this.deps.selfId, {
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

    /** 重新登录（引导期原地重登，已登录时软重登）。 */
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
