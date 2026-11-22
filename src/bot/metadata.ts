import type { LogLevel } from "../config.js";

/** logLevel 配置 → reggol 数字（reggol：DEBUG=3 / INFO=2 / ERROR=1 / SILENT=0）。 */
export const LOG_LEVEL_MAP: Record<LogLevel, number> = {
    debug: 3,
    info: 2,
    error: 1,
    silent: 0,
};

export const BOT_INJECT = { optional: ["database", "console"] };

export function avatarUrl(selfId: string): string {
    const avatar = new URL("https://q.qlogo.cn/headimg_dl");
    avatar.searchParams.set("dst_uin", selfId);
    avatar.searchParams.set("spec", "640");
    return avatar.href;
}

export const BOT_USAGE = `
<div style="border-radius: 10px; border: 1px solid #ddd; padding: 16px; margin-bottom: 20px; box-shadow: 0 2px 5px rgba(0,0,0,0.1);">
  <h2 style="margin-top: 0; color: #4a6ee0;">🖥️ NapukettoQQ 适配器</h2>
  <p>自研 QQ NT <strong>wrapper.node</strong> 协议层，无需外部协议端。</p>
  <p>每个 <code>bots</code> 配置项启动一个自建宿主子进程，经 IPC 与 Koishi 通信。
  Windows 使用 QQNT.dll stub，Linux / WSL 使用 Linux 版 QQ、ELF stub 与 libgnutls.so.30。
  Wine 已退役。配置 <code>selfId</code> 为登录 QQ 号即可。
  登录二维码在插件详情页实时展示（控制台安装后可见）。</p>
</div>
`;
