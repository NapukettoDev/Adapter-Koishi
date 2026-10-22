/**
 * types.ts：动作桥类型（docs/internals/actions.md）。
 *
 * 动作桥做 koishi 动作 → IPC action 请求 → kernel API。传输抽象 `RequestFn`
 * 对应 napcat 的 `internal._request`（§9.1）——把 HTTP 换成 IPC 请求即可。
 * koishi 主包不 import（单测崩溃，docs/guides/development.md 单测边界），类型用宽松结构 + 依赖注入。
 */

/** 传输抽象：IPC 动作请求（apply() 层注入 client.request 绑定）。 */
export type RequestFn = (action: string, params?: Record<string, unknown>) => Promise<unknown>;

/** 动作桥选项。 */
export interface NapukettoInternalOptions {
    /** 传输抽象（IPC 动作请求）。 */
    request: RequestFn;
    /** 远程媒体下载失败等告警日志（缺省静默）。 */
    logger?: { warn(message: string): void };
}

/** Peer 目标参数（channelId 解析结果，loader 侧 toPeer 消费）。 */
export interface PeerTarget {
    chatType: number;
    peerUin: string;
}

/** 消息列表响应（koishi MessageList 宽松形状）。 */
export interface MessageListResponse<T> {
    data: T[];
    next?: string;
}
