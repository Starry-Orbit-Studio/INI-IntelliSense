import * as path from 'path';
import { createHash } from 'crypto';
import * as vscode from 'vscode';
import { localize } from '../../i18n';
import { TextContentService } from '../../services/text-content-service';
import { MixArchive } from '../core/archive';
import { GlobalMixDb } from '../core/global-mix-db';
import { MixType, MixGame } from '../core/types';
import { MixUriCodec } from './mix-uri-codec';
import { SafeFileStore } from './safe-file-store';
import { BrowserLocations } from '../browser/locations';
import { backupPolicy } from './backup-policy';

export type MixMutation = { uri: vscode.Uri } & (
    | { kind: 'write'; content: Uint8Array; create: boolean; overwrite: boolean; expected?: string | null }
    | { kind: 'delete'; recursive: boolean; expected?: string }
    | { kind: 'rename'; target: vscode.Uri; overwrite: boolean }
);

export class MixWorkspaceManager {
    private readonly store = new SafeFileStore(backupPolicy);
    private readonly locations = new BrowserLocations(this);
    private readonly changeEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    public readonly onDidChangeFile = this.changeEmitter.event;

    constructor(
        private readonly globalMixDb: GlobalMixDb,
        private readonly textContentService: TextContentService
    ) {}

    public async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
        return this.locations.stat(uri);
    }

    public async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
        return (await this.locations.list(uri)).entries.map((entry) => [
            entry.name,
            entry.directory ? vscode.FileType.Directory : vscode.FileType.File,
        ]);
    }

    public async readFile(uri: vscode.Uri): Promise<Uint8Array> {
        return this.locations.read(uri);
    }

    public async peekFile(uri: vscode.Uri, maxBytes: number): Promise<Uint8Array> {
        const stat = await this.locations.stat(uri);
        return this.locations.readRange(uri, 0, Math.min(stat.size, maxBytes));
    }

    public async readFileRange(uri: vscode.Uri, offset: number, length: number): Promise<Uint8Array> {
        return this.locations.readRange(uri, offset, length);
    }

    /** Known names resolve by their game ID without loading or renaming a cached archive. */
    public async findResource(root: vscode.Uri, name: string): Promise<vscode.Uri | undefined> {
        return this.locations.find(root, name);
    }

    public resolveResourceName(game: import('../core/types').MixGame, id: number): Promise<string | undefined> {
        return this.globalMixDb.getFileName(game, id);
    }

    public async writeFile(
        uri: vscode.Uri,
        content: Uint8Array,
        options: { create: boolean; overwrite: boolean }
    ): Promise<void> {
        await this.mutate([{ kind: 'write', uri, content, ...options }]);
    }

    public async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
        await this.mutate([{ kind: 'rename', uri: oldUri, target: newUri, ...options }]);
    }

    public async delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
        await this.mutate([{ kind: 'delete', uri, ...options }]);
    }

    public async createDirectory(_uri: vscode.Uri): Promise<void> {
        throw new Error(
            localize(
                'mix.error.emptyDirectory',
                'MIX files cannot store empty directories. Import files or create a nested MIX instead.'
            )
        );
    }

    /** All descendants of one physical archive are committed together, from leaves to root. */
    public async mutate(operations: readonly MixMutation[]): Promise<string | undefined> {
        if (!operations.length) {
            return;
        }
        const root = MixUriCodec.decode(operations[0].uri).containerUri;
        if (
            root.scheme !== 'file' ||
            operations.some(
                (operation) => MixUriCodec.decode(operation.uri).containerUri.toString() !== root.toString()
            )
        ) {
            throw new Error(localize('mix.error.batchRoot', 'A MIX transaction must target one local outer archive.'));
        }
        const revision = await this.store.update(root.fsPath, async (original) => {
            const nodes = new Map<
                string,
                { archive: MixArchive; chain: string[]; parent?: MixArchive; path?: string }
            >();
            const outer = await MixArchive.open(original);
            await this.applyGlobalNames(outer);
            nodes.set('[]', { archive: outer, chain: [] });
            const resolve = async (chain: string[]): Promise<MixArchive> => {
                const key = JSON.stringify(chain),
                    cached = nodes.get(key);
                if (cached) {
                    return cached.archive;
                }
                const parent = await resolve(chain.slice(0, -1));
                if (parent.getType() === MixType.RaTsEncrypted) {
                    throw new Error(
                        localize(
                            'mix.error.saveEncryptedUnsupported',
                            'Saving encrypted MIX files is not yet supported.'
                        )
                    );
                }
                const entry = this.findNestedEntryPath(parent, chain.at(-1)!);
                const archive = await parent.openNested(entry);
                await this.applyGlobalNames(archive);
                nodes.set(key, { archive, chain, parent, path: entry });
                return archive;
            };
            for (const operation of operations) {
                const decoded = MixUriCodec.decode(operation.uri),
                    archive = await resolve(decoded.nestedChain);
                const entry = this.resourcePath(archive, decoded.virtualPath);
                if (operation.kind !== 'rename' && operation.expected !== undefined) {
                    const existing = archive.findPathByName(entry);
                    const actual = existing
                        ? createHash('sha256').update(archive.readFile(existing)).digest('hex')
                        : null;
                    if (actual !== operation.expected) {
                        throw new Error(
                            localize(
                                'mix.error.externalChange',
                                'The file changed outside this operation. Refresh and try again.'
                            )
                        );
                    }
                }
                if (operation.kind === 'write') {
                    archive.writeFile(entry, operation.content, operation);
                } else if (operation.kind === 'delete') {
                    archive.delete(entry, operation);
                } else {
                    const target = MixUriCodec.decode(operation.target);
                    if (
                        target.containerUri.toString() !== root.toString() ||
                        JSON.stringify(target.nestedChain) !== JSON.stringify(decoded.nestedChain)
                    ) {
                        throw new Error(
                            localize(
                                'mix.error.crossArchiveRename',
                                'Renaming across different MIX archives is not supported.'
                            )
                        );
                    }
                    archive.rename(entry, target.virtualPath, operation);
                }
            }
            for (const node of [...nodes.values()].sort((a, b) => b.chain.length - a.chain.length)) {
                if (!node.archive.isDirty()) {
                    continue;
                }
                const bytes = node.archive.serialize(),
                    check = await MixArchive.open(bytes);
                if (!check.isWritable()) {
                    throw new Error(localize('mix.error.verifyWrite', 'Written file failed verification.'));
                }
                if (node.parent) {
                    node.parent.writeFile(node.path!, bytes, { create: false, overwrite: true });
                }
            }
            return outer.isDirty() ? outer.serialize() : original;
        });
        this.clearCache(root);
        this.changeEmitter.fire(
            operations.flatMap<vscode.FileChangeEvent>((operation) =>
                operation.kind === 'rename'
                    ? [
                          { uri: operation.uri, type: vscode.FileChangeType.Deleted },
                          { uri: operation.target, type: vscode.FileChangeType.Created },
                      ]
                    : [
                          {
                              uri: operation.uri,
                              type:
                                  operation.kind === 'delete'
                                      ? vscode.FileChangeType.Deleted
                                      : vscode.FileChangeType.Changed,
                          },
                      ]
            )
        );
        return revision;
    }

    public canUndo(uri: vscode.Uri, revision?: string): boolean {
        return this.store.canUndo(
            (uri.scheme === MixUriCodec.scheme ? MixUriCodec.decode(uri).containerUri : uri).fsPath,
            revision
        );
    }
    public async undo(uri: vscode.Uri, revision?: string): Promise<void> {
        const root = uri.scheme === MixUriCodec.scheme ? MixUriCodec.decode(uri).containerUri : uri;
        await this.store.undo(root.fsPath, revision);
        this.clearCache(root);
        this.fireChanged(MixUriCodec.toRootUri(root), vscode.FileChangeType.Changed);
    }

    public watch(uri: vscode.Uri, _options: { recursive: boolean; excludes: readonly string[] }): vscode.Disposable {
        const root = MixUriCodec.decode(uri).containerUri;
        const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(vscode.Uri.file(path.dirname(root.fsPath)), path.basename(root.fsPath))
        );
        const changed = () => {
            this.clearCache(root);
            this.fireChanged(uri, vscode.FileChangeType.Changed);
        };
        const listeners = [watcher.onDidChange(changed), watcher.onDidCreate(changed), watcher.onDidDelete(changed)];
        return new vscode.Disposable(() => {
            listeners.forEach((listener) => listener.dispose());
            watcher.dispose();
        });
    }

    public async openAsWorkspace(
        containerUri: vscode.Uri,
        nestedChain: string[] = [],
        forceNewWindow = false
    ): Promise<void> {
        const rootUri = MixUriCodec.toRootUri(containerUri, nestedChain);
        await vscode.commands.executeCommand('vscode.openFolder', rootUri, forceNewWindow);
    }

    public async flushAll(): Promise<void> {
        // Mutations are committed by mutate; cached archives are never writable drafts.
    }

    public clearCache(_targetUri?: vscode.Uri): void {
        this.locations.clear();
    }

    public getTextContentService(): TextContentService {
        return this.textContentService;
    }

    private resourcePath(archive: MixArchive, virtualPath: string): string {
        try {
            archive.stat(virtualPath);
            return virtualPath;
        } catch {
            return archive.findPathByName(virtualPath) ?? virtualPath;
        }
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
                const resolvedName =
                    (await this.globalMixDb.getFileName(archive.getGame(), id)) ??
                    (archive.getGame() === MixGame.TdRa
                        ? await this.globalMixDb.getFileName(MixGame.Ts, id)
                        : undefined);
                if (!resolvedName) {
                    continue;
                }

                archive.applyDisplayName(id, resolvedName);
            }
        }
    }

    private findNestedEntryPath(archive: MixArchive, segment: string): string {
        const known = archive.findPathByName(segment);
        if (known) {
            return known;
        }
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

    private fireChanged(uri: vscode.Uri, type: vscode.FileChangeType): void {
        this.changeEmitter.fire([{ type, uri }]);
    }
}
