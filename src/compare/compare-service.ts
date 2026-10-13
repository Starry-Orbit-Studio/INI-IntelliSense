import * as crypto from 'crypto';
import * as path from 'path';
import { createReadStream } from 'fs';
import * as vscode from 'vscode';
import { TextContentService } from '../services/text-content-service';
import { MixUriCodec } from '../mix/fs/mix-uri-codec';
import { MixArchive } from '../mix/core/archive';
import { MixGame } from '../mix/core/types';
import {
    CompareEntryDetails,
    CompareEntryType,
    CompareItem,
    CompareResult,
    CompareSource,
    CompareSummary,
} from './types';

interface ScannedEntry extends CompareEntryDetails {
    key: string;
    relativePath: string;
    extension: string;
    hash?: string;
}

export interface CompareReader {
    list(uri: vscode.Uri): Promise<{ entries: { name: string; directory: boolean; id?: number }[] }>;
    stat(uri: vscode.Uri): Promise<vscode.FileStat>;
    read(uri: vscode.Uri): Promise<Uint8Array>;
    resourceRange(uri: vscode.Uri): Promise<{ container: vscode.Uri; offset: number; size: number } | undefined>;
    game?(uri: vscode.Uri): Promise<MixGame>;
}

export class CompareService {
    public reader?: CompareReader;
    constructor(private readonly textContentService: TextContentService) {}

    public async compare(
        left: CompareSource,
        right: CompareSource,
        progress?: vscode.Progress<{ message?: string; increment?: number }>,
        token?: vscode.CancellationToken
    ): Promise<CompareResult> {
        progress?.report({ message: `Scanning ${left.label}` });
        const game =
            left.kind === 'mix' || right.kind === 'mix'
                ? ((await this.reader?.game?.(left.kind === 'mix' ? left.rootUri : right.rootUri)) ?? MixGame.Ra2)
                : undefined;
        const leftEntries = await this.scanSource(left, progress, token, game);

        progress?.report({ message: `Scanning ${right.label}` });
        const rightEntries = await this.scanSource(right, progress, token, game);

        // ID matching must still report a file occupying the other side's directory name.
        for (const [current, opposite] of [
            [leftEntries, rightEntries],
            [rightEntries, leftEntries],
        ]) {
            for (const [key, entry] of [...current]) {
                if (entry.entryType !== 'directory') {
                    continue;
                }
                const conflict = [...opposite].find(
                    ([, other]) =>
                        other.entryType === 'file' &&
                        normalizeCompareKey(other.relativePath) === normalizeCompareKey(entry.relativePath)
                );
                if (!conflict) {
                    continue;
                }
                const canonical = 'path:' + normalizeCompareKey(entry.relativePath);
                current.delete(key);
                opposite.delete(conflict[0]);
                current.set(canonical, { ...entry, key: canonical });
                opposite.set(canonical, { ...conflict[1], key: canonical });
            }
        }

        const keys = new Set<string>([...leftEntries.keys(), ...rightEntries.keys()]);

        const items: CompareItem[] = [];
        const summary: CompareSummary = {
            leftFiles: countEntries(leftEntries, 'file'),
            leftDirectories: countEntries(leftEntries, 'directory'),
            rightFiles: countEntries(rightEntries, 'file'),
            rightDirectories: countEntries(rightEntries, 'directory'),
            leftOnly: 0,
            rightOnly: 0,
            different: 0,
            identical: 0,
            typeMismatch: 0,
            totalItems: 0,
        };

        const orderedKeys = [...keys].sort((leftKey, rightKey) => {
            const leftEntry = leftEntries.get(leftKey);
            const rightEntry = rightEntries.get(rightKey);
            const leftPath = leftEntry?.relativePath ?? leftKey;
            const rightPath = rightEntry?.relativePath ?? rightKey;
            return leftPath.localeCompare(rightPath);
        });

        for (const key of orderedKeys) {
            if (token?.isCancellationRequested) {
                throw new vscode.CancellationError();
            }
            const leftEntry = leftEntries.get(key);
            const rightEntry = rightEntries.get(key);

            if (!leftEntry && !rightEntry) {
                continue;
            }

            if (!leftEntry) {
                items.push(this.createSingleSideItem(key, rightEntry!, 'right-only'));
                summary.rightOnly++;
                continue;
            }

            if (!rightEntry) {
                items.push(this.createSingleSideItem(key, leftEntry, 'left-only'));
                summary.leftOnly++;
                continue;
            }

            if (leftEntry.entryType !== rightEntry.entryType) {
                items.push({
                    key,
                    relativePath: leftEntry.relativePath,
                    entryType: leftEntry.entryType,
                    status: 'type-mismatch',
                    reason: 'Entry type differs between both sources.',
                    left: leftEntry,
                    right: rightEntry,
                });
                summary.typeMismatch++;
                continue;
            }

            if (leftEntry.entryType === 'directory') {
                continue;
            }

            if (leftEntry.size !== rightEntry.size) {
                items.push({
                    key,
                    relativePath: leftEntry.relativePath,
                    entryType: 'file',
                    status: 'different',
                    reason: 'File size differs.',
                    left: leftEntry,
                    right: rightEntry,
                });
                summary.different++;
                continue;
            }

            await this.populateFingerprint(leftEntry, token);
            await this.populateFingerprint(rightEntry, token);

            const identical = leftEntry.hash === rightEntry.hash;
            items.push({
                key,
                relativePath: leftEntry.relativePath,
                entryType: 'file',
                status: identical ? 'identical' : 'different',
                reason: identical ? 'File content is identical.' : 'File content differs.',
                left: leftEntry,
                right: rightEntry,
            });

            if (identical) {
                summary.identical++;
            } else {
                summary.different++;
            }
        }

        summary.totalItems = items.length;

        return {
            left,
            right,
            summary,
            items,
            generatedAt: new Date().toISOString(),
        };
    }

