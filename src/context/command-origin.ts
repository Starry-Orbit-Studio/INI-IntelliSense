import * as vscode from 'vscode';

/** View-title commands receive a view context, not necessarily a resource URI. */
export function commandOrigin(value?: unknown): vscode.Uri | undefined {
    if (value instanceof vscode.Uri) {
        return value;
    }
    if (value && typeof value === 'object') {
        const item = value as { origin?: unknown; resourceUri?: unknown };
        if (item.origin instanceof vscode.Uri) {
            return item.origin;
        }
        if (item.resourceUri instanceof vscode.Uri) {
            return item.resourceUri;
        }
    }
    return vscode.window.activeTextEditor?.document.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
}
