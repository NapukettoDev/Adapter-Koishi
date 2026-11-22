import type { SelfInfo } from "@napuketto/kernel";
import type { Bot, Logger } from "koishi";
import type { NapukettoEventBridge } from "../bridge/events/bridge.js";
import type { NapukettoLoginState } from "../console/login-state.js";
import type { NapukettoDriver } from "../runtime/driver/driver.js";
import type { DriverEvents } from "../runtime/driver/types.js";
import type { IpcLoginPayload, NapukettoIpcClient } from "../runtime/ipc/index.js";
import { BOT_STATUS } from "../shared.js";
import { buildDriverEvents } from "./driver-events.js";

type LifecycleDriver = Pick<
    NapukettoDriver,
    "start" | "stop" | "restartLogin" | "currentState" | "currentClient"
>;

interface LifecycleHost {
    bot: Pick<Bot, "status" | "isActive" | "online" | "offline" | "getLogin">;
    logger: Pick<Logger, "debug" | "info" | "warn" | "error">;
    login: Pick<
        NapukettoLoginState,
        | "snapshot"
        | "reset"
        | "onReady"
        | "onLogin"
        | "onQr"
        | "onExit"
        | "beginLoginRound"
        | "rejectIdentity"
        | "currentGeneration"
    >;
    getBridge(): Pick<NapukettoEventBridge, "handle" | "resetMessageBaseline">;
    getSelfId(): string;
    stopBot(): Promise<void>;
    syncUser(user: { uin: string; nick: string }): void;
    createDriver(events: DriverEvents, forceQr: { current: boolean }): LifecycleDriver;
}

export class BotLifecycleController {
    private clientRef: NapukettoIpcClient | null = null;
    private announcedClient: NapukettoIpcClient | null = null;
    private readonly qrOnlyRef = { current: false };
    private driver: LifecycleDriver | null = null;
    private stopTask: Promise<void> | null = null;
    private round = 0;
    private stopEpoch = 0;
    private identityMismatch = false;
    /** 当前会话已完成装配（首启 ready 或软重登后的 ready）。 */
    private sessionReady = false;
    /** 身份查询代次：软重登/退出/新一轮使在途查询作废。 */
    private verifySerial = 0;

    constructor(private readonly host: LifecycleHost) {}

    /** 动作桥在会话完成装配且账号校验通过后才可用。 */
    get client(): NapukettoIpcClient | null {
        return this.sessionReady ? this.clientRef : null;
    }

    get dispatchClient(): NapukettoIpcClient | null {
        return this.identityMismatch ? null : this.client;
    }

    /** 控制台登录指令在引导期就可发送。 */
    get loginClient(): NapukettoIpcClient | null {
        return this.driver?.currentClient ?? null;
    }

    /** 当前登录轮次（异步 getLogin 结果据此判定是否仍有效）。 */
    get loginGeneration(): number {
        return this.host.login.currentGeneration;
    }

    isLoginGeneration(generation: number): boolean {
        return generation === this.host.login.currentGeneration;
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
        this.clearSessionClient();
        this.host.login.reset();
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
        this.clearSessionClient();
        this.identityMismatch = false;
        this.host.login.reset();
    }

