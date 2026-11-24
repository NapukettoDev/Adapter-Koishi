import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CanonicalElement } from "@napuketto/kernel";
import { encodePcmToSilk } from "@napuketto/media";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
    createVoiceEnricher,
    enrichReceiveVoice,
    resolveNtFile,
    resolveQqVoiceFile,
    type VoiceDecodeRequest,
    type VoiceDecoder,
} from "../../../../src/bridge/events/voice-decode.js";

const dirs: string[] = [];

function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), `napuketto-${prefix}-`));
    dirs.push(dir);
    return dir;
}

afterAll(() => {
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

/** 生成最小 WAV（pcm_s16le 单声道 24000Hz，0.1s 静音）。 */
function makeWav(path: string): void {
    const sampleRate = 24000;
    const samples = sampleRate / 10;
    const header = Buffer.alloc(44);
    header.write("RIFF", 0, "ascii");
    header.writeUInt32LE(36 + samples * 2, 4);
    header.write("WAVE", 8, "ascii");
    header.write("fmt ", 12, "ascii");
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36, "ascii");
    header.writeUInt32LE(samples * 2, 40);
    writeFileSync(path, Buffer.concat([header, Buffer.alloc(samples * 2)]));
}

/** 在临时 QQ 根目录里生成一个真实 SILK 文件，返回 { silk, root }。 */
async function makeSilk(name: string): Promise<{ silk: string; root: string }> {
    const root = join(tempDir(`qq-${name}`), "nt_qq", "global");
    const ptt = join(root, "nt_data", "Ptt");
    mkdirSync(ptt, { recursive: true });
    const wav = join(ptt, `${name}.wav`);
    makeWav(wav);
    const silk = await encodePcmToSilk(wav);
    return { silk, root };
}

/** 注入解码器：在独占输出目录写一个可读 WAV。 */
const decodeToWav: VoiceDecoder = async ({ outDir }: VoiceDecodeRequest) => {
    const wavPath = join(outDir, "out.wav");
    makeWav(wavPath);
    return { wavPath };
};

function voice(path: string): CanonicalElement {
    return { type: "voice", path };
}

describe("resolveNtFile", () => {
    it("Linux 和 Windows 调试沙箱使用宿主数据根，普通 Windows 宿主等待实际 QQ 目录", () => {
        const root = tempDir("host-data");
        const file = join(root, "nt_qq", "global", "a.silk");
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, "x");
        const real = realpathSync.native(file);
        try {
            vi.stubEnv("NAPUKETTO_SANDBOX_ROOT", root);
            expect(resolveNtFile("a.silk", root, "win32")).toBe(real);
            vi.stubEnv("NAPUKETTO_SANDBOX_ROOT", undefined);
            expect(resolveNtFile("a.silk", root, "linux")).toBe(real);
            expect(resolveNtFile("a.silk", root, "win32")).toBeNull();
            expect(resolveNtFile(file, root, "win32")).toBeNull();
        } finally {
            vi.unstubAllEnvs();
        }
    });
});

