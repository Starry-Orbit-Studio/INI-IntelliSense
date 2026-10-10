import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { localize } from '../i18n';

export function workbenchHtml(webview: vscode.Webview, extension: vscode.Uri): string {
    const nonce = randomBytes(18).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(extension, 'dist', 'workbench', 'main.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(extension, 'dist', 'workbench', 'main.css'));
    const worker = webview.asWebviewUri(vscode.Uri.joinPath(extension, 'dist', 'workbench', 'worker.js'));
    const title = localize('workbench.title', 'Object Inspector');
    return (
        '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src ' +
        webview.cspSource +
        ' data: blob:; media-src blob:; connect-src ' +
        webview.cspSource +
        "; worker-src blob:; script-src 'nonce-" +
        nonce +
        "'; style-src " +
        webview.cspSource +
        ';">' +
        '<link rel="stylesheet" href="' +
        style +
        '"><title>' +
        title +
        '</title></head><body>' +
        '<main id="app" aria-live="polite"></main><script nonce="' +
        nonce +
        '" src="' +
        script +
        '" data-worker="' +
        worker +
        '"></script></body></html>'
    );
}
