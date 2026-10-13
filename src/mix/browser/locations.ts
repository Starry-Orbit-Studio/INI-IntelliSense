import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
import { MixWorkspaceManager } from '../fs/mix-workspace-manager';
import { MixUriCodec } from '../fs/mix-uri-codec';
import { MixArchive } from '../core/archive';
import { indexMix, MixResourceEntry } from '../../resources/mix-resource-index';
import { MixGame } from '../core/types';
import { localize } from '../../i18n';

interface Slice {
    container: vscode.Uri;
    offset: number;
    size: number;
    read(offset: number, length: number): Promise<Uint8Array>;
}
export interface BrowserEntry {
    uri: vscode.Uri;
    name: string;
    size: number;
    directory: boolean;
    archive: boolean;
    id?: number;
}
export interface BrowserListing {
    uri: vscode.Uri;
    entries: BrowserEntry[];
    readonly: boolean;
    game?: MixGame;
}

/** Metadata-only navigation: listing a large or nested pack never copies its payload. */
export class BrowserLocations {
    private readonly textVersions = new Map<string, { hash: string; mtime: number }>();
    private indexes = new Map<
        string,
        Promise<{
            slice: Slice;
            entries: Map<number, MixResourceEntry>;
            game: MixGame;
            databaseId?: number;
            readonly: boolean;
            paths: Map<string, MixResourceEntry>;
        }>
    >();
    constructor(private readonly mix: MixWorkspaceManager) {}
    public clear(): void {
        this.indexes.clear();
    }
    public async game(uri: vscode.Uri): Promise<MixGame> {
        return (await this.index(uri)).game;
    }

    private async physical(uri: vscode.Uri): Promise<Slice> {
        const stat = await vscode.workspace.fs.stat(uri);
        if (uri.scheme !== 'file') {
            throw new Error(localize('mix.browser.localOnly', 'Archive operations require local files.'));
        }
        return {
            container: uri,
            offset: 0,
            size: stat.size,
            read: async (offset, length) => {
                if (offset < 0 || length < 0 || offset + length > stat.size) {
                    throw new Error('Invalid archive range.');
                }
                const handle = await fs.open(uri.fsPath, 'r');
                try {
                    const bytes = Buffer.alloc(length);
                    let done = 0;
                    while (done < length) {
                        const result = await handle.read(bytes, done, length - done, offset + done);
                        if (!result.bytesRead) {
                            throw new Error('Truncated archive.');
                        }
                        done += result.bytesRead;
                    }
                    return bytes;
                } finally {
                    await handle.close();
                }
            },
        };
    }

    private async index(uri: vscode.Uri) {
        const decoded = MixUriCodec.decode(uri),
            stat = await vscode.workspace.fs.stat(decoded.containerUri);
        const key = JSON.stringify([decoded.containerUri.toString(), decoded.nestedChain, stat.size, stat.mtime]);
        let pending = this.indexes.get(key);
        if (!pending) {
            pending = (async () => {
                let slice = await this.physical(decoded.containerUri),
                    readonly = false;
                for (let depth = 0; depth <= decoded.nestedChain.length; depth++) {
                    const prefix = await slice.read(0, Math.min(slice.size, 10)),
                        view = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength);
                    readonly ||=
                        prefix.length >= 4 &&
                        (view.getUint32(0, true) & 0xffff) === 0 &&
                        !!(view.getUint32(0, true) & 0x20000);
                    const result = await indexMix(
                        slice.size,
                        slice.read,
                        (game, id) => this.mix.resolveResourceName(game, id),
                        true
                    );
                    if (depth === decoded.nestedChain.length) {
                        return {
                            ...result,
                            slice,
                            readonly,
                            paths: new Map(
                                [...result.entries.values()]
                                    .filter((entry) => entry.name)
                                    .map((entry) => [entry.name!.replace(/\\/g, '/').toLowerCase(), entry])
                            ),
                        };
                    }
                    const name = decoded.nestedChain[depth].replace(/\\/g, '/').replace(/^\//, '');
                    const entry =
                        [...result.entries.values()].find(
                            (entry) => entry.name?.replace(/\\/g, '/').toLowerCase() === name.toLowerCase()
                        ) ??
                        result.entries.get(
                            /^0x[0-9a-f]{8}$/i.test(name)
                                ? parseInt(name.slice(2), 16)
                                : MixArchive.calculateId(name, result.game)
                        );
                    if (!entry) {
                        throw new Error(
                            localize('mix.error.nestedMixNotFound', 'Nested MIX file not found: {0}', name)
                        );
                    }
                    const parent = slice;
                    slice = {
                        container: parent.container,
                        offset: parent.offset + entry.offset,
                        size: entry.size,
                        read: (offset, length) => parent.read(entry.offset + offset, length),
                    };
                }
                throw new Error('Invalid archive chain.');
            })();
            this.indexes.set(key, pending);
            pending.catch(() => {
                this.indexes.delete(key);
            });
            if (this.indexes.size > 64) {
                this.indexes.delete(this.indexes.keys().next().value!);
            }
        }
        return pending;
    }