describe("resolveQqVoiceFile", () => {
    it("使用显式的自定义 QQ 目录解析绝对路径和两种相对分隔符", () => {
        const root = join(tempDir("data"), "自定义 QQ 目录", "nt_qq", "global");
        const file = join(root, "nt_data", "Ptt", "a.silk");
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, "x");
        const real = realpathSync.native(file);

        expect(resolveQqVoiceFile(file, root)).toBe(real);
        expect(resolveQqVoiceFile("nt_data/Ptt/a.silk", root)).toBe(real);
        expect(resolveQqVoiceFile("nt_data\\Ptt\\a.silk", root)).toBe(real);
        expect(resolveQqVoiceFile(file)).toBeNull();
    });

    it("拒绝目录外绝对路径、父目录跳转、同前缀兄弟目录和非文件", () => {
        const data = tempDir("boundary");
        const root = join(data, "global");
        const sibling = join(data, "global-other");
        mkdirSync(join(root, "dir"), { recursive: true });
        mkdirSync(sibling);
        const file = join(sibling, "a.silk");
        writeFileSync(file, "x");

        for (const path of [
            file,
            "../global-other/a.silk",
            "..\\global-other\\a.silk",
            "dir",
            "missing",
            "",
        ]) {
            expect(resolveQqVoiceFile(path, root)).toBeNull();
        }
    });

    it("解析目录链接，接收内部目标和可信的根目录别名", () => {
        const data = tempDir("links");
        const root = join(data, "global");
        const ptt = join(root, "Ptt");
        const outside = join(data, "outside");
        const alias = join(data, "QQ 的目录联接");
        mkdirSync(ptt, { recursive: true });
        mkdirSync(outside);
        const file = join(ptt, "a.silk");
        writeFileSync(file, "in");
        writeFileSync(join(outside, "a.silk"), "out");
        const type = process.platform === "win32" ? "junction" : "dir";
        symlinkSync(root, alias, type);
        symlinkSync(ptt, join(root, "inside"), type);
        symlinkSync(outside, join(root, "outside"), type);

        const real = realpathSync.native(file);
        expect(resolveQqVoiceFile("inside/a.silk", alias)).toBe(real);
        expect(resolveQqVoiceFile(join(alias, "Ptt", "a.silk"), alias)).toBe(real);
        expect(resolveQqVoiceFile(file, alias)).toBe(real);
        expect(resolveQqVoiceFile("outside/a.silk", alias)).toBeNull();
        expect(resolveQqVoiceFile(join(root, "outside", "a.silk"), root)).toBeNull();
    });

    it.runIf(process.platform === "linux")("文件符号链接按真实目标判断", () => {
        const root = tempDir("file-links");
        const inside = join(root, "in.silk");
        const outside = join(tempDir("outside-link"), "out.silk");
        writeFileSync(inside, "in");
        writeFileSync(outside, "out");
        symlinkSync(inside, join(root, "inside.silk"));
        symlinkSync(outside, join(root, "outside.silk"));

        expect(resolveQqVoiceFile("inside.silk", root)).toBe(realpathSync.native(inside));
        expect(resolveQqVoiceFile("outside.silk", root)).toBeNull();
    });

    it.runIf(process.platform === "win32")("拒绝依赖当前盘符的路径、ADS 和设备命名空间", () => {
        const root = tempDir("windows-path");
        const file = join(root, "a.silk");
        writeFileSync(file, "x");
        for (const path of [file.slice(2), "C:a.silk", `${file}:stream`, `\\\\?\\${file}`]) {
            expect(resolveQqVoiceFile(path, root)).toBeNull();
        }
    });
});

