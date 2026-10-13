import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { createHash, randomUUID } from 'crypto';
import { BrowserLocations } from './locations';
import { MixMutation, MixWorkspaceManager } from '../fs/mix-workspace-manager';
import { MixUriCodec } from '../fs/mix-uri-codec';
import { MixArchive } from '../core/archive';
import { MixGame } from '../core/types';
import { SafeFileStore } from '../fs/safe-file-store';
import { localize } from '../../i18n';
import { validRelativeFileName } from './file-names';
import { backupPolicy } from '../fs/backup-policy';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const identity = (uri: vscode.Uri) => uri.toString().toLowerCase();
interface TransferFile {
    source: vscode.Uri;
    target: vscode.Uri;
    bytes: Uint8Array;
    before?: string;
    collision?: string;
    skip?: boolean;
}
export interface TransferPlan {
    files: TransferFile[];
    sources: vscode.Uri[];
    directories: { source: vscode.Uri; target: vscode.Uri }[];
    move: boolean;
    target: vscode.Uri;
    totalBytes: number;
    conflicts: string[];
}
interface UndoStep {
    run(): Promise<void>;
    canRun?(): boolean;
}

/** One planner for the editor browser and native MIX tree; conflicts are resolved before mutations. */
export class BrowserTransfers {
    private readonly files = new SafeFileStore(backupPolicy);
    private readonly history: { steps: UndoStep[]; uris: vscode.Uri[] }[] = [];
    constructor(
        private readonly locations: BrowserLocations,
        private readonly mix: MixWorkspaceManager
    ) {}