    public async find(root: vscode.Uri, name: string): Promise<vscode.Uri | undefined> {
        const indexed = await this.index(root),
            normalized = name.replace(/\\/g, '/').replace(/^\//, '');
        const entry =
            indexed.paths.get(normalized.toLowerCase()) ??
            indexed.entries.get(MixArchive.calculateId(normalized.replace(/\//g, '\\'), indexed.game)) ??
            indexed.entries.get(
                MixArchive.calculateId(
                    normalized.replace(/\//g, '\\'),
                    indexed.game === MixGame.TdRa ? MixGame.Ts : MixGame.TdRa
                )
            );
        return entry
            ? MixUriCodec.toChildUri(root, entry.name ?? '0x' + entry.id.toString(16).toUpperCase().padStart(8, '0'))
            : undefined;
    }

    public async resourceRange(
        uri: vscode.Uri
    ): Promise<{ container: vscode.Uri; offset: number; size: number } | undefined> {
        if (uri.scheme !== MixUriCodec.scheme) {
            return undefined;
        }
        const indexed = await this.index(uri),
            name = MixUriCodec.decode(uri).virtualPath.slice(1);
        const entry =
            indexed.paths.get(name.toLowerCase()) ??
            indexed.entries.get(
                /^0x[0-9a-f]{8}$/i.test(name)
                    ? parseInt(name.slice(2), 16)
                    : MixArchive.calculateId(name.replace(/\//g, '\\'), indexed.game)
            );
        return entry
            ? { container: indexed.slice.container, offset: indexed.slice.offset + entry.offset, size: entry.size }
            : undefined;
    }

    public async read(uri: vscode.Uri): Promise<Uint8Array> {
        if (uri.scheme !== MixUriCodec.scheme) {
            return vscode.workspace.fs.readFile(uri);
        }
        const indexed = await this.index(uri),
            name = MixUriCodec.decode(uri).virtualPath.slice(1);
        const entry =
            indexed.paths.get(name.toLowerCase()) ??
            indexed.entries.get(
                /^0x[0-9a-f]{8}$/i.test(name)
                    ? parseInt(name.slice(2), 16)
                    : MixArchive.calculateId(name.replace(/\//g, '\\'), indexed.game)
            );
        if (!entry) {
            throw new Error(localize('mix.error.fileNotFound', 'File not found: {0}', name));
        }
        return indexed.slice.read(entry.offset, entry.size);
    }

    public async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
        if (uri.scheme !== MixUriCodec.scheme) {
            return vscode.workspace.fs.stat(uri);
        }
        const range = await this.resourceRange(uri),
            outer = await vscode.workspace.fs.stat(MixUriCodec.decode(uri).containerUri);
        if (range) {
            let mtime = outer.mtime;
            if (/\.(ini|map|mpr|yrm|llf)$/i.test(uri.path) && range.size <= 8 * 1024 * 1024) {
                // MIX has no member timestamps. Other members changing must not make an unchanged open INI conflict.
                const key = uri.toString(),
                    fingerprint = createHash('sha256')
                        .update(await this.read(uri))
                        .digest('hex'),
                    previous = this.textVersions.get(key);
                mtime = previous?.hash === fingerprint ? previous.mtime : Math.max(mtime, (previous?.mtime ?? 0) + 1);
                this.textVersions.set(key, { hash: fingerprint, mtime });
                if (this.textVersions.size > 256) {
                    this.textVersions.delete(this.textVersions.keys().next().value!);
                }
            }
            return {
                ...outer,
                mtime,
                size: range.size,
                type: vscode.FileType.File,
                permissions: (await this.index(uri)).readonly ? vscode.FilePermission.Readonly : undefined,
            };
        }
        if (uri.path === '/' || (await this.list(uri)).entries.length) {
            return {
                ...outer,
                size: 0,
                type: vscode.FileType.Directory,
                permissions: (await this.index(uri)).readonly ? vscode.FilePermission.Readonly : undefined,
            };
        }
        throw vscode.FileSystemError.FileNotFound(uri);
    }

    public async readRange(uri: vscode.Uri, offset: number, length: number): Promise<Uint8Array> {
        if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0) {
            throw new Error('Invalid archive range.');
        }
        const range = await this.resourceRange(uri);
        if (range) {
            if (offset + length > range.size) {
                throw new Error('Invalid archive range.');
            }
            const slice = await this.physical(range.container);
            return slice.read(range.offset + offset, length);
        }
        return (await this.physical(uri)).read(offset, length);
    }

    public async list(uri: vscode.Uri): Promise<BrowserListing> {
        if (uri.scheme !== MixUriCodec.scheme) {
            const entries: BrowserEntry[] = [];
            for (const [name, type] of await vscode.workspace.fs.readDirectory(uri)) {
                if (
                    /\.ra2-(?:backup-|workbench\.lock)|\.ra2-.*\.tmp$/.test(name) ||
                    type & vscode.FileType.SymbolicLink
                ) {
                    continue;
                }
                const child = vscode.Uri.joinPath(uri, name),
                    stat = await vscode.workspace.fs.stat(child),
                    directory = !!(type & vscode.FileType.Directory);
                entries.push({ uri: child, name, size: stat.size, directory, archive: false });
            }
            return { uri, entries, readonly: uri.scheme !== 'file' };
        }
        const indexed = await this.index(uri),
            prefix = MixUriCodec.decode(uri).virtualPath.slice(1),
            entries: BrowserEntry[] = [],
            directories = new Set<string>();
        for (const entry of indexed.entries.values()) {
            if (entry.id === indexed.databaseId) {
                continue;
            }
            const name = (entry.name ?? '0x' + entry.id.toString(16).toUpperCase().padStart(8, '0')).replace(
                /\\/g,
                '/'
            );
            if (prefix && !name.toLowerCase().startsWith(prefix.toLowerCase() + '/')) {
                continue;
            }
            const relative = prefix ? name.slice(prefix.length + 1) : name,
                segment = relative.split('/')[0];
            if (!segment || segment === '..' || segment === '.' || name.includes('\0')) {
                continue;
            }
            const child = MixUriCodec.toChildUri(uri, '/' + (prefix ? prefix + '/' : '') + segment);
            if (relative.includes('/')) {
                if (!directories.has(segment)) {
                    entries.push({ uri: child, name: segment, size: 0, directory: true, archive: false });
                    directories.add(segment);
                }
            } else {
                entries.push({
                    uri: child,
                    name: segment,
                    size: entry.size,
                    directory: false,
                    archive: false,
                    id: entry.id,
                });
            }
        }
        if (prefix && !entries.length) {
            if (indexed.paths.has(prefix.toLowerCase())) {
                throw vscode.FileSystemError.FileNotADirectory(uri);
            }
            throw vscode.FileSystemError.FileNotFound(uri);
        }
        return { uri, entries, readonly: indexed.readonly, game: indexed.game };
    }

    public async isArchive(uri: vscode.Uri): Promise<boolean> {
        try {
            let slice: Slice;
            if (uri.scheme === MixUriCodec.scheme) {
                const indexed = await this.index(uri),
                    name = MixUriCodec.decode(uri).virtualPath.slice(1);
                const entry =
                    indexed.paths.get(name.toLowerCase()) ??
                    indexed.entries.get(
                        /^0x[0-9a-f]{8}$/i.test(name)
                            ? parseInt(name.slice(2), 16)
                            : MixArchive.calculateId(name, indexed.game)
                    );
                if (!entry) {
                    return false;
                }
                slice = {
                    container: indexed.slice.container,
                    offset: indexed.slice.offset + entry.offset,
                    size: entry.size,
                    read: (offset, length) => indexed.slice.read(entry.offset + offset, length),
                };
            } else {
                slice = await this.physical(uri);
            }
            if (slice.size < 6) {
                return false;
            }
            const bytes = await slice.read(0, Math.min(slice.size, 10)),
                view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
                flags = view.getUint32(0, true),
                modern = (flags & 0xffff) === 0;
            if (modern && flags & ~0x30000) {
                return false;
            }
            if (modern && flags & 0x20000) {
                return false;
            } // Existing encrypted reader remains available via the legacy workspace.
            const header = modern ? 10 : 6;
            if (bytes.length < header) {
                return false;
            }
            const count = view.getUint16(header - 6, true),
                body = view.getUint32(header - 4, true),
                start = header + count * 12;
            if (start + body + (modern && flags & 0x10000 ? 20 : 0) !== slice.size) {
                return false;
            }
            const directory = await slice.read(header, count * 12),
                dir = new DataView(directory.buffer, directory.byteOffset, directory.byteLength),
                ids = new Set<number>();
            for (let i = 0; i < count; i++) {
                const id = dir.getUint32(i * 12, true),
                    offset = dir.getUint32(i * 12 + 4, true),
                    size = dir.getUint32(i * 12 + 8, true);
                if (ids.has(id) || offset + size > body) {
                    return false;
                }
                ids.add(id);
            }
            return true;
        } catch {
            return false;
        }
    }

    public archiveRoot(uri: vscode.Uri): vscode.Uri {
        return uri.scheme === MixUriCodec.scheme ? MixUriCodec.toNestedRootUri(uri) : MixUriCodec.toRootUri(uri);
    }
    public child(uri: vscode.Uri, name: string): vscode.Uri {
        return uri.scheme === MixUriCodec.scheme
            ? MixUriCodec.toChildUri(uri, path.posix.join(uri.path, name))
            : vscode.Uri.joinPath(uri, name);
    }
    public parent(uri: vscode.Uri): vscode.Uri {
        if (uri.scheme !== MixUriCodec.scheme) {
            return vscode.Uri.file(path.dirname(uri.fsPath));
        }
        const decoded = MixUriCodec.decode(uri);
        if (decoded.virtualPath !== '/') {
            return MixUriCodec.toChildUri(uri, path.posix.dirname(uri.path));
        }
        if (decoded.nestedChain.length) {
            const entry = decoded.nestedChain.at(-1)!;
            return MixUriCodec.toChildUri(
                MixUriCodec.toRootUri(decoded.containerUri, decoded.nestedChain.slice(0, -1)),
                path.posix.dirname('/' + entry)
            );
        }
        return vscode.Uri.file(path.dirname(decoded.containerUri.fsPath));
    }
}
