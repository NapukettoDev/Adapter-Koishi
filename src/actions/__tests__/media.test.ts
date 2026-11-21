import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import type { CanonicalElement } from "@napuketto/kernel";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareOutboundMedia } from "../media.js";

const { encode, frame, videoInfo, publicDownload, compatibleDownload } = vi.hoisted(() => ({
    encode: vi.fn(),
    frame: vi.fn(),
    videoInfo: vi.fn(),
    publicDownload: vi.fn(),
    compatibleDownload: vi.fn(),
}));
const workspaceCreated = vi.hoisted(() => vi.fn<(path: string) => void>());

vi.mock("node:fs/promises", async (original) => {
    const fs = await original<typeof import("node:fs/promises")>();
    return {
        ...fs,
        async mkdtemp(prefix: string) {
            const path = await fs.mkdtemp(prefix);
            workspaceCreated(path);
            return path;
        },
    };
});

vi.mock("@napuketto/media", async (original) => ({
    ...(await original<typeof import("@napuketto/media")>()),
    encodePcmToSilk: encode,
    extractVideoFrame: frame,
    getVideoInfo: videoInfo,
    downloadPublicUrl: publicDownload,
    downloadUrl: compatibleDownload,
}));

function pathOf(element?: CanonicalElement): string {
    if (element?.type !== "image" && element?.type !== "voice" && element?.type !== "video") {
        throw new Error("媒体元素丢失");
    }
    return element.path;
}

