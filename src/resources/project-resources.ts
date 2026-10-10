import * as vscode from 'vscode';
import * as path from 'path';
import { open } from 'fs/promises';
import { MixUriCodec } from '../mix/fs/mix-uri-codec';
import { MixWorkspaceManager } from '../mix/fs/mix-workspace-manager';
import { ByteCache } from '../media/byte-cache';
import { indexMix, MixResourceEntry } from './mix-resource-index';
import { MixArchive } from '../mix/core/archive';
import { MixGame } from '../mix/core/types';
import { isWithinRoot, resolveProjectRoot } from './project-root';

export interface ResourceCandidate {
    uri: vscode.Uri;
    name: string;
    priority: number;
    source: string;
    role?: 'project' | 'backup' | 'archive';
}

interface ResourceIndex {
    files: Map<string, ResourceCandidate[]>;
    archives: {
        uri: vscode.Uri;
        priority: number;
        entries?: Map<number, MixResourceEntry>;
        game?: MixGame;
        container?: vscode.Uri;
        offset?: number;
    }[];
    count: number;
    errors: string[];
}

/** One project-scoped resource catalog for every preview surface. */
export class ProjectResources implements vscode.Disposable {
    private indexes = new Map<string, Promise<ResourceIndex>>();
    private looseIndexes = new Map<string, Promise<ResourceIndex>>();
    private slices = new Map<string, { container: vscode.Uri; offset: number; size: number }>();
    private lookups = new Map<string, Promise<ResourceCandidate[]>>();
    private bytes = new ByteCache<Uint8Array>(64 * 1024 * 1024);
    private reads = new Map<string, Promise<Uint8Array>>();
    private disposables: vscode.Disposable[] = [];
    private epoch = 0;
    private catalogEpoch = 0;
    private disposed = false;
    private roots = new Map<string, vscode.Uri>();
    private rootCache = new Map<string, vscode.Uri>();
    private projectWatchers = new Map<string, vscode.Disposable[]>();
    private emitter = new vscode.EventEmitter<vscode.Uri | undefined>();
    public readonly onDidChange = this.emitter.event;

    constructor(private readonly mix: MixWorkspaceManager) {
        const watcher = vscode.workspace.createFileSystemWatcher('**/*');
        this.disposables.push(
            watcher,
            watcher.onDidCreate((uri) => this.invalidate(uri)),
            watcher.onDidChange((uri) => this.invalidate(uri, false)),
            watcher.onDidDelete((uri) => this.invalidate(uri)),
            mix.onDidChangeFile(() => this.invalidate()),
            vscode.workspace.onDidChangeWorkspaceFolders(() => {
                this.clearProjectWatchers();
                this.invalidate();
            }),
            vscode.workspace.onDidChangeConfiguration((event) => {
                if (event.affectsConfiguration('ra2-ini-intellisense')) {
                    this.clearProjectWatchers();
                    this.invalidate();
                }
            })
        );
    }

    public projectRoot(uri: vscode.Uri): vscode.Uri {
        const cached = this.rootCache.get(uri.toString());
        if (cached) {
            return cached;
        }
        const physical = uri.scheme === MixUriCodec.scheme ? MixUriCodec.decode(uri).containerUri : uri;
        const known = [...this.roots.values()]
            .filter((root) => isWithinRoot(root, physical))
            .sort((a, b) => b.path.length - a.path.length)[0];
        const folder = vscode.workspace.getWorkspaceFolder(physical)?.uri;
        const configured = vscode.workspace
            .getConfiguration('ra2-ini-intellisense', physical)
            .get<string | null>('validationFolderPath');
        const explicit = configured
            ? /^[a-z][\w+.-]*:\/\//i.test(configured)
                ? vscode.Uri.parse(configured)
                : vscode.Uri.file(configured)
            : undefined;
        const root = resolveProjectRoot(
            physical,
            folder ?? known,
            explicit ? resolveProjectRoot(explicit, explicit) : undefined
        );
        if (!this.roots.has(root.toString())) {
            // A newly discovered nested mod can refine earlier fallback ownership.
            // Keep both roots: revisiting its parent must not discard the child mod.
            this.rootCache.clear();
        }
        this.roots.set(root.toString(), root);
        this.rootCache.set(uri.toString(), root);
        this.watchProject(root);
        return root;
    }

