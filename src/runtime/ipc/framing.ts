/**
 * framing.ts：JSON 行协议的增量字节分帧。
 *
 * Node 的 readline 会为一个没有换行的超长行持续累积内存。这里按字节块消费
 * stdout，在行完成前就实施上限：超过上限的物理行整行丢弃，并继续扫描到下一个
 * 换行，从而保证后续有效行仍可送达。UTF-8 多字节字符可能被拆在两个 chunk
 * 之间，因此只在收到完整行后统一解码。
 */

/** 分帧器选项。 */
export interface LineFramerOptions {
    /** 单行 UTF-8 字节上限（不含行尾 LF）。 */
    maxLineBytes: number;
    /** 收到完整行（已去掉行尾 LF/CR）。 */
    onLine: (line: string) => void;
    /** 超限行被丢弃时通知一次。 */
    onOversize?: (limitBytes: number) => void;
}

/** 有界增量 JSON 行分帧器。 */
export class LineFramer {
    private readonly maxLineBytes: number;
    private chunks: Buffer[] = [];
    private size = 0;
    private discarding = false;

    constructor(private readonly options: LineFramerOptions) {
        if (!Number.isSafeInteger(options.maxLineBytes) || options.maxLineBytes <= 0) {
            throw new RangeError("maxLineBytes 必须是正整数");
        }
        this.maxLineBytes = options.maxLineBytes;
    }

    /** 消费一块 stdout 数据。 */
    push(chunk: Buffer | Uint8Array | string): void {
        const data = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
        let offset = 0;
        while (offset < data.length) {
            const newline = data.indexOf(0x0a, offset);
            const end = newline === -1 ? data.length : newline;
            if (this.discarding) {
                if (newline === -1) {
                    return;
                }
                this.discarding = false;
                offset = newline + 1;
                continue;
            }
            const segment = data.subarray(offset, end);
            if (this.size + segment.length > this.maxLineBytes) {
                // 丢弃已缓冲的前缀，并跳过本行剩余内容直到换行；不保留超限数据。
                this.chunks = [];
                this.size = 0;
                this.discarding = true;
                this.options.onOversize?.(this.maxLineBytes);
                if (newline === -1) {
                    return;
                }
                this.discarding = false;
                offset = newline + 1;
                continue;
            }
            if (segment.length > 0) {
                this.chunks.push(Buffer.from(segment));
                this.size += segment.length;
            }
            if (newline === -1) {
                return;
            }
            this.emitLine();
            offset = newline + 1;
        }
    }

    /** 数据源结束：输出最后一个没有换行结尾的行。 */
    end(): void {
        if (this.discarding) {
            this.reset();
            return;
        }
        if (this.size > 0) {
            this.emitLine();
        }
    }

    /** 丢弃未完成的行与丢弃状态。 */
    reset(): void {
        this.chunks = [];
        this.size = 0;
        this.discarding = false;
    }

    private emitLine(): void {
        const buffer = Buffer.concat(this.chunks, this.size);
        this.chunks = [];
        this.size = 0;
        let line = buffer.toString("utf8");
        if (line.endsWith("\r")) {
            line = line.slice(0, -1);
        }
        this.options.onLine(line);
    }
}