    public async plan(
        sources: readonly vscode.Uri[],
        target: vscode.Uri,
        move = false,
        token?: vscode.CancellationToken,
        relativePaths?: ReadonlyMap<string, string>
    ): Promise<TransferPlan> {
        const candidates = [...new Map(sources.map((uri) => [identity(uri), uri])).values()];
        const directories = await Promise.all(
            candidates.map(async (uri) => !!((await this.locations.stat(uri)).type & vscode.FileType.Directory))
        );
        const unique = candidates.filter(
            (uri) =>
                !candidates.some(
                    (parent, index) =>
                        directories[index] &&
                        parent !== uri &&
                        parent.scheme === uri.scheme &&
                        parent.query === uri.query &&
                        uri.path.toLowerCase().startsWith(parent.path.toLowerCase() + '/')
                )
        );
        if (
            unique.some(
                (source) =>
                    identity(source) === identity(target) ||
                    (source.scheme === target.scheme &&
                        source.query === target.query &&
                        target.path.toLowerCase().startsWith(source.path.toLowerCase() + '/'))
            )
        ) {
            throw new Error(localize('mix.browser.selfCopy', 'A folder cannot be copied into itself.'));
        }
        if (
            target.scheme === MixUriCodec.scheme &&
            unique.some((source) => {
                const destination = MixUriCodec.decode(target);
                if (source.scheme === 'file') {
                    return identity(source) === identity(destination.containerUri);
                }
                if (source.scheme !== MixUriCodec.scheme) {
                    return false;
                }
                const origin = MixUriCodec.decode(source),
                    prefix = origin.nestedChain;
                return (
                    identity(origin.containerUri) === identity(destination.containerUri) &&
                    prefix.every((part, index) => destination.nestedChain[index] === part) &&
                    (origin.virtualPath === '/' ||
                        destination.nestedChain[prefix.length] === origin.virtualPath.slice(1))
                );
            })
        ) {
            throw new Error(localize('mix.browser.selfCopy', 'A folder cannot be copied into itself.'));
        }
        const listing = await this.locations.list(target);
        if (listing.readonly) {
            throw new Error(localize('mix.browser.readonly', 'This archive is read-only.'));
        }
        const files: TransferFile[] = [],
            seen = new Map<string, TransferFile>(),
            folders: TransferPlan['directories'] = [];
        const configured = vscode.workspace
            .getConfiguration(
                'ra2-ini-intellisense',
                target.scheme === MixUriCodec.scheme ? MixUriCodec.decode(target).containerUri : target
            )
            .get<number>('mix.transferBudgetMiB', 512);
        const budgetMiB = Number.isFinite(configured) ? Math.max(16, Math.min(2048, configured)) : 512;
        let totalBytes = 0;
        const scan = async (source: vscode.Uri, relative: string, depth: number) => {
            if (token?.isCancellationRequested) {
                throw new vscode.CancellationError();
            }
            if (depth > 64 || files.length > 65534) {
                throw new Error(
                    localize('mix.browser.transferLimit', 'Transfer exceeds the directory depth or MIX entry limit.')
                );
            }
            const stat = await this.locations.stat(source);
            if (move && stat.permissions === vscode.FilePermission.Readonly) {
                throw new Error(localize('mix.browser.readonly', 'This archive is read-only.'));
            }
            if (stat.type & vscode.FileType.SymbolicLink) {
                throw new Error(
                    localize('mix.browser.symlink', 'Symbolic links are not imported. Select their actual files.')
                );
            }
            if (stat.type & vscode.FileType.Directory) {
                if (target.scheme !== MixUriCodec.scheme) {
                    folders.push({ source, target: this.locations.child(target, relative) });
                }
                for (const entry of (await this.locations.list(source)).entries) {
                    await scan(entry.uri, path.posix.join(relative, entry.name), depth + 1);
                }
                return;
            }
            // Classic game archives are flat. Folder imports use resource basenames deliberately.
            const name = target.scheme === MixUriCodec.scheme ? path.posix.basename(relative) : relative;
            if (!validRelativeFileName(name)) {
                throw new Error(localize('mix.browser.invalidName', 'Invalid destination filename: {0}', name));
            }
            let destination = this.locations.child(target, name);
            const id = /^0x[0-9a-f]{8}$/i.test(name)
                ? parseInt(name.slice(2), 16)
                : MixArchive.calculateId(name, listing.game ?? MixGame.Ra2);
            const matching = listing.entries.find(
                (entry) =>
                    entry.name.toLowerCase() === name.toLowerCase() ||
                    (target.scheme === MixUriCodec.scheme && entry.id === id)
            );
            if (matching) {
                destination = matching.uri;
            }
            if (identity(source) === identity(destination)) {
                return;
            }
            if (totalBytes + stat.size > budgetMiB * 1024 * 1024) {
                throw new Error(
                    localize(
                        'mix.browser.memoryBudget',
                        'This transfer exceeds the {0} MiB staging budget. Select fewer files or increase MIX Transfer Budget in extension settings.',
                        budgetMiB
                    )
                );
            }
            const bytes = await this.locations.read(source);
            totalBytes += bytes.length;
            let before: string | undefined;
            if (target.scheme === MixUriCodec.scheme) {
                if (matching?.directory) {
                    throw new Error(
                        localize(
                            'mix.browser.fileDirectoryConflict',
                            'A directory already uses this filename: {0}',
                            name
                        )
                    );
                }
                if (matching) {
                    before = hash(await this.locations.read(destination));
                }
            } else {
                try {
                    const stat = await vscode.workspace.fs.stat(destination);
                    if (stat.type & vscode.FileType.Directory) {
                        throw new Error(
                            localize(
                                'mix.browser.fileDirectoryConflict',
                                'A directory already uses this filename: {0}',
                                name
                            )
                        );
                    }
                    before = hash(await this.locations.read(destination));
                } catch (error) {
                    if (!(error instanceof vscode.FileSystemError && error.code === 'FileNotFound')) {
                        throw error;
                    }
                }
            }
            const key = identity(destination),
                prior = seen.get(key),
                file: TransferFile = {
                    source,
                    target: destination,
                    bytes,
                    before,
                    collision: prior ? name : before ? name : undefined,
                };
            if (prior) {
                prior.collision = name;
            }
            files.push(file);
            seen.set(key, file);
        };
        for (const source of unique) {
            await scan(source, relativePaths?.get(source.toString()) ?? path.posix.basename(source.path), 0);
        }
        if (
            target.scheme === MixUriCodec.scheme &&
            !files.length &&
            unique.some((uri) => directories[candidates.indexOf(uri)])
        ) {
            throw new Error(
                localize(
                    'mix.error.emptyDirectory',
                    'MIX files cannot store empty directories. Import files or create a nested MIX instead.'
                )
            );
        }
        return {
            files,
            directories: folders,
            sources: unique,
            target,
            move,
            totalBytes: files.reduce((total, file) => total + file.bytes.length, 0),
            conflicts: [...new Set(files.flatMap((file) => (file.collision ? [file.collision] : [])))],
        };
    }