    /** Child-folder workspaces still need updates from sibling resources and archives. */
    private watchProject(root: vscode.Uri): void {
        if (
            this.disposed ||
            root.scheme !== 'file' ||
            this.projectWatchers.has(root.toString()) ||
            vscode.workspace.getWorkspaceFolder(root)
        ) {
            return;
        }
        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '**/*'));
        this.projectWatchers.set(root.toString(), [
            watcher,
            watcher.onDidCreate((uri) => this.invalidate(uri)),
            watcher.onDidChange((uri) => this.invalidate(uri, false)),
            watcher.onDidDelete((uri) => this.invalidate(uri)),
        ]);
    }

    private clearProjectWatchers(): void {
        for (const subscriptions of this.projectWatchers.values()) {
            subscriptions.forEach((subscription) => subscription.dispose());
        }
        this.projectWatchers.clear();
    }

    public contains(origin: vscode.Uri, target: vscode.Uri): boolean {
        const root = this.projectRoot(origin),
            targetRoot = this.projectRoot(target);
        return isWithinRoot(root, targetRoot) && isWithinRoot(targetRoot, root);
    }

    public invalidate(uri?: vscode.Uri, structural = true): void {
        if (uri && uri.scheme === 'file' && /\/(node_modules|\.git|dist|out|\.vscode-test)\//i.test(uri.path)) {
            return;
        }
        if (
            uri &&
            !/\.(ini|map|mpr|yrm|mix|shp|tem|sno|urb|ubn|des|lun|vxl|hva|pal|vpl|idx|bag|wav|ogg|mp3|flac|pcx)$|\/ext[^/]*\.dll$/i.test(
                uri.path
            )
        ) {
            return;
        }
        if (uri && !structural && !/\.mix$|\/ext[^/]*\.dll$/i.test(uri.path)) {
            this.epoch++;
            this.bytes.delete(uri.toString());
            this.reads.delete(uri.toString());
            this.emitter.fire(uri);
            return;
        }
        if (uri && /\.mix$/i.test(uri.path)) {
            this.mix.clearCache(uri);
        }
        this.epoch++;
        this.catalogEpoch++;
        this.roots.clear();
        this.rootCache.clear();
        this.indexes.clear();
        this.looseIndexes.clear();
        this.slices.clear();
        this.lookups.clear();
        this.bytes.clear();
        this.reads.clear();
        this.emitter.fire(uri);
    }

    public async read(uri: vscode.Uri, maxBytes = 64 * 1024 * 1024): Promise<Uint8Array> {
        const key = uri.toString();
        const cached = this.bytes.get(key);
        if (cached) {
            if (cached.length > maxBytes) {
                throw new Error('Resource exceeds the read budget.');
            }
            return cached;
        }
        const slice = this.slices.get(key);
        if (slice) {
            if (slice.size > maxBytes) {
                throw new Error('Resource exceeds the read budget.');
            }
            const epoch = this.epoch;
            const bytes = await this.readRange(uri, 0, slice.size);
            if (epoch === this.epoch) {
                this.bytes.set(key, bytes, bytes.length);
            }
            return bytes;
        }
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > maxBytes) {
            throw new Error('Resource exceeds the read budget.');
        }
        let pending = this.reads.get(key);
        if (!pending) {
            const epoch = this.epoch;
            pending = Promise.resolve(vscode.workspace.fs.readFile(uri))
                .then((bytes) => {
                    if (bytes.length > maxBytes) {
                        throw new Error('Resource exceeds the read budget.');
                    }
                    if (epoch === this.epoch) {
                        this.bytes.set(key, bytes, bytes.length);
                    }
                    return bytes;
                })
                .finally(() => {
                    if (this.reads.get(key) === pending) {
                        this.reads.delete(key);
                    }
                });
            this.reads.set(key, pending);
        }
        const bytes = await pending;
        if (bytes.length > maxBytes) {
            throw new Error('Resource exceeds the read budget.');
        }
        return bytes;
    }

    /** Read only the selected bank sample, including banks larger than the cache budget. */
    public async readRange(uri: vscode.Uri, offset: number, length: number): Promise<Uint8Array> {
        if (
            !Number.isSafeInteger(offset) ||
            !Number.isSafeInteger(length) ||
            offset < 0 ||
            length < 0 ||
            length > 64 * 1024 * 1024
        ) {
            throw new Error('Invalid resource slice.');
        }
        const slice = this.slices.get(uri.toString());
        if (slice) {
            if (offset + length > slice.size) {
                throw new Error('Resource slice exceeds its container.');
            }
            return this.readRange(slice.container, slice.offset + offset, length);
        }
        const stat = await vscode.workspace.fs.stat(uri);
        if (offset + length > stat.size) {
            throw new Error('BAG sample exceeds its container.');
        }
        if (uri.scheme === MixUriCodec.scheme) {
            return this.mix.readFileRange(uri, offset, length);
        }
        if (uri.scheme !== 'file') {
            return (await this.read(uri, Math.max(stat.size, length))).slice(offset, offset + length);
        }
        const file = await open(uri.fsPath, 'r');
        try {
            const bytes = new Uint8Array(length);
            let received = 0;
            while (received < length) {
                const result = await file.read(bytes, received, length - received, offset + received);
                if (!result.bytesRead) {
                    throw new Error('Resource slice is truncated.');
                }
                received += result.bytesRead;
            }
            return bytes;
        } finally {
            await file.close();
        }
    }

    public async find(
        origin: vscode.Uri,
        name: string,
        token?: vscode.CancellationToken
    ): Promise<ResourceCandidate[]> {
        const key = this.projectRoot(origin).toString() + ':' + name.toLowerCase();
        let pending = this.lookups.get(key);
        if (!pending) {
            pending = this.findIndexed(origin, name).catch((error) => {
                this.lookups.delete(key);
                throw error;
            });
            this.lookups.set(key, pending);
        }
        const found = await pending;
        return token?.isCancellationRequested ? [] : [...found];
    }

    private async findIndexed(origin: vscode.Uri, name: string): Promise<ResourceCandidate[]> {
        const index = await this.index(origin);
        const normalized = path.posix.basename(name.replace(/\\/g, '/')).toLowerCase();
        const found = [...(index.files.get(normalized) ?? [])];
        for (const archive of index.archives) {
            try {
                if (archive.entries) {
                    const entry =
                        archive.entries.get(MixArchive.calculateId(normalized, archive.game!)) ??
                        archive.entries.get(
                            MixArchive.calculateId(
                                normalized,
                                archive.game === MixGame.TdRa ? MixGame.Ts : MixGame.TdRa
                            )
                        );
                    if (entry) {
                        const uri = MixUriCodec.toChildUri(
                            archive.uri,
                            entry.name ?? '/0x' + entry.id.toString(16).toUpperCase().padStart(8, '0')
                        );
                        this.slices.set(uri.toString(), {
                            container: archive.container!,
                            offset: archive.offset! + entry.offset,
                            size: entry.size,
                        });
                        found.push({
                            uri,
                            name,
                            priority: archive.priority,
                            source: this.label(origin, uri),
                            role: archive.priority >= 10000 ? 'backup' : 'archive',
                        });
                    }
                    continue;
                }
                const uri = await this.mix.findResource(archive.uri, name);
                if (uri) {
                    found.push({
                        uri,
                        name,
                        priority: archive.priority,
                        source: this.label(origin, uri),
                        role: archive.priority >= 10000 ? 'backup' : 'archive',
                    });
                }
            } catch {
                /* A broken or unsupported archive cannot hide valid loose resources. */
            }
        }
        const unique = new Map(found.map((item) => [item.uri.toString(), item]));
        return [...unique.values()].sort(
            (a, b) => a.priority - b.priority || a.uri.toString().localeCompare(b.uri.toString())
        );
    }

    public async list(origin: vscode.Uri, extensions: string[]): Promise<ResourceCandidate[]> {
        const index = await this.index(origin);
        const result = [...index.files.values()]
            .flat()
            .filter((item) => extensions.includes(path.posix.extname(item.name).toLowerCase()));
        return [...new Map(result.map((item) => [item.uri.toString(), item])).values()].sort(
            (a, b) =>
                a.priority - b.priority ||
                a.name.localeCompare(b.name) ||
                a.uri.toString().localeCompare(b.uri.toString())
        );
    }

    /** INI discovery never waits for archive decoding or opens hundreds of editor documents. */
    public async listDocuments(origin: vscode.Uri): Promise<ResourceCandidate[]> {
        if (this.disposed) {
            throw new vscode.CancellationError();
        }
        const root = this.projectRoot(origin),
            key = root.toString();
        const generation = this.catalogEpoch;
        let pending = this.looseIndexes.get(key);
        if (!pending) {
            pending = this.build(root, false).catch((error) => {
                if (this.looseIndexes.get(key) === pending) {
                    this.looseIndexes.delete(key);
                }
                throw error;
            });
            this.looseIndexes.set(key, pending);
        }
        const index = await pending;
        if (generation !== this.catalogEpoch) {
            return this.listDocuments(origin);
        }
        return [...index.files.values()].flat().filter((item) => /\.ini$/i.test(item.name) && item.role !== 'backup');
    }

    public async warm(origin: vscode.Uri): Promise<void> {
        await this.index(origin);
    }

    public async describeIndex(
        origin: vscode.Uri
    ): Promise<{ root: string; files: number; errors: string[]; archives: { source: string; entries: number }[] }> {
        const index = await this.index(origin);
        return {
            root: this.projectRoot(origin).toString(),
            files: index.files.size,
            errors: index.errors,
            archives: index.archives.map((archive) => ({
                source: this.label(origin, archive.uri),
                entries: archive.entries?.size ?? 0,
            })),
        };
    }

    public label(origin: vscode.Uri, uri: vscode.Uri): string {
        if (uri.scheme === MixUriCodec.scheme) {
            const decoded = MixUriCodec.decode(uri);
            return [this.label(origin, decoded.containerUri), ...decoded.nestedChain, uri.path.replace(/^\//, '')].join(
                ' › '
            );
        }
        const root = this.projectRoot(origin);
        if (root.scheme === 'file' && uri.scheme === 'file' && process.platform === 'win32') {
            return path.relative(root.fsPath, uri.fsPath).replace(/\\/g, '/') || path.basename(uri.fsPath);
        }
        return uri.scheme === root.scheme && uri.authority === root.authority
            ? path.posix.relative(root.path, uri.path) || path.posix.basename(uri.path)
            : uri.toString(true);
    }

    private async index(origin: vscode.Uri): Promise<ResourceIndex> {
        if (this.disposed) {
            throw new vscode.CancellationError();
        }
        const root = this.projectRoot(origin);
        const key = root.toString();
        const generation = this.catalogEpoch;
        let pending = this.indexes.get(key);
        if (!pending) {
            pending = this.build(root).catch((error) => {
                if (this.indexes.get(key) === pending) {
                    this.indexes.delete(key);
                }
                throw error;
            });
            this.indexes.set(key, pending);
        }
        const index = await pending;
        return generation === this.catalogEpoch ? index : this.index(origin);
    }

    private async build(root: vscode.Uri, includeArchives = true): Promise<ResourceIndex> {
        const generation = this.catalogEpoch;
        const result: ResourceIndex = { files: new Map(), archives: [], count: 0, errors: [] };
        const config = vscode.workspace.getConfiguration('ra2-ini-intellisense', root);
        // Root order is explicit. Unknown archive precedence remains a candidate ambiguity.
        const roots = [
            root,
            ...config
                .get<string[]>('media.resourceRoots', [])
                .filter((value) => typeof value === 'string')
                .map((value) =>
                    /^[a-z][\w+.-]*:\/\//i.test(value)
                        ? vscode.Uri.parse(value)
                        : vscode.Uri.file(path.resolve(root.fsPath, value))
                ),
        ];
        const configured = config.get<string[]>('media.archiveOrder', []).filter((value) => typeof value === 'string');
        const excluded = new Set(
            config
                .get<string[]>('media.excludedDirectories', ['.tmp', '.cache', 'Tools'])
                .map((name) => name.toLowerCase())
        );
        const visited = new Set<string>();
        for (let priority = 0; priority < roots.length; priority++) {
            const queue = [{ uri: roots[priority], depth: 0, priority: priority * 1000 }];
            for (
                let cursor = 0;
                cursor < queue.length && result.count < 100000 && generation === this.catalogEpoch;
                cursor++
            ) {
                const current = queue[cursor];
                if (current.depth > 16 || visited.has(current.uri.toString())) {
                    continue;
                }
                visited.add(current.uri.toString());
                if (current.uri.scheme === MixUriCodec.scheme && current.uri.path === '/') {
                    if (!result.archives.some((item) => item.uri.toString() === current.uri.toString())) {
                        result.archives.push({ uri: current.uri, priority: current.priority });
                    }
                }
                let entries: [string, vscode.FileType][];
                try {
                    entries = await vscode.workspace.fs.readDirectory(current.uri);
                } catch {
                    continue;
                }
                for (const [name, type] of entries) {
                    if (result.count >= 100000 || generation !== this.catalogEpoch) {
                        break;
                    }
                    result.count++;
                    const uri = vscode.Uri.joinPath(current.uri, name);
                    if (type & vscode.FileType.Directory) {
                        if (
                            !/^(node_modules|\.git|dist|out|\.vscode-test)$/i.test(name) &&
                            !excluded.has(name.toLowerCase())
                        ) {
                            queue.push({ ...current, uri, depth: current.depth + 1 });
                        }
                    } else if (/\.mix$|^ext[^/]*\.dll$/i.test(name)) {
                        if (!includeArchives) {
                            continue;
                        }
                        const order = configured.findIndex((value) => value.toLowerCase() === name.toLowerCase());
                        const archiveRoot =
                            uri.scheme === MixUriCodec.scheme
                                ? MixUriCodec.toNestedRootUri(uri)
                                : MixUriCodec.toRootUri(uri);
                        const backup = /\/(MixBackup|backup|backups)\//i.test(uri.path);
                        const archivePriority =
                            current.uri.scheme === MixUriCodec.scheme
                                ? current.priority
                                : priority * 1000 + (backup ? 10000 : order < 0 ? 500 : 100 + order);
                        if (uri.scheme === 'file') {
                            try {
                                await this.addArchive(
                                    result,
                                    root,
                                    archiveRoot,
                                    uri,
                                    0,
                                    (await vscode.workspace.fs.stat(uri)).size,
                                    archivePriority,
                                    0,
                                    generation
                                );
                            } catch (error) {
                                result.errors.push(this.label(root, uri) + ': ' + String(error));
                            }
                        } else {
                            result.archives.push({ uri: archiveRoot, priority: archivePriority });
                            queue.push({ uri: archiveRoot, depth: current.depth + 1, priority: archivePriority });
                        }
                    } else {
                        const backup = /\/(MixBackup|backup|backups)\//i.test(uri.path);
                        const entry: ResourceCandidate = {
                            uri,
                            name,
                            priority: current.priority + (backup ? 10000 : 0),
                            source: this.label(root, uri),
                            role: backup ? 'backup' : 'project',
                        };
                        const key = name.toLowerCase();
                        const values = result.files.get(key) ?? [];
                        values.push(entry);
                        result.files.set(key, values);
                    }
                }
            }
        }
        return result;
    }

    private async addArchive(
        result: ResourceIndex,
        origin: vscode.Uri,
        root: vscode.Uri,
        container: vscode.Uri,
        offset: number,
        size: number,
        priority: number,
        depth: number,
        generation: number
    ): Promise<void> {
        if (depth > 8 || result.archives.length >= 512) {
            return;
        }
        try {
            const { entries, game } = await indexMix(
                size,
                (at, length) => this.readRange(container, offset + at, length),
                (type, id) => this.mix.resolveResourceName(type, id)
            );
            if (generation !== this.catalogEpoch) {
                return;
            }
            result.archives.push({ uri: root, priority, entries, game, container, offset });
            for (const entry of entries.values()) {
                if (!entry.name) {
                    continue;
                }
                const uri = MixUriCodec.toChildUri(root, entry.name);
                this.slices.set(uri.toString(), { container, offset: offset + entry.offset, size: entry.size });
                if (/\.mix$/i.test(entry.name)) {
                    await this.addArchive(
                        result,
                        origin,
                        MixUriCodec.toNestedRootUri(uri),
                        container,
                        offset + entry.offset,
                        entry.size,
                        priority + 1,
                        depth + 1,
                        generation
                    );
                } else {
                    const name = path.posix.basename(entry.name),
                        key = name.toLowerCase();
                    const values = result.files.get(key) ?? [];
                    values.push({
                        uri,
                        name,
                        priority,
                        source: this.label(origin, uri),
                        role: priority >= 10000 ? 'backup' : 'archive',
                    });
                    result.files.set(key, values);
                }
            }
        } catch (error) {
            result.errors.push(
                this.label(origin, root) + ': ' + (error instanceof Error ? error.message : String(error))
            );
            console.debug('[ProjectResources] Archive index unavailable', container.toString(), error);
        }
    }

    public dispose(): void {
        this.disposed = true;
        this.clearProjectWatchers();
        this.epoch++;
        this.catalogEpoch++;
        this.roots.clear();
        this.rootCache.clear();
        this.disposables.forEach((item) => item.dispose());
        this.emitter.dispose();
        this.indexes.clear();
        this.looseIndexes.clear();
        this.slices.clear();
        this.lookups.clear();
        this.bytes.clear();
        this.reads.clear();
    }
}
