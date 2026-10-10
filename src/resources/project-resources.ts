import * as vscode from 'vscode';
import * as path from 'path';
import { open } from 'fs/promises';
import { MixUriCodec } from '../mix/fs/mix-uri-codec';
import { MixWorkspaceManager } from '../mix/fs/mix-workspace-manager';
import { ByteCache } from '../media/byte-cache';

export interface ResourceCandidate {
    uri: vscode.Uri;
    name: string;
    priority: number;
    source: string;
}

interface ResourceIndex {
    files: Map<string, ResourceCandidate[]>;
    archives: { uri: vscode.Uri; priority: number }[];
    count: number;
}

/** One project-scoped resource catalog for every preview surface. */
export class ProjectResources implements vscode.Disposable {
    private indexes = new Map<string, Promise<ResourceIndex>>();
    private bytes = new ByteCache<Uint8Array>(64 * 1024 * 1024);
    private reads = new Map<string, Promise<Uint8Array>>();
    private disposables: vscode.Disposable[] = [];
    private epoch = 0;
    private emitter = new vscode.EventEmitter<void>();
    public readonly onDidChange = this.emitter.event;

    constructor(private readonly mix: MixWorkspaceManager) {
        const watcher = vscode.workspace.createFileSystemWatcher('**/*');
        this.disposables.push(
            watcher,
            watcher.onDidCreate((uri) => this.invalidate(uri)),
            watcher.onDidChange((uri) => this.invalidate(uri)),
            watcher.onDidDelete((uri) => this.invalidate(uri)),
            mix.onDidChangeFile(() => this.invalidate()),
            vscode.workspace.onDidChangeWorkspaceFolders(() => this.invalidate()),
            vscode.workspace.onDidChangeConfiguration((event) => {
                if (event.affectsConfiguration('ra2-ini-intellisense')) {
                    this.invalidate();
                }
            })
        );
    }

    public projectRoot(uri: vscode.Uri): vscode.Uri {
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        if (folder) {
            return folder.uri;
        }
        if (uri.scheme === MixUriCodec.scheme) {
            const decoded = MixUriCodec.decode(uri);
            return (
                vscode.workspace.getWorkspaceFolder(decoded.containerUri)?.uri ??
                decoded.containerUri.with({ path: path.posix.dirname(decoded.containerUri.path) })
            );
        }
        return uri.with({ path: path.posix.dirname(uri.path) });
    }

    public contains(origin: vscode.Uri, target: vscode.Uri): boolean {
        return this.projectRoot(origin).toString() === this.projectRoot(target).toString();
    }

    public invalidate(uri?: vscode.Uri): void {
        if (uri && uri.scheme === 'file' && /\/(node_modules|\.git|dist|out|\.vscode-test)\//i.test(uri.path)) {
            return;
        }
        if (uri && /\.mix$/i.test(uri.path)) {
            this.mix.clearCache(uri);
        }
        this.epoch++;
        this.indexes.clear();
        this.bytes.clear();
        this.reads.clear();
        this.emitter.fire();
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
        const index = await this.index(origin);
        const normalized = path.posix.basename(name.replace(/\\/g, '/')).toLowerCase();
        const found = [...(index.files.get(normalized) ?? [])];
        for (const archive of index.archives) {
            if (token?.isCancellationRequested) {
                return [];
            }
            try {
                const uri = await this.mix.findResource(archive.uri, name);
                if (uri) {
                    found.push({ uri, name, priority: archive.priority, source: archive.uri.toString() });
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

    private index(origin: vscode.Uri): Promise<ResourceIndex> {
        const root = this.projectRoot(origin);
        const key = root.toString();
        let pending = this.indexes.get(key);
        if (!pending) {
            pending = this.build(root).catch((error) => {
                this.indexes.delete(key);
                throw error;
            });
            this.indexes.set(key, pending);
        }
        return pending;
    }

    private async build(root: vscode.Uri): Promise<ResourceIndex> {
        const result: ResourceIndex = { files: new Map(), archives: [], count: 0 };
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
        const visited = new Set<string>();
        for (let priority = 0; priority < roots.length; priority++) {
            const queue = [{ uri: roots[priority], depth: 0, priority: priority * 1000 }];
            for (let cursor = 0; cursor < queue.length && result.count < 100000; cursor++) {
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
                    result.count++;
                    const uri = vscode.Uri.joinPath(current.uri, name);
                    if (type & vscode.FileType.Directory) {
                        if (!/^(node_modules|\.git|dist|out|\.vscode-test)$/i.test(name)) {
                            queue.push({ ...current, uri, depth: current.depth + 1 });
                        }
                    } else if (/\.mix$/i.test(name)) {
                        const order = configured.findIndex((value) => value.toLowerCase() === name.toLowerCase());
                        const archiveRoot =
                            uri.scheme === MixUriCodec.scheme
                                ? MixUriCodec.toNestedRootUri(uri)
                                : MixUriCodec.toRootUri(uri);
                        const archivePriority =
                            current.uri.scheme === MixUriCodec.scheme
                                ? current.priority
                                : priority * 1000 + (order < 0 ? 500 : 100 + order);
                        result.archives.push({ uri: archiveRoot, priority: archivePriority });
                        // Discover nested archives, bounded by depth and entry count.
                        queue.push({ uri: archiveRoot, depth: current.depth + 1, priority: archivePriority });
                    } else {
                        const entry = { uri, name, priority: current.priority, source: current.uri.toString() };
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

    public dispose(): void {
        this.disposables.forEach((item) => item.dispose());
        this.emitter.dispose();
        this.indexes.clear();
        this.bytes.clear();
        this.reads.clear();
    }
}