    public async resolve(plan: TransferPlan): Promise<boolean> {
        if (!plan.conflicts.length) {
            return true;
        }
        const replace = localize('mix.browser.replace', 'Replace'),
            skip = localize('mix.browser.skip', 'Skip'),
            cancel = localize('mix.browser.cancel', 'Cancel'),
            keep = localize('mix.browser.keepBoth', 'Keep both (rename incoming)');
        const choice = await vscode.window.showQuickPick([replace, skip, keep, cancel], {
            title: localize('mix.browser.conflicts', '{0} filename / hash conflicts', plan.conflicts.length),
            placeHolder: plan.conflicts.slice(0, 10).join(', '),
            ignoreFocusOut: true,
        });
        if (!choice || choice === cancel) {
            return false;
        }
        if (choice === keep) {
            await this.keepBoth(plan);
        } else if (choice === skip) {
            plan.files.forEach((file) => {
                file.skip = !!file.collision;
            });
        } else {
            const seen = new Set<string>();
            for (const file of [...plan.files].reverse()) {
                const key = identity(file.target);
                if (seen.has(key)) {
                    file.skip = true;
                }
                seen.add(key);
            }
        }
        return true;
    }

    public async keepBoth(plan: TransferPlan): Promise<void> {
        const listing = await this.locations.list(plan.target),
            occupied = new Set(plan.files.map((file) => identity(file.target)));
        const ids = new Set(listing.entries.flatMap((entry) => (entry.id !== undefined ? [entry.id] : [])));
        const incoming = new Set<string>();
        for (const file of plan.files.filter((file) => file.collision)) {
            if (!file.before && !incoming.has(identity(file.target))) {
                incoming.add(identity(file.target));
                file.collision = undefined;
                continue;
            }
            const original = path.posix.basename(file.target.path),
                extension = path.posix.extname(original),
                stem = original.slice(0, original.length - extension.length);
            if (plan.target.scheme === MixUriCodec.scheme && /^0x[0-9a-f]{8}$/i.test(original)) {
                throw new Error(
                    localize(
                        'mix.browser.unknownRename',
                        'Two entries with the same unknown MIX ID cannot coexist. Replace or skip this entry instead.'
                    )
                );
            }
            let counter = 1;
            while (true) {
                const name = `${stem} (${++counter})${extension}`,
                    target = this.locations.child(this.locations.parent(file.target), name);
                const id = MixArchive.calculateId(name, listing.game ?? MixGame.Ra2);
                if (occupied.has(identity(target)) || (plan.target.scheme === MixUriCodec.scheme && ids.has(id))) {
                    continue;
                }
                try {
                    await this.locations.stat(target);
                    continue;
                } catch (error) {
                    if (!(error instanceof vscode.FileSystemError && error.code === 'FileNotFound')) {
                        throw error;
                    }
                }
                occupied.add(identity(target));
                ids.add(id);
                file.target = target;
                file.before = undefined;
                file.collision = undefined;
                break;
            }
        }
    }

