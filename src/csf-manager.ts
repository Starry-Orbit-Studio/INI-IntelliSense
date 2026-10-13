// 新文件：负责 CSF 文件的二进制解析、管理与查询
import * as vscode from 'vscode';
import { parseCsf, parseLlf, StringTableEntry } from './strings/string-table';

export type CsfEntry = StringTableEntry;

export class CsfManager {
    // 存储合并后的所有标签，key 转为小写以支持忽略大小写查找
    private mergedLabels: Map<string, CsfEntry> = new Map();
    // 按文件存储标签，外层key为文件路径，内层key为标签名（小写）
    private fileLabels: Map<string, Map<string, CsfEntry>> = new Map();
    private watcher: vscode.FileSystemWatcher;
    private _isInitialized = false;
    private initializationPromise: Promise<void> | null = null;

    constructor() {
        this.watcher = vscode.workspace.createFileSystemWatcher('**/*.{csf,llf}');
        this.watcher.onDidChange((uri) => this.reloadFile(uri));
        this.watcher.onDidCreate((uri) => this.reloadFile(uri));
        this.watcher.onDidDelete((uri) => this.removeFile(uri));

        // 初始扫描，但异步进行
        this.initializationPromise = this.indexWorkspaceFiles().then(() => {
            this._isInitialized = true;
        });
    }

    public async indexWorkspaceFiles() {
        const csfUris = await vscode.workspace.findFiles('**/*.csf');
        const llfUris = await vscode.workspace.findFiles('**/*.llf');
        const allUris = [...csfUris, ...llfUris];
        for (const uri of allUris) {
            await this.reloadFile(uri);
        }
    }

    public getLabel(labelName: string): CsfEntry | undefined {
        return this.mergedLabels.get(labelName.toLowerCase());
    }

    private async reloadFile(uri: vscode.Uri) {
        try {
            const buffer = await vscode.workspace.fs.readFile(uri);
            const table = uri.path.toLowerCase().endsWith('.llf')
                ? parseLlf(new TextDecoder().decode(buffer))
                : parseCsf(buffer);
            this.fileLabels.set(
                uri.toString(),
                new Map(table.entries.map((entry) => [entry.label.toLowerCase(), entry]))
            );
            this.rebuildLabels();
        } catch (e) {
            console.error(`Failed to parse file ${uri.fsPath}:`, e);
        }
    }

    private removeFile(uri: vscode.Uri) {
        this.fileLabels.delete(uri.toString());
        this.rebuildLabels();
    }

    private rebuildLabels(): void {
        this.mergedLabels.clear();
        for (const entries of this.fileLabels.values()) {
            for (const [key, entry] of entries) {
                this.mergedLabels.set(key, entry);
            }
        }
    }

    // 公共方法，用于树状视图
    public getLabelsByFile(uri: vscode.Uri): Map<string, CsfEntry> | undefined {
        return this.fileLabels.get(uri.toString());
    }

    public getFiles(): string[] {
        return Array.from(this.fileLabels.keys(), (key) => vscode.Uri.parse(key).fsPath);
    }

    public getEntryCount(): number {
        let count = 0;
        for (const fileMap of this.fileLabels.values()) {
            count += fileMap.size;
        }
        return count;
    }

    public async waitForInitialization(): Promise<void> {
        if (this.initializationPromise) {
            await this.initializationPromise;
        }
    }

    public isInitialized(): boolean {
        return this._isInitialized;
    }

    public getAllEntries(): CsfEntry[] {
        const entries: CsfEntry[] = [];
        for (const fileMap of this.fileLabels.values()) {
            for (const entry of fileMap.values()) {
                entries.push(entry);
            }
        }
        return entries;
    }
}
