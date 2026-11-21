/**
 * driver.ts：NapukettoDriver——自建宿主子进程生命周期驱动（docs/internals/runtime.md）。
 *
 * 职责：spawn（launch 工厂注入）→ IPC client → 状态机 → 崩溃/失联重启（退避）。
 * 不 import loader：launch 由 apply() 用 launchSelfHost 组装注入。
 *
 * 心跳监控：spawn 后立即开始（兜 dlopen/登录卡死挂起），client.seenAt 超过
 * heartbeatTimeoutMs 判定失联 → kill + 重启。
 *
 * 状态重同步（2026-09-06「能收不能发」事故）：status 消息（尤其 ready）经子进程
 * stdout 传输，可能被并发输出撕裂丢失（原生 printf 直写 fd 等 JS 层拦不住的
 * 污染）。booting 期间暂存 event，收到 event 或定时（20s）发 control status 查询，
 * 子进程重播最近一条 status。收到 ready 并完成 onReady 后按序回放事件。
 */
import type { ChildProcess } from "node:child_process";
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

/** 优雅退出等待超时（毫秒）。 */
const STOP_TIMEOUT_MS = 5_000;

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

/** 子进程生命周期驱动。 */
export class NapukettoDriver {
    private readonly events: DriverEvents;
    private readonly launch: DriverLauncher;
    private readonly createTransport: TransportFactory;
    private readonly restart: Required<RestartPolicy>;
    private readonly heartbeatTimeoutMs: number;
    private readonly onJunkLine: ((line: string) => void) | undefined;

    private state: DriverState = "idle";
    private client: NapukettoIpcClient | null = null;
    private child: ChildProcessLike | null = null;
    private restartCount = 0;
    private spawnAt = 0;
    /** 最近一次状态重查时间（节流用）。 */
    private lastStatusQueryAt: number | null = null;
    /** 当前子进程的待回放事件，完成回放或清理后为 null。 */
    private startupEvents: IpcEventPayload[] | null = null;
    private readonly heartbeat: HeartbeatMonitor;
    private restartTimer: NodeJS.Timeout | null = null;
    private stopTimer: NodeJS.Timeout | null = null;
    /** booting 阶段状态重查定时器（离开 booting 即清）。 */
    private bootQueryTimer: NodeJS.Timeout | null = null;

