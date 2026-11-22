import { copyFile, open, stat } from "node:fs/promises";
import { extname } from "node:path";
import type { CanonicalElement } from "@napuketto/kernel";
import * as media from "@napuketto/media";
import type { MediaFileFactory, OutboundLogger } from "./acquire.js";

const MAX_AUDIO_INPUT_BYTES = 32 * 1024 * 1024;
const SAFE_EXTENSION = /^\.[a-z0-9]{1,12}$/i;

async function isSilk(path: string): Promise<boolean> {
    const handle = await open(path, "r");
    try {
        const head = Buffer.alloc(7);
        await handle.read(head, 0, head.length, 0);
        return head.toString("ascii", head[0] === 2 ? 1 : 0).startsWith("#!SILK");
    } finally {
        await handle.close();
    }
}

export async function ensureSilk(
    path: string,
    createFile: MediaFileFactory,
    logger?: OutboundLogger,
): Promise<string> {
    try {
        const info = await stat(path);
        if (!info.isFile() || info.size > MAX_AUDIO_INPUT_BYTES || (await isSilk(path))) {
            return path;
        }
        // 0.2.2 将 SILK 写入输入同目录。复制到独占位置，避免覆盖任何调用方文件。
        const suffix = extname(path);
        const input = await createFile(
            SAFE_EXTENSION.test(suffix) && suffix.toLowerCase() !== ".silk" ? suffix : ".bin",
        );
        await copyFile(path, input);
        return await media.encodePcmToSilk(input);
    } catch {
        logger?.warn("语音转码失败，继续使用原文件");
        return path;
    }
}

export async function enrichVideo(
    element: Extract<CanonicalElement, { type: "video" }>,
    createFile: MediaFileFactory,
    logger?: OutboundLogger,
): Promise<Extract<CanonicalElement, { type: "video" }>> {
    try {
        const info = await media.getVideoInfo(element.path);
        const thumbPath = await createFile(".png");
        await media.extractVideoFrame(element.path, thumbPath);
        return {
            ...element,
            thumbPath,
            width: info.width,
            height: info.height,
            durationSec: Math.max(1, Math.round(info.durationMs / 1000)),
        };
    } catch {
        logger?.warn("视频缩略图或元数据生成失败，继续尝试发送");
        return element;
    }
}
