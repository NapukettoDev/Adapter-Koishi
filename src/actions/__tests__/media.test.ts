/**
 * media.test.ts：ensureSilk / ensureVoiceSilk 单测（mock @napuketto/media）。
 *
 * 锁定语音归一化的三条路径（design.md §5.10）：
 * - 已是 silk（#!SILK 头）→ 原样返回（不触发转码）
 * - 非 silk → encodePcmToSilk 转码返回新路径
 * - 转码失败 → 回落原路径（kernel 发送兜底，不阻断）
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    enrichVideoElements,
    ensureSilk,
    ensureVoiceSilk,
    materializeDataUrlImages,
    materializeDataUrlVideos,
} from "../media.js";

const { encodePcmToSilkMock, extractVideoFrameMock, getVideoInfoMock } = vi.hoisted(() => ({
    encodePcmToSilkMock: vi.fn(),
    extractVideoFrameMock: vi.fn(),
    getVideoInfoMock: vi.fn(),
}));
vi.mock("@napuketto/media", () => ({
    encodePcmToSilk: encodePcmToSilkMock,
    extractVideoFrame: extractVideoFrameMock,
    getVideoInfo: getVideoInfoMock,
}));

describe("ensureSilk", () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "napuketto-koishi-media-"));
        encodePcmToSilkMock.mockReset();
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it("已是 silk（#!SILK 头）→ 原样返回（不转码）", async () => {
        const silk = join(dir, "voice.silk");
        writeFileSync(silk, Buffer.concat([Buffer.from("#!SILK_V3"), Buffer.alloc(16)]));

        await expect(ensureSilk(silk)).resolves.toBe(silk);
        expect(encodePcmToSilkMock).not.toHaveBeenCalled();
    });

    it("非 silk（ogg）→ encodePcmToSilk 转码返回新路径", async () => {
        const ogg = join(dir, "voice.ogg");
        writeFileSync(ogg, Buffer.from("OggS........"));
        encodePcmToSilkMock.mockResolvedValue(join(dir, "voice.silk"));

        await expect(ensureSilk(ogg)).resolves.toBe(join(dir, "voice.silk"));
        expect(encodePcmToSilkMock).toHaveBeenCalledWith(ogg);
    });

    it("转码失败 → 回落原路径（不阻断发送）", async () => {
        const ogg = join(dir, "voice.ogg");
        writeFileSync(ogg, Buffer.from("OggS........"));
        encodePcmToSilkMock.mockRejectedValue(new Error("ffmpeg 不可用"));

        await expect(ensureSilk(ogg)).resolves.toBe(ogg);
    });

    it("ensureVoiceSilk：voice 元素转码，其他元素原样", async () => {
        const ogg = join(dir, "voice.ogg");
        writeFileSync(ogg, Buffer.from("OggS........"));
        encodePcmToSilkMock.mockResolvedValue(join(dir, "voice.silk"));

        const out = await ensureVoiceSilk([
            { type: "text", text: "hi" },
            { type: "voice", path: ogg },
        ]);

        expect(out[0]).toEqual({ type: "text", text: "hi" });
        expect(out[1]).toEqual({ type: "voice", path: join(dir, "voice.silk") });
    });
});

describe("materializeDataUrlImages", () => {
    it("将 Base64 图片 data URL 写入临时文件并在清理后删除", async () => {
        const source = "data:image/jpeg;base64,/9j/AA==";
        const materialized = await materializeDataUrlImages([{ type: "image", path: source }]);
        const path = (materialized.elements[0] as { path: string }).path;

        expect(path).not.toBe(source);
        expect(path).toMatch(/\.jpg$/);
        expect(readFileSync(path)).toEqual(Buffer.from([0xff, 0xd8, 0xff, 0x00]));

        await materialized.cleanup();
        expect(() => readFileSync(path)).toThrow();
    });
});

describe("materializeDataUrlVideos", () => {
    it("将 Base64 视频 data URL 写入 .mp4 临时文件并在清理后删除", async () => {
        const source = "data:video/mp4;base64,AAAA";
        const materialized = await materializeDataUrlVideos([{ type: "video", path: source }]);
        const path = (materialized.elements[0] as { path: string }).path;

        expect(path).not.toBe(source);
        expect(path).toMatch(/\.mp4$/);
        expect(readFileSync(path)).toEqual(Buffer.from([0, 0, 0]));

        await materialized.cleanup();
        expect(() => readFileSync(path)).toThrow();
    });

    it("非视频 data URL 元素原样返回（不触发落盘）", async () => {
        const image = { type: "image" as const, path: "data:image/png;base64,AA==" };
        const materialized = await materializeDataUrlVideos([image]);
        expect(materialized.elements[0]).toEqual(image);
    });
});

describe("enrichVideoElements", () => {
    it("本地视频 → 抽帧 + 宽高/时长填入 canonical video", async () => {
        getVideoInfoMock.mockResolvedValue({ width: 640, height: 360, durationMs: 3200 });
        extractVideoFrameMock.mockImplementation(async (_input: string, output: string) => {
            writeFileSync(output, "png");
            return output;
        });

        const enriched = await enrichVideoElements([
            { type: "video", path: "C:/tmp/a.mp4" },
            { type: "text", text: "hi" },
        ]);
        const video = enriched.elements[0] as {
            thumbPath?: string;
            width?: number;
            height?: number;
            durationSec?: number;
        };

        expect(video.width).toBe(640);
        expect(video.height).toBe(360);
        expect(video.durationSec).toBe(3);
        expect(video.thumbPath).toMatch(/\.png$/);
        expect(readFileSync(video.thumbPath as string).toString()).toBe("png");
        expect(enriched.elements[1]).toEqual({ type: "text", text: "hi" });

        const thumbPath = video.thumbPath as string;
        await enriched.cleanup();
        expect(() => readFileSync(thumbPath)).toThrow();
    });

    it("抽帧失败 → 降级为无缩略图并打 warn（不抛错）", async () => {
        getVideoInfoMock.mockResolvedValue({ width: 640, height: 360, durationMs: 1000 });
        extractVideoFrameMock.mockRejectedValue(new Error("ffmpeg 不可用"));
        const warn = vi.fn();

        const enriched = await enrichVideoElements([{ type: "video", path: "C:/tmp/b.mp4" }], {
            logger: { warn },
        });

        expect(enriched.elements[0]).toEqual({ type: "video", path: "C:/tmp/b.mp4" });
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]?.[0]).toContain("视频缩略图");
        await enriched.cleanup();
    });
});
