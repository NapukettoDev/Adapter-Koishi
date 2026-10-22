/**
 * message.ts：NapukettoMessageEncoder（docs/internals/bot.md）。
 *
 * koishi `Bot.createMessage` 用 `static MessageEncoder` 实例化 → `send(content)`
 * → `prepare()`（channel.type 补全）+ `render()`（逐个 `visit`）+ `flush()`。
 *
 * visit 收到的 element 是 h 实例（text 内容在 attrs.content，napcat 实证）——
 * 攒进数组，flush() 一次性 internal.sendMessage（元素 → canonical 转换复用
 * actions/elements.ts 的 toCanonicalElements 宽松结构）。
 *
 * 运行时 import koishi（MessageEncoder/h/Universal）——本文件不进单测。
 */
import { type Bot, type Context, type h, MessageEncoder } from "koishi";
import { PRIVATE_PREFIX } from "../constants.js";

/** 消息编码器：收集 koishi 元素 → flush 时经 internal.sendMessage 发送。 */
export class NapukettoMessageEncoder<C extends Context = Context> extends MessageEncoder<
    C,
    Bot<C>
> {
    private readonly children: unknown[] = [];

    override async prepare(): Promise<void> {
        await super.prepare();
        const channel = this.session.event.channel;
        if (channel && !channel.type) {
            // protocol Channel.Type：DIRECT=1 / TEXT=0（const enum，verbatimModuleSyntax 禁访问）
            channel.type = channel.id.startsWith(PRIVATE_PREFIX) ? 1 : 0;
        }
        if (!this.session.isDirect) {
            this.session.guildId ??= this.channelId;
        }
    }

    /** 收集元素（h 实例；toCanonicalElements 宽松结构消费 attrs/children）。 */
    override async visit(element: h): Promise<void> {
        this.children.push(element);
    }

    /** 一次性发送收集的元素 → session 'send' 事件。 */
    override async flush(): Promise<void> {
        if (this.children.length === 0) {
            return;
        }
        const session = this.bot.session();
        session.content = "";
        const ids = await this.bot.internal.sendMessage(
            this.channelId,
            this.children,
            this.session.guildId,
        );
        session.messageId = ids[0] ?? "";
        session.userId = this.bot.selfId;
        if (this.session.channelId !== undefined) {
            session.channelId = this.session.channelId;
        }
        if (this.session.guildId !== undefined) {
            session.guildId = this.session.guildId;
        }
        session.isDirect = this.session.isDirect;
        session.app.emit(session, "send", session);
        if (session.event.message !== undefined) {
            this.results.push(session.event.message);
        }
        this.children.length = 0;
    }
}
