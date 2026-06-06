import * as path from 'path';
import { localize } from '../../i18n';
import { crc32 } from './crc32';
import { getParentMixPath, joinMixPath, normalizeMixPath, splitMixVirtualPath } from './path-utils';
import { MixArchiveOptions, MixArchiveWarning, MixDirectoryEntry, MixEntry, MixGame, MixStat, MixTreeEntry, MixType } from './types';

const MIX_CHECKSUM = 0x00010000;
const MIX_ENCRYPTED = 0x00020000;
const LOCAL_MIX_DATABASE_ID = 0x366e051f;
const XCC_ID = 'XCC by Olaf van der Spek\x1a\x04\x17\x27\x10\x19\x80';

interface MixDbEntry {
    id: number;
    fileName: string;
    path: string;
}

interface DirectoryNode {
    directories: Set<string>;
    files: Set<string>;
}

export class MixArchive {
    private readonly sourceData: Uint8Array;
    private readonly sourceLabel?: string;
    private type: MixType = MixType.Unknown;
    private game: MixGame = MixGame.Ts;
    private bodyStartOffset = 0;
    private entries = new Map<string, MixEntry>();
    private entryOrder: string[] = [];
    private contentCache = new Map<string, Uint8Array>();
    private directories = new Map<string, DirectoryNode>();
    private warnings: MixArchiveWarning[] = [];
    private modified = false;
    private entryMtime = Date.now();
    private localDb = new Map<number, string>();
    private customDb = new Map<string, MixDbEntry>();

    private constructor(bytes: Uint8Array, options?: MixArchiveOptions) {
        this.sourceData = bytes;
        this.sourceLabel = options?.sourceLabel;
    }

    public static async open(bytes: Uint8Array, options?: MixArchiveOptions): Promise<MixArchive> {
        const archive = new MixArchive(bytes, options);
        archive.parse();
        return archive;
    }

    public getWarnings(): MixArchiveWarning[] {
        return [...this.warnings];
    }

    public getType(): MixType {
        return this.type;
    }

    public getGame(): MixGame {
        return this.game;
    }

    public isDirty(): boolean {
        return this.modified;
    }

    public listDirectory(dirPath: string): MixTreeEntry[] {
        const normalizedDir = normalizeMixPath(dirPath);
        const node = this.directories.get(normalizedDir);
        if (!node) {
            throw new Error(localize('mix.error.directoryNotFound', 'Directory not found: {0}', normalizedDir));
        }

        const directories = [...node.directories].map(name => ({
            name,
            path: joinMixPath(normalizedDir, name),
            type: 'directory' as const,
            size: 0,
        }));

        const files = [...node.files].map(name => {
            const fullPath = joinMixPath(normalizedDir, name);
            const entry = this.entries.get(fullPath);
            if (!entry) {
                throw new Error(localize('mix.error.fileNotFound', 'File not found: {0}', fullPath));
            }
            return {
                name,
                path: fullPath,
                type: 'file' as const,
                size: entry.size,
            };
        });

        return [...directories, ...files].sort((left, right) => {
            if (left.type !== right.type) {
                return left.type === 'directory' ? -1 : 1;
            }
            return left.name.localeCompare(right.name);
        });
    }

    public stat(virtualPath: string): MixStat {
        const normalizedPath = normalizeMixPath(virtualPath);
        if (this.directories.has(normalizedPath)) {
            return {
                type: 'directory',
                ctime: this.entryMtime,
                mtime: this.entryMtime,
                size: 0,
            };
        }

        const entry = this.entries.get(normalizedPath);
        if (!entry) {
            throw new Error(localize('mix.error.pathNotFound', 'Path not found: {0}', normalizedPath));
        }

        return {
            type: 'file',
            ctime: this.entryMtime,
            mtime: this.entryMtime,
            size: entry.size,
        };
    }

    public readFile(virtualPath: string): Uint8Array {
        const normalizedPath = normalizeMixPath(virtualPath);
        const entry = this.entries.get(normalizedPath);
        if (!entry) {
            throw new Error(localize('mix.error.fileNotFound', 'File not found: {0}', normalizedPath));
        }

        const cached = this.contentCache.get(normalizedPath);
        if (cached) {
            return cached;
        }

        const start = this.bodyStartOffset + entry.offset;
        const end = start + entry.size;
        if (start < 0 || end > this.sourceData.byteLength) {
            throw new Error(localize('mix.error.entryOutOfRange', 'The MIX entry "{0}" is out of range.', entry.fileName));
        }

        const bytes = this.sourceData.slice(start, end);
        this.contentCache.set(normalizedPath, bytes);
        return bytes;
    }

