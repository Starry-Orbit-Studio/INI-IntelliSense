import * as path from 'path';
import * as vscode from 'vscode';
import { localize } from '../i18n';
import { MixUriCodec } from '../mix/fs/mix-uri-codec';

export class ImportExportService {
    public async importIntoMix(targetDir: vscode.Uri, sourceUris: readonly vscode.Uri[]): Promise<void> {
        for (const sourceUri of sourceUris) {
            const stat = await vscode.workspace.fs.stat(sourceUri);
            if (stat.type & vscode.FileType.Directory) {
                await this.importDirectory(targetDir, sourceUri);
                continue;
            }

            const targetUri = MixUriCodec.toChildUri(targetDir, path.posix.join(targetDir.path, path.posix.basename(sourceUri.path)));
            const content = await vscode.workspace.fs.readFile(sourceUri);
            await vscode.workspace.fs.writeFile(targetUri, content);
        }
    }

    public async exportFromMix(sourceUris: readonly vscode.Uri[]): Promise<void> {
        const targetRoot = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: localize('mix.export.selectFolder', 'Select export folder'),
        });
        if (!targetRoot?.[0]) {
            return;
        }

        for (const sourceUri of sourceUris) {
            const stat = await vscode.workspace.fs.stat(sourceUri);
            const targetUri = vscode.Uri.joinPath(targetRoot[0], path.posix.basename(sourceUri.path));
            if (stat.type & vscode.FileType.Directory) {
                await this.exportDirectory(sourceUri, targetUri);
            } else {
                const bytes = await vscode.workspace.fs.readFile(sourceUri);
                await vscode.workspace.fs.writeFile(targetUri, bytes);
            }
        }
    }

    private async importDirectory(targetDir: vscode.Uri, sourceDir: vscode.Uri): Promise<void> {
        const targetUri = MixUriCodec.toChildUri(targetDir, path.posix.join(targetDir.path, path.basename(sourceDir.path)));
        await vscode.workspace.fs.createDirectory(targetUri);
        const entries = await vscode.workspace.fs.readDirectory(sourceDir);
        for (const [name, type] of entries) {
            const childSourceUri = vscode.Uri.joinPath(sourceDir, name);
            if (type & vscode.FileType.Directory) {
                await this.importDirectory(targetUri, childSourceUri);
                continue;
            }

            const childTargetUri = MixUriCodec.toChildUri(targetUri, path.posix.join(targetUri.path, name));
            const content = await vscode.workspace.fs.readFile(childSourceUri);
            await vscode.workspace.fs.writeFile(childTargetUri, content);
        }
    }

    private async exportDirectory(sourceDir: vscode.Uri, targetDir: vscode.Uri): Promise<void> {
        await vscode.workspace.fs.createDirectory(targetDir);
        const entries = await vscode.workspace.fs.readDirectory(sourceDir);
        for (const [name, type] of entries) {
            const childSourceUri = vscode.Uri.joinPath(sourceDir, name);
            const childTargetUri = vscode.Uri.joinPath(targetDir, name);
            if (type & vscode.FileType.Directory) {
                await this.exportDirectory(childSourceUri, childTargetUri);
                continue;
            }

            const content = await vscode.workspace.fs.readFile(childSourceUri);
            await vscode.workspace.fs.writeFile(childTargetUri, content);
        }
    }
}
