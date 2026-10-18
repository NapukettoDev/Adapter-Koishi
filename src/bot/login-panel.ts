/**
 * login-panel.ts：控制台登录面板装配（design.md §5.12，自 bot.ts 拆出）。
 *
 * NapukettoLoginPanel 封装「console 服务就绪后装配 provider」的完整逻辑：
 *  - reload 去重：root store 不随插件 dispose 自动清理，同 selfId 已注册则复用
 *  - 服务值注册到 root store（Client.refresh() 的 PULL 读 root store）+ dispose 清理
 *  - 客户端连接回放：登录自动启动，二维码/状态在客户端连接前就推完，被
 *    DataService.refresh() → broadcast 的 `if (!handles.length) return` 丢弃；
 *    console/connection 事件在 console 服务自身 ctx 上发出（inject fork 作用域
 *    是兄弟分支收不到），需在该 ctx 上监听，连接瞬间再推一次
 *  - 指令上行：relogin / refresh-qr → deps 回调（bot 层执行 IPC）
 *
 * 运行时 import koishi / @koishijs/plugin-console——本文件不进单测。
 */

import type { IpcControlPayload } from "@napuketto/loader";
import type { Context, Logger } from "koishi";
import { loginServiceId, NapukettoLoginProvider, toLoginPanelPayload } from "../console/index.js";
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
    /**
     * 强制扫码重启（2026-09-08）：置一次性 qrOnly 标记 + control restart——
     * 子进程重启后跳过快速登录直接出码（登录期外的「扫码登录」走这条；
     * 登录期内走 control login qr=true 原地出码，不经本回调）。
     * client 未就绪返回 false（driver 崩溃退避重启会消费标记）。
     */
    forceQrRestart: () => boolean;
    /** 日志对象（bot 的 logger，namespace 已含 napuketto）。 */
    logger: Logger;
}

/** 控制台登录面板装配（每 bot 实例一份）。 */
export class NapukettoLoginPanel {
    /** 当前 provider 引用（console 服务就绪后装配；重启/重载前 null）。 */
    private readonly providerRef: { current: NapukettoLoginProvider | null } = { current: null };

    constructor(private readonly deps: LoginPanelDeps) {}

    /**
     * console 服务就绪后装配（bot 构造时调用）。
     *
     * ⚠️ satorijs Context → koishi Context cast——运行时同一实例，仅类型收窄。
     * inject 回调 fork 出一个插件作用域 ctx，与调用方 ctx 不同——回调内部
     * 的 dispose 监听挂在 fork ctx 上（正确：随本 bot 实例清理）。
     */
    setup(ctx: Context): void {
        const koishiCtx = ctx as unknown as Context;
        koishiCtx.inject(["console"], (fork) => {
            this.deps.logger.info("[napuketto] console 服务就绪，开始装配控制台登录面板");
            registerConsoleEntry(fork);
            const serviceName = `console.services.${loginServiceId(this.deps.selfId)}`;
            // reload 去重：root store 不随插件 dispose 自动清理，若同 selfId
            // 服务已注册（上一次 apply 未清理干净），直接复用旧 provider。
            const existing = fork.root.get(serviceName) as NapukettoLoginProvider | undefined;
            if (existing !== undefined) {
                this.providerRef.current = existing;
                this.push();
                return;
            }
            const provider = new NapukettoLoginProvider(fork, {
                selfId: this.deps.selfId,
                // 日志走 bot logger（等级随 logLevel；DataService 的 ctx logger
                // 名字是 console.services.*，不受插件日志等级控制）
                logger: this.deps.logger,
                onRelogin: () => this.requestRelogin(),
                onQrLogin: () => this.requestQrLogin(),
                onRefreshQr: () => void this.requestRefreshQr(),
            });
            this.providerRef.current = provider;
            // 注册服务值到 root store（Client.refresh() 的 PULL 读 root store）；
            // 拿 set 返回的 dispose 函数，在 bot dispose 时调用——既清理 store
            // 又从 root scope.disposables 移除自身（reload 不报错、不泄漏）。
            const disposeService = fork.root.set(serviceName, provider);
            // 兜底：客户端连接瞬间再推一次（连接事件在 console 自身 ctx 上发出）
            const offConnection = fork.console.ctx.on("console/connection", () => {
                this.push();
            });
            fork.on("dispose", () => {
                disposeService();
                offConnection();
            });
            // 装配完成立即推送当前快照（面板打开即有状态，不必等下次变化）
            this.push();
        });
    }

    /** 登录快照 → 面板推送（provider 未装配时静默跳过）。 */
    push(): void {
        const provider = this.providerRef.current;
        if (provider === null) {
            // 诊断：provider 未装配 = console inject 回调尚未触发
            this.deps.logger.debug(
                "[napuketto] pushLoginPanel: provider 未装配（console 未就绪），跳过推送",
            );
            return;
        }
        const payload = toLoginPanelPayload(this.deps.getSnapshot(), this.deps.selfId);
        this.deps.logger.debug("[napuketto] pushLoginPanel: 推送登录面板 state=%s", payload.state);
        provider.update(payload);
    }

    /**
     * 重新登录（2026-09-08 接 control login，login-actions.ts 决策+执行）：
     *  - 登录期（idle/waiting_scan/scanned）→ control login 原地重登（不重启
     *    子进程；loader 端成功结果抢占初始登录竞速，装配链用新结果继续）
     *  - ready/failed/client 不可用 → control restart 整进程重启（可靠路径：
     *    ready 态软重登需装配链重跑，见 design.md 遗留）
     */
    requestRelogin(): void {
        const plan = planRelogin({
            state: this.deps.getSnapshot().state,
            uin: this.deps.selfId,
            clientReady: true, // sendControl 内部判 client 可用性，失败回落 restart
            qrOnly: false,
        });
        executeRelogin(plan, {
            sendControl: (payload) => this.deps.sendControl(payload as IpcControlPayload),
            forceQrRestart: () => this.deps.forceQrRestart(),
            logger: {
                info: (message) => this.deps.logger.info(message),
                warn: (message) => this.deps.logger.warn(message),
            },
        });
    }

    /**
     * 强制扫码登录（2026-09-08）：登录期 control login qr=true 原地出码；
     * 其余状态置一次性 qrOnly 标记 + control restart（重启后直接扫码）。
     */
    requestQrLogin(): void {
        const plan = planRelogin({
            state: this.deps.getSnapshot().state,
            uin: this.deps.selfId,
            clientReady: true,
            qrOnly: true,
        });
        executeRelogin(plan, {
            sendControl: (payload) => this.deps.sendControl(payload as IpcControlPayload),
            forceQrRestart: () => this.deps.forceQrRestart(),
            logger: {
                info: (message) => this.deps.logger.info(message),
                warn: (message) => this.deps.logger.warn(message),
            },
        });
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
