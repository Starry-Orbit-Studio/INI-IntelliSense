import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { TextContentService } from '../services/text-content-service';
import { MixUriCodec } from '../mix/fs/mix-uri-codec';
import { CompareEntryDetails, CompareEntryType, CompareItem, CompareResult, CompareSource, CompareSummary } from './types';

interface ScannedEntry extends CompareEntryDetails {
    key: string;
    relativePath: string;
    extension: string;
    hash?: string;
}

export class CompareService {
    constructor(private readonly textContentService: TextContentService) {}

    public async compare(
        left: CompareSource,
        right: CompareSource,
        progress?: vscode.Progress<{ message?: string; increment?: number }>
    ): Promise<CompareResult> {
        progress?.report({ message: `Scanning ${left.label}` });
        const leftEntries = await this.scanSource(left, progress);

        progress?.report({ message: `Scanning ${right.label}` });
        const rightEntries = await this.scanSource(right, progress);

        const keys = new Set<string>([
            ...leftEntries.keys(),
            ...rightEntries.keys(),
        ]);

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

            await this.populateFingerprint(leftEntry);
            await this.populateFingerprint(rightEntry);

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
        progress?: vscode.Progress<{ message?: string; increment?: number }>
    ): Promise<Map<string, ScannedEntry>> {
        const results = new Map<string, ScannedEntry>();
        const queue: Array<{ uri: vscode.Uri; relativePath: string }> = [{ uri: source.rootUri, relativePath: '' }];

        while (queue.length > 0) {
            const current = queue.shift()!;
            const entries = await vscode.workspace.fs.readDirectory(current.uri);

            for (const [name, type] of entries) {
                const relativePath = normalizeRelativePath(current.relativePath ? path.posix.join(current.relativePath, name) : name);
                const key = normalizeCompareKey(relativePath);
                const childUri = current.uri.scheme === MixUriCodec.scheme
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

                const stat = await vscode.workspace.fs.stat(childUri);
                results.set(key, {
                    key,
                    relativePath,
                    uri: childUri,
                    size: stat.size,
                    entryType: 'file',
                    extension: path.extname(name).toLowerCase(),
                });
            }

            progress?.report({ message: `Scanning ${source.label}: ${current.relativePath || '/'}` });
        }

        return results;
    }

    private createSingleSideItem(
        key: string,
        entry: ScannedEntry,
        status: 'left-only' | 'right-only'
    ): CompareItem {
        return {
            key,
            relativePath: entry.relativePath,
            entryType: entry.entryType,
            status,
            reason: status === 'left-only'
                ? 'Only exists in the left source.'
                : 'Only exists in the right source.',
            left: status === 'left-only' ? entry : undefined,
            right: status === 'right-only' ? entry : undefined,
        };
    }

    private async populateFingerprint(entry: ScannedEntry): Promise<void> {
        if (entry.entryType !== 'file' || entry.hash) {
            return;
        }

        const bytes = await vscode.workspace.fs.readFile(entry.uri);
        entry.hash = crypto.createHash('sha256').update(bytes).digest('hex');
        entry.likelyText = isDefinitelyText(entry.extension) || this.textContentService.isLikelyText(bytes);
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
