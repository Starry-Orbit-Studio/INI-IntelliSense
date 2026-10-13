import * as path from 'path';
import { createHash } from 'crypto';
import { localize } from '../../i18n';
import { crc32 } from './crc32';
import { decryptMixHeader } from './encrypted-header';
import {
    LOCAL_MIX_DATABASE_ID,
    LEGACY_LOCAL_MIX_DATABASE_ID,
    readLocalMixDatabase,
    writeLocalMixDatabase,
} from './local-mix-database';
import { getParentMixPath, joinMixPath, normalizeMixPath, splitMixVirtualPath } from './path-utils';
import {
    MixArchiveOptions,
    MixArchiveWarning,
    MixDirectoryEntry,
    MixEntry,
    MixGame,
    MixStat,
    MixTreeEntry,
    MixType,
} from './types';

const MIX_CHECKSUM = 0x00010000;
const MIX_ENCRYPTED = 0x00020000;

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
    private checksum = false;
    private entries = new Map<string, MixEntry>();
    private entryOrder: string[] = [];
    private contentCache = new Map<string, Uint8Array>();
    private directories = new Map<string, DirectoryNode>();
    private warnings: MixArchiveWarning[] = [];
    private modified = false;
    private invalidEntries = false;
    private entryMtime = Date.now();
    private localDb = new Map<number, string>();
    private localDatabaseId?: number;
    private localNameBytes = new Map<number, Uint8Array>();
    private customDb = new Map<string, MixDbEntry>();

    private constructor(bytes: Uint8Array, options?: MixArchiveOptions) {
        this.sourceData = bytes;
        this.sourceLabel = options?.sourceLabel;
    }

    public static async open(bytes: Uint8Array, options?: MixArchiveOptions): Promise<MixArchive> {
        const archive = new MixArchive(bytes, options);
        const flags =
            bytes.length >= 4 ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true) : 0;
        const decrypted =
            (flags & 0xffff) === 0 && (flags & MIX_ENCRYPTED) !== 0 ? await decryptMixHeader(bytes) : undefined;
        archive.parse(decrypted);
        return archive;
    }

    /** Empty RA2-compatible archive, with names persisted by the serializer. */
    public static async create(): Promise<MixArchive> {
        const archive = await MixArchive.open(new Uint8Array(10));
        archive.game = MixGame.Ra2;
        return archive;
    }

    public entryId(virtualPath: string): number | undefined {
        return this.entries.get(this.findPathByName(virtualPath) ?? normalizeMixPath(virtualPath))?.id;
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

    /** Resolve a known filename even when the directory only has an unknown hash. */
    public findPathByName(name: string): string | undefined {
        const normalized = normalizeMixPath(name);
        const direct = [...this.entries.keys()].find((key) => key.toLowerCase() === normalized.toLowerCase());
        if (direct) {
            return direct;
        }
        // A legacy header has no game marker; RA2 also ships legacy CRC archives.
        const rawId = /^0x[0-9a-f]{8}$/i.test(path.posix.basename(normalized))
            ? parseInt(path.posix.basename(normalized).slice(2), 16)
            : undefined;
        if (rawId !== undefined) {
            const raw = [...this.entries].find(([, entry]) => entry.id === rawId)?.[0];
            if (raw) {
                return raw;
            }
        }
        const basename = path.posix.basename(name),
            fullName = normalized.slice(1).replace(/\//g, '\\');
        for (const game of [this.game, this.game === MixGame.TdRa ? MixGame.Ts : MixGame.TdRa]) {
            const fullId = MixArchive.calculateId(fullName, game);
            const full = [...this.entries.entries()].find(([, entry]) => entry.id === fullId)?.[0];
            if (full) {
                return full;
            }
            if (fullName.includes('\\')) {
                continue;
            }
            const id = MixArchive.calculateId(basename, game);
            const found = [...this.entries.entries()].find(([, entry]) => entry.id === id)?.[0];
            if (found) {
                return found;
            }
        }
        return undefined;
    }

    public isDirty(): boolean {
        return this.modified;
    }

    /** Nested models share immutable source storage; writes always allocate their own entry buffer. */
    public async openNested(virtualPath: string): Promise<MixArchive> {
        return MixArchive.open(this.contentView(virtualPath));
    }

    private contentView(virtualPath: string): Uint8Array {
        const normalized = normalizeMixPath(virtualPath),
            cached = this.contentCache.get(normalized),
            entry = this.entries.get(normalized);
        if (cached) {
            return cached;
        }
        if (!entry) {
            throw new Error(localize('mix.error.fileNotFound', 'File not found: {0}', virtualPath));
        }
        const start = this.bodyStartOffset + entry.offset;
        if (start + entry.size > this.sourceData.length) {
            throw new Error(localize('mix.error.truncated', 'The MIX directory or payload is truncated.'));
        }
        return this.sourceData.subarray(start, start + entry.size);
    }

    public listDirectory(dirPath: string): MixTreeEntry[] {
        const normalizedDir = normalizeMixPath(dirPath);
        const node = this.directories.get(normalizedDir);
        if (!node) {
            throw new Error(localize('mix.error.directoryNotFound', 'Directory not found: {0}', normalizedDir));
        }

        const directories = [...node.directories].map((name) => ({
            name,
            path: joinMixPath(normalizedDir, name),
            type: 'directory' as const,
            size: 0,
        }));

        const files = [...node.files].map((name) => {
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
            throw new Error(
                localize('mix.error.entryOutOfRange', 'The MIX entry "{0}" is out of range.', entry.fileName)
            );
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
            throw new Error(
                localize('mix.error.entryOutOfRange', 'The MIX entry "{0}" is out of range.', entry.fileName)
            );
        }

        return this.sourceData.slice(start, end);
    }

    /** Copy a bounded slice without allocating or caching the entire archive entry. */
    public readFileRange(virtualPath: string, offset: number, length: number): Uint8Array {
        const normalized = normalizeMixPath(virtualPath),
            entry = this.entries.get(normalized);
        if (
            !entry ||
            !Number.isSafeInteger(offset) ||
            !Number.isSafeInteger(length) ||
            offset < 0 ||
            length < 0 ||
            offset + length > entry.size
        ) {
            throw new Error('Invalid MIX entry slice.');
        }
        const cached = this.contentCache.get(normalized);
        if (cached) {
            return cached.slice(offset, offset + length);
        }
        const start = this.bodyStartOffset + entry.offset + offset;
        if (start + length > this.sourceData.length) {
            throw new Error('Truncated MIX entry slice.');
        }
        return this.sourceData.slice(start, start + length);
    }

    public writeFile(virtualPath: string, content: Uint8Array, options: { create: boolean; overwrite: boolean }): void {
        this.assertWritable();
        const normalizedPath = this.findPathByName(virtualPath) ?? normalizeMixPath(virtualPath);
        const existing = this.entries.get(normalizedPath);
        if (
            (existing?.id ?? MixArchive.calculateId(normalizedPath.slice(1), this.game)) ===
            (this.localDatabaseId ?? MixArchive.calculateId('local mix database.dat', this.game))
        ) {
            throw new Error(
                localize('mix.error.managedDatabase', 'The local MIX filename database is maintained automatically.')
            );
        }
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
        this.assertWritable();
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
        if (entry.id === (this.localDatabaseId ?? MixArchive.calculateId('local mix database.dat', this.game))) {
            throw new Error(
                localize('mix.error.managedDatabase', 'The local MIX filename database is maintained automatically.')
            );
        }

        if (this.entries.has(newNormalized) && !options.overwrite) {
            throw new Error(localize('mix.error.fileExists', 'File already exists: {0}', newNormalized));
        }

        const newParts = splitMixVirtualPath(newNormalized);
        this.ensureDirectoryExists(newParts.dir);

        const newId = MixArchive.calculateId(newNormalized.slice(1).replace(/\//g, '\\'), this.game);
        const collision = [...this.entries].find(([key, value]) => key !== oldNormalized && value.id === newId);
        if (collision && collision[0] !== newNormalized) {
            throw new Error(localize('mix.error.hashCollision', 'MIX entry limit or filename hash collision.'));
        }
        const replaced = this.entries.get(newNormalized);
        if (replaced && replaced.id !== entry.id && !options.overwrite) {
            throw new Error(localize('mix.error.fileExists', 'File already exists: {0}', newNormalized));
        }

        const sourceContent = this.contentView(oldNormalized);
        this.contentCache.delete(newNormalized);
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

        this.contentCache.delete(oldNormalized);
        this.contentCache.set(newNormalized, sourceContent);

        this.registerFile(newNormalized, entry);
        this.markDirty();
    }

    public delete(virtualPath: string, options: { recursive: boolean }): void {
        this.assertWritable();
        const normalizedPath = normalizeMixPath(virtualPath);
        if (
            this.entries.get(normalizedPath)?.id ===
            (this.localDatabaseId ?? MixArchive.calculateId('local mix database.dat', this.game))
        ) {
            throw new Error(
                localize('mix.error.managedDatabase', 'The local MIX filename database is maintained automatically.')
            );
        }
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

    public createDirectory(_virtualPath: string): void {
        this.assertWritable();
        throw new Error(
            localize(
                'mix.error.emptyDirectory',
                'MIX files cannot store empty directories. Import files or create a nested MIX instead.'
            )
        );
    }

    public serialize(): Uint8Array {
        this.assertWritable();
        // Serialize without changing source offsets: repeated serialization must be stable.
        const files = [...this.entries]
            .filter(([, entry]) => entry.id !== this.localDatabaseId)
            .map(([key, entry]) => ({
                id: entry.id,
                bytes: this.contentView(key),
                name: key.slice(1).replace(/\//g, '\\'),
            }));
        const names = files
            .filter(
                (file) =>
                    !/^0x[0-9a-f]{8}$/i.test(file.name) &&
                    (MixArchive.calculateId(file.name, this.game) === file.id ||
                        this.localDb.get(file.id)?.replace(/\//g, '\\') === file.name)
            )
            .map((file) =>
                this.localDb.get(file.id)?.replace(/\//g, '\\') === file.name
                    ? (this.localNameBytes.get(file.id) ?? file.name)
                    : file.name
            );
        const database = writeLocalMixDatabase(this.game, names);
        files.push({
            id: MixArchive.calculateId('local mix database.dat', this.game),
            bytes: database,
            name: 'local mix database.dat',
        });
        files.sort((a, b) => (a.id | 0) - (b.id | 0));
        if (files.length > 65535 || new Set(files.map((file) => file.id)).size !== files.length) {
            throw new Error(localize('mix.error.hashCollision', 'MIX entry limit or filename hash collision.'));
        }
        const bodySize = files.reduce((size, file) => size + file.bytes.length, 0);
        if (bodySize > 0xffffffff) {
            throw new Error(localize('mix.error.tooLarge', 'MIX payload exceeds 4 GiB.'));
        }
        const headerSize = this.type === MixType.Td ? 6 : 10;
        const bodyStart = headerSize + files.length * 12;
        const result = new Uint8Array(bodyStart + bodySize + (this.checksum ? 20 : 0));
        const view = new DataView(result.buffer);
        if (headerSize === 10) {
            view.setUint32(0, this.checksum ? MIX_CHECKSUM : 0, true);
        }
        view.setUint16(headerSize - 6, files.length, true);
        view.setUint32(headerSize - 4, bodySize, true);
        let offset = 0,
            cursor = headerSize;
        for (const file of files) {
            view.setUint32(cursor, file.id, true);
            view.setUint32(cursor + 4, offset, true);
            view.setUint32(cursor + 8, file.bytes.length, true);
            result.set(file.bytes, bodyStart + offset);
            offset += file.bytes.length;
            cursor += 12;
        }
        if (this.checksum) {
            result.set(
                createHash('sha1')
                    .update(result.subarray(bodyStart, bodyStart + bodySize))
                    .digest(),
                bodyStart + bodySize
            );
        }
        return result;
    }

    public static calculateId(name: string, game: MixGame): number {
        return MixArchive.calculateIdBytes(new TextEncoder().encode(name), game);
    }

    public static calculateIdBytes(name: Uint8Array, game: MixGame): number {
        const upper = Array.from(name, (byte) => (byte >= 97 && byte <= 122 ? byte - 32 : byte === 47 ? 92 : byte));
        if (game === MixGame.TdRa) {
            let i = 0;
            let id = 0 >>> 0;
            while (i < upper.length) {
                let a = 0 >>> 0;
                for (let j = 0; j < 4; j++) {
                    a = a >>> 8;
                    if (i < upper.length) {
                        a = (a + (upper[i] << 24)) >>> 0;
                    }
                    i++;
                }
                id = (((id << 1) | (id >>> 31)) + a) >>> 0;
            }
            return id >>> 0;
        }

        const bytes: number[] = [];
        for (let i = 0; i < upper.length; i++) {
            bytes.push(upper[i]);
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
        if (
            this.game === MixGame.TdRa &&
            MixArchive.calculateId(resolvedName, MixGame.Ts) === id &&
            MixArchive.calculateId(resolvedName, MixGame.TdRa) !== id
        ) {
            this.game = MixGame.Ts;
        }
        const currentEntry = [...this.entries.entries()].find(([, entry]) => entry.id === id);
        if (!currentEntry) {
            return;
        }

        const [oldPath, entry] = currentEntry;
        const targetPath = joinMixPath(entry.path, resolvedName);
        this.unregisterPath(oldPath);
        this.entries.delete(oldPath);
        const cached = this.contentCache.get(oldPath);
        if (cached) {
            this.contentCache.delete(oldPath);
            this.contentCache.set(targetPath, cached);
        }
        entry.fileName = resolvedName;
        entry.type = getFileType(resolvedName);
        this.entries.set(targetPath, entry);
        this.registerFile(targetPath, entry);
        this.entryOrder = this.entryOrder.map((candidate) => (candidate === oldPath ? targetPath : candidate));
    }

    public isWritable(): boolean {
        return this.type !== MixType.RaTsEncrypted && !this.invalidEntries;
    }

    private assertWritable(): void {
        if (this.invalidEntries) {
            throw new Error(
                localize('mix.error.corruptWrite', 'Cannot rewrite a MIX archive with invalid or duplicate entries.')
            );
        }
        if (this.type === MixType.RaTsEncrypted) {
            throw new Error(
                localize('mix.error.saveEncryptedUnsupported', 'Saving encrypted MIX files is not yet supported.')
            );
        }
    }

    private parse(decrypted?: { bytes: Uint8Array; bodyOffset: number }): void {
        const bytes = this.sourceData;
        if (bytes.byteLength < 6) {
            throw new Error(localize('mix.error.tooSmall', 'The MIX file is too small to be valid.'));
        }

        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const flags = view.getUint32(0, true);
        this.checksum = (flags & 0xffff) === 0 && (flags & MIX_CHECKSUM) !== 0;
        if ((flags & 0xffff) === 0 && (flags & ~(MIX_CHECKSUM | MIX_ENCRYPTED)) !== 0) {
            throw new Error(localize('mix.error.invalidFlags', 'Invalid MIX flags.'));
        }
        // A nonzero first word is a legacy file count, not modern flags. The following
        // body-size word may set any upper bits in the first dword.
        if ((flags & 0xffff) !== 0) {
            this.type = MixType.Td;
            this.game = MixGame.TdRa;
            this.parseTd(view);
        } else if ((flags & MIX_ENCRYPTED) !== 0) {
            this.type = MixType.RaTsEncrypted;
            this.game = MixGame.Ts;
            if (!decrypted) {
                throw new Error('Encrypted MIX header is unavailable.');
            }
            const header = new DataView(decrypted.bytes.buffer, decrypted.bytes.byteOffset, decrypted.bytes.byteLength);
            this.bodyStartOffset = decrypted.bodyOffset;
            this.readEntries(header, 6, header.getUint16(0, true), header.getUint32(2, true));
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
        const fileCount = view.getUint16(0, true);
        const bodySize = view.getUint32(2, true);
        let cursor = 6;
        this.bodyStartOffset = cursor + fileCount * 12;
        this.readEntries(view, cursor, fileCount, bodySize);
    }

    private parseRaTs(view: DataView): void {
        if (view.byteLength < 10) {
            throw new Error(localize('mix.error.truncated', 'The MIX directory or payload is truncated.'));
        }
        const fileCount = view.getUint16(4, true);
        const bodySize = view.getUint32(6, true);
        let cursor = 10;
        this.bodyStartOffset = cursor + fileCount * 12;
        this.readEntries(view, cursor, fileCount, bodySize);
    }

    private readEntries(view: DataView, cursor: number, fileCount: number, bodySize: number): void {
        if (cursor + fileCount * 12 > view.byteLength || this.bodyStartOffset + bodySize > this.sourceData.length) {
            throw new Error(localize('mix.error.truncated', 'The MIX directory or payload is truncated.'));
        }
        for (let i = 0; i < fileCount; i++) {
            const id = view.getUint32(cursor, true);
            cursor += 4;
            const offset = view.getUint32(cursor, true);
            cursor += 4;
            const size = view.getUint32(cursor, true);
            cursor += 4;

            if (offset < 0 || size < 0 || offset + size > bodySize) {
                this.invalidEntries = true;
                this.warnings.push({
                    message: localize(
                        'mix.warning.invalidEntry',
                        'Skipped invalid MIX entry with id 0x{0}.',
                        id.toString(16).toUpperCase().padStart(8, '0')
                    ),
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
            if (this.entries.has(fullPath)) {
                this.invalidEntries = true;
                this.warnings.push({
                    message: localize('mix.warning.duplicateId', 'Duplicate MIX entry: {0}', rawName),
                });
            }
            this.entries.set(fullPath, entry);
            this.entryOrder.push(fullPath);
        }

        const localDb = this.tryReadLocalMixDatabase();
        if (localDb) {
            this.parseLocalMixDatabase(localDb.bytes, localDb.id);
        }
    }

    private tryReadLocalMixDatabase(): { bytes: Uint8Array; id: number } | undefined {
        for (const id of [LOCAL_MIX_DATABASE_ID, LEGACY_LOCAL_MIX_DATABASE_ID]) {
            const entry = [...this.entries.values()].find((entry) => entry.id === id);
            if (!entry) {
                continue;
            }
            const bytes = this.readFile(joinMixPath(entry.path, entry.fileName));
            if (readLocalMixDatabase(bytes)) {
                return { bytes, id };
            }
        }
        return undefined;
    }

    private parseLocalMixDatabase(bytes: Uint8Array, databaseId: number): void {
        const database = readLocalMixDatabase(bytes);
        if (!database) {
            return;
        }
        this.localDatabaseId = databaseId;
        this.game = database.game;
        for (const entry of database.entries) {
            const id = MixArchive.calculateIdBytes(entry.encodedName, this.game);
            this.localDb.set(id, entry.name);
            this.localNameBytes.set(id, entry.encodedName);
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
            id: /^0x[0-9a-f]{8}$/i.test(name)
                ? Number.parseInt(name.slice(2), 16)
                : MixArchive.calculateId(
                      dir === '/' ? name : joinMixPath(dir, name).slice(1).replace(/\//g, '\\'),
                      this.game
                  ),
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
        if (newNormalized.startsWith(oldNormalized + '/')) {
            throw new Error(localize('mix.browser.selfCopy', 'A folder cannot be copied into itself.'));
        }
        if ((this.directories.has(newNormalized) || this.entries.has(newNormalized)) && !options.overwrite) {
            throw new Error(localize('mix.error.fileExists', 'File already exists: {0}', newNormalized));
        }

        const affectedEntries = [...this.entries.entries()].filter(
            ([fullPath]) => fullPath === oldNormalized || fullPath.startsWith(`${oldNormalized}/`)
        );

        for (const [oldEntryPath, entry] of affectedEntries) {
            const suffix = oldEntryPath.slice(oldNormalized.length);
            const targetPath = normalizeMixPath(`${newNormalized}${suffix}`);
            const sourceContent = this.contentView(oldEntryPath);
            this.unregisterPath(oldEntryPath);
            this.entries.delete(oldEntryPath);
            const { dir, name } = splitMixVirtualPath(targetPath);
            this.ensureDirectoryExists(dir);
            this.contentCache.delete(oldEntryPath);
            this.contentCache.set(targetPath, sourceContent);
            entry.path = dir;
            entry.fileName = name;
            entry.id = MixArchive.calculateId(targetPath.slice(1).replace(/\//g, '\\'), this.game);
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
