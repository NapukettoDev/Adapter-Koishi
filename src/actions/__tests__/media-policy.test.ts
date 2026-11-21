import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAllowedMedia } from "../media-policy.js";

describe("本地媒体目录白名单", () => {
    let dir: string;
    let root: string;
    let sibling: string;
    let trusted: string;
    let secret: string;

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
        const canonical = (await realpath(trusted)).split(sep).join("/");
        await expect(resolveAllowedMedia(trusted, [root])).resolves.toBe(canonical);
        const relativePath = relative(process.cwd(), trusted);
        await expect(resolveAllowedMedia(relativePath, [root])).resolves.toBe(canonical);
        await expect(resolveAllowedMedia(secret, [root])).rejects.toMatchObject({
            code: "INVALID_PARAM",
        });
        const traversal = `${root}${sep}..${sep}media-other${sep}outside.png`;
        await expect(resolveAllowedMedia(traversal, [root])).rejects.toMatchObject({
            code: "INVALID_PARAM",
        });
    });

    it("检测 symlink 或 junction 的实际目标", async () => {
        const link = join(root, "outbound-link");
        await symlink(sibling, link, process.platform === "win32" ? "junction" : "dir");
        await expect(resolveAllowedMedia(join(link, "outside.png"), [root])).rejects.toMatchObject({
            code: "INVALID_PARAM",
        });
        const trustedLink = join(dir, "trusted-link");
        await symlink(root, trustedLink, process.platform === "win32" ? "junction" : "dir");
        await expect(resolveAllowedMedia(join(trustedLink, "allowed.png"), [root])).resolves.toBe(
            (await realpath(trusted)).split(sep).join("/"),
        );
    });

    it("空白名单、目录、UNC、设备路径与 ADS 均被拒绝", async () => {
        await expect(resolveAllowedMedia(trusted, [])).rejects.toMatchObject({
            code: "INVALID_PARAM",
        });
        for (const path of [root, "//server/share/file", "//?/C:/file", `${trusted}:alternate`]) {
            await expect(resolveAllowedMedia(path, [root])).rejects.toMatchObject({
                code: "INVALID_PARAM",
            });
        }
    });
});
