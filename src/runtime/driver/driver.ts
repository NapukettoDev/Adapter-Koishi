import { IpcError } from "../../shared.js";
import type { NapukettoIpcClient } from "../ipc/index.js";
import { BootResyncBuffer } from "./boot-resync.js";
import { connectHost } from "./client-events.js";
import { HeartbeatMonitor, RestartScheduler } from "./supervision.js";
import { type HostProcess, HostTerminator } from "./terminator.js";
import type {
    AccountOwner,
    AccountOwners,
    DriverEvents,
    DriverLaunchResult,
    DriverOptions,
    DriverState,
} from "./types.js";

/** 自建宿主的状态转换、IPC 接线与协作者编排。 */
export class NapukettoDriver {
    private state: DriverState = "idle";
    private client: NapukettoIpcClient | null = null;
    private host: HostProcess | null = null;
    private launching = false;
    private spawnAt = 0;
    private stopCompletion: ReturnType<typeof Promise.withResolvers<void>> | null = null;

    private readonly options: DriverOptions;
    private readonly events: DriverEvents;
    private readonly owners: AccountOwners;
    private readonly restart: RestartScheduler;
    private readonly heartbeat: HeartbeatMonitor;
    private readonly resync = new BootResyncBuffer(
        () => this.state === "booting",
        () => this.client?.sendControl({ command: "status" }),
        (payload) => this.events.onEvent?.(payload),
    );
    private readonly terminator = new HostTerminator({
        isCurrent: (host) => this.host === host,
        getClient: () => this.client,
        closeClient: () => this.closeClient(),
        onTerminating: () => this.setState("terminating"),
        stopHeartbeat: () => this.heartbeat.stop(),
        onTimeout: () => this.resolveStop("failed"),
        onLoginRestart: () => this.events.onLoginRestart?.(),
        onError: (error) => this.events.onError?.(error),
    });

    constructor(options: DriverOptions) {
        this.options = { ...options };
        this.events = options.events;
        this.owners = options.accountOwners ?? sharedAccountOwners;
        this.restart = new RestartScheduler(options.restart);
        this.heartbeat = new HeartbeatMonitor(
            {
                seenAt: () => this.client?.seenAt ?? 0,
                spawnAt: () => this.spawnAt,
                state: () => this.state,
            },
            {
                intervalMs: 1_000,
                timeoutMs: options.heartbeatTimeoutMs ?? 45_000,
                onStale: () => {
                    if (this.host !== null) {
                        this.terminator.begin(this.host, "stale");
                    }
                },
            },
        );
    }

    get currentState(): DriverState {
        return this.state;
    }

    get currentClient(): NapukettoIpcClient | null {
        return (this.state === "booting" || this.state === "ready") && this.client?.alive
            ? this.client
            : null;
    }

    get restartAttempts(): number {
        return this.restart.attempts;
    }

    start(): void {
        if (this.state === "stopped") {
            this.restart.reset();
            this.setState("idle");
        }
        if (this.state === "idle") {
            void this.spawnProcess("spawning");
        }
    }

    restartLogin(): boolean {
        if (this.host === null || this.currentClient === null) {
            return false;
        }
        this.terminator.begin(this.host, "restart");
        return true;
    }