    private async scanSource(
        source: CompareSource,
        progress?: vscode.Progress<{ message?: string; increment?: number }>,
        token?: vscode.CancellationToken,
        game?: MixGame
    ): Promise<Map<string, ScannedEntry>> {
        const results = new Map<string, ScannedEntry>();
        const queue: Array<{ uri: vscode.Uri; relativePath: string }> = [{ uri: source.rootUri, relativePath: '' }];

        while (queue.length > 0) {
            if (token?.isCancellationRequested) {
                throw new vscode.CancellationError();
            }
            const current = queue.shift()!;
            const entries: [string, vscode.FileType, number?][] = this.reader
                ? (await this.reader.list(current.uri)).entries.map((entry) => [
                      entry.name,
                      entry.directory ? vscode.FileType.Directory : vscode.FileType.File,
                      entry.id,
                  ])
                : await vscode.workspace.fs.readDirectory(current.uri);

            for (const [name, type, id] of entries) {
                if (
                    type & vscode.FileType.SymbolicLink ||
                    /\.ra2-(?:backup-|workbench\.lock)|\.ra2-.*\.tmp$/.test(name) ||
                    (source.kind === 'mix' && /^(local mix database\.dat|0x366e051f)$/i.test(name))
                ) {
                    continue;
                }
                const relativePath = normalizeRelativePath(
                    current.relativePath ? path.posix.join(current.relativePath, name) : name
                );
                const key =
                    game !== undefined && !(type & vscode.FileType.Directory)
                        ? 'id:' +
                          (id ??
                              (/^0x[0-9a-f]{8}$/i.test(name)
                                  ? parseInt(name.slice(2), 16)
                                  : MixArchive.calculateId(relativePath.replace(/\//g, '\\'), game)))
                        : normalizeCompareKey(relativePath);
                const childUri =
                    current.uri.scheme === MixUriCodec.scheme
                        ? MixUriCodec.toChildUri(current.uri, path.posix.join(current.uri.path, name))
                        : vscode.Uri.joinPath(current.uri, name);

                if (type & vscode.FileType.Directory) {
                    results.set(key, {
                        key,
                        relativePath,
                        uri: childUri,
                        size: 0,
                        entryType: 'directory',
                        extension: '',
                    });
                    queue.push({ uri: childUri, relativePath });
                    continue;
                }

                const stat = await (this.reader?.stat(childUri) ?? vscode.workspace.fs.stat(childUri));
                results.set(key, {
                    key,
                    relativePath,
                    uri: childUri,
                    size: stat.size,
                    entryType: 'file',
                    extension: path.extname(name).toLowerCase(),
                    likelyText: isDefinitelyText(path.extname(name).toLowerCase()),
                });
            }

            progress?.report({ message: `Scanning ${source.label}: ${current.relativePath || '/'}` });
        }

        return results;
    }

    private createSingleSideItem(key: string, entry: ScannedEntry, status: 'left-only' | 'right-only'): CompareItem {
        return {
            key,
            relativePath: entry.relativePath,
            entryType: entry.entryType,
            status,
            reason: status === 'left-only' ? 'Only exists in the left source.' : 'Only exists in the right source.',
            left: status === 'left-only' ? entry : undefined,
            right: status === 'right-only' ? entry : undefined,
        };
    }

    private async populateFingerprint(entry: ScannedEntry, token?: vscode.CancellationToken): Promise<void> {
        if (entry.entryType !== 'file' || entry.hash) {
            return;
        }

        const range = await this.reader?.resourceRange(entry.uri);
        const physical = range?.container ?? entry.uri;
        const fingerprint = crypto.createHash('sha256');
        if (physical.scheme === 'file' && entry.size > 0) {
            const stream = createReadStream(physical.fsPath, {
                start: range?.offset ?? 0,
                end: (range?.offset ?? 0) + entry.size - 1,
                highWaterMark: 1024 * 1024,
            });
            const cancel = token?.onCancellationRequested(() => stream.destroy(new vscode.CancellationError()));
            try {
                let received = 0;
                for await (const chunk of stream) {
                    if (token?.isCancellationRequested) {
                        throw new vscode.CancellationError();
                    }
                    received += chunk.length;
                    fingerprint.update(chunk);
                    entry.likelyText ??=
                        isDefinitelyText(entry.extension) ||
                        this.textContentService.isLikelyText(chunk.subarray(0, 4096));
                }
                if (received !== entry.size) {
                    throw new Error('File changed during comparison.');
                }
            } finally {
                cancel?.dispose();
                stream.destroy();
            }
        } else {
            const bytes = await (this.reader?.read(entry.uri) ?? vscode.workspace.fs.readFile(entry.uri));
            fingerprint.update(bytes);
            entry.likelyText = isDefinitelyText(entry.extension) || this.textContentService.isLikelyText(bytes);
        }
        entry.hash = fingerprint.digest('hex');
    }
}

function countEntries(entries: Map<string, ScannedEntry>, entryType: CompareEntryType): number {
    let count = 0;
    for (const entry of entries.values()) {
        if (entry.entryType === entryType) {
            count++;
        }
    }
    return count;
}

function normalizeRelativePath(value: string): string {
    return value.replace(/\\/g, '/').replace(/^\/+/, '');
}

function normalizeCompareKey(value: string): string {
    return normalizeRelativePath(value).toLowerCase();
}

function isDefinitelyText(extension: string): boolean {
    return TEXT_EXTENSIONS.has(extension);
}

const TEXT_EXTENSIONS = new Set([
    '.ini',
    '.txt',
    '.md',
    '.json',
    '.xml',
    '.yaml',
    '.yml',
    '.lua',
    '.js',
    '.ts',
    '.cs',
    '.cfg',
    '.rules',
    '.art',
    '.sound',
    '.eva',
    '.map',
    '.mpr',
    '.yrm',
]);
