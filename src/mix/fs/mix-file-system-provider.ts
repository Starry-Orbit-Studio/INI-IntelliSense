import * as vscode from 'vscode';
import { MixWorkspaceManager } from './mix-workspace-manager';

export class MixFileSystemProvider implements vscode.FileSystemProvider {
    public readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]>;

    constructor(private readonly manager: MixWorkspaceManager) {
        this.onDidChangeFile = manager.onDidChangeFile;
    }

    public watch(uri: vscode.Uri, options: { readonly recursive: boolean; readonly excludes: readonly string[] }): vscode.Disposable {
        return this.manager.watch(uri, options);
    }

    public stat(uri: vscode.Uri): Thenable<vscode.FileStat> {
        return this.manager.stat(uri);
    }

    public readDirectory(uri: vscode.Uri): Thenable<[string, vscode.FileType][]> {
        return this.manager.readDirectory(uri);
    }

    public createDirectory(uri: vscode.Uri): Thenable<void> {
        return this.manager.createDirectory(uri);
    }

    public readFile(uri: vscode.Uri): Thenable<Uint8Array> {
        return this.manager.readFile(uri);
    }

    public writeFile(uri: vscode.Uri, content: Uint8Array, options: { readonly create: boolean; readonly overwrite: boolean }): Thenable<void> {
        return this.manager.writeFile(uri, content, options);
    }

    public delete(uri: vscode.Uri, options: { readonly recursive: boolean }): Thenable<void> {
        return this.manager.delete(uri, options);
    }

    public rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { readonly overwrite: boolean }): Thenable<void> {
        return this.manager.rename(oldUri, newUri, options);
    }
}
