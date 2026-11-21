/**
 * test-utils.ts：driver 层测试共享设施。
 * FakeChild（可触发 exit）+ createHarness（driver + spawns/peers 记录）。
 */
import { EventEmitter } from "node:events";
import {
    encodeIpcMessage,
    IPC_VERSION,
    type IpcMessage,
    type IpcStatusPayload,
} from "../ipc/index.js";
import { MemoryLinePair } from "../ipc/test-utils.js";
import { NapukettoDriver } from "./driver.js";
import type { ChildProcessLike, DriverEvents } from "./types.js";

/** 假子进程：可手动触发 exit。 */
export class FakeChild
    extends EventEmitter<{
        exit: [code: number | null, signal: string | null];
        error: [error: Error];
    }>
    implements ChildProcessLike
{
    readonly signals: Array<NodeJS.Signals | number> = [];
    pid: number | undefined = 9999;
    exitCode: number | null = null;
    signalCode: string | null = null;
    killResult = true;

    kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
        this.signals.push(signal);
        return this.killResult;
    }

    /** 触发子进程退出（模拟崩溃/正常退出）。 */
    emitExit(code: number | null, signal: string | null): void {
        this.exitCode = code;
        this.signalCode = signal;
        this.emit("exit", code, signal);
    }
}

/** 测试夹具：driver + 每次 spawn 的 child/pair 记录。 */
export interface DriverHarness {
    driver: NapukettoDriver;
    spawns: FakeChild[];
    peers: MemoryLinePair[];
    /** 模拟子进程发 status 消息（发给最近一次 spawn 的 client）。 */
    emit: (phase: IpcStatusPayload["phase"], message?: string, errorCode?: string) => void;
}

/** 创建夹具（restart 默认 maxRetries=3 / backoffMs=100 / factor=2）。 */
export function createHarness(
    events: DriverEvents = {},
    options: {
        restart?: { maxRetries?: number; backoffMs?: number; backoffFactor?: number };
        onJunkLine?: (line: string) => void;
        accountDir?: string;
    } = {},
): DriverHarness {
    const spawns: FakeChild[] = [];
    const peers: MemoryLinePair[] = [];
    const driver = new NapukettoDriver({
        launch: async () => {
            const child = new FakeChild();
            spawns.push(child);
            return { child };
        },
        createTransport: () => {
            const pair = new MemoryLinePair();
            peers.push(pair);
            return pair;
        },
        events,
        ...(options.accountDir !== undefined ? { accountDir: options.accountDir } : {}),
        restart: { maxRetries: 3, backoffMs: 100, backoffFactor: 2, ...options.restart },
        heartbeatTimeoutMs: 45_000,
        ...(options.onJunkLine !== undefined ? { onJunkLine: options.onJunkLine } : {}),
    });
    return {
        driver,
        spawns,
        peers,
        emit: (phase, message, errorCode) => {
            const pair = peers.at(-1);
            if (pair === undefined) {
                throw new Error("尚无 spawn");
            }
            const msg: IpcMessage = {
                v: IPC_VERSION,
                type: "status",
                payload: {
                    phase,
                    ...(message !== undefined ? { message } : {}),
                    ...(errorCode !== undefined
                        ? { error: { code: errorCode, message: "失败" } }
                        : {}),
                },
            };
            pair.peer.write(encodeIpcMessage(msg));
        },
    };
}

/** 等待 driver 状态切换（同步 tick + 微任务）。 */
export async function flush(): Promise<void> {
    await Promise.resolve();
}