    public async execute(plan: TransferPlan, token?: vscode.CancellationToken): Promise<void> {
        const selected = plan.files.filter((file) => !file.skip),
            undo: UndoStep[] = [],
            grouped = new Map<string, MixMutation[]>();
        this.assertSaved(selected.map((file) => file.target));
        if (plan.move) {
            this.assertSaved(plan.sources);
        }
        for (const file of selected) {
            if (token?.isCancellationRequested) {
                throw new vscode.CancellationError();
            }
            if (hash(await this.locations.read(file.source)) !== hash(file.bytes)) {
                throw new Error(
                    localize(
                        'mix.error.externalChange',
                        'The file changed outside this operation. Refresh and try again.'
                    )
                );
            }
            if (file.before && hash(await this.locations.read(file.target)) !== file.before) {
                throw new Error(
                    localize(
                        'mix.error.externalChange',
                        'The file changed outside this operation. Refresh and try again.'
                    )
                );
            }
            if (!file.before && file.target.scheme !== MixUriCodec.scheme) {
                try {
                    await vscode.workspace.fs.stat(file.target);
                    throw new Error(
                        localize(
                            'mix.error.externalChange',
                            'The file changed outside this operation. Refresh and try again.'
                        )
                    );
                } catch (error) {
                    if (
                        !(error instanceof vscode.FileSystemError && error.code === 'FileNotFound') &&
                        !/not found/i.test(error instanceof Error ? error.message : '')
                    ) {
                        throw error;
                    }
                }
            }
            if (file.target.scheme === MixUriCodec.scheme) {
                const root = MixUriCodec.decode(file.target).containerUri.toString(),
                    group = grouped.get(root) ?? [];
                group.push({
                    kind: 'write',
                    uri: file.target,
                    content: file.bytes,
                    create: true,
                    overwrite: !!file.before,
                    expected: file.before ?? null,
                });
                grouped.set(root, group);
            }
        }
        try {
            for (const folder of plan.directories.sort((a, b) => a.target.path.length - b.target.path.length)) {
                await this.assertDestination(plan.target, folder.target);
                try {
                    await fs.mkdir(folder.target.fsPath);
                    undo.push({ run: () => fs.rmdir(folder.target.fsPath) });
                } catch (error) {
                    if (
                        (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
                        !(await fs.stat(folder.target.fsPath)).isDirectory()
                    ) {
                        throw error;
                    }
                }
            }
            // Ordinary destination files are individually replaceable; recovery reverses completed steps on failure.
            for (const file of selected.filter((file) => file.target.scheme !== MixUriCodec.scheme)) {
                if (token?.isCancellationRequested) {
                    throw new vscode.CancellationError();
                }
                const destination = file.target.fsPath;
                await this.assertDestination(plan.target, file.target);
                await fs.mkdir(path.dirname(destination), { recursive: true });
                if (file.before) {
                    const revision = await this.files.update(destination, async (original) => {
                        if (hash(original) !== file.before) {
                            throw new Error(
                                localize(
                                    'mix.error.externalChange',
                                    'The file changed outside this operation. Refresh and try again.'
                                )
                            );
                        }
                        return file.bytes;
                    });
                    if (revision) {
                        undo.push({
                            canRun: () => this.files.canUndo(destination, revision),
                            run: () => this.files.undo(destination, revision),
                        });
                    }
                } else {
                    const temp = destination + '.ra2-' + randomUUID() + '.tmp';
                    try {
                        await fs.writeFile(temp, file.bytes, { flag: 'wx' });
                        await fs.link(temp, destination);
                    } finally {
                        await fs.unlink(temp).catch(() => undefined);
                    }
                    undo.push({
                        run: async () => {
                            if (hash(await fs.readFile(destination)) !== hash(file.bytes)) {
                                throw new Error(
                                    localize(
                                        'mix.error.undoChanged',
                                        'Cannot undo: the file has changed since this operation. The backup is still available beside the file.'
                                    )
                                );
                            }
                            await fs.unlink(destination);
                        },
                    });
                }
            }
            const sourceDeletes = new Map<string, MixMutation[]>();
            if (plan.move) {
                for (const file of selected) {
                    if (file.source.scheme !== MixUriCodec.scheme) {
                        continue;
                    }
                    const root = MixUriCodec.decode(file.source).containerUri.toString(),
                        group = grouped.get(root) ?? sourceDeletes.get(root) ?? [];
                    group.push({ kind: 'delete', uri: file.source, recursive: false, expected: hash(file.bytes) });
                    if (!grouped.has(root)) {
                        sourceDeletes.set(root, group);
                    }
                }
            }
            for (const [root, operations] of grouped) {
                if (token?.isCancellationRequested) {
                    throw new vscode.CancellationError();
                }
                const revision = await this.mix.mutate(operations);
                if (revision) {
                    undo.push({
                        canRun: () => this.mix.canUndo(vscode.Uri.parse(root), revision),
                        run: () => this.mix.undo(vscode.Uri.parse(root), revision),
                    });
                }
            }
            this.locations.clear();
            // Delete sources only after every target is committed. Same-root moves are already in that single transaction.
            for (const [root, operations] of sourceDeletes) {
                const revision = await this.mix.mutate(operations);
                if (revision) {
                    undo.push({
                        canRun: () => this.mix.canUndo(vscode.Uri.parse(root), revision),
                        run: () => this.mix.undo(vscode.Uri.parse(root), revision),
                    });
                }
            }
            if (plan.move) {
                const movedDirectories: vscode.Uri[] = [];
                for (const source of plan.sources.filter((uri) => uri.scheme === 'file')) {
                    if (
                        !((await this.locations.stat(source)).type & vscode.FileType.Directory) ||
                        plan.files.some(
                            (file) =>
                                file.skip && file.source.path.toLowerCase().startsWith(source.path.toLowerCase() + '/')
                        )
                    ) {
                        continue;
                    }
                    for (const file of selected.filter(
                        (file) =>
                            file.source.scheme === 'file' &&
                            file.source.path.toLowerCase().startsWith(source.path.toLowerCase() + '/')
                    )) {
                        if (hash(await fs.readFile(file.source.fsPath)) !== hash(file.bytes)) {
                            throw new Error(
                                localize(
                                    'mix.error.externalChange',
                                    'The file changed outside this operation. Refresh and try again.'
                                )
                            );
                        }
                    }
                    const recovery = source.fsPath + '.ra2-backup-' + randomUUID();
                    await fs.rename(source.fsPath, recovery);
                    movedDirectories.push(source);
                    undo.push({
                        run: async () => {
                            try {
                                await fs.lstat(source.fsPath);
                            } catch (error) {
                                if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                                    await fs.rename(recovery, source.fsPath);
                                    return;
                                }
                                throw error;
                            }
                            throw new Error(
                                localize(
                                    'mix.error.undoChanged',
                                    'Cannot undo: the file has changed since this operation. The backup is still available beside the file.'
                                )
                            );
                        },
                    });
                }
                for (const file of selected.filter(
                    (file) =>
                        file.source.scheme === 'file' &&
                        !movedDirectories.some((source) =>
                            file.source.path.toLowerCase().startsWith(source.path.toLowerCase() + '/')
                        )
                )) {
                    if (hash(await fs.readFile(file.source.fsPath)) !== hash(file.bytes)) {
                        throw new Error(
                            localize(
                                'mix.error.externalChange',
                                'The file changed outside this operation. Refresh and try again.'
                            )
                        );
                    }
                    const recovery = file.source.fsPath + '.ra2-backup-' + randomUUID();
                    await fs.rename(file.source.fsPath, recovery);
                    undo.push({
                        run: async () => {
                            try {
                                await fs.link(recovery, file.source.fsPath);
                            } catch {
                                throw new Error(
                                    localize(
                                        'mix.error.undoChanged',
                                        'Cannot undo: the file has changed since this operation. The backup is still available beside the file.'
                                    )
                                );
                            }
                        },
                    });
                }
            }
            this.history.push({
                steps: undo,
                uris: selected.flatMap((file) => (plan.move ? [file.source, file.target] : [file.target])),
            });
            if (this.history.length > 20) {
                this.history.shift();
            }
        } catch (error) {
            const recoveryErrors: unknown[] = [];
            for (const step of [...undo].reverse()) {
                try {
                    await step.run();
                } catch (recoveryError) {
                    recoveryErrors.push(recoveryError);
                }
            }
            if (recoveryErrors.length) {
                throw new Error(
                    localize(
                        'mix.browser.recoveryError',
                        'Operation failed and recovery needs attention. Backup files remain beside their originals. {0}',
                        String(error)
                    )
                );
            }
            throw error;
        } finally {
            this.locations.clear();
        }
    }

