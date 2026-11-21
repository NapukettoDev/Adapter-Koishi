/**
 * driver.ts：NapukettoDriver——自建宿主子进程生命周期驱动（docs/internals/runtime.md）。
 *
 * 职责：spawn（launch 工厂注入）→ IPC client → 状态机 → 崩溃/失联重启（退避）。
 * 不 import loader：launch 由 apply() 用 launchSelfHost 组装注入。
 *
 * 心跳监控：spawn 后立即开始（兜 dlopen/登录卡死挂起），client.seenAt 超过
 * heartbeatTimeoutMs 判定失联 → 有界终止 → 确认退出后退避重启。
 *
 * 状态重同步（2026-09-06「能收不能发」事故）：status 消息（尤其 ready）经子进程
 * stdout 传输，可能被并发输出撕裂丢失（原生 printf 直写 fd 等 JS 层拦不住的
 * 污染）。booting 期间暂存 event，收到 event 或定时（20s）发 control status 查询，
 * 子进程重播最近一条 status。收到 ready 并完成 onReady 后按序回放事件。
 */
import type { ChildProcess } from "node:child_process";
import { EXIT_CONFIG_INVALID } from "@napuketto/kernel";
import { IpcError } from "../ipc/errors.js";
import {
    ChildProcessIpcTransport,
    type IpcEventPayload,
    type IpcLineTransport,
    type IpcStatusPayload,
    NapukettoIpcClient,
} from "../ipc/index.js";
import { backoffDelay } from "./backoff.js";
import { HeartbeatMonitor } from "./heartbeat.js";
import type {
    ChildProcessLike,
    DriverEvents,
    DriverLauncher,
    DriverLaunchResult,
    DriverOptions,
    DriverState,
    ExitReason,
    RestartPolicy,
    TransportFactory,
} from "./types.js";

/** 心跳检查间隔（毫秒）。 */
const HEALTH_CHECK_INTERVAL_MS = 1_000;

/** 每级终止操作后等待确认退出的时间。 */
const EXIT_TIMEOUT_MS = 5_000;

/** booting 阶段状态重查间隔（毫秒）：status 丢失后定期向子进程重同步。 */
const BOOT_STATUS_QUERY_INTERVAL_MS = 20_000;

/** 状态重查节流下限（毫秒）：事件风暴下避免 control status 刷屏。 */
const STATUS_QUERY_MIN_INTERVAL_MS = 5_000;

/** 单次引导暂存的事件数上限，超限丢弃最旧事件。 */
const MAX_STARTUP_EVENTS = 256;

/** 默认重启策略。 */
const DEFAULT_RESTART: Required<RestartPolicy> = {
    maxRetries: 3,
    backoffMs: 1_000,
    backoffFactor: 2,
};

/** 默认传输工厂（ChildProcessIpcTransport，断言收窄宽松 child 面）。 */
const defaultTransport: TransportFactory = (child) => {
    return new ChildProcessIpcTransport(child as ChildProcess);
};

interface HostProcess {
    child: ChildProcessLike;
    removeListeners(): void;
    cleanup?: () => void;
    reason: ExitReason;
    timer?: NodeJS.Timeout;
    configInvalid?: boolean;
}

/** 子进程生命周期驱动。 */
export class NapukettoDriver {
    private static readonly owners = new Map<string, NapukettoDriver>();
    private readonly events: DriverEvents;
    private readonly launch: DriverLauncher;
    private readonly accountDir: string | undefined;
    private readonly createTransport: TransportFactory;
    private readonly restart: Required<RestartPolicy>;
    private readonly heartbeatTimeoutMs: number;
    private readonly onJunkLine: ((line: string) => void) | undefined;