    public peekFile(virtualPath: string, maxBytes: number): Uint8Array {
        const normalizedPath = normalizeMixPath(virtualPath);
        const entry = this.entries.get(normalizedPath);
        if (!entry) {
            throw new Error(localize('mix.error.fileNotFound', 'File not found: {0}', normalizedPath));
        }

        const cached = this.contentCache.get(normalizedPath);
        if (cached) {
            return cached.subarray(0, Math.min(maxBytes, cached.byteLength));
        }

        const start = this.bodyStartOffset + entry.offset;
        const end = Math.min(start + Math.min(entry.size, maxBytes), this.sourceData.byteLength);
        if (start < 0 || end > this.sourceData.byteLength) {
            throw new Error(localize('mix.error.entryOutOfRange', 'The MIX entry "{0}" is out of range.', entry.fileName));
        }

        return this.sourceData.slice(start, end);
    }

    public writeFile(virtualPath: string, content: Uint8Array, options: { create: boolean; overwrite: boolean }): void {
        const normalizedPath = normalizeMixPath(virtualPath);
        const existing = this.entries.get(normalizedPath);
        if (!existing && !options.create) {
            throw new Error(localize('mix.error.fileNotFound', 'File not found: {0}', normalizedPath));
        }
        if (existing && !options.overwrite) {
            throw new Error(localize('mix.error.fileExists', 'File already exists: {0}', normalizedPath));
        }

        const { dir, name } = splitMixVirtualPath(normalizedPath);
        this.ensureDirectoryExists(dir);

        const entry = existing ?? this.createEntry(dir, name, content);
        entry.size = content.byteLength;
        entry.type = getFileType(name);
        this.entries.set(normalizedPath, entry);
        this.contentCache.set(normalizedPath, Uint8Array.from(content));
        this.registerFile(normalizedPath, entry);
        this.markDirty();
    }

    public rename(oldPath: string, newPath: string, options: { overwrite: boolean }): void {
        const oldNormalized = normalizeMixPath(oldPath);
        const newNormalized = normalizeMixPath(newPath);
        if (oldNormalized === newNormalized) {
            return;
        }

        if (this.directories.has(oldNormalized)) {
            this.renameDirectory(oldNormalized, newNormalized, options);
            return;
        }

        const entry = this.entries.get(oldNormalized);
        if (!entry) {
            throw new Error(localize('mix.error.pathNotFound', 'Path not found: {0}', oldNormalized));
        }

        if (this.entries.has(newNormalized) && !options.overwrite) {
            throw new Error(localize('mix.error.fileExists', 'File already exists: {0}', newNormalized));
        }

        const newParts = splitMixVirtualPath(newNormalized);
        this.ensureDirectoryExists(newParts.dir);

        const newId = MixArchive.calculateId(newParts.name, this.game);
        const replaced = this.entries.get(newNormalized);
        if (replaced && replaced.id !== entry.id && !options.overwrite) {
            throw new Error(localize('mix.error.fileExists', 'File already exists: {0}', newNormalized));
        }

        this.unregisterPath(oldNormalized);
        if (replaced) {
            this.unregisterPath(newNormalized);
        }

        entry.id = newId;
        entry.fileName = newParts.name;
        entry.path = newParts.dir;
        entry.type = getFileType(newParts.name);
        this.entries.delete(oldNormalized);
        this.entries.set(newNormalized, entry);

        const cached = this.contentCache.get(oldNormalized);
        if (cached) {
            this.contentCache.delete(oldNormalized);
            this.contentCache.set(newNormalized, cached);
        }

        this.registerFile(newNormalized, entry);
        this.markDirty();
    }

    public delete(virtualPath: string, options: { recursive: boolean }): void {
        const normalizedPath = normalizeMixPath(virtualPath);
        if (this.entries.has(normalizedPath)) {
            this.unregisterPath(normalizedPath);
            this.entries.delete(normalizedPath);
            this.contentCache.delete(normalizedPath);
            this.markDirty();
            return;
        }

        if (!this.directories.has(normalizedPath)) {
            throw new Error(localize('mix.error.pathNotFound', 'Path not found: {0}', normalizedPath));
        }

        const children = this.listDirectory(normalizedPath);
        if (children.length > 0 && !options.recursive) {
            throw new Error(localize('mix.error.directoryNotEmpty', 'Directory is not empty: {0}', normalizedPath));
        }

        for (const child of children) {
            this.delete(child.path, { recursive: true });
        }

        if (normalizedPath !== '/') {
            this.directories.delete(normalizedPath);
            const parent = getParentMixPath(normalizedPath);
            const parentNode = this.directories.get(parent);
            if (parentNode) {
                parentNode.directories.delete(path.posix.basename(normalizedPath));
            }
        }
        this.markDirty();
    }

