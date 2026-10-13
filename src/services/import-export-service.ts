import * as vscode from 'vscode';
import { localize } from '../i18n';
import { BrowserTransfers } from '../mix/browser/transfers';

/** The legacy tree uses exactly the same planner, conflicts and transactions as the editor browser. */
export class ImportExportService {
    public transfers?: BrowserTransfers;

    private engine(): BrowserTransfers {
        if (!this.transfers) {
            throw new Error(
                localize('mix.error.notReady', 'The archive browser is still initializing. Try again shortly.')
            );
        }
        return this.transfers;
    }

    public async importIntoMix(targetDir: vscode.Uri, sourceUris: readonly vscode.Uri[]): Promise<void> {
        const engine = this.engine(),
            plan = await engine.plan(sourceUris, targetDir);
        if (await engine.resolve(plan)) {
            await engine.execute(plan);
        }
    }

    public async exportFromMix(sourceUris: readonly vscode.Uri[]): Promise<void> {
        const target = (
            await vscode.window.showOpenDialog({
                canSelectFiles: false,
                canSelectFolders: true,
                canSelectMany: false,
                openLabel: localize('mix.export.selectFolder', 'Select export folder'),
            })
        )?.[0];
        if (!target) {
            return;
        }
        const engine = this.engine(),
            plan = await engine.plan(sourceUris, target);
        if (await engine.resolve(plan)) {
            await engine.execute(plan);
        }
    }
}
