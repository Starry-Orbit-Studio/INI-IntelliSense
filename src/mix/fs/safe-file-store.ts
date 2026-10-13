import * as fs from 'fs/promises';
import * as path from 'path';
import { createReadStream } from 'fs';
import { createHash, randomUUID } from 'crypto';
import { localize } from '../../i18n';

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function fileDigest(file: string): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) {
        hash.update(chunk);
    }
    return hash.digest('hex');
}
interface Revision {
    id: string;
    backup: string;
    before: string;
    after: string;
}
export interface BackupPolicy {
    count: number;
    maxBytes: number;
}

/** Serialized, optimistic file replacement. Originals remain recoverable beside the file. */
export class SafeFileStore {
    private readonly queues = new Map<string, Promise<unknown>>();
    private readonly history = new Map<string, Revision[]>();
    constructor(
        private readonly policy: (file: string) => BackupPolicy = () => ({ count: 5, maxBytes: 1024 * 1024 * 1024 })
    ) {}

    public async update(file: string, change: (bytes: Uint8Array) => Promise<Uint8Array>): Promise<string | undefined> {
        const key = path.resolve(file).toLowerCase();
        const previous = this.queues.get(key) ?? Promise.resolve();
        const task = previous
            .catch(() => undefined)
            .then(async () => {
                const lockPath = file + '.ra2-workbench.lock';
                const lock = await fs.open(lockPath, 'wx').catch(() => {
                    throw new Error(
                        localize(
                            'mix.error.locked',
                            'Another operation is using this archive. If a previous process crashed, remove its .ra2-workbench.lock file after checking the backup.'
                        )
                    );
                });
                const temp = path.join(path.dirname(file), '.' + path.basename(file) + '.ra2-' + randomUUID() + '.tmp');
                let backup: string | undefined;
                try {
                    const stat = await fs.lstat(file);
                    if (stat.isSymbolicLink()) {
                        throw new Error(
                            localize(
                                'mix.browser.symlink',
                                'Symbolic links are not imported. Select their actual files.'
                            )
                        );
                    }
                    const original = await fs.readFile(file);
                    const before = digest(original),
                        next = await change(original),
                        after = digest(next);
                    if (after === before) {
                        return;
                    }
                    const handle = await fs.open(temp, 'wx', stat.mode);
                    try {
                        await handle.writeFile(next);
                        await handle.sync();
                    } finally {
                        await handle.close();
                    }
                    if ((await fileDigest(temp)) !== after) {
                        throw new Error(localize('mix.error.verifyWrite', 'Written file failed verification.'));
                    }
                    if ((await fileDigest(file)) !== before) {
                        throw new Error(
                            localize(
                                'mix.error.externalChange',
                                'The file changed outside this operation. Refresh and try again.'
                            )
                        );
                    }
                    backup = file + '.ra2-backup-' + randomUUID();
                    await fs.copyFile(file, backup, fs.constants.COPYFILE_EXCL);
                    if ((await fileDigest(backup)) !== before || (await fileDigest(file)) !== before) {
                        throw new Error(
                            localize(
                                'mix.error.externalChange',
                                'The file changed outside this operation. Refresh and try again.'
                            )
                        );
                    }
                    // rename replaces the destination on Windows too; never delete the original first.
                    await fs.rename(temp, file);
                    const revisions = this.history.get(key) ?? [];
                    revisions.push({ id: backup, backup, before, after });
                    this.history.set(key, revisions);
                    try {
                        await this.prune(file, key, backup);
                    } catch (error) {
                        console.error('[MIX backup cleanup]', error);
                    }
                    return backup;
                } finally {
                    await fs.unlink(temp).catch(() => undefined);
                    await lock.close();
                    await fs.unlink(lockPath).catch(() => undefined);
                }
            });
        this.queues.set(key, task);
        try {
            return await task;
        } finally {
            if (this.queues.get(key) === task) {
                this.queues.delete(key);
            }
        }
    }

    public canUndo(file: string, revision?: string): boolean {
        const latest = this.history.get(path.resolve(file).toLowerCase())?.at(-1);
        return !!latest && (revision === undefined || latest.id === revision);
    }

    private async prune(file: string, key: string, latest: string): Promise<void> {
        const policy = this.policy(file),
            prefix = path.basename(file) + '.ra2-backup-';
        const candidates = (await fs.readdir(path.dirname(file))).filter(
            (name) =>
                name.startsWith(prefix) &&
                /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name.slice(prefix.length))
        );
        const backups = await Promise.all(
            candidates.map(async (name) => {
                const backup = path.join(path.dirname(file), name);
                return { backup, stat: await fs.stat(backup) };
            })
        );
        backups.sort((a, b) => (a.backup === latest ? -1 : b.backup === latest ? 1 : b.stat.mtimeMs - a.stat.mtimeMs));
        let total = 0;
        const retained = new Set<string>();
        for (const [index, item] of backups.entries()) {
            if (index === 0 || (index < Math.max(1, policy.count) && total + item.stat.size <= policy.maxBytes)) {
                total += item.stat.size;
                retained.add(item.backup);
            } else {
                await fs.unlink(item.backup);
            }
        }
        this.history.set(
            key,
            (this.history.get(key) ?? []).filter((revision) => retained.has(revision.backup))
        );
    }

    public async undo(file: string, expectedRevision?: string): Promise<void> {
        const key = path.resolve(file).toLowerCase(),
            revisions = this.history.get(key),
            revision = revisions?.at(-1);
        if (!revision) {
            if (expectedRevision) {
                throw new Error(
                    localize(
                        'mix.error.undoChanged',
                        'Cannot undo: the file has changed since this operation. The backup is still available beside the file.'
                    )
                );
            }
            return;
        }
        await this.update(file, async (bytes) => {
            if (
                this.history.get(key)?.at(-1)?.id !== revision.id ||
                (expectedRevision !== undefined && revision.id !== expectedRevision) ||
                digest(bytes) !== revision.after
            ) {
                throw new Error(
                    localize(
                        'mix.error.undoChanged',
                        'Cannot undo: the file has changed since this operation. The backup is still available beside the file.'
                    )
                );
            }
            const original = await fs.readFile(revision.backup);
            if (digest(original) !== revision.before) {
                throw new Error(
                    localize(
                        'mix.error.undoChanged',
                        'Cannot undo: the file has changed since this operation. The backup is still available beside the file.'
                    )
                );
            }
            return original;
        });
        // update creates a recovery copy of the undone version; retain it on disk, not in the undo stack.
        const current = this.history.get(key)!;
        current.pop();
        current.pop();
    }
}