    /** 关闭动作/派发闸门并作废在途身份查询（不改变登录状态机）。 */
    private clearSessionClient(): void {
        this.clientRef = null;
        this.announcedClient = null;
        this.sessionReady = false;
        this.verifySerial++;
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
                // 宿主重启与软重登共用：进入连接中，旧身份/动作/事件立即作废。
                handleLoginRestart: () => this.beginLoginRound(),
                clearClient: () => this.clearSessionClient(),
                onLoggedIn: (self) => this.handleLoggedIn(self),
                offline: (error) => this.host.bot.offline(error),
                // 停止过程中仍接收当前轮次的退出和超时；新驱动创建后才丢弃旧回调。
                isCurrent: () => round === this.round,
            }),
            this.qrOnlyRef,
        );
    }

    /**
     * driver ready（首启或软重登装配完成）：只有已验证身份才打开动作/派发闸门。
     *
     * ready 可能先于 logged_in 到达。此时先用登录快照；快照没有身份时通过
     * 当前锁定版本公开的 `login.getSelf` 补拉，查询失败/空值保持连接中并进入
     * 可重新登录的 failed 快照，不把缺失身份当成放行。
     */
    private handleReady(): void {
        const driver = this.driver;
        if (driver === null || driver.currentState !== "ready") {
            return;
        }
        const client = driver.currentClient;
        if (client === null) {
            return;
        }
        this.sessionReady = true;
        const round = this.round;
        const generation = this.host.login.currentGeneration;
        const decision = evaluateIdentity(
            this.host.getSelfId(),
            this.host.login.snapshot.self?.uin,
        );
        if (decision.kind === "verified") {
            this.activate(round, driver, client);
            return;
        }
        if (decision.kind === "mismatch") {
            this.rejectMismatch(decision);
            return;
        }
        void this.queryIdentity(round, driver, client, generation);
    }

    /** 软重登开始：旧客户端的动作与事件立即失效，等待新会话 ready。 */
    private beginLoginRound(): void {
        this.clearSessionClient();
        this.identityMismatch = false;
        this.host.login.beginLoginRound();
        this.host.bot.status = BOT_STATUS.CONNECT;
    }

    /** 账号信息和 ready 可能以不同顺序到达，收到账号信息时立即校验。 */
    private handleLoggedIn(self: NonNullable<IpcLoginPayload["selfInfo"]>): void {
        const decision = evaluateIdentity(this.host.getSelfId(), self.uin);
        if (decision.kind === "verified") {
            // 登录事件已给出可信身份，进行中的 getSelf 补拉结果不再需要。
            this.verifySerial++;
            this.host.syncUser({ uin: self.uin, nick: self.nick });
            this.activateCurrent();
            return;
        }
        if (decision.kind === "mismatch") {
            this.rejectMismatch(decision);
            return;
        }
        this.rejectUnavailable("登录信息缺少账号（selfInfo.uin 为空）");
    }

    /** 用当前轮次/客户端补拉登录身份；只在同一 generation 内生效。 */
    private async queryIdentity(
        round: number,
        driver: LifecycleDriver,
        client: NapukettoIpcClient,
        generation: number,
    ): Promise<void> {
        const serial = ++this.verifySerial;
        try {
            const raw = await client.request("login.getSelf");
            if (!this.isAttemptCurrent(serial, round, driver, client, generation)) {
                return;
            }
            const self = parseSelfIdentity(raw);
            if (self === null) {
                this.rejectUnavailable("宿主未返回可用的登录身份");
                return;
            }
            const decision = evaluateIdentity(this.host.getSelfId(), self.uin);
            if (decision.kind === "mismatch") {
                // 不把查询到的错账号写入登录快照。
                this.rejectMismatch(decision);
                return;
            }
            if (decision.kind === "missing") {
                this.rejectUnavailable("宿主返回的登录身份为空");
                return;
            }
            this.host.login.onLogin("logged_in", self);
            this.host.syncUser({ uin: self.uin, nick: self.nick });
            this.activate(round, driver, client);
        } catch (error) {
            if (!this.isAttemptCurrent(serial, round, driver, client, generation)) {
                return;
            }
            const reason = error instanceof Error ? error.message : String(error);
            this.rejectUnavailable(`获取登录身份失败: ${reason}`);
        }
    }

    private isAttemptCurrent(
        serial: number,
        round: number,
        driver: LifecycleDriver,
        client: NapukettoIpcClient,
        generation: number,
    ): boolean {
        return (
            serial === this.verifySerial &&
            round === this.round &&
            this.driver === driver &&
            this.sessionReady &&
            driver.currentState === "ready" &&
            driver.currentClient === client &&
            this.host.login.currentGeneration === generation
        );
    }

    /** 登录事件到达且会话已 ready 时，用当前驱动/客户端恢复上线。 */
    private activateCurrent(): void {
        const driver = this.driver;
        if (driver === null || !this.sessionReady || driver.currentState !== "ready") {
            return;
        }
        const client = driver.currentClient;
        if (client === null) {
            return;
        }
        this.activate(this.round, driver, client);
    }

    private activate(round: number, driver: LifecycleDriver, client: NapukettoIpcClient): void {
        if (
            round !== this.round ||
            this.driver !== driver ||
            !this.sessionReady ||
            driver.currentState !== "ready" ||
            driver.currentClient !== client
        ) {
            return;
        }
        this.clientRef = client;
        this.host.login.onReady();
        if (this.announcedClient === client) {
            return;
        }
        this.announcedClient = client;
        this.host.bot.online();
        void this.host.bot.getLogin().catch((error) => {
            this.host.logger.warn("[napuketto] 拉取登录信息失败: %o", error);
        });
    }

    /** 查询失败/空身份：关闭闸门但保留宿主，后续登录或重新登录可恢复。 */
    private rejectUnavailable(message: string): void {
        // 会话装配本身已完成（ready），只是身份不可用；保留 sessionReady，
        // 让随后到达的 logged_in 仍能重新校验并上线。
        this.clientRef = null;
        this.announcedClient = null;
        this.verifySerial++;
        this.host.login.rejectIdentity(message);
        this.host.logger.error(
            "[napuketto] 账号身份未确认：%s —— 已暂停上线与派发，请重新登录或检查插件配置的 selfId",
            message,
        );
        if (this.host.bot.status === BOT_STATUS.ONLINE) {
            this.host.bot.offline(new Error(message));
        }
    }

    /** 扫码账号可能与配置不同。拒绝错账号，避免写入错误的数据库指派和绑定。 */
    private rejectMismatch(decision: Extract<IdentityDecision, { kind: "mismatch" }>): void {
        this.clearSessionClient();
        this.host.login.rejectIdentity(identityMismatchMessage(decision));
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
    }
}

