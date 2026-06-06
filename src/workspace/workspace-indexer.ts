import * as vscode from 'vscode';

export interface WorkspaceIndexerOptions {
    includeExtensions: Set<string>;
    excludeGlobs: string[];
}

export class WorkspaceIndexer {
    public async collectFiles(rootUri: vscode.Uri, options: WorkspaceIndexerOptions): Promise<vscode.Uri[]> {
        const results: vscode.Uri[] = [];
        await this.walk(rootUri, options, results);
        return results;
    }

    private async walk(currentUri: vscode.Uri, options: WorkspaceIndexerOptions, results: vscode.Uri[]): Promise<void> {
        const entries = await vscode.workspace.fs.readDirectory(currentUri);
        for (const [name, type] of entries) {
            const childUri = vscode.Uri.joinPath(currentUri, name);
            if (type === vscode.FileType.Directory) {
                await this.walk(childUri, options, results);
                continue;
            }

            const ext = extensionOf(name);
            if (options.includeExtensions.has(ext)) {
                results.push(childUri);
            }
        }
    }
}

function extensionOf(name: string): string {
    const index = name.lastIndexOf('.');
    return index === -1 ? '' : name.slice(index).toLowerCase();
}
