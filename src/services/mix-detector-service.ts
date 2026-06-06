import * as fs from 'fs/promises';
import * as vscode from 'vscode';
import { MixWorkspaceManager } from '../mix/fs/mix-workspace-manager';

const MIX_CHECKSUM = 0x00010000;
const MIX_ENCRYPTED = 0x00020000;

export class MixDetectorService {
    private readonly cache = new Map<string, boolean>();
    private readonly directoryCache = new Map<string, boolean>();

    constructor(private readonly mixWorkspaceManager: MixWorkspaceManager) {}

    public async isMixLike(uri: vscode.Uri): Promise<boolean> {
        const cacheKey = uri.toString();
        const cached = this.cache.get(cacheKey);
        if (cached !== undefined) {
            return cached;
        }

        const result = await this.detect(uri);
        this.cache.set(cacheKey, result);
        return result;
    }

    public clear(uri?: vscode.Uri): void {
        if (!uri) {
            this.cache.clear();
            this.directoryCache.clear();
            return;
        }
        const key = uri.toString();
        this.cache.delete(key);
        this.directoryCache.delete(key);
    }

    public async directoryContainsMix(uri: vscode.Uri): Promise<boolean> {
        const key = uri.toString();
        const cached = this.directoryCache.get(key);
        if (cached !== undefined) {
            return cached;
        }

        const entries = await vscode.workspace.fs.readDirectory(uri);
        const subdirectories: vscode.Uri[] = [];
        for (const [name, type] of entries) {
            const childUri = vscode.Uri.joinPath(uri, name);
            if (type === vscode.FileType.Directory) {
                subdirectories.push(childUri);
                continue;
            }

            if (await this.isMixLike(childUri)) {
                this.directoryCache.set(key, true);
                return true;
            }
        }

        for (const childUri of subdirectories) {
            if (await this.directoryContainsMix(childUri)) {
                this.directoryCache.set(key, true);
                return true;
            }
        }

        this.directoryCache.set(key, false);
        return false;
    }

    private async detect(uri: vscode.Uri): Promise<boolean> {
        try {
            const stat = await vscode.workspace.fs.stat(uri);
            if (!(stat.type & vscode.FileType.File)) {
                return false;
            }

            const header = await this.peekFile(uri, 32);
            return looksLikeMix(header, stat.size);
        } catch {
            return false;
        }
    }

    private async peekFile(uri: vscode.Uri, maxBytes: number): Promise<Uint8Array> {
        if (uri.scheme === 'file') {
            const handle = await fs.open(uri.fsPath, 'r');
            try {
                const buffer = Buffer.alloc(maxBytes);
                const result = await handle.read(buffer, 0, maxBytes, 0);
                return buffer.subarray(0, result.bytesRead);
            } finally {
                await handle.close();
            }
        }

        if (uri.scheme === 'ra2mix') {
            return this.mixWorkspaceManager.peekFile(uri, maxBytes);
        }

        const bytes = await vscode.workspace.fs.readFile(uri);
        return bytes.subarray(0, maxBytes);
    }
}

function looksLikeMix(header: Uint8Array, totalSize: number): boolean {
    if (header.byteLength < 6) {
        return false;
    }

    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);

    if (header.byteLength >= 10) {
        const flags = view.getUint32(0, true);
        const fileCount = view.getInt16(4, true);
        const bodySize = view.getInt32(6, true);
        const hasOnlyKnownFlags = (flags & ~(MIX_CHECKSUM | MIX_ENCRYPTED)) === 0;
        if (hasOnlyKnownFlags && fileCount > 0 && fileCount < 20000) {
            const indexSize = 10 + fileCount * 12 + bodySize;
            if ((flags & MIX_ENCRYPTED) !== 0) {
                return totalSize >= 92;
            }
            if (bodySize >= 0 && totalSize >= indexSize) {
                return true;
            }
            if ((flags & MIX_CHECKSUM) !== 0 && bodySize >= 0 && totalSize >= indexSize + 20) {
                return true;
            }
        }
    }

    const tdFileCount = view.getInt16(0, true);
    const tdBodySize = view.getInt32(2, true);
    if (tdFileCount > 0 && tdFileCount < 20000 && tdBodySize >= 0) {
        return totalSize >= 6 + tdFileCount * 12 + tdBodySize;
    }

    return false;
}
