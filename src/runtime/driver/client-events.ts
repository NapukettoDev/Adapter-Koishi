import type { ChildProcess } from "node:child_process";
import { IpcError } from "../../shared.js";
import {
    ChildProcessIpcTransport,
    type IpcEventPayload,
    type IpcLineTransport,
    type IpcStatusPayload,
    NapukettoIpcClient,
} from "../ipc/index.js";
import type { HostProcess } from "./terminator.js";
import type { DriverEvents, DriverOptions, DriverState } from "./types.js";

/** 诊断回调只接受 Error，非 Error 抛出值转成 Error 再上报。 */
function toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

interface ClientBinding {
    onConnect(client: NapukettoIpcClient): void;
    onTransportError(): void;
    isActive(client: NapukettoIpcClient): boolean;
    getState(): DriverState;
    onReady(): void;
    onEvent(payload: IpcEventPayload): void;
}

export function connectHost(
    host: HostProcess,
    { createTransport, events, onJunkLine }: DriverOptions,
    binding: ClientBinding,
): void {
    let transport: IpcLineTransport;
    try {
        transport =
            createTransport !== undefined
                ? createTransport(host.child)
                : new ChildProcessIpcTransport(
                      host.child as ChildProcess,
                      (error) => events.onIpcWriteError?.(error),
                      {
                          onOversizeLine: (error) => events.onIpcError?.(error),
                          ...(events.onStderr === undefined ? {} : { onStderr: events.onStderr }),
                      },
                  );
    } catch (error) {
        binding.onTransportError();
        events.onError?.(error);
        return;
    }
    const client = new NapukettoIpcClient(transport, {
        ...(onJunkLine === undefined ? {} : { onJunkLine }),
        onHandlerError: (error) => events.onIpcError?.(toError(error)),
    });
    binding.onConnect(client);
    subscribeClient(client, host, events, binding);
}

function subscribeClient(
    client: NapukettoIpcClient,
    host: HostProcess,
    events: DriverEvents,
    binding: ClientBinding,
): void {
    const active = () => binding.isActive(client);
    let previousPhase: IpcStatusPayload["phase"] | undefined;
    let reassemblyPending = false;
    client.on("status", (message) => {
        if (!active()) {
            return;
        }
        const status = message.payload;
        // Loader 在软重登时先报告 sessioning，再接入新一轮原始事件转发。
        const reassembling =
            binding.getState() === "ready" &&
            status.phase === "sessioning" &&
            previousPhase !== "sessioning";
        previousPhase = status.phase;
        if (reassembling) {
            // 先关旧会话的身份/动作闸门，再刷新事件积压基准。
            reassemblyPending = true;
            events.onRelogin?.();
            events.onEventSubscription?.();
        }
        events.onStatus?.(status);
        if (active()) {
            if (status.phase === "ready" && binding.getState() === "booting") {
                binding.onReady();
            } else if (status.phase === "ready" && reassemblyPending) {
                reassemblyPending = false;
                events.onReassembled?.();
            } else if (status.phase === "failed") {
                reassemblyPending = false;
                // loader 用 INVALID_PARAM 上报不可恢复的配置校验失败。
                if (status.error?.code === "INVALID_PARAM") {
                    host.configInvalid = true;
                } else {
                    events.onError?.(
                        new IpcError(
                            status.message ?? "子进程引导失败",
                            status.error?.code ?? "UNKNOWN",
                        ),
                    );
                }
            }
        }
    });
    client.on("login", (message) => {
        if (active()) {
            events.onLogin?.(message.payload);
        }
    });
    client.on("qr", (message) => {
        if (active()) {
            events.onQr?.(message.payload);
        }
    });
    client.on("event", (message) => {
        if (!active()) {
            return;
        }
        binding.onEvent(message.payload);
    });
    client.on("log", (message) => {
        if (active()) {
            events.onLog?.(message.payload);
        }
    });
    events.onEventSubscription?.();
}
