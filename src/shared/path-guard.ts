/** 本地媒体路径不接受 UNC、设备路径、ADS 或 NUL。 */
export function isLocalPath(path: string): boolean {
    const withoutDrive = process.platform === "win32" ? path.replace(/^[a-z]:/i, "") : path;
    return !/^[\\/]{2}/.test(path) && !withoutDrive.includes(":") && !path.includes("\0");
}