    public createDirectory(virtualPath: string): void {
        const normalizedPath = normalizeMixPath(virtualPath);
        this.ensureDirectoryExists(normalizedPath);
        this.markDirty();
    }

    public serialize(): Uint8Array {
        if (this.type === MixType.RaTsEncrypted) {
            throw new Error(localize('mix.error.saveEncryptedUnsupported', 'Saving encrypted MIX files is not yet supported.'));
        }

        const fileEntries = [...this.entries.entries()]
            .sort((left, right) => left[1].id - right[1].id);

        const headerSize = this.type === MixType.Td ? 6 : 10;
        const indexSize = fileEntries.length * 12;
        const bodyChunks: Uint8Array[] = [];
        let currentOffset = 0;

        for (const [, entry] of fileEntries) {
            const bytes = this.contentCache.get(joinMixPath(entry.path, entry.fileName)) ?? this.readFile(joinMixPath(entry.path, entry.fileName));
            entry.offset = currentOffset;
            entry.size = bytes.byteLength;
            currentOffset += bytes.byteLength;
            bodyChunks.push(bytes);
        }

        const totalBodySize = currentOffset;
        const header = new Uint8Array(headerSize + indexSize + totalBodySize);
        const view = new DataView(header.buffer);

        let cursor = 0;
        if (this.type === MixType.Td) {
            view.setInt16(cursor, fileEntries.length, true);
            cursor += 2;
            view.setInt32(cursor, totalBodySize, true);
            cursor += 4;
        } else {
            view.setUint32(cursor, 0, true);
            cursor += 4;
            view.setInt16(cursor, fileEntries.length, true);
            cursor += 2;
            view.setInt32(cursor, totalBodySize, true);
            cursor += 4;
        }

        for (const [, entry] of fileEntries) {
            view.setUint32(cursor, entry.id >>> 0, true);
            cursor += 4;
            view.setInt32(cursor, entry.offset, true);
            cursor += 4;
            view.setInt32(cursor, entry.size, true);
            cursor += 4;
        }

        for (const bytes of bodyChunks) {
            header.set(bytes, cursor);
            cursor += bytes.byteLength;
        }

        return header;
    }

    public static calculateId(name: string, game: MixGame): number {
        const upper = name.toUpperCase();
        if (game === MixGame.TdRa) {
            let i = 0;
            let id = 0 >>> 0;
            while (i < upper.length) {
                let a = 0 >>> 0;
                for (let j = 0; j < 4; j++) {
                    a = a >>> 8;
                    if (i < upper.length) {
                        a = (a + (upper.charCodeAt(i) << 24)) >>> 0;
                    }
                    i++;
                }
                id = (((id << 1) | (id >>> 31)) + a) >>> 0;
            }
            return id >>> 0;
        }

        const bytes: number[] = [];
        for (let i = 0; i < upper.length; i++) {
            bytes.push(upper.charCodeAt(i) & 0xff);
        }

        const originalLength = bytes.length;
        const alignedLength = originalLength & ~3;
        if (originalLength & 3) {
            bytes.push(originalLength - alignedLength);
            const repeatedByte = bytes[alignedLength] ?? 0;
            for (let i = 0; i < 3 - (originalLength & 3); i++) {
                bytes.push(repeatedByte);
            }
        }

        return crc32(Uint8Array.from(bytes)) >>> 0;
    }

    public applyDisplayName(id: number, resolvedName: string): void {
        const currentEntry = [...this.entries.entries()].find(([, entry]) => entry.id === id);
        if (!currentEntry) {
            return;
        }

        const [oldPath, entry] = currentEntry;
        const targetPath = joinMixPath(entry.path, resolvedName);
        this.unregisterPath(oldPath);
        this.entries.delete(oldPath);
        entry.fileName = resolvedName;
        entry.type = getFileType(resolvedName);
        this.entries.set(targetPath, entry);
        this.registerFile(targetPath, entry);
        this.entryOrder = this.entryOrder.map(candidate => candidate === oldPath ? targetPath : candidate);
    }

