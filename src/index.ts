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
import { NapukettoBot } from "./bot/index.js";
import { napukettoConfigSchema as Config } from "./config.js";

export * from "./actions/index.js";
export * from "./bot/index.js";
export * from "./events/index.js";

// NapukettoBot 经 export * from "./bot/index.js" 已导出；这里只补 Config
// （bot.ts namespace 声明合并成员，不走 barrel 链）。
export { Config };

export default NapukettoBot;