describe("enrichReceiveVoice", () => {
    it("本地 silk → WAV（RIFF 头 + 落 tmpdir napuketto-voice）", async () => {
        const root = tempDir("silk");
        const dir = join(root, "nt_qq", "global");
        mkdirSync(dir, { recursive: true });
        const wav = join(dir, "in.wav");
        makeWav(wav);
        const silk = await encodePcmToSilk(wav);
        vi.stubEnv("NAPUKETTO_SANDBOX_ROOT", root);
        const out = await enrichReceiveVoice([voice(silk)], root).finally(() => {
            vi.unstubAllEnvs();
        });
        expect(out[0]?.type).toBe("voice");
        const path = (out[0] as { path: string }).path;
        expect(path).not.toBe(silk);
        dirs.push(dirname(path));
        expect(path.toLowerCase().endsWith(".wav")).toBe(true);
        expect(existsSync(path)).toBe(true);
        // RIFF 头校验（WAV）
        expect(readFileSync(path).subarray(0, 4).toString("ascii")).toBe("RIFF");
    });

    it("已确认的 QQ 目录内的相对 silk 路径可解码", async () => {
        const root = tempDir("voice-root");
        const qqGlobalPath = join(root, "nt_qq", "global");
        const ptt = join(qqGlobalPath, "nt_data", "Ptt");
        mkdirSync(ptt, { recursive: true });
        const wav = join(ptt, "relative.wav");
        makeWav(wav);
        await encodePcmToSilk(wav);

        const [element] = await createVoiceEnricher()(
            [voice("nt_data/Ptt/relative.silk")],
            qqGlobalPath,
        );
        expect(element).toMatchObject({ type: "voice", path: expect.stringMatching(/\.wav$/) });
        if (element?.type !== "voice") throw new Error("语音元素丢失");
        dirs.push(dirname(element.path));
        expect(readFileSync(element.path).subarray(0, 4).toString("ascii")).toBe("RIFF");
    });

    it("不允许的文件、无效 silk、http/data 和空路径原样透传", async () => {
        const dir = tempDir("notsilk");
        const file = join(dir, "not.txt");
        writeFileSync(file, "x");
        const wav = join(tempDir("outside"), "voice.wav");
        makeWav(wav);
        const silk = await encodePcmToSilk(wav);
        const input: CanonicalElement[] = [
            voice(file),
            voice(silk),
            voice("https://x/a.silk"),
            voice("data:audio/wav;base64,AA=="),
            voice(""),
            { type: "text", text: "hi" },
        ];
        const out = await createVoiceEnricher()(input, dir);
        expect(out).toEqual(input);
    });

    it("同名语音并发解码各自独占文件，缓存上限与 TTL 给已派发语音留出消费窗口", async () => {
        const sources = await Promise.all(["one", "two", "three"].map((name) => makeSilk(name)));
        const enrich = createVoiceEnricher({
            ttlMs: 250,
            maxCached: 2,
            maxConcurrent: 1,
            decode: decodeToWav,
        });
        const results = await Promise.all(
            sources.map(async ({ silk, root }) => (await enrich([voice(silk)], root))[0]),
        );
        const output = results.map((element) => (element?.type === "voice" ? element.path : ""));
        const decoded = output.filter((path) => !sources.some(({ silk }) => silk === path));
        expect(decoded).toHaveLength(2);
        expect(new Set(decoded).size).toBe(2);
        for (const path of decoded) {
            dirs.push(dirname(path));
            expect(readFileSync(path).subarray(0, 4).toString("ascii")).toBe("RIFF");
        }
        // 上限用尽时第三条原样透传（仍指向原始 SILK）。
        expect(output.filter((path) => sources.some(({ silk }) => silk === path))).toHaveLength(1);

        await vi.waitFor(() => {
            for (const path of decoded) {
                expect(existsSync(dirname(path))).toBe(false);
            }
        });
        expect(sources.every(({ silk }) => existsSync(silk))).toBe(true);

        const third = sources[2];
        if (third === undefined) throw new Error("语音夹具丢失");
        const [next] = await enrich([voice(third.silk)], third.root);
        expect(next).toMatchObject({ type: "voice", path: expect.stringMatching(/\.wav$/) });
        if (next?.type === "voice") dirs.push(dirname(next.path));
    });
});