    private parse(): void {
        const bytes = this.sourceData;
        if (bytes.byteLength < 6) {
            throw new Error(localize('mix.error.tooSmall', 'The MIX file is too small to be valid.'));
        }

        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const flags = view.getUint32(0, true);
        const tdCandidateCount = view.getInt16(0, true);
        const tdCandidateBodySize = view.getInt32(2, true);

        if ((flags & 0xffff0000) === 0 && tdCandidateCount > 0 && tdCandidateCount < 10000 && bytes.byteLength >= 6 + tdCandidateCount * 12 + tdCandidateBodySize) {
            this.type = MixType.Td;
            this.game = MixGame.TdRa;
            this.parseTd(view);
        } else if ((flags & MIX_ENCRYPTED) !== 0) {
            this.type = MixType.RaTsEncrypted;
            this.game = MixGame.Ts;
            throw new Error(localize('mix.error.encryptedUnsupported', 'Encrypted MIX files are not yet supported for browsing in this version.'));
        } else {
            this.type = MixType.RaTs;
            this.game = MixGame.Ts;
            this.parseRaTs(view);
        }

        this.ensureDirectoryExists('/');
        this.applyNameDatabase();
        this.rebuildDirectoryIndex();
    }

    private parseTd(view: DataView): void {
        const fileCount = view.getInt16(0, true);
        const bodySize = view.getInt32(2, true);
        let cursor = 6;
        this.bodyStartOffset = cursor + fileCount * 12;
        this.readEntries(view, cursor, fileCount, bodySize);
    }

    private parseRaTs(view: DataView): void {
        const fileCount = view.getInt16(4, true);
        const bodySize = view.getInt32(6, true);
        let cursor = 10;
        this.bodyStartOffset = cursor + fileCount * 12;
        this.readEntries(view, cursor, fileCount, bodySize);
    }

    private readEntries(view: DataView, cursor: number, fileCount: number, bodySize: number): void {
        for (let i = 0; i < fileCount; i++) {
            const id = view.getUint32(cursor, true);
            cursor += 4;
            const offset = view.getInt32(cursor, true);
            cursor += 4;
            const size = view.getInt32(cursor, true);
            cursor += 4;

            if (offset < 0 || size < 0 || offset + size > bodySize) {
                this.warnings.push({
                    message: localize('mix.warning.invalidEntry', 'Skipped invalid MIX entry with id 0x{0}.', id.toString(16).toUpperCase().padStart(8, '0')),
                });
                continue;
            }

            const rawName = `0x${id.toString(16).toUpperCase().padStart(8, '0')}`;
            const entry: MixEntry = {
                id,
                fileName: rawName,
                size,
                offset,
                type: getFileType(rawName),
                path: '/',
            };

            const fullPath = joinMixPath('/', rawName);
            this.entries.set(fullPath, entry);
            this.entryOrder.push(fullPath);
        }

        const localDbBytes = this.tryReadLocalMixDatabase();
        if (localDbBytes) {
            this.parseLocalMixDatabase(localDbBytes);
        }
    }

    private tryReadLocalMixDatabase(): Uint8Array | undefined {
        const localEntry = [...this.entries.values()].find(entry => entry.id === LOCAL_MIX_DATABASE_ID);
        if (!localEntry) {
            return undefined;
        }

        try {
            return this.readFile(joinMixPath(localEntry.path, localEntry.fileName));
        } catch {
            return undefined;
        }
    }

    private parseLocalMixDatabase(bytes: Uint8Array): void {
        if (bytes.byteLength < 40) {
            return;
        }

        const headerBytes = bytes.slice(0, 32);
        const expectedHeaderBytes = Uint8Array.from(XCC_ID, char => char.charCodeAt(0));
        if (headerBytes.byteLength !== expectedHeaderBytes.byteLength) {
            return;
        }
        for (let i = 0; i < expectedHeaderBytes.byteLength; i++) {
            if (headerBytes[i] !== expectedHeaderBytes[i]) {
                return;
            }
        }

        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const decoder = new TextDecoder('latin1');
        const gameId = view.getInt32(44, true);
        const fileCount = view.getInt32(48, true);
        this.game = mapGameId(gameId);

        let cursor = 52;
        const entriesWithoutDb = [...this.entries.values()]
            .sort((left, right) => left.offset - right.offset);
        this.localDb.clear();

        for (let i = 0; i < fileCount && cursor < bytes.byteLength; i++) {
            const end = bytes.indexOf(0, cursor);
            if (end === -1) {
                break;
            }
            const name = decoder.decode(bytes.slice(cursor, end));
            cursor = end + 1;
            const id = MixArchive.calculateId(name, this.game);
            this.localDb.set(id, name);
        }

        if (fileCount !== entriesWithoutDb.filter(entry => entry.id !== LOCAL_MIX_DATABASE_ID).length) {
            this.warnings.push({
                message: localize('mix.warning.localDbCountMismatch', 'The local MIX database count does not match the entry count.'),
            });
        }
    }

