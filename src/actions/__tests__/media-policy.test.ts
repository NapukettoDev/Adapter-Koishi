import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stageAllowedMedia } from "../media-policy.js";

describe("本地媒体目录白名单", () => {
    let dir: string;
    let root: string;
    let sibling: string;
    let trusted: string;
    let secret: string;

    async function stage(path: string, roots: string[] = [root], maxBytes = 10): Promise<string> {
        return stageAllowedMedia(path, roots, maxBytes, async () => {
            const workspace = await mkdtemp(join(dir, "staged-"));
            return join(workspace, "image.png");
        });
    }

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), "napuketto-media-policy-"));
        root = join(dir, "media");
        sibling = join(dir, "media-other");
        await mkdir(root);
        await mkdir(sibling);
        trusted = join(root, "allowed.png");
        secret = join(sibling, "outside.png");
        await writeFile(trusted, "trusted");
        await writeFile(secret, "outside");
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it("按实际路径和目录分段判断，允许受信任文件与相对路径", async () => {
        for (const path of [trusted, relative(process.cwd(), trusted)]) {
            const staged = await stage(path);
            expect(staged).not.toBe(trusted);
            await expect(readFile(staged, "utf8")).resolves.toBe("trusted");
        }
        await expect(stage(secret)).rejects.toMatchObject({ code: "INVALID_PARAM" });
        const traversal = `${root}${sep}..${sep}media-other${sep}outside.png`;
        await expect(stage(traversal)).rejects.toMatchObject({ code: "INVALID_PARAM" });
    });

    it("检测 symlink 或 junction 的实际目标", async () => {
        const link = join(root, "outbound-link");
        await symlink(sibling, link, process.platform === "win32" ? "junction" : "dir");
        await expect(stage(join(link, "outside.png"))).rejects.toMatchObject({
            code: "INVALID_PARAM",
        });
        const trustedLink = join(dir, "trusted-link");
        await symlink(root, trustedLink, process.platform === "win32" ? "junction" : "dir");
        const staged = await stage(join(trustedLink, "allowed.png"));
        await expect(readFile(staged, "utf8")).resolves.toBe("trusted");
    });

    it("空白名单、目录、UNC、设备路径与 ADS 均被拒绝", async () => {
        await expect(stage(trusted, [])).rejects.toMatchObject({ code: "INVALID_PARAM" });
        for (const path of [root, "//server/share/file", "//?/C:/file", `${trusted}:alternate`]) {
            await expect(stage(path)).rejects.toMatchObject({ code: "INVALID_PARAM" });
        }
    });

    it("拒绝多硬链接和超限文件，允许恰好等于限额的文件", async () => {
        const hardlink = join(root, "hardlink.png");
        await link(secret, hardlink);
        await expect(stage(hardlink)).rejects.toMatchObject({ code: "INVALID_PARAM" });
        await expect(stage(trusted, [root], 6)).rejects.toMatchObject({ code: "INVALID_PARAM" });
        const staged = await stage(trusted, [root], 7);
        await expect(readFile(staged, "utf8")).resolves.toBe("trusted");
    });
});
