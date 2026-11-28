import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareConsoleAssets } from "../../../src/console/entry-assets.js";

let root: string;
let source: string;

function writeAssets(js: string, css: string, timestamp: number): void {
    writeFileSync(join(source, "index.js"), js);
    writeFileSync(join(source, "index.css"), css);
    utimesSync(join(source, "index.js"), timestamp, timestamp);
    utimesSync(join(source, "index.css"), timestamp, timestamp);
}

function readAssets(path: string): string[] {
    return ["index.js", "index.css"].map((name) => readFileSync(join(path, name), "utf8"));
}

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "napuketto-console-test-"));
    source = join(root, "package", "dist");
    mkdirSync(source, { recursive: true });
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

describe("Console 生产产物", () => {
    it("按内容切换并回滚同样大小的旧时间戳文件，旧入口仍可读", () => {
        writeAssets("new-js", "new-css", 300);
        const newest = prepareConsoleAssets(source, root);
        writeAssets("old-js", "old-css", 100);
        const older = prepareConsoleAssets(source, root);
        expect(older).not.toBe(newest);
        expect(readAssets(newest)).toEqual(["new-js", "new-css"]);
        expect(readAssets(older)).toEqual(["old-js", "old-css"]);
        writeAssets("new-js", "new-css", 200);
        expect(prepareConsoleAssets(source, root)).toBe(newest);
    });

    it("缺件时报告文件，保留现有入口", () => {
        writeAssets("js", "css", 100);
        const first = prepareConsoleAssets(source, root);
        rmSync(join(source, "index.css"));
        expect(() => prepareConsoleAssets(source, root)).toThrow("dist/index.css");
        expect(readAssets(first)).toEqual(["js", "css"]);
    });

    it("发布失败时不会创建半成品入口", () => {
        writeAssets("js", "css", 100);
        const occupied = join(root, "data");
        writeFileSync(occupied, "directory expected");
        expect(() => prepareConsoleAssets(source, root)).toThrow();
        expect(existsSync(join(occupied, "napuketto-console"))).toBe(false);
    });

    it("标准 npm 安装复用已校验的 dist", () => {
        source = join(root, "node_modules", "plugin", "dist");
        mkdirSync(source, { recursive: true });
        writeAssets("js", "css", 100);
        expect(prepareConsoleAssets(source, root)).toBe(source);
        rmSync(join(source, "index.js"));
        expect(() => prepareConsoleAssets(source, root)).toThrow("dist/index.js");
    });
});
