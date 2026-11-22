/**
 * index.ts：koishi-plugin-adapter-napuketto 插件入口。
 *
 * 默认导出 NapukettoBot（koishi Bot 子类）——koishi 自动 `ctx.platform('onebot', ...)`
 * 注册平台，按用户 bots 配置（`bots: { 'onebot:<uin>': {...} }`）实例化；
 * Bot 构造自动注册 `ctx.on('ready', () => this.start())` → start() spawn 自建宿主
 * 子进程（driver → IPC）→ 登录 → 事件桥/动作桥装配。控制台登录面板
 * （docs/internals/console.md）在 bot 构造内装配（console 服务就绪后：DataService 推送 +
 * addEntry 前端入口）。
 *
 * 运行时 import koishi（Session 声明扩展）——本文件不进单测（docs/guides/development.md 单测边界）。
 */
import { NapukettoBot } from "./bot/bot.js";
import { napukettoConfigSchema as Config } from "./config.js";

export {
    buildLaunch,
    type ResolvedLaunch,
    resolveEntry,
    resolveLaunchOptions,
} from "./bot/launch.js";
export { NapukettoMessageEncoder } from "./bot/message.js";
export { parseChannelId } from "./bridge/actions/codecs.js";
export { toCanonicalElements } from "./bridge/actions/elements.js";
export { NapukettoInternal } from "./bridge/actions/internal.js";
export type {
    MessageListResponse,
    NapukettoInternalOptions,
    PeerTarget,
    RequestFn,
} from "./bridge/actions/types.js";
export { adaptRawMessage, adaptRawMessageWithMedia } from "./bridge/events/adapt.js";
export { NapukettoEventBridge } from "./bridge/events/bridge.js";
export type {
    EventBridge,
    EventBridgeOptions,
    NapukettoSessionFields,
    Ob11EventPayload,
} from "./bridge/events/types.js";
export { enrichReceiveVoice, resolveNtFile } from "./bridge/events/voice-decode.js";
export { toKoishiElements } from "./shared.js";
export { Config, NapukettoBot };

export default NapukettoBot;