describe("createVoiceEnricher 调度与清理", () => {
    it("并发解码名额独立于缓存占用，且不超过上限", async () => {
        const sources = await Promise.all(["a", "b", "c", "d", "e"].map((name) => makeSilk(name)));
        let active = 0;
        let peak = 0;
        const decode: VoiceDecoder = async ({ outDir }) => {
            active += 1;
            peak = Math.max(peak, active);
            await new Promise((resolve) => setTimeout(resolve, 10));
            active -= 1;
            makeWav(join(outDir, "out.wav"));
            return { wavPath: join(outDir, "out.wav") };
        };
        const enrich = createVoiceEnricher({ maxConcurrent: 2, decode });
        const results = await Promise.all(
            sources.map(async ({ silk, root }) => (await enrich([voice(silk)], root))[0]),
        );
        expect(peak).toBe(2);
        expect(results.every((element) => element?.type === "voice")).toBe(true);
        expect(enrich.stats()).toMatchObject({ decoding: 0, waiting: 0, cached: 5 });
        for (const element of results) {
            if (element?.type === "voice") dirs.push(dirname(element.path));
        }
    });

    it("等待队列有界：满后新语音原样透传并告警", async () => {
        const sources = await Promise.all(["q1", "q2", "q3"].map((name) => makeSilk(name)));
        const gate = Promise.withResolvers<void>();
        const decode: VoiceDecoder = async ({ outDir }) => {
            await gate.promise;
            makeWav(join(outDir, "out.wav"));
            return { wavPath: join(outDir, "out.wav") };
        };
        const warn = vi.fn();
        const enrich = createVoiceEnricher({
            maxConcurrent: 1,
            maxWaiting: 1,
            maxCached: 8,
            decode,
        });
        const promises = sources.map(
            async ({ silk, root }) => (await enrich([voice(silk)], root, warn))[0],
        );
        await vi.waitFor(() => expect(enrich.stats()).toMatchObject({ decoding: 1, waiting: 1 }));
        gate.resolve();
        const results = await Promise.all(promises);
        const paths = results.map((element) => (element?.type === "voice" ? element.path : ""));
        expect(paths.filter((path) => sources.some(({ silk }) => silk === path))).toHaveLength(1);
        expect(warn).toHaveBeenCalledWith("语音解码队列已满，已回退原始路径");
        for (const path of paths) {
            if (!sources.some(({ silk }) => silk === path)) dirs.push(dirname(path));
        }
    });

    it("超过截止时间时中止解码并回退原始路径", async () => {
        const { silk, root } = await makeSilk("deadline");
        const aborted = vi.fn();
        const decode: VoiceDecoder = async ({ signal }) =>
            new Promise((_resolve, reject) => {
                signal.addEventListener(
                    "abort",
                    () => {
                        aborted();
                        reject(new Error("aborted"));
                    },
                    { once: true },
                );
            });
        const warn = vi.fn();
        const enrich = createVoiceEnricher({ deadlineMs: 40, decode });
        const [element] = await enrich([voice(silk)], root, warn);
        expect(element).toMatchObject({ type: "voice", path: silk });
        expect(aborted).toHaveBeenCalledOnce();
        expect(warn).toHaveBeenCalledWith("语音解码超时，已回退原始路径");
        expect(enrich.stats()).toMatchObject({ decoding: 0, waiting: 0 });
    });

    it("调用方取消时中止解码、清理临时目录且不告警", async () => {
        const { silk, root } = await makeSilk("cancel");
        const controller = new AbortController();
        const started = Promise.withResolvers<void>();
        const aborted = vi.fn();
        const created: string[] = [];
        const decode: VoiceDecoder = async ({ signal }) => {
            started.resolve();
            return new Promise((_resolve, reject) => {
                signal.addEventListener(
                    "abort",
                    () => {
                        aborted();
                        reject(new Error("aborted"));
                    },
                    { once: true },
                );
            });
        };
        const warn = vi.fn();
        const enrich = createVoiceEnricher({
            decode,
            createTempDirectory: async () => {
                const dir = await mkdtemp(join(tmpdir(), "napuketto-voice-"));
                created.push(dir);
                return dir;
            },
        });
        const pending = enrich([voice(silk)], root, warn, controller.signal);
        await started.promise;
        controller.abort();
        const [element] = await pending;
        expect(element).toMatchObject({ type: "voice", path: silk });
        expect(aborted).toHaveBeenCalledOnce();
        expect(warn).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(created.every((dir) => !existsSync(dir))).toBe(true));
        expect(enrich.stats()).toMatchObject({ decoding: 0, waiting: 0, cached: 0 });
    });

    it("解码期间缓存占用仍为 0，完成后才计入缓存", async () => {
        const { silk, root } = await makeSilk("stats");
        const gate = Promise.withResolvers<void>();
        const decode: VoiceDecoder = async ({ outDir }) => {
            await gate.promise;
            makeWav(join(outDir, "out.wav"));
            return { wavPath: join(outDir, "out.wav") };
        };
        const enrich = createVoiceEnricher({ decode });
        const pending = enrich([voice(silk)], root);
        await vi.waitFor(() => expect(enrich.stats().decoding).toBe(1));
        expect(enrich.stats().cached).toBe(0);
        gate.resolve();
        const [element] = await pending;
        expect(element?.type).toBe("voice");
        expect(enrich.stats()).toMatchObject({ decoding: 0, cached: 1 });
        if (element?.type === "voice") dirs.push(dirname(element.path));
    });

    it("完成时缓存已满则清理本次输出并透传", async () => {
        const sources = await Promise.all(["cap1", "cap2"].map((name) => makeSilk(name)));
        const gate = Promise.withResolvers<void>();
        const decode: VoiceDecoder = async ({ outDir }) => {
            await gate.promise;
            makeWav(join(outDir, "out.wav"));
            return { wavPath: join(outDir, "out.wav") };
        };
        const enrich = createVoiceEnricher({ maxCached: 1, maxConcurrent: 2, decode });
        const promises = sources.map(
            async ({ silk, root }) => (await enrich([voice(silk)], root))[0],
        );
        await vi.waitFor(() => expect(enrich.stats().decoding).toBe(2));
        gate.resolve();
        const results = await Promise.all(promises);
        const decoded = results.filter(
            (element) =>
                element?.type === "voice" && !sources.some(({ silk }) => silk === element.path),
        );
        expect(decoded).toHaveLength(1);
        expect(enrich.stats().cached).toBe(1);
        for (const element of decoded) {
            if (element?.type === "voice") dirs.push(dirname(element.path));
        }
    });

    it("清理反复失败：有限重试后释放缓存名额并保留受限残留，新语音仍可解码", async () => {
        const first = await makeSilk("cleanup1");
        const second = await makeSilk("cleanup2");
        let removals = 0;
        const removeDirectory = async () => {
            removals += 1;
            throw new Error("目录仍被占用");
        };
        const warn = vi.fn();
        const enrich = createVoiceEnricher({
            ttlMs: 20,
            cleanupRetries: 2,
            cleanupRetryMs: 10,
            maxResidual: 4,
            decode: decodeToWav,
            removeDirectory,
        });
        const [element] = await enrich([voice(first.silk)], first.root, warn);
        if (element?.type === "voice") dirs.push(dirname(element.path));
        await vi.waitFor(() => expect(enrich.stats().cached).toBe(0));
        // 首次 + 两次重试，重试次数有界。
        expect(removals).toBe(3);
        expect(enrich.stats().residual).toBe(1);
        expect(warn).toHaveBeenCalledWith("入站语音临时目录清理失败，将重试");
        // 名额已释放：后续语音仍能解码，不会永久耗尽。
        const [next] = await enrich([voice(second.silk)], second.root, warn);
        expect(next).toMatchObject({ type: "voice", path: expect.stringMatching(/\.wav$/) });
        if (next?.type === "voice") dirs.push(dirname(next.path));
    });

    it("清理重试成功时释放缓存且不再进入残留", async () => {
        const { silk, root } = await makeSilk("retry-ok");
        let attempts = 0;
        const removeDirectory = async () => {
            attempts += 1;
            if (attempts === 1) {
                throw new Error("暂时占用");
            }
        };
        const warn = vi.fn();
        const enrich = createVoiceEnricher({
            ttlMs: 10,
            cleanupRetries: 2,
            cleanupRetryMs: 10,
            decode: decodeToWav,
            removeDirectory,
        });
        const [element] = await enrich([voice(silk)], root, warn);
        if (element?.type === "voice") dirs.push(dirname(element.path));
        await vi.waitFor(() => expect(enrich.stats().cached).toBe(0));
        expect(enrich.stats().residual).toBe(0);
        expect(attempts).toBe(2);
    });

    it("残留目录达到上限后不再无界累积", async () => {
        const sources = await Promise.all(["res1", "res2"].map((name) => makeSilk(name)));
        const warn = vi.fn();
        const enrich = createVoiceEnricher({
            ttlMs: 10,
            cleanupRetries: 0,
            maxResidual: 1,
            decode: decodeToWav,
            removeDirectory: async () => {
                throw new Error("永远失败");
            },
        });
        for (const { silk, root } of sources) {
            const [element] = await enrich([voice(silk)], root, warn);
            if (element?.type === "voice") dirs.push(dirname(element.path));
            await vi.waitFor(() => expect(enrich.stats().cached).toBe(0));
        }
        expect(enrich.stats().residual).toBe(1);
        expect(warn).toHaveBeenCalledWith("语音临时目录残留已达上限，交由系统临时目录策略清理");
    });
});
