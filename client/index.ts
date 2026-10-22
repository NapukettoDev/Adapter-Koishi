/**
 * index.ts：控制台前端入口（docs/internals/console.md）。
 *
 * 把扫码登录面板挂到 Koishi 控制台的插件详情页（plugin-details slot）——
 * 机制参照 koishi-plugin-adapter-bilibili-dm（MIT，仅借鉴挂载点模式）。
 * 由 @koishijs/client 的构建链编译（dev 走 koishi dev；prod 走 vite 打包）。
 */
import Settings from './settings.vue';
import type { Context } from './types/koishijs-client';

export default (ctx: Context) =>
{
  ctx.slot({
    type: 'plugin-details',
    component: Settings,
    order: 800,
  });
};