    private applyNameDatabase(): void {
        const renamedEntries = new Map<string, MixEntry>();
        for (const fullPath of this.entryOrder) {
            const entry = this.entries.get(fullPath);
            if (!entry) {
                continue;
            }

            const resolvedName = this.localDb.get(entry.id);
            if (resolvedName) {
                entry.fileName = resolvedName;
                entry.type = getFileType(resolvedName);
            }

            const actualPath = joinMixPath(entry.path, entry.fileName);
            renamedEntries.set(actualPath, entry);
        }

        if (renamedEntries.size > 0) {
            this.entries = renamedEntries;
            this.entryOrder = [...renamedEntries.keys()];
        }
    }

    private rebuildDirectoryIndex(): void {
        this.directories.clear();
        this.ensureDirectoryExists('/');
        for (const [fullPath, entry] of this.entries.entries()) {
            this.registerFile(fullPath, entry);
        }
    }

    private registerFile(fullPath: string, entry: MixEntry): void {
        const normalizedPath = normalizeMixPath(fullPath);
        const { dir, name } = splitMixVirtualPath(normalizedPath);
        this.ensureDirectoryExists(dir);

        const parent = this.directories.get(dir);
        if (!parent) {
            throw new Error(localize('mix.error.directoryNotFound', 'Directory not found: {0}', dir));
        }
        parent.files.add(name);

        entry.path = dir;
        entry.fileName = name;
        this.entries.set(normalizedPath, entry);
    }

    private unregisterPath(fullPath: string): void {
        const normalizedPath = normalizeMixPath(fullPath);
        const { dir, name } = splitMixVirtualPath(normalizedPath);
        const parent = this.directories.get(dir);
        if (parent) {
            parent.files.delete(name);
        }
    }

    private ensureDirectoryExists(dirPath: string): void {
        const normalizedDir = normalizeMixPath(dirPath);
        if (this.directories.has(normalizedDir)) {
            return;
        }

        if (normalizedDir !== '/') {
            const parent = getParentMixPath(normalizedDir);
            this.ensureDirectoryExists(parent);
            const parentNode = this.directories.get(parent);
            if (parentNode) {
                parentNode.directories.add(path.posix.basename(normalizedDir));
            }
        }

        this.directories.set(normalizedDir, {
            directories: new Set(),
            files: new Set(),
        });
    }

    private createEntry(dir: string, name: string, content: Uint8Array): MixEntry {
        const entry: MixEntry = {
            id: MixArchive.calculateId(name, this.game),
            fileName: name,
            size: content.byteLength,
            offset: 0,
            type: getFileType(name),
            path: dir,
        };
        return entry;
    }

    private renameDirectory(oldPath: string, newPath: string, options: { overwrite: boolean }): void {
        const oldNormalized = normalizeMixPath(oldPath);
        const newNormalized = normalizeMixPath(newPath);
        if (oldNormalized === '/') {
            throw new Error(localize('mix.error.renameRoot', 'The MIX root directory cannot be renamed.'));
        }
        if (this.directories.has(newNormalized) && !options.overwrite) {
            throw new Error(localize('mix.error.fileExists', 'File already exists: {0}', newNormalized));
        }

        const affectedEntries = [...this.entries.entries()]
            .filter(([fullPath]) => fullPath === oldNormalized || fullPath.startsWith(`${oldNormalized}/`));

        for (const [oldEntryPath, entry] of affectedEntries) {
            const suffix = oldEntryPath.slice(oldNormalized.length);
            const targetPath = normalizeMixPath(`${newNormalized}${suffix}`);
            this.unregisterPath(oldEntryPath);
            this.entries.delete(oldEntryPath);
            const { dir, name } = splitMixVirtualPath(targetPath);
            this.ensureDirectoryExists(dir);
            entry.path = dir;
            entry.fileName = name;
            this.entries.set(targetPath, entry);
        }

        this.rebuildDirectoryIndex();
        this.markDirty();
    }

    private markDirty(): void {
        this.modified = true;
        this.entryMtime = Date.now();
    }
}

function getFileType(name: string): string {
    const ext = path.extname(name).replace('.', '').toUpperCase();
    return ext || 'BIN';
}

function mapGameId(gameId: number): MixGame {
    switch (gameId) {
        case 0:
        case 1:
            return MixGame.TdRa;
        case 2:
        case 14:
            return MixGame.Ts;
        case 5:
        case 6:
            return MixGame.Ra2;
        default:
            return MixGame.Ts;
    }
}