    /** 停止期间取消重启，等旧宿主确认退出或终止超时。 */
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
        this.restart.cancel();
        if (host !== null) {
            this.terminator.begin(host, "stop");
        } else if (!this.launching) {
            this.resolveStop("stopped");
        }
        return completion.promise;
    }

    private async spawnProcess(state: "spawning" | "restarting"): Promise<void> {
        this.setState(state);
        this.launching = true;
        const { accountDir } = this.options;
        let result: DriverLaunchResult;
        try {
            if (accountDir !== undefined) {
                const release = this.owners.waitForRelease(accountDir);
                if (release !== undefined) {
                    await release;
                }
                if (this.state === "stopping") {
                    this.launching = false;
                    this.resolveStop("stopped");
                    return;
                }
                this.owners.claim(accountDir, this);
            }
            result = await this.options.launch();
        } catch (error) {
            this.launching = false;
            this.owners.release(accountDir, this);
            if (this.state === "stopping") {
                this.resolveStop("stopped");
            } else {
                this.setState("failed");
                this.events.onExit?.({ code: null, signal: null, reason: "spawn-error" });
                this.events.onError?.(error);
            }
            return;
        }
        this.launching = false;
        const host = this.terminator.watch(result, this.state === "stopping" ? "stop" : "crash", {
            onAttach: (host) => (this.host = host),
            onExit: (host, code, signal) => this.handleChildExit(host, code, signal),
            onSpawnError: (host) => this.terminator.begin(host, "spawn-error"),
        });
        if (host === null) {
            return;
        }
        if (this.state === "stopping") {
            this.terminator.begin(host, "stop");
        } else {
            this.connect(host);
        }
    }

    private connect(host: HostProcess): void {
        connectHost(host, this.options, {
            onConnect: (client) => {
                this.client = client;
                this.resync.open();
                this.spawnAt = Date.now();
                this.setState("booting");
                this.heartbeat.start();
            },
            onTransportError: () => this.terminator.begin(host, "spawn-error"),
            isActive: (client) => this.currentClient === client,
            getState: () => this.state,
            onReady: () => {
                this.restart.reset();
                this.setState("ready");
                this.events.onReady?.();
                this.resync.flush();
            },
            onEvent: (payload) => {
                if (!this.resync.enqueue(payload) && this.state === "ready") {
                    this.events.onEvent?.(payload);
                }
            },
        });
    }

    private handleChildExit(host: HostProcess, code: number | null, signal: string | null): void {
        if (this.host !== host) {
            return;
        }
        this.host = null;
        this.terminator.detach(host);
        this.heartbeat.stop();
        this.closeClient();
        this.owners.release(this.options.accountDir, this);
        this.terminator.cleanup(host);

        if (this.state === "failed") {
            if (host.reason === "stop") {
                this.resolveStop("stopped");
            }
            return;
        }
        const failure = this.terminator.getExitError(host, code, this.restart.exhausted);
        if (host.reason === "stop") {
            this.resolveStop("stopped");
        } else if (host.reason === "restart") {
            this.scheduleRestart(0); // 手动重启从新的崩溃重试配额开始。
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

    private scheduleRestart(attempt?: number): void {
        this.setState("restarting");
        this.restart.schedule(() => void this.spawnProcess("restarting"), attempt);
    }

    private resolveStop(state: "failed" | "stopped"): void {
        this.setState(state);
        this.stopCompletion?.resolve();
        this.stopCompletion = null;
    }

    private closeClient(): void {
        this.resync.discard();
        const client = this.client;
        this.client = null;
        client?.close();
    }

    private setState(next: DriverState): void {
        this.state = next;
        this.resync.updateTimer();
    }
}

/** 同账号的新驱动只等待已进入停止流程的旧宿主。 */
export class AccountOwnerRegistry implements AccountOwners {
    private readonly owners = new Map<string, AccountOwner>();

    waitForRelease(dir: string): Promise<void> | undefined {
        const previous = this.owners.get(dir);
        return previous?.currentState === "stopping" ? previous.stop() : undefined;
    }

    claim(dir: string, owner: AccountOwner): void {
        if (this.owners.has(dir)) {
            throw new IpcError(
                `账号数据目录仍由旧宿主使用（${dir}），请先停止旧宿主`,
                "INVALID_STATE",
            );
        }
        this.owners.set(dir, owner);
    }

    release(dir: string | undefined, owner: AccountOwner): void {
        if (dir !== undefined && this.owners.get(dir) === owner) {
            this.owners.delete(dir);
        }
    }
}

export const sharedAccountOwners = new AccountOwnerRegistry();
