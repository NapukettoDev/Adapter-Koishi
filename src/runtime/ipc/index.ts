/**
 * index.ts：IPC 协议层出口（barrel）。
 *
 * 只 re-export 有内部消费者的符号（driver/events/bot 层）；其余类型
 * 由消费方直接从 types.js import（barrel 保持最小面，fallow 无死导出）。
 */

export {
    IPC_VERSION,
    type IpcEventPayload,
    type IpcGroupRequest,
    IpcGroupRequestSchema,
    type IpcLoginPayload,
    type IpcLogPayload,
    type IpcMessage,
    IpcRespondToGroupRequestParamsSchema,
    type IpcStatusPayload,
} from "@napuketto/loader";
export { decodeIpcMessage, encodeIpcMessage, NapukettoIpcClient } from "./client.js";
export { ChildProcessIpcTransport, type IpcLineTransport } from "./transport.js";
