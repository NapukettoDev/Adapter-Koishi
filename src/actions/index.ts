/**
 * index.ts：动作桥出口（barrel）。
 */
export { parseChannelId } from "./channel.js";
export { toCanonicalElements } from "./elements.js";
export { NapukettoInternal } from "./internal.js";
export { requireFirstPage } from "./ob11-resources.js";
export type {
    MessageListResponse,
    NapukettoInternalOptions,
    PeerTarget,
    RequestFn,
} from "./types.js";
