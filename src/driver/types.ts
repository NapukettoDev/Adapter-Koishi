/**
 * types.ts：驱动层类型（driver.ts 依赖注入面）。
 *
 * driver 不直接 import loader（launch 封装隔离）——只管子进程生命周期，
 * 与传输/IPC 解耦。测试注入假 child + 内存传输，不依赖真实子进程。
 */
import type { QrCodeData } from "@napuketto/kernel";
import type {
    IpcEventPayload,
    IpcLineTransport,
    IpcLoginPayload,
    IpcLogPayload,
    IpcStatusPayload,
} from "../ipc/index.js";

/** 驱动状态机（docs/internals/runtime.md）。 */
export type DriverState =
    | "idle" // 未启动
    | "spawning" // 正在 spawn 子进程
    | "booting" // 子进程引导中（收到 status）
    | "ready" // session READY（收到 status.ready）
    | "restarting" // 崩溃/失联，退避等待重启
    | "stopping" // 主动停止中
    | "stopped" // 已停止
    | "failed"; // 重启次数达上限

/** 宽松子进程面（driver 只用到这些成员；测试可伪造）。 */
export interface ChildProcessLike {
    stdout: NodeJS.ReadableStream | null;
    stdin: NodeJS.WritableStream | null;
    /** 监听退出（退出码 + 信号）。 */
    once(event: "exit", listener: (code: number | null, signal: string | null) => void): unknown;
    /**
     * 监听启动失败（spawn ENOENT 等，Node 异步 emit——无监听者会抛
     * uncaughtException 崩掉宿主进程，2026-08-23 WSL 实测 koishi 崩溃）。
     */
    once(event: "error", listener: (err: Error) => void): unknown;
    kill(signal?: NodeJS.Signals | number): boolean;
    pid?: number;
}

/** 启动结果（launch 工厂返回）。 */
export interface DriverLaunchResult {
    child: ChildProcessLike;
    /** 启动失败清理（如 stub 缺失时的资源释放）。 */
    cleanup?: () => void;
}

/** 启动工厂（apply() 层用 launchSelfHost 组装；测试注入假 child）。异步：launchSelfHost 自 P2（2026-08-12）起为 async。 */
export type DriverLauncher = () => Promise<DriverLaunchResult>;

/** 驱动选项。 */
export interface DriverOptions {
    /** 启动子进程（默认 launchSelfHost 组装，测试注入假 child）。 */
    launch: DriverLauncher;
    /** 传输工厂（默认 ChildProcessIpcTransport，测试注入内存双端）。 */
    createTransport?: TransportFactory;
    /** 事件回调（apply() 注入）。 */
    events: DriverEvents;
    /** 重启策略。 */
    restart?: RestartPolicy;
    /** 心跳超时（毫秒，默认 45s）。 */
    heartbeatTimeoutMs?: number;
    /** IPC 通道脏行回调（子进程 stdout 被并发输出撕裂/污染时的诊断留痕，接 logger）。 */
    onJunkLine?: (line: string) => void;
}

/** 传输工厂（默认 ChildProcessIpcTransport；测试注入内存双端）。 */
export type TransportFactory = (child: ChildProcessLike) => IpcLineTransport;

/** 重启策略。 */
export interface RestartPolicy {
    /** 最大重启次数（0 = 不重启），默认 3。 */
    maxRetries?: number;
    /** 首次退避基数（毫秒），默认 1000。 */
    backoffMs?: number;
    /** 退避因子，默认 2。 */
    backoffFactor?: number;
}

/** 驱动事件回调（上层 apply() 注入）。 */
export interface DriverEvents {
    /** 引导状态（booting/dlopening/logging/sessioning/ready/failed）。 */
    onStatus?(status: IpcStatusPayload): void;
    /** 登录状态。 */
    onLogin?(payload: IpcLoginPayload): void;
    /** 二维码数据（扫码登录展示）。 */
    onQr?(qr: QrCodeData): void;
    /** kernel 事件转发（翻译层消费）。 */
    onEvent?(payload: IpcEventPayload): void;
    /** 结构化日志转发。 */
    onLog?(payload: IpcLogPayload): void;
    /** 就绪（每轮就绪回调，客户端实例随重启更换）。 */
    onReady?(): void;
    /** 子进程退出（code/signal/原因：crash/stale/stop）。 */
    onExit?(info: { code: number | null; signal: string | null; reason: ExitReason }): void;
    /** 驱动错误（spawn 失败、重启达上限等）。 */
    onError?(error: unknown): void;
}

/** 退出原因。 */
export type ExitReason = "crash" | "stale" | "stop" | "spawn-error";