    private state: DriverState = "idle";
    private client: NapukettoIpcClient | null = null;
    private host: HostProcess | null = null;
    private launching = false;
    private restartCount = 0;
    private spawnAt = 0;
    /** 最近一次状态重查时间（节流用）。 */
    private lastStatusQueryAt: number | null = null;
    /** 当前子进程的待回放事件，完成回放或清理后为 null。 */
    private startupEvents: IpcEventPayload[] | null = null;
    private readonly heartbeat: HeartbeatMonitor;
    private restartTimer: NodeJS.Timeout | null = null;
    private stopCompletion: ReturnType<typeof Promise.withResolvers<void>> | null = null;
    /** booting 阶段状态重查定时器（离开 booting 即清）。 */
    private bootQueryTimer: NodeJS.Timeout | null = null;

    constructor(options: DriverOptions) {
        this.events = options.events;
        this.launch = options.launch;
        this.accountDir = options.accountDir;
        this.createTransport = options.createTransport ?? defaultTransport;
        this.onJunkLine = options.onJunkLine;
        this.restart = {
            maxRetries: options.restart?.maxRetries ?? DEFAULT_RESTART.maxRetries,
            backoffMs: options.restart?.backoffMs ?? DEFAULT_RESTART.backoffMs,
            backoffFactor: options.restart?.backoffFactor ?? DEFAULT_RESTART.backoffFactor,
        };
        this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 45_000;
        this.heartbeat = new HeartbeatMonitor(
            {
                seenAt: () => this.client?.seenAt ?? 0,
                spawnAt: () => this.spawnAt,
                state: () => this.state,
            },
            {
                intervalMs: HEALTH_CHECK_INTERVAL_MS,
                timeoutMs: this.heartbeatTimeoutMs,
                onStale: () => {
                    const host = this.host;
                    if (host !== null) {
                        this.beginTermination(host, "stale");
                    }
                },
            },
        );
    }

    /** 当前状态。 */
    get currentState(): DriverState {
        return this.state;
    }

    /** 引导期和就绪期均可取得当前打开的 IPC 连接。 */
    get currentClient(): NapukettoIpcClient | null {
        if (this.state !== "booting" && this.state !== "ready") {
            return null;
        }
        return this.client?.alive === true ? this.client : null;
    }

    /** 已重启次数（诊断用）。 */
    get restartAttempts(): number {
        return this.restartCount;
    }

    /** 启动子进程（幂等：非 idle 直接忽略；spawn 异步 fire-and-forget）。 */
    start(): void {
        if (this.state !== "idle") {
            return;
        }
        void this.spawnProcess("start");
    }

    /** 主动停止，等待确认退出或终止超时；期间取消重启。 */
    stop(): Promise<void> {
        if (this.stopCompletion !== null) {
            return this.stopCompletion.promise;
        }
        if (this.state === "idle" || this.state === "stopped") {
            return Promise.resolve();
        }
        const host = this.host;
        if (this.state === "failed" && host !== null) {
            host.reason = "stop";
            return Promise.resolve();
        }
        const completion = Promise.withResolvers<void>();
        this.stopCompletion = completion;
        this.setState("stopping");
        this.clearRestartTimer();
        if (host !== null) {
            this.beginTermination(host, "stop");
        } else if (!this.launching) {
            this.finishStop();
        }
        return completion.promise;
    }

    // ── 内部 ──

