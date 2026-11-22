/**
 * errors.ts：IPC 层错误（协议级：超时 / 通道关闭 / 远端错误码）。
 *
 * 与 kernel 的 KernelError 区分：远端错误码是宽松 string（来自协议边界），
 * 不伪造 KernelErrorCode；插件侧 driver/events 层再按需映射。
 */
export class IpcError extends Error {
    readonly code: string;

    constructor(message: string, code: string) {
        super(message);
        this.name = "IpcError";
        this.code = code;
    }
}
