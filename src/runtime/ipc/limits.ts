/**
 * limits.ts：IPC 通道的本地资源上限。
 *
 * 协议消息类型与 schema 仍由 `@napuketto/loader` 提供；这里只约束插件侧
 * 单条物理行和同时在途请求数，防止异常对端或调用方把父进程内存拖垮。
 */

/**
 * 单条物理 IPC 行的 UTF-8 字节上限（不含行尾 LF）。
 *
 * 按 JSON 行协议整行计数；超过上限的入站行整行丢弃（保留通道继续处理后续行），
 * 出站请求在本地拒绝。16 MiB 足以容纳较大的消息事件与二维码载荷。
 */
export const DEFAULT_MAX_IPC_LINE_BYTES = 16 * 1024 * 1024;

/** 同时等待响应的动作请求上限；超过后新请求立即失败。 */
export const DEFAULT_MAX_PENDING_REQUESTS = 256;
