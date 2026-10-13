import * as vscode from 'vscode';
import { BackupPolicy } from './safe-file-store';

export function backupPolicy(file: string): BackupPolicy {
    const configuration = vscode.workspace.getConfiguration('ra2-ini-intellisense', vscode.Uri.file(file));
    const count = configuration.get<number>('mix.backupCount', 5),
        budget = configuration.get<number>('mix.backupBudgetMiB', 1024);
    return {
        count: Number.isFinite(count) ? Math.min(50, Math.max(1, count)) : 5,
        maxBytes: (Number.isFinite(budget) ? Math.min(8192, Math.max(128, budget)) : 1024) * 1024 * 1024,
    };
}
