import * as path from 'path';
import * as vscode from 'vscode';

export class ResourcePath {
    public static basename(uri: vscode.Uri): string {
        if (uri.scheme === 'file') {
            return path.basename(uri.fsPath);
        }
        return path.posix.basename(uri.path);
    }

    public static extname(uri: vscode.Uri): string {
        const name = ResourcePath.basename(uri);
        return path.extname(name);
    }

    public static relativeToWorkspace(uri: vscode.Uri): string {
        const relative = vscode.workspace.asRelativePath(uri, false);
        if (relative && relative !== uri.toString()) {
            return relative;
        }
        if (uri.scheme === 'file') {
            return uri.fsPath;
        }
        return uri.path;
    }
}
