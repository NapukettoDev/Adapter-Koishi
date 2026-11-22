import { IpcError } from "../shared/errors.js";

interface AccountOwner {
    readonly currentState: string;
    stop(): Promise<void>;
}

/** 同账号的新驱动只等待已进入停止流程的旧宿主。 */
export class AccountOwnerRegistry {
    private readonly owners = new Map<string, AccountOwner>();

    waitForRelease(dir: string): Promise<void> | undefined {
        const previous = this.owners.get(dir);
        return previous?.currentState === "stopping" ? previous.stop() : undefined;
    }

    claim(dir: string, owner: AccountOwner): void {
        if (this.owners.has(dir)) {
            throw new IpcError(
                `账号数据目录仍由旧宿主使用（${dir}），请先停止旧宿主`,
                "INVALID_STATE",
            );
        }
        this.owners.set(dir, owner);
    }

    release(dir: string | undefined, owner: AccountOwner): void {
        if (dir !== undefined && this.owners.get(dir) === owner) {
            this.owners.delete(dir);
        }
    }
}

export const sharedAccountOwners = new AccountOwnerRegistry();