    private async spawnProcess(reason: "start" | "restart"): Promise<void> {
        this.setState(reason === "start" ? "spawning" : "restarting");
        this.launching = true;
        let result: DriverLaunchResult;
        try {
            const dir = this.accountDir;
            if (dir !== undefined) {
                const previous = NapukettoDriver.owners.get(dir);
                if (previous?.state === "stopping") {
                    await previous.stop();
                }
                if (this.state === "stopping") {
                    this.launching = false;
                    this.finishStop();
                    return;
                }
                if (NapukettoDriver.owners.has(dir)) {
                    throw new IpcError(
                        `账号数据目录仍由旧宿主使用（${dir}），请先停止旧宿主`,
                        "INVALID_STATE",
                    );
                }
                NapukettoDriver.owners.set(dir, this);
            }
            result = await this.launch();
        } catch (err) {
            this.launching = false;
            this.releaseAccount();
            this.handleSpawnError(err);
            return;
        }
        this.launching = false;
        const { child, cleanup } = result;
        const onExit = (code: number | null, signal: string | null) => {
            this.handleChildExit(host, code, signal);
        };
        const onError = (err: Error) => {
            this.handleChildError(host, err);
        };
        const host: HostProcess = {
            child,
            reason: this.state === "stopping" ? "stop" : "crash",
            removeListeners: () => {
                child.off("exit", onExit);
                child.off("error", onError);
            },
            ...(cleanup !== undefined ? { cleanup } : {}),
        };
        this.host = host;
        child.on("error", onError);
        child.once("exit", onExit);
        const exitCode = child.exitCode ?? null;
        const signalCode = child.signalCode ?? null;
        if (exitCode !== null || signalCode !== null) {
            onExit(exitCode, signalCode);
            return;
        }
        if (this.state === "stopping") {
            this.beginTermination(host, "stop");
            return;
        }

        // 每次 spawn 建新 transport + 新 client（旧 client 随旧子进程 closed）
        let transport: IpcLineTransport;
        try {
            transport = this.createTransport(child);
        } catch (err) {
            this.beginTermination(host, "spawn-error");
            this.events.onError?.(err);
            return;
        }
        const client = new NapukettoIpcClient(
            transport,
            // exactOptionalPropertyTypes：可选回调条件展开，不显式赋 undefined
            this.onJunkLine !== undefined ? { onJunkLine: this.onJunkLine } : {},
        );
        this.client = client;
        this.startupEvents = [];
        this.lastStatusQueryAt = null;
        this.spawnAt = Date.now();
        this.setState("booting");
        this.heartbeat.start();
        this.subscribeClient(host, client);
    }

    private subscribeClient(host: HostProcess, client: NapukettoIpcClient): void {
        const active = () => this.currentClient === client;
        let previousPhase: IpcStatusPayload["phase"] | undefined;
        client.on("status", (message) => {
            if (!active()) {
                return;
            }
            const status = message.payload;
            // Loader 在软重登时先报告 sessioning，再接入新一轮原始事件转发。
            const reassembling =
                this.state === "ready" &&
                status.phase === "sessioning" &&
                previousPhase !== "sessioning";
            previousPhase = status.phase;
            if (reassembling) {
                this.events.onEventSubscription?.();
            }
            this.events.onStatus?.(status);
            if (active()) {
                this.handleStatus(host, status);
            }
        });
        client.on("login", (message) => {
            if (active()) {
                this.events.onLogin?.(message.payload);
            }
        });
        client.on("qr", (message) => {
            if (active()) {
                this.events.onQr?.(message.payload);
            }
        });
        client.on("event", (message) => {
            if (!active()) {
                return;
            }
            const pending = this.startupEvents;
            if (pending === null) {
                if (this.state === "ready") {
                    this.events.onEvent?.(message.payload);
                }
                return;
            }
            if (pending.length === MAX_STARTUP_EVENTS) {
                pending.shift();
            }
            pending.push(message.payload);
            // 先入队，再查状态。传输层可以同步重播 ready。
            if (this.state === "booting") {
                this.resyncStatus();
            }
        });
        client.on("log", (message) => {
            if (active()) {
                this.events.onLog?.(message.payload);
            }
        });
        this.events.onEventSubscription?.();
    }

