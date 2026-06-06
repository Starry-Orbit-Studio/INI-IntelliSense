import * as path from 'path';
import * as vscode from 'vscode';
import { localize } from '../../i18n';
import { TextContentService } from '../../services/text-content-service';
import { MixArchive } from '../core/archive';
import { GlobalMixDb } from '../core/global-mix-db';
import { MixType } from '../core/types';
import { MixUriCodec } from './mix-uri-codec';

interface MixArchiveHandle {
    archive: MixArchive;
    lastAccess: number;
}

export class MixWorkspaceManager {
    private archiveHandles = new Map<string, MixArchiveHandle>();
    private readonly changeEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    public readonly onDidChangeFile = this.changeEmitter.event;

    constructor(
        private readonly globalMixDb: GlobalMixDb,
        private readonly textContentService: TextContentService
    ) {}

    public async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
        const { archive, virtualPath } = await this.resolveArchive(uri);
        const stat = archive.stat(virtualPath);
        return {
            type: stat.type === 'directory' ? vscode.FileType.Directory : vscode.FileType.File,
            ctime: stat.ctime,
            mtime: stat.mtime,
            size: stat.size,
        };
    }

    public async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
        const { archive, virtualPath } = await this.resolveArchive(uri);
        return archive.listDirectory(virtualPath).map(entry => [
            entry.name,
            entry.type === 'directory' ? vscode.FileType.Directory : vscode.FileType.File,
        ]);
    }

    public async readFile(uri: vscode.Uri): Promise<Uint8Array> {
        const { archive, virtualPath } = await this.resolveArchive(uri);
        return archive.readFile(virtualPath);
    }

    public async peekFile(uri: vscode.Uri, maxBytes: number): Promise<Uint8Array> {
        const { archive, virtualPath } = await this.resolveArchive(uri);
        return archive.peekFile(virtualPath, maxBytes);
    }

    public async writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }): Promise<void> {
        const { archive } = await this.resolveArchive(uri);
        archive.writeFile(MixUriCodec.decode(uri).virtualPath, content, options);
        await this.flushContainer(uri, archive);
        this.fireChanged(uri, vscode.FileChangeType.Changed);
    }

    public async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
        const oldDecoded = MixUriCodec.decode(oldUri);
        const newDecoded = MixUriCodec.decode(newUri);
        if (oldDecoded.containerUri.toString() !== newDecoded.containerUri.toString() || oldDecoded.nestedChain.join('/') !== newDecoded.nestedChain.join('/')) {
            throw new Error(localize('mix.error.crossArchiveRename', 'Renaming across different MIX archives is not supported.'));
        }

        const { archive } = await this.resolveArchive(oldUri);
        archive.rename(oldDecoded.virtualPath, newDecoded.virtualPath, options);
        await this.flushContainer(oldUri, archive);
        this.fireChanged(oldUri, vscode.FileChangeType.Deleted);
        this.fireChanged(newUri, vscode.FileChangeType.Created);
    }

    public async delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
        const { archive } = await this.resolveArchive(uri);
        archive.delete(MixUriCodec.decode(uri).virtualPath, options);
        await this.flushContainer(uri, archive);
        this.fireChanged(uri, vscode.FileChangeType.Deleted);
    }

    public async createDirectory(uri: vscode.Uri): Promise<void> {
        const { archive } = await this.resolveArchive(uri);
        archive.createDirectory(MixUriCodec.decode(uri).virtualPath);
        await this.flushContainer(uri, archive);
        this.fireChanged(uri, vscode.FileChangeType.Created);
    }

    public watch(_uri: vscode.Uri, _options: { recursive: boolean; excludes: readonly string[] }): vscode.Disposable {
        return new vscode.Disposable(() => undefined);
    }

    public async openAsWorkspace(containerUri: vscode.Uri, nestedChain: string[] = [], forceNewWindow = false): Promise<void> {
        const rootUri = MixUriCodec.toRootUri(containerUri, nestedChain);
        await vscode.commands.executeCommand('vscode.openFolder', rootUri, forceNewWindow);
    }

    public async flushAll(): Promise<void> {
        for (const [key, handle] of this.archiveHandles.entries()) {
            const decoded = JSON.parse(key) as { container: string };
            await vscode.workspace.fs.writeFile(vscode.Uri.parse(decoded.container), handle.archive.serialize());
        }
    }

    public getTextContentService(): TextContentService {
        return this.textContentService;
    }

    private async resolveArchive(uri: vscode.Uri): Promise<{ archive: MixArchive; virtualPath: string }> {
        const decoded = MixUriCodec.decode(uri);
        const key = this.getArchiveKey(decoded.containerUri, decoded.nestedChain);
        const existing = this.archiveHandles.get(key);
        if (existing) {
            existing.lastAccess = Date.now();
            return {
                archive: existing.archive,
                virtualPath: decoded.virtualPath,
            };
        }

        const archive = await this.loadArchive(decoded.containerUri, decoded.nestedChain);
        this.archiveHandles.set(key, {
            archive,
            lastAccess: Date.now(),
        });
        return {
            archive,
            virtualPath: decoded.virtualPath,
        };
    }

    private async loadArchive(containerUri: vscode.Uri, nestedChain: string[]): Promise<MixArchive> {
        let bytes = await vscode.workspace.fs.readFile(containerUri);
        let sourceLabel = containerUri.toString();
        let archive = await MixArchive.open(bytes, { sourceLabel });

        for (const segment of nestedChain) {
            const candidatePath = this.findNestedEntryPath(archive, segment);
            const nestedBytes = archive.readFile(candidatePath);
            sourceLabel = `${sourceLabel}:${segment}`;
            archive = await MixArchive.open(nestedBytes, { sourceLabel });
        }

        await this.applyGlobalNames(archive);
        return archive;
    }

    private async applyGlobalNames(archive: MixArchive): Promise<void> {
        if (archive.getType() === MixType.Unknown) {
            return;
        }

        const queue = ['/'];
        while (queue.length > 0) {
            const current = queue.shift()!;
            for (const item of archive.listDirectory(current)) {
                if (item.type === 'directory') {
                    queue.push(item.path);
                    continue;
                }

                const baseName = path.posix.basename(item.path);
                if (!/^0x[0-9A-F]{8}$/i.test(baseName)) {
                    continue;
                }

                const id = Number.parseInt(baseName.slice(2), 16);
                const resolvedName = await this.globalMixDb.getFileName(archive.getGame(), id);
                if (!resolvedName) {
                    continue;
                }

                archive.applyDisplayName(id, resolvedName);
            }
        }
    }

    private findNestedEntryPath(archive: MixArchive, segment: string): string {
        const queue = ['/'];
        while (queue.length > 0) {
            const current = queue.shift()!;
            for (const child of archive.listDirectory(current)) {
                if (child.type === 'directory') {
                    queue.push(child.path);
                    continue;
                }
                if (path.posix.basename(child.path).toLowerCase() === segment.toLowerCase()) {
                    return child.path;
                }
            }
        }

        throw new Error(localize('mix.error.nestedMixNotFound', 'Nested MIX file not found: {0}', segment));
    }

    private async flushContainer(uri: vscode.Uri, archive: MixArchive): Promise<void> {
        const decoded = MixUriCodec.decode(uri);
        if (decoded.nestedChain.length > 0) {
            throw new Error(localize('mix.error.flushNestedUnsupported', 'Saving nested MIX archives is not yet supported.'));
        }
        await vscode.workspace.fs.writeFile(decoded.containerUri, archive.serialize());
    }

    private fireChanged(uri: vscode.Uri, type: vscode.FileChangeType): void {
        this.changeEmitter.fire([{ type, uri }]);
    }

    private getArchiveKey(containerUri: vscode.Uri, nestedChain: string[]): string {
        return JSON.stringify({
            container: containerUri.toString(),
            chain: nestedChain,
        });
    }
}