describe("prepareOutboundMedia", () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "napuketto-koishi-media-"));
        vi.resetAllMocks();
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it.each(["#!SILK_V3", "\x02#!SILK_V3"])("已有 SILK %s 保留原路径", async (header) => {
        const silk = join(dir, "voice.silk");
        writeFileSync(silk, header);
        const result = await prepareOutboundMedia([{ type: "voice", path: silk }]);
        expect(pathOf(result.elements[0])).toBe(silk);
        expect(encode).not.toHaveBeenCalled();
        await result.cleanup();
        expect(readFileSync(silk, "utf8")).toBe(header);
    });

    it("并发转换同一源文件各有独占 SILK，清理不覆盖同名文件或源文件", async () => {
        const ogg = join(dir, "voice.ogg");
        const existing = join(dir, "voice.silk");
        writeFileSync(ogg, "OggS");
        writeFileSync(existing, "existing");
        encode.mockImplementation(async (input: string) => {
            expect(input).not.toBe(ogg);
            expect(extname(input)).toBe(".ogg");
            expect(readFileSync(input, "utf8")).toBe("OggS");
            const output = input.replace(/\.ogg$/, ".silk");
            writeFileSync(output, "silk");
            return output;
        });
        const elements: CanonicalElement[] = [{ type: "voice", path: ogg }];
        const [first, second] = await Promise.all([
            prepareOutboundMedia(elements),
            prepareOutboundMedia(elements),
        ]);
        const a = pathOf(first.elements[0]);
        const b = pathOf(second.elements[0]);
        expect(a).not.toBe(b);
        expect(dirname(a)).not.toBe(dir);
        await first.cleanup();
        expect(existsSync(a)).toBe(false);
        expect(readFileSync(b, "utf8")).toBe("silk");
        await second.cleanup();
        expect(existsSync(b)).toBe(false);
        expect(readFileSync(existing, "utf8")).toBe("existing");
        expect(readFileSync(ogg, "utf8")).toBe("OggS");
    });

    it("转码失败回落源文件并在发送结束后清理部分输出", async () => {
        const source = join(dir, "voice.silk");
        writeFileSync(source, "OggS");
        let partial = "";
        encode.mockImplementation(async (input: string) => {
            partial = input.replace(/\.bin$/, ".silk");
            writeFileSync(partial, "partial");
            throw new Error("ffmpeg unavailable");
        });
        const warn = vi.fn();
        const result = await prepareOutboundMedia([{ type: "voice", path: source }], {
            logger: { warn },
        });
        expect(pathOf(result.elements[0])).toBe(source);
        expect(warn).toHaveBeenCalledOnce();
        await result.cleanup();
        expect(existsSync(partial)).toBe(false);
        expect(readFileSync(source, "utf8")).toBe("OggS");
    });

    it("允许白名单外的适配器 data URL 产物并保留二进制字节", async () => {
        videoInfo.mockRejectedValue(new Error("无探测器"));
        const result = await prepareOutboundMedia(
            [
                { type: "image", path: "data:image/jpeg,%FF%D8%FF%00" },
                { type: "video", path: "data:video/mp4;base64,AAAA" },
                { type: "voice", path: "data:audio/silk;base64,AiMhU0lMS19WMw==" },
            ],
            { localFilePolicy: "allowlist" },
        );
        const files = result.elements.map(pathOf);
        expect(files.map((file) => extname(file))).toEqual([".jpg", ".mp4", ".silk"]);
        expect(files.map((file) => readFileSync(file, "hex"))).toEqual([
            "ffd8ff00",
            "000000",
            "02232153494c4b5f5633",
        ]);
        expect(encode).not.toHaveBeenCalled();
        await result.cleanup();
        expect(files.some(existsSync)).toBe(false);
    });

    it("白名单复制期间发现源文件变化时拒绝发送并清理工作目录", async () => {
        const source = join(dir, "changing.png");
        writeFileSync(source, "image");
        let stage = "";
        workspaceCreated.mockImplementationOnce((path) => {
            stage = path;
            writeFileSync(source, "updated image");
        });
        await expect(
            prepareOutboundMedia([{ type: "image", path: source }], {
                localFilePolicy: "allowlist",
                localMediaRoots: [dir],
            }),
        ).rejects.toMatchObject({ code: "INVALID_PARAM" });
        expect(stage).not.toBe("");
        expect(existsSync(stage)).toBe(false);
        expect(readFileSync(source, "utf8")).toBe("updated image");
    });

    it("公网策略只调用上游公网入口，拒绝时不回退兼容下载器", async () => {
        publicDownload
            .mockImplementationOnce(async (_url: string, path: string) => {
                writeFileSync(path, "media");
                return 5;
            })
            .mockRejectedValueOnce(new Error("blocked"));
        const result = await prepareOutboundMedia(
            [
                { type: "image", path: "https://media.example/image.png" },
                { type: "image", path: "https://user:secret@media.example/other.png?token=secret" },
            ],
            { remoteMediaPolicy: "public-only", localFilePolicy: "allowlist" },
        );
        expect(publicDownload).toHaveBeenCalledTimes(2);
        expect(compatibleDownload).not.toHaveBeenCalled();
        expect(readFileSync(pathOf(result.elements[0]), "utf8")).toBe("media");
        expect(result.elements[1]).toEqual({
            type: "text",
            text: "[图片: https://media.example/other.png]",
        });
        await result.cleanup();
    });

    it("本地视频抽帧后保留其他元素并清理缩略图", async () => {
        videoInfo.mockResolvedValue({ width: 640, height: 360, durationMs: 3200 });
        frame.mockImplementation(async (_input: string, output: string) => {
            writeFileSync(output, "png");
            return output;
        });
        const source = join(dir, "a.mp4");
        const text: CanonicalElement = { type: "text", text: "hi" };
        const result = await prepareOutboundMedia([{ type: "video", path: source }, text]);
        const [video, rest] = result.elements;
        expect(video).toMatchObject({
            type: "video",
            path: source,
            width: 640,
            height: 360,
            durationSec: 3,
        });
        expect(rest).toBe(text);
        if (video?.type !== "video" || video.thumbPath === undefined) throw new Error("缺少缩略图");
        expect(readFileSync(video.thumbPath, "utf8")).toBe("png");
        await result.cleanup();
        expect(existsSync(video.thumbPath)).toBe(false);
    });

    it("后续 data URL 无效时清理白名单副本和已经生成的缩略图", async () => {
        const source = join(dir, "a.mp4");
        writeFileSync(source, "video");
        videoInfo.mockResolvedValue({ width: 640, height: 360, durationMs: 3200 });
        let staged = "";
        let thumb = "";
        frame.mockImplementation(async (input: string, output: string) => {
            staged = input;
            thumb = output;
            writeFileSync(output, "png");
        });
        await expect(
            prepareOutboundMedia(
                [
                    { type: "video", path: source },
                    { type: "image", path: "data:audio/ogg;base64,AAAA" },
                ],
                { localFilePolicy: "allowlist", localMediaRoots: [dir] },
            ),
        ).rejects.toThrow("data URL");
        expect(thumb).not.toBe("");
        expect(staged).not.toBe("");
        expect(existsSync(staged)).toBe(false);
        expect(existsSync(dirname(thumb))).toBe(false);
        expect(readFileSync(source, "utf8")).toBe("video");
    });
});