    constructor(options: DriverOptions) {
        this.events = options.events;
        this.launch = options.launch;
        this.createTransport = options.createTransport ?? defaultTransport;
        this.onJunkLine = options.onJunkLine;
        this.restart = {
            maxRetries: options.restart?.maxRetries ?? DEFAULT_RESTART.maxRetries,
            backoffMs: options.restart?.backoffMs ?? DEFAULT_RESTART.backoffMs,
            backoffFactor: options.restart?.backoffFactor ?? DEFAULT_RESTART.backoffFactor,
        };
        this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 45_000;
        // 心跳监控（heartbeat.ts 独立类：轮询 seenAt，失联回调 kill + 重启）。
        // driver 只提供采样源（client.seenAt/spawnAt/state）与失联处理。
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
                    const child = this.child;
                    if (child !== null) {
                        child.kill();
                        this.handleChildExit(child, null, "SIGKILL", "stale");
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

    /** 主动停止：发 control stop → 等退出（5s）→ kill。不再重启。 */
    stop(): void {
        if (this.state === "idle" || this.state === "stopped" || this.state === "stopping") {
            return;
        }
        this.startupEvents = null;
        this.setState("stopping");
        this.clearRestartTimer();
        this.heartbeat.stop();

        const current = this.client;
        if (current === null) {
            this.finishStop();
            return;
        }
        // 等待子进程退出；超时强杀
        this.stopTimer = setTimeout(() => {
            this.child?.kill();
            this.finishStop();
        }, STOP_TIMEOUT_MS);
        if (current.alive) {
            current.sendControl({ command: "stop" });
        }
    }

    // ── 内部 ──

    private async spawnProcess(reason: "start" | "restart"): Promise<void> {
        this.setState(reason === "start" ? "spawning" : "restarting");
        let result: DriverLaunchResult;
        try {
            result = await this.launch();
        } catch (err) {
            if (this.state !== "stopped") {
                this.handleSpawnError(err);
            }
            return;
        }
        const { child, cleanup } = result;
        // ⚠️ spawn error 兜底（2026-08-23 WSL 生产事故）：命令缺失（wine 未安装等）
        // 时 Node 异步 emit 'error'，不监听 = uncaughtException 崩掉整个 koishi。
        // launch 工厂（launcher）已预检 + 内部监听防崩溃，这里再转发 onError 走
        // 友好错误流程（[W] 驱动错误 + offline）；清理后忽略旧进程回调。
        child.once("error", (err) => {
            if (this.child === child) {
                this.handleSpawnError(err);
            }
        });
        if (this.state === "stopped") {
            child.kill();
            cleanup?.();
            return;
        }
        this.child = child;
        // 子进程退出（崩溃/正常/被 kill）→ 统一处理（stop 流程除外）
        child.once("exit", (code, signal) => {
            this.handleChildExit(child, code, signal, "crash");
        });

        // 每次 spawn 建新 transport + 新 client（旧 client 随旧子进程 closed）
        let transport: IpcLineTransport;
        try {
            transport = this.createTransport(child);
        } catch (err) {
            cleanup?.();
            this.handleSpawnError(err);
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
        this.subscribeClient(client);

        this.spawnAt = Date.now();
        this.setState("booting");
        this.heartbeat.start();
    }

    private subscribeClient(client: NapukettoIpcClient): void {
        this.events.onEventSubscription?.();
        let previousPhase: IpcStatusPayload["phase"] | undefined;
        client.on("status", (message) => {
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
            this.handleStatus(status);
        });
        client.on("login", (message) => {
            this.events.onLogin?.(message.payload);
        });
        client.on("qr", (message) => {
            this.events.onQr?.(message.payload);
        });
        client.on("event", (message) => {
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
            this.events.onLog?.(message.payload);
        });
    }

    private handleStatus(status: IpcStatusPayload): void {
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
                this.events.onError?.(new Error(status.message ?? "子进程引导失败"));
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

    private handleChildExit(
        child: ChildProcessLike,
        code: number | null,
        signal: string | null,
        reason: ExitReason,
    ): void {
        if (this.child !== child) {
            return;
        }
        this.detachChild();
        this.events.onExit?.({ code, signal, reason });

        if (this.state === "stopping") {
            this.finishStop();
            return;
        }
        if (this.state === "stopped") {
            return;
        }
        // 崩溃/失联 → 按策略重启
        if (this.restartCount >= this.restart.maxRetries) {
            this.setState("failed");
            this.events.onError?.(new Error(`子进程退出（code=${code ?? "?"}），重启次数达上限`));
            return;
        }
        this.scheduleRestart();
    }

    private handleSpawnError(err: unknown): void {
        this.detachChild();
        this.events.onExit?.({ code: null, signal: null, reason: "spawn-error" });
        this.events.onError?.(err);
        if (this.state === "stopping") {
            this.finishStop();
        } else if (this.state !== "stopped") {
            this.setState("failed");
        }
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
        if (this.stopTimer !== null) {
            clearTimeout(this.stopTimer);
            this.stopTimer = null;
        }
        this.detachChild();
        this.setState("stopped");
    }

    private detachChild(): void {
        this.heartbeat.stop();
        this.startupEvents = null;
        const client = this.client;
        this.client = null;
        this.child = null;
        client?.close();
    }

    private setState(next: DriverState): void {
        this.state = next;
        this.updateBootQueryTimer();
    }

    /**
     * 状态重查（节流）：向子进程发 control status，子进程重播最近一条 status。
     * 与心跳监控互补——心跳兜「全静默」（kill + 重启），重查兜「活着但关键
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