/** 登录身份查询响应（loader `login.getSelf` 当前返回 `{ uin, nickname, uid }`）。 */
function parseSelfIdentity(raw: unknown): SelfInfo | null {
    if (typeof raw !== "object" || raw === null) {
        return null;
    }
    const record = raw as Record<string, unknown>;
    const uin = record["uin"];
    if (typeof uin !== "string" || uin.trim() === "") {
        return null;
    }
    const uid = typeof record["uid"] === "string" ? record["uid"] : "";
    const nick =
        typeof record["nickname"] === "string"
            ? record["nickname"]
            : typeof record["nick"] === "string"
              ? record["nick"]
              : "";
    return { uin, uid, nick };
}
/** 扫码账号与配置不一致时，停止宿主并拒绝上线。 */

/** 账号一致性判定结果（verified：放行上线；missing：身份不可用；mismatch：拒绝）。 */
export type IdentityDecision =
    | {
          readonly kind: "verified";
          /** 已验证的实际登录 uin（等于配置 selfId）。 */
          readonly uin: string;
      }
    | { readonly kind: "missing" }
    | {
          readonly kind: "mismatch";
          /** 配置 selfId（提示文案/Error 插值用）。 */
          readonly configSelfId: string;
          /** 实际登录 uin。 */
          readonly actualUin: string;
      };

/**
 * 账号一致性判定：只有实际 uin 非空且等于配置 selfId 才放行。
 *
 * ready 缺少 selfInfo 时缺失身份不是放行理由；调用方应先补拉身份，
 * 补拉失败/为空按 missing 进入可恢复的失败态。
 */
export function evaluateIdentity(
    configSelfId: string,
    actualUin: string | undefined,
): IdentityDecision {
    if (actualUin === undefined || actualUin.trim() === "") {
        return { kind: "missing" };
    }
    if (actualUin === configSelfId) {
        return { kind: "verified", uin: actualUin };
    }
    return { kind: "mismatch", configSelfId, actualUin };
}

/** 账号不一致的稳定错误文案（登录快照 lastError 与拒绝原因共用）。 */
export function identityMismatchMessage(
    decision: Extract<IdentityDecision, { kind: "mismatch" }>,
): string {
    return `账号不一致：配置 selfId=${decision.configSelfId}，实际登录 uin=${decision.actualUin}`;
}

/** 拒绝上线动作宿主（生命周期控制器注入 logger/identityMismatch/driver/offline 真实接线）。 */
export interface IdentityMismatchSink {
    /** logger.error：可操作提示（改 selfId 或换账号重扫）。 */
    onError: (message: string, ...args: unknown[]) => void;
    /** 置 identityMismatch 闸门（dispatch 拒派发 + onExit 判主动断开）。 */
    setMismatch: () => void;
    /** 停 driver 子进程。 */
    stopDriver: () => void;
    /** 拒绝上线（koishi Bot offline）。 */
    offline: (error: Error) => void;
}

/** 不一致处置：置闸门 → error 提示 → 停 driver → 拒绝上线（原 checkIdentity 顺序）。 */
export function rejectIdentityMismatch(
    decision: Extract<IdentityDecision, { kind: "mismatch" }>,
    sink: IdentityMismatchSink,
): void {
    sink.setMismatch();
    sink.onError(
        "[napuketto] 账号不一致：配置 selfId=%s，实际登录 uin=%s —— 已拒绝上线，" +
            "以免污染数据目录与 koishi 的 channel.assignee/binding（会导致群消息被" +
            "静默丢弃）。请把插件配置 selfId 改成 %s，或改用 %s 重新扫码登录。",
        decision.configSelfId,
        decision.actualUin,
        decision.actualUin,
        decision.configSelfId,
    );
    sink.stopDriver();
    sink.offline(
        new Error(
            `账号不一致：配置 selfId=${decision.configSelfId}，实际登录 uin=${decision.actualUin}`,
        ),
    );
}
