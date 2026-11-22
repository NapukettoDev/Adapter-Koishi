/**
 * index.ts：事件桥出口（barrel）。
 */

export { toKoishiElements } from "../shared/protocol.js";
export { adaptRawMessage, adaptRawMessageWithMedia } from "./adapt.js";
export { NapukettoEventBridge } from "./bridge.js";
export type {
    EventBridge,
    EventBridgeOptions,
    NapukettoSessionFields,
    Ob11EventPayload,
} from "./types.js";
export { enrichReceiveVoice, resolveNtFile } from "./voice-decode.js";
