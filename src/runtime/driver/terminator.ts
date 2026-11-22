import { EXIT_CONFIG_INVALID } from "@napuketto/kernel";
import { IpcError } from "../../shared.js";
import type { NapukettoIpcClient } from "../ipc/index.js";
import type { ChildProcessLike, DriverLaunchResult, ExitReason } from "./types.js";

const EXIT_TIMEOUT_MS = 5_000;

export interface HostProcess {
    child: ChildProcessLike;
    removeListeners(): void;
    cleanup?: () => void;
    reason: ExitReason;
    timer?: NodeJS.Timeout;
    configInvalid?: boolean;
}

interface TerminatorDeps {
    isCurrent(host: HostProcess): boolean;
    getClient(): NapukettoIpcClient | null;
    closeClient(): void;
    onTerminating(): void;
    stopHeartbeat(): void;
    onTimeout(): void;
    onLoginRestart(): void;
    onError(error: unknown): void;
}

interface HostCallbacks {
    onAttach(host: HostProcess): void;
    onExit(host: HostProcess, code: number | null, signal: string | null): void;
    onSpawnError(host: HostProcess): void;
}

export class HostTerminator {
    constructor(private readonly deps: TerminatorDeps) {}

    watch(
        result: DriverLaunchResult,
        reason: ExitReason,
        callbacks: HostCallbacks,
    ): HostProcess | null {
        const { child, cleanup } = result;
        const onExit = (code: number | null, signal: string | null) => {
            callbacks.onExit(host, code, signal);
        };
        const onError = (error: Error) => {
            this.handleChildError(host, error, callbacks);
        };
        const host: HostProcess = {
            child,
            reason,
            removeListeners: () => {
                child.off("exit", onExit);
                child.off("error", onError);
            },
            ...(cleanup !== undefined ? { cleanup } : {}),
        };
        callbacks.onAttach(host);
        child.on("error", onError);
        child.once("exit", onExit);
        const exitCode = child.exitCode ?? null;
        const signalCode = child.signalCode ?? null;
        if (exitCode !== null || signalCode !== null) {
            onExit(exitCode, signalCode);
            return null;
        }
        return host;
    }

    private handleChildError(host: HostProcess, error: Error, callbacks: HostCallbacks): void {
        if (!this.deps.isCurrent(host)) {
            return;
        }
        if (host.child.pid === undefined) {
            // Node 启动失败时只有 error/close，没有待退出的进程。
            if (host.reason !== "stop") {
                host.reason = "spawn-error";
            }
            callbacks.onExit(host, null, null);
        } else if (host.reason === "crash") {
            callbacks.onSpawnError(host);
        }
        this.deps.onError?.(error);
    }

    detach(host: HostProcess): void {
        if (host.timer !== undefined) {
            clearTimeout(host.timer);
            delete host.timer;
        }
        host.removeListeners();
    }

    cleanup(host: HostProcess): void {
        if (host.reason === "spawn-error" || host.reason === "stop" || host.reason === "restart") {
            host.cleanup?.();
        }
    }

    begin(host: HostProcess, reason: Exclude<ExitReason, "crash">): void {
        host.reason = reason;
        if (host.timer !== undefined) {
            return; // 主动停止可以接管当前终止流程，沿用已安排的升级期限。
        }
        if (reason !== "stop") {
            this.deps.onTerminating();
        }
        this.deps.stopHeartbeat();
        const client = this.deps.getClient();
        if ((reason === "stop" || reason === "restart") && client?.alive === true) {
            // 先设期限，控制指令可能导致子进程立即退出。
            host.timer = setTimeout(() => {
                delete host.timer;
                this.signalHost(host, "SIGTERM");
            }, EXIT_TIMEOUT_MS);
            try {
                if (reason === "restart") {
                    this.deps.onLoginRestart?.();
                }
                client.sendControl({ command: host.reason === "stop" ? "stop" : "restart" });
            } catch (err) {
                this.deps.onError?.(err);
            } finally {
                if (this.deps.isCurrent(host)) {
                    this.deps.closeClient();
                }
            }
        } else {
            this.deps.closeClient();
            this.signalHost(host, "SIGTERM");
        }
    }

    private signalHost(host: HostProcess, signal: "SIGTERM" | "SIGKILL"): void {
        if (!this.deps.isCurrent(host)) {
            return;
        }
        host.timer = setTimeout(() => {
            delete host.timer;
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
            if (this.deps.isCurrent(host)) {
                this.deps.onError?.(err);
            }
            return;
        }
        if (this.deps.isCurrent(host)) {
            this.deps.onError?.(
                new IpcError(
                    `向子进程（PID ${pid}）发送 ${signal} 失败，仍在等待退出`,
                    "SIGNAL_FAILED",
                ),
            );
        }
    }

    private failTermination(host: HostProcess): void {
        if (!this.deps.isCurrent(host)) {
            return;
        }
        this.deps.onTimeout();
        this.deps.onError?.(
            new IpcError(
                `无法确认子进程（PID ${host.child.pid ?? "?"}）已退出，已停止重启。请在系统中确认或停止该进程后重新启用插件。`,
                "EXIT_TIMEOUT",
            ),
        );
    }

    getExitError(host: HostProcess, code: number | null, retryLimit: boolean): IpcError | null {
        if (host.reason === "stop" || host.reason === "restart" || host.reason === "spawn-error") {
            return null;
        }
        if (code === EXIT_CONFIG_INVALID || host.configInvalid === true) {
            return new IpcError(
                "子进程配置校验失败，已停止重试。请检查该账号的 Napuketto 配置和 napuketto-boot.log，修正后重新启用插件。",
                "INVALID_PARAM",
            );
        }
        if (retryLimit) {
            return new IpcError(`子进程退出（code=${code ?? "?"}），重启次数达上限`, "RETRY_LIMIT");
        }
        return null;
    }
}
