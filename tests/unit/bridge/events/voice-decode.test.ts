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
        const out = await enrichReceiveVoice([{ type: "voice", path: silk }], root).finally(() => {
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

        const [voice] = await createVoiceEnricher()(
            [{ type: "voice", path: "nt_data/Ptt/relative.silk" }],
            qqGlobalPath,
        );
        expect(voice).toMatchObject({ type: "voice", path: expect.stringMatching(/\.wav$/) });
        if (voice?.type !== "voice") throw new Error("语音元素丢失");
        dirs.push(dirname(voice.path));
        expect(readFileSync(voice.path).subarray(0, 4).toString("ascii")).toBe("RIFF");
    });

    it("不允许的文件、无效 silk、http/data 和空路径原样透传", async () => {
        const dir = tempDir("notsilk");
        const file = join(dir, "not.txt");
        writeFileSync(file, "x");
        const wav = join(tempDir("outside"), "voice.wav");
        makeWav(wav);
        const silk = await encodePcmToSilk(wav);
        const input: CanonicalElement[] = [
            { type: "voice", path: file },
            { type: "voice", path: silk },
            { type: "voice", path: "https://x/a.silk" },
            { type: "voice", path: "data:audio/wav;base64,AA==" },
            { type: "voice", path: "" },
            { type: "text", text: "hi" },
        ];
        const out = await createVoiceEnricher()(input, dir);
        expect(out).toEqual(input);
    });

    it("同名语音并发解码各自独占文件，容量和 TTL 给已派发语音留出消费窗口", async () => {
        const wavs = ["one", "two", "three"].map((name) => join(tempDir(name), "same.wav"));
        const sources = await Promise.all(
            wavs.map(async (wav) => {
                makeWav(wav);
                return encodePcmToSilk(wav);
            }),
        );
        const enrich = createVoiceEnricher(250, 2);
        const elements = sources.map((path) => ({ type: "voice" as const, path }));
        const results = await Promise.all(
            elements.map(async (el) => (await enrich([el], dirname(el.path)))[0]),
        );
        const output = results.map((el) => (el?.type === "voice" ? el.path : ""));
        const [a = "", b = ""] = output.filter((path) => !sources.includes(path));
        expect(a).not.toBe(b);
        expect(a).toMatch(/\.wav$/);
        expect(b).toMatch(/\.wav$/);
        expect(output.filter((path) => sources.includes(path))).toHaveLength(1);
        for (const path of [a, b]) {
            expect(readFileSync(path).subarray(0, 4).toString("ascii")).toBe("RIFF");
        }
        await vi.waitFor(() => {
            expect(existsSync(dirname(a))).toBe(false);
            expect(existsSync(dirname(b))).toBe(false);
        });
        expect(sources.every(existsSync)).toBe(true);
        const third = elements[2];
        if (third === undefined) throw new Error("语音夹具丢失");
        const [next] = await enrich([third], dirname(third.path));
        expect(next).toMatchObject({ type: "voice", path: expect.stringMatching(/\.wav$/) });
    });
});
