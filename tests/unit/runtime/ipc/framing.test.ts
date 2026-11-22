/**
 * framing.test.ts：IPC 物理行增量分帧单测。
 *
 * 覆盖：跨 chunk 的 UTF-8 多字节字符、CRLF、精确上限、超限整行丢弃、
 * 超限后恢复、无换行结尾 flush、reset 与多条行混合。
 */
import { describe, expect, it, vi } from "vitest";
import { LineFramer } from "../../../../src/runtime/ipc/framing.js";

function createFramer(maxLineBytes: number) {
    const lines: string[] = [];
    const oversize = vi.fn();
    const framer = new LineFramer({
        maxLineBytes,
        onLine: (line) => lines.push(line),
        onOversize: oversize,
    });
    return { framer, lines, oversize };
}

describe("LineFramer", () => {
    it("按换行拆行；空行也按行交付", () => {
        const { framer, lines } = createFramer(1024);
        framer.push('{"a":1}\n\n{"b":2}\n');
        expect(lines).toEqual(['{"a":1}', "", '{"b":2}']);
    });

    it("UTF-8 多字节字符跨 chunk 不被截断", () => {
        const { framer, lines } = createFramer(1024);
        const data = Buffer.from('{"text":"你好世界"}\n', "utf8");
        const split = data.indexOf(Buffer.from("好", "utf8"));
        framer.push(data.subarray(0, split + 1));
        framer.push(data.subarray(split + 1));
        expect(lines).toEqual(['{"text":"你好世界"}']);
    });

    it("CRLF 跨 chunk 时去掉行尾 CR", () => {
        const { framer, lines } = createFramer(1024);
        framer.push("line\r");
        framer.push("\nnext\r\n");
        expect(lines).toEqual(["line", "next"]);
    });

    it("恰好等于上限的行允许通过", () => {
        const { framer, lines, oversize } = createFramer(8);
        framer.push("12345678\n");
        expect(lines).toEqual(["12345678"]);
        expect(oversize).not.toHaveBeenCalled();
    });

    it("超限行整行丢弃，后续行继续交付", () => {
        const { framer, lines, oversize } = createFramer(8);
        framer.push("123456789");
        framer.push("abcdefghij\nvalid\n");
        expect(oversize).toHaveBeenCalledExactlyOnceWith(8);
        expect(lines).toEqual(["valid"]);
    });

    it("同一 chunk 内超限后立即恢复，前后有效行都交付", () => {
        const { framer, lines, oversize } = createFramer(8);
        framer.push("before\n123456789abcdef\nafter\n");
        expect(oversize).toHaveBeenCalledOnce();
        expect(lines).toEqual(["before", "after"]);
    });

    it("上限按 UTF-8 字节计数（不是字符数）", () => {
        const { framer, lines, oversize } = createFramer(6);
        framer.push("你好\n");
        framer.push("你好!\n");
        expect(lines).toEqual(["你好"]);
        expect(oversize).toHaveBeenCalledOnce();
    });

    it("无换行结尾时 end() 输出剩余行；超限未结束行直接丢弃", () => {
        const first = createFramer(1024);
        first.framer.push("tail");
        first.framer.end();
        expect(first.lines).toEqual(["tail"]);

        const second = createFramer(4);
        second.framer.push("12345");
        second.framer.end();
        expect(second.lines).toEqual([]);
        expect(second.oversize).toHaveBeenCalledOnce();
    });

    it("reset 丢弃未完成行并清除超限丢弃状态", () => {
        const { framer, lines } = createFramer(4);
        framer.push("12345");
        framer.reset();
        framer.push("ok\n");
        expect(lines).toEqual(["ok"]);
    });

    it("分片输入下增量上限不会保留超限内容", () => {
        const { framer, lines, oversize } = createFramer(16);
        for (let index = 0; index < 10; index += 1) {
            framer.push("0123456789");
        }
        framer.push("\nnext\n");
        expect(oversize).toHaveBeenCalledOnce();
        expect(lines).toEqual(["next"]);
    });

    it("1 MiB 的正常大帧在 2 MiB 上限内完整交付", () => {
        const { framer, lines, oversize } = createFramer(2 * 1024 * 1024);
        const line = "x".repeat(1024 * 1024);
        framer.push(`${line}\n`);
        expect(lines).toEqual([line]);
        expect(oversize).not.toHaveBeenCalled();
    });

    it("非法上限抛 RangeError", () => {
        expect(() => new LineFramer({ maxLineBytes: 0, onLine: () => {} })).toThrow(RangeError);
        expect(() => new LineFramer({ maxLineBytes: 1.5, onLine: () => {} })).toThrow(RangeError);
    });
});