    private handleStatus(host: HostProcess, status: IpcStatusPayload): void {
        switch (status.phase) {
            case "ready":
                // 幂等守卫：control status 重播会重复送达 ready，已 ready 不再触发
                // onReady（防 online/getLogin 等重复副作用）
                if (this.state === "booting") {
                    this.restartCount = 0; // 就绪即健康，重置重启计数
                    this.setState("ready");
                    this.events.onReady?.();
                    this.flushStartupEvents();
                }
                break;
            case "failed":
                // loader 用 INVALID_PARAM 上报配置校验失败，其他类别可能恢复。
                if (status.error?.code === "INVALID_PARAM") {
                    host.configInvalid = true;
                } else {
                    this.events.onError?.(
                        new IpcError(
                            status.message ?? "子进程引导失败",
                            status.error?.code ?? "UNKNOWN",
                        ),
                    );
                }
                break;
            default:
                // booting/dlopening/logging/sessioning：状态机保持 booting
                break;
        }
    }

    private flushStartupEvents(): void {
        const pending = this.startupEvents;
        if (pending === null) {
            return; // onReady 可能因账号不一致而停止驱动
        }
        while (this.startupEvents === pending) {
            const payload = pending.shift();
            if (payload === undefined) {
                this.startupEvents = null;
                return;
            }
            this.events.onEvent?.(payload);
        }
    }

    private beginTermination(host: HostProcess, reason: "stop" | "stale" | "spawn-error"): void {
        host.reason = reason;
        if (host.timer !== undefined) {
            return; // 主动停止可以接管当前终止流程，沿用已安排的升级期限。
        }
        if (reason !== "stop") {
            this.setState("terminating");
        }
        this.heartbeat.stop();
        const client = this.client;
        if (reason === "stop" && client?.alive === true) {
            // 先设期限，发送 stop 时子进程可能已经退出。
            host.timer = setTimeout(() => this.signalHost(host, "SIGTERM"), EXIT_TIMEOUT_MS);
            try {
                client.sendControl({ command: "stop" });
            } catch (err) {
                this.events.onError?.(err);
            } finally {
                if (this.host === host) {
                    this.closeClient();
                }
            }
        } else {
            this.closeClient();
            this.signalHost(host, "SIGTERM");
        }
    }

    private signalHost(host: HostProcess, signal: "SIGTERM" | "SIGKILL"): void {
        if (this.host !== host) {
            return;
        }
        host.timer = setTimeout(() => {
            if (signal === "SIGTERM") {
                this.signalHost(host, "SIGKILL");
            } else {
                this.failTermination(host);
            }
        }, EXIT_TIMEOUT_MS);
        const pid = host.child.pid ?? "?";
        try {
            if (host.child.kill(signal)) {
                return;
            }
        } catch (err) {
            if (this.host === host) {
                this.events.onError?.(err);
            }
            return;
        }
        if (this.host === host) {
            this.events.onError?.(
                new IpcError(
                    `向子进程（PID ${pid}）发送 ${signal} 失败，仍在等待退出`,
                    "SIGNAL_FAILED",
                ),
            );
        }
    }

    private failTermination(host: HostProcess): void {
        if (this.host !== host) {
            return;
        }
        this.setState("failed");
        this.resolveStop();
        this.events.onError?.(
            new IpcError(
                `无法确认子进程（PID ${host.child.pid ?? "?"}）已退出，已停止重启。请在系统中确认或停止该进程后重新启用插件。`,
                "EXIT_TIMEOUT",
            ),
        );
    }

    private handleChildError(host: HostProcess, error: Error): void {
        if (this.host !== host) {
            return;
        }
        if (host.child.pid === undefined) {
            // Node 启动失败时只有 error/close，没有待退出的进程。
            if (host.reason !== "stop") {
                host.reason = "spawn-error";
            }
            this.handleChildExit(host, null, null);
        } else if (host.reason === "crash") {
            this.beginTermination(host, "spawn-error");
        }
        this.events.onError?.(error);
    }

