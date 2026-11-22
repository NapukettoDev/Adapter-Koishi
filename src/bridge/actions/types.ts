/**
 * types.ts：动作桥类型（docs/internals/actions.md）。
 *
 * 动作桥做 koishi 动作 → IPC action 请求 → kernel API。传输抽象 `RequestFn`
 * 对应 napcat 的 `internal._request`（§9.1）——把 HTTP 换成 IPC 请求即可。
 * koishi 主包不 import（单测崩溃，docs/guides/development.md 单测边界），类型用宽松结构 + 依赖注入。
 */
import type { SelfInfo } from "@napuketto/kernel";
import type { h, Universal } from "koishi";
import type { OutboundMediaPolicy } from "../../shared.js";

/** 传输抽象：IPC 动作请求（apply() 层注入 client.request 绑定）。 */
export type RequestFn = (action: string, params?: Record<string, unknown>) => Promise<unknown>;

/** 动作桥选项。 */
export interface NapukettoInternalOptions extends OutboundMediaPolicy {
    /** 传输抽象（IPC 动作请求）。 */
    request: RequestFn;
    diagnostics?: boolean;
    /** 运行 Koishi 的账户控制的临时文件根。 */
    outboundRoot?: string;
    /** 登录返回的身份，用于私聊自身时直接获取 UID。 */
    getSelfIdentity?: () => Pick<SelfInfo, "uin" | "uid"> | undefined;
    /** Koishi 元素工厂，历史查询时使用。 */
    h?: typeof h;
    /** 远程媒体下载失败等告警日志（缺省静默）。 */
    logger?: { warn(message: string): void };
}

/** Peer 目标参数（channelId 解析结果，loader 侧 toPeer 消费）。 */
export interface PeerTarget {
    chatType: number;
    peerUin: string;
}

/** Koishi 双向分页列表。 */
export type MessageListResponse<T> = Universal.BidiList<T>;