    public get canUndo(): boolean {
        return !!this.history.length && this.history.at(-1)!.steps.every((step) => step.canRun?.() ?? true);
    }
    private assertSaved(sources: readonly vscode.Uri[]): void {
        const affected = (source: vscode.Uri, document: vscode.Uri): boolean => {
            if (
                identity(source) === identity(document) ||
                (source.scheme === document.scheme &&
                    source.query === document.query &&
                    document.path.toLowerCase().startsWith(source.path.toLowerCase() + '/'))
            ) {
                return true;
            }
            if (document.scheme !== MixUriCodec.scheme) {
                return false;
            }
            const address = MixUriCodec.decode(document);
            if (source.scheme === 'file') {
                return (
                    identity(source) === identity(address.containerUri) ||
                    address.containerUri.path.toLowerCase().startsWith(source.path.toLowerCase() + '/')
                );
            }
            if (source.scheme !== MixUriCodec.scheme) {
                return false;
            }
            const origin = MixUriCodec.decode(source);
            return (
                identity(origin.containerUri) === identity(address.containerUri) &&
                origin.nestedChain.every((segment, index) => address.nestedChain[index] === segment) &&
                (origin.virtualPath === '/' ||
                    address.nestedChain[origin.nestedChain.length] === origin.virtualPath.slice(1))
            );
        };
        if (
            vscode.workspace.textDocuments.some(
                (document) => document.isDirty && sources.some((source) => affected(source, document.uri))
            )
        ) {
            throw new Error(
                localize(
                    'mix.browser.unsaved',
                    'Save or revert the open INI changes before moving, deleting, renaming or replacing their file/container.'
                )
            );
        }
    }
    private async assertDestination(root: vscode.Uri, target: vscode.Uri): Promise<void> {
        if (root.scheme !== 'file' || target.scheme !== 'file') {
            throw new Error(localize('mix.browser.localOnly', 'Archive operations require local files.'));
        }
        const base = await fs.realpath(root.fsPath);
        let parent = path.dirname(target.fsPath);
        while (true) {
            try {
                const resolved = await fs.realpath(parent),
                    relative = path.relative(base, resolved);
                if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
                    throw new Error(
                        localize(
                            'mix.browser.outsideRoot',
                            'The destination crosses a symbolic link outside the selected folder.'
                        )
                    );
                }
                return;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                    throw error;
                }
                const next = path.dirname(parent);
                if (next === parent) {
                    throw error;
                }
                parent = next;
            }
        }
    }
    public async remove(sources: readonly vscode.Uri[]): Promise<void> {
        this.assertSaved(sources);
        const groups = new Map<string, MixMutation[]>(),
            steps: UndoStep[] = [];
        try {
            for (const source of sources) {
                if (source.scheme === MixUriCodec.scheme) {
                    if (source.path === '/') {
                        throw new Error(localize('mix.error.renameRoot', 'The MIX root directory cannot be renamed.'));
                    }
                    const root = MixUriCodec.decode(source).containerUri.toString(),
                        group = groups.get(root) ?? [];
                    group.push({ kind: 'delete', uri: source, recursive: true });
                    groups.set(root, group);
                } else {
                    const recovery = source.fsPath + '.ra2-backup-' + randomUUID();
                    await fs.rename(source.fsPath, recovery);
                    steps.push({
                        run: async () => {
                            try {
                                await fs.lstat(source.fsPath);
                            } catch (error) {
                                if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                                    await fs.rename(recovery, source.fsPath);
                                    return;
                                }
                                throw error;
                            }
                            throw new Error(
                                localize(
                                    'mix.error.undoChanged',
                                    'Cannot undo: the file has changed since this operation. The backup is still available beside the file.'
                                )
                            );
                        },
                    });
                }
            }
            for (const [root, operations] of groups) {
                const revision = await this.mix.mutate(operations);
                if (revision) {
                    steps.push({
                        canRun: () => this.mix.canUndo(vscode.Uri.parse(root), revision),
                        run: () => this.mix.undo(vscode.Uri.parse(root), revision),
                    });
                }
            }
            this.history.push({ steps, uris: [...sources] });
        } catch (error) {
            for (const step of steps.reverse()) {
                await step.run();
            }
            throw error;
        } finally {
            this.locations.clear();
        }
    }

    public async rename(source: vscode.Uri, target: vscode.Uri): Promise<void> {
        this.assertSaved([source, target]);
        if (source.scheme === MixUriCodec.scheme) {
            const revision = await this.mix.mutate([{ kind: 'rename', uri: source, target, overwrite: false }]);
            if (revision) {
                this.history.push({
                    steps: [
                        {
                            canRun: () => this.mix.canUndo(source, revision),
                            run: () => this.mix.undo(source, revision),
                        },
                    ],
                    uris: [source, target],
                });
            }
        } else {
            await vscode.workspace.fs.rename(source, target, { overwrite: false });
            this.history.push({
                steps: [
                    {
                        run: async () => {
                            await vscode.workspace.fs.rename(target, source, { overwrite: false });
                        },
                    },
                ],
                uris: [source, target],
            });
        }
        this.locations.clear();
    }

    public async createArchive(target: vscode.Uri): Promise<void> {
        const bytes = (await MixArchive.create()).serialize();
        if (target.scheme === MixUriCodec.scheme) {
            const revision = await this.mix.mutate([
                { kind: 'write', uri: target, content: bytes, create: true, overwrite: false },
            ]);
            if (revision) {
                this.history.push({
                    steps: [
                        {
                            canRun: () => this.mix.canUndo(target, revision),
                            run: () => this.mix.undo(target, revision),
                        },
                    ],
                    uris: [target],
                });
            }
        } else {
            await fs.writeFile(target.fsPath, bytes, { flag: 'wx' });
            this.history.push({
                steps: [
                    {
                        run: async () => {
                            if (hash(await fs.readFile(target.fsPath)) !== hash(bytes)) {
                                throw new Error(
                                    localize(
                                        'mix.error.undoChanged',
                                        'Cannot undo: the file has changed since this operation. The backup is still available beside the file.'
                                    )
                                );
                            }
                            await fs.unlink(target.fsPath);
                        },
                    },
                ],
                uris: [target],
            });
        }
        this.locations.clear();
    }
    public async undo(): Promise<void> {
        const action = this.history.at(-1);
        if (!action) {
            return;
        }
        this.assertSaved(action.uris);
        const steps = action.steps;
        while (steps.length) {
            await steps.at(-1)!.run();
            steps.pop();
        }
        this.history.pop();
        this.locations.clear();
    }
}