    private handleChildExit(host: HostProcess, code: number | null, signal: string | null): void {
        if (this.host !== host) {
            return;
        }
        this.host = null;
        clearTimeout(host.timer);
        host.removeListeners();
        this.heartbeat.stop();
        this.closeClient();
        this.releaseAccount();
        if (host.reason === "spawn-error" || host.reason === "stop") {
            host.cleanup?.();
        }

        if (this.state === "failed") {
            if (host.reason === "stop") {
                this.finishStop();
            }
            return;
        }
        const failure = this.getExitError(host, code);
        if (host.reason === "stop") {
            this.finishStop();
        } else if (host.reason === "spawn-error" || failure !== null) {
            this.setState("failed");
        } else {
            this.scheduleRestart();
        }
        this.events.onExit?.({ code, signal, reason: host.reason });
        if (failure !== null && this.currentState === "failed") {
            this.events.onError?.(failure);
        }
    }

    private getExitError(host: HostProcess, code: number | null): IpcError | null {
        if (host.reason === "stop" || host.reason === "spawn-error") {
            return null;
        }
        if (code === EXIT_CONFIG_INVALID || host.configInvalid === true) {
            return new IpcError(
                "子进程配置校验失败，已停止重试。请检查该账号的 Napuketto 配置和 napuketto-boot.log，修正后重新启用插件。",
                "INVALID_PARAM",
            );
        }
        if (this.restartCount >= this.restart.maxRetries) {
            return new IpcError(`子进程退出（code=${code ?? "?"}），重启次数达上限`, "RETRY_LIMIT");
        }
        return null;
    }

    private handleSpawnError(err: unknown): void {
        if (this.state === "stopping") {
            this.finishStop();
            return;
        }
        this.setState("failed");
        this.events.onExit?.({ code: null, signal: null, reason: "spawn-error" });
        this.events.onError?.(err);
    }

    private scheduleRestart(): void {
        const attempt = this.restartCount + 1;
        const delay = backoffDelay(attempt, this.restart.backoffMs, this.restart.backoffFactor);
        this.setState("restarting");
        this.restartTimer = setTimeout(() => {
            this.restartTimer = null;
            this.restartCount = attempt;
            void this.spawnProcess("restart");
        }, delay);
    }

    private clearRestartTimer(): void {
        if (this.restartTimer !== null) {
            clearTimeout(this.restartTimer);
            this.restartTimer = null;
        }
    }

    private finishStop(): void {
        this.setState("stopped");
        this.resolveStop();
    }

    private resolveStop(): void {
        this.stopCompletion?.resolve();
        this.stopCompletion = null;
    }

    private releaseAccount(): void {
        const dir = this.accountDir;
        if (dir !== undefined && NapukettoDriver.owners.get(dir) === this) {
            NapukettoDriver.owners.delete(dir);
        }
    }

    private closeClient(): void {
        this.startupEvents = null;
        const client = this.client;
        this.client = null;
        client?.close();
    }

    private setState(next: DriverState): void {
        this.state = next;
        this.updateBootQueryTimer();
    }

    /**
     * 状态重查（节流）：向子进程发 control status，子进程重播最近一条 status。
     * 与心跳监控互补——心跳兜「全静默」（终止后重启），重查兜「活着但关键
     * status 丢失」（协议行被撕裂丢弃，事件/心跳照常）。
     */
    private resyncStatus(): void {
        const now = Date.now();
        if (
            this.lastStatusQueryAt !== null &&
            now - this.lastStatusQueryAt < STATUS_QUERY_MIN_INTERVAL_MS
        ) {
            return;
        }
        this.lastStatusQueryAt = now;
        this.client?.sendControl({ command: "status" });
    }

    /** booting 阶段定期状态重查（status 丢失自愈）；离开 booting 停表。 */
    private updateBootQueryTimer(): void {
        if (this.state === "booting") {
            if (this.bootQueryTimer === null) {
                this.bootQueryTimer = setInterval(() => {
                    if (this.state === "booting") {
                        this.resyncStatus();
                    }
                }, BOOT_STATUS_QUERY_INTERVAL_MS);
            }
            return;
        }
        if (this.bootQueryTimer !== null) {
            clearInterval(this.bootQueryTimer);
            this.bootQueryTimer = null;
        }
    }
}
