import type { Bot, Logger } from "koishi";
import type { NapukettoDriver } from "../driver/index.js";
import type { DriverEvents } from "../driver/types.js";
import type { NapukettoEventBridge } from "../events/index.js";
import type { IpcLoginPayload, NapukettoIpcClient } from "../ipc/index.js";
import type { NapukettoLoginState } from "../login/index.js";
import { BOT_STATUS } from "../shared/protocol.js";
import { buildDriverEvents } from "./driver-events.js";
import { evaluateIdentity, rejectIdentityMismatch } from "./identity.js";

type LifecycleDriver = Pick<
    NapukettoDriver,
    "start" | "stop" | "restartLogin" | "currentState" | "currentClient"
>;

interface LifecycleHost {
    bot: Pick<Bot, "status" | "isActive" | "online" | "offline" | "getLogin">;
    logger: Pick<Logger, "debug" | "warn" | "error">;
    login: Pick<
        NapukettoLoginState,
        "snapshot" | "reset" | "onReady" | "onLogin" | "onQr" | "onExit"
    >;
    getBridge(): Pick<NapukettoEventBridge, "handle" | "resetMessageBaseline">;
    getSelfId(): string;
    stopBot(): Promise<void>;
    syncUser(user: { uin: string; nick: string }): void;
    createDriver(events: DriverEvents, forceQr: { current: boolean }): LifecycleDriver;
}

export class BotLifecycleController {
    private clientRef: NapukettoIpcClient | null = null;
    private readonly qrOnlyRef = { current: false };
    private driver: LifecycleDriver | null = null;
    private stopTask: Promise<void> | null = null;
    private round = 0;
    private stopEpoch = 0;
    private identityMismatch = false;

    constructor(private readonly host: LifecycleHost) {}

    /** 动作桥在 ready 并通过账号校验后才可用。 */
    get client(): NapukettoIpcClient | null {
        return this.clientRef;
    }

    get dispatchClient(): NapukettoIpcClient | null {
        return this.identityMismatch ? null : this.clientRef;
    }

    /** 控制台登录指令在引导期就可发送。 */
    get loginClient(): NapukettoIpcClient | null {
        return this.driver?.currentClient ?? null;
    }

    restartLogin(forceQr: boolean): boolean {
        if (forceQr) {
            this.qrOnlyRef.current = true;
        }
        return this.driver?.restartLogin() ?? false;
    }

    /** 等待上一轮结束，再用独立的驱动和回调开启新一轮。 */
    async start(): Promise<void> {
        if (this.host.bot.isActive) {
            return;
        }
        const startRound = this.round;
        const startEpoch = this.stopEpoch;
        const superseded = () => startRound !== this.round || startEpoch !== this.stopEpoch;
        this.host.bot.status = BOT_STATUS.CONNECT;
        // 上一轮的登录、账号闸门与动作客户端都要在 spawn 前复位；否则错账号
        // 留下的 identityMismatch 会让新一轮即使登录正确也永远拒绝上线。
        this.resetSessionState();

        const stopping = this.stopTask;
        if (stopping !== null) {
            await stopping;
            if (superseded()) {
                return; // 等待期间被新的 stop/start 取代
            }
        }
        const previous = this.driver;
        this.driver = null;
        if (previous !== null) {
            // 防御：driver 可能在离线状态下仍在退避重试（Bot.status 已 OFFLINE）。
            // 先停止并确认退出，避免同一账号数据目录被两个宿主同时占用。
            await previous.stop();
            if (superseded()) {
                return;
            }
        }
        // 等待旧宿主期间可能已经被基类 stop() 置为 OFFLINE，这里重新进入 CONNECT。
        this.host.bot.status = BOT_STATUS.CONNECT;
        try {
            // 真正创建 driver 时才递增轮次：等待期间的 stop 不会让本轮旧 driver
            // 的 onExit/onError 被误判为过期。
            const round = ++this.round;
            const driver = this.createDriver(round);
            this.driver = driver;
            driver.start();
        } catch (error) {
            this.host.bot.offline(error instanceof Error ? error : new Error(String(error)));
        }
    }

    /** 解除当前驱动引用并使尚在等待的 start 失效。 */
    async stop(): Promise<void> {
        this.stopEpoch++;
        this.clientRef = null;
        const driver = this.driver;
        this.driver = null;
        const previous = this.stopTask;
        const task = (async () => {
            await Promise.all([previous ?? Promise.resolve(), driver?.stop(), this.host.stopBot()]);
        })();
        this.stopTask = task;
        try {
            await task;
        } finally {
            if (this.stopTask === task) {
                this.stopTask = null;
            }
        }
    }

    private resetSessionState(): void {
        this.clientRef = null;
        this.identityMismatch = false;
        this.host.login.reset();
    }

    private createDriver(round: number): LifecycleDriver {
        return this.host.createDriver(
            buildDriverEvents({
                logger: this.host.logger,
                login: this.host.login,
                bridge: this.host.getBridge(),
                isDisconnected: () =>
                    this.host.bot.status === BOT_STATUS.DISCONNECT || this.identityMismatch,
                handleReady: () => this.handleReady(),
                handleLoginRestart: () => {
                    this.host.bot.status = BOT_STATUS.CONNECT;
                    this.host.login.reset();
                },
                clearClient: () => {
                    this.clientRef = null;
                },
                onLoggedIn: (self) => this.handleLoggedIn(self),
                offline: (error) => this.host.bot.offline(error),
                // 停止过程中仍接收当前轮次的退出和超时；新驱动创建后才丢弃旧回调。
                isCurrent: () => round === this.round,
            }),
            this.qrOnlyRef,
        );
    }

    /** driver ready：登录状态就绪 + 校验账号 + 绑定客户端 + online。 */
    private handleReady(): void {
        this.host.login.onReady();
        // ⚠️ 账号一致性校验必须在 online 之前（见 checkIdentity）：不一致时
        // 一条消息都不能派发，否则 koishi 会按错账号落库 assignee/binding。
        if (!this.checkIdentity()) {
            return;
        }
        const driver = this.driver;
        const client = driver?.currentState === "ready" ? driver.currentClient : null;
        if (client === null) {
            return;
        }
        this.clientRef = client;
        this.host.bot.online();
        void this.host.bot.getLogin().catch((error) => {
            this.host.logger.warn("[napuketto] 拉取登录信息失败: %o", error);
        });
    }

    /** 扫码账号可能与配置不同。拒绝错账号，避免写入错误的数据库指派和绑定。 */
    private checkIdentity(): boolean {
        const decision = evaluateIdentity(
            this.host.getSelfId(),
            this.host.login.snapshot.self?.uin,
        );
        if (decision.kind === "allow") {
            return true;
        }
        rejectIdentityMismatch(decision, {
            onError: (message, ...args) => {
                this.host.logger.error(message, ...args);
            },
            setMismatch: () => {
                this.identityMismatch = true;
                this.clientRef = null;
            },
            stopDriver: () => {
                void this.driver?.stop();
            },
            offline: (error) => {
                this.host.bot.offline(error);
            },
        });
        return false;
    }

    /** 账号信息和 ready 可能以不同顺序到达，收到账号信息时立即校验。 */
    private handleLoggedIn(self: NonNullable<IpcLoginPayload["selfInfo"]>): void {
        if (!this.checkIdentity()) {
            return;
        }
        this.host.syncUser({ uin: self.uin, nick: self.nick });
    }
}
