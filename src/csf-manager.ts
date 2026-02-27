// 新文件：负责 CSF 文件的二进制解析、管理与查询
import * as vscode from 'vscode';
import * as fs from 'fs/promises';

export interface CsfEntry {
    label: string;
    value: string;
    extraValue?: string;
}

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
        this.watcher.onDidChange(uri => this.reloadFile(uri));
        this.watcher.onDidCreate(uri => this.reloadFile(uri));
        this.watcher.onDidDelete(uri => this.removeFile(uri));
        
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
            const buffer = await fs.readFile(uri.fsPath);
            const content = buffer.toString('utf-8');
            if (uri.fsPath.toLowerCase().endsWith('.llf')) {
                this.parseLlf(content, uri.fsPath);
            } else {
                this.parseCsf(buffer, uri.fsPath);
            }
        } catch (e) {
            console.error(`Failed to parse file ${uri.fsPath}:`, e);
        }
    }

    private removeFile(uri: vscode.Uri) {
        // CSF 移除比较麻烦，因为我们目前是合并存储的。
        // 简单起见，每次变动都建议重扫，但在性能敏感场景下，
        // 可以暂不处理移除，或者触发全量重建。
        // 这里为了严谨，选择全量重建。
        this.fileLabels.delete(uri.fsPath);
        this.mergedLabels.clear();
        this.indexWorkspaceFiles();
    }

    /**
     * 解析LLF文件
     */
    private parseLlf(content: string, filePath: string) {
        const fileEntries = new Map<string, CsfEntry>();
        const lines = content.split('\n');
        let currentLabel = '';
        let currentValue = '';
        let isMultiline = false;
        let inMultilineBlock = false;

        for (let line of lines) {
            line = line.replace(/\r$/, '');

            if (line.trim() === '') {
                continue;
            }

            if (inMultilineBlock) {
                if (line.startsWith('  ')) {
                    currentValue += '\n' + line.substring(2);
                } else {
                    const entry: CsfEntry = {
                        label: currentLabel,
                        value: currentValue
                    };
                    fileEntries.set(currentLabel.toLowerCase(), entry);
                    this.mergedLabels.set(currentLabel.toLowerCase(), entry);
                    inMultilineBlock = false;
                    currentLabel = '';
                    currentValue = '';
                }
                continue;
            }

            const commentIndex = line.indexOf('#');
            if (commentIndex !== -1) {
                const beforeComment = line.substring(0, commentIndex);
                if (beforeComment.trim() === '') {
                    continue;
                }
                line = beforeComment;
            }

            const separatorIndex = line.indexOf(': ');
            if (separatorIndex !== -1) {
                currentLabel = line.substring(0, separatorIndex).trim();
                let valuePart = line.substring(separatorIndex + 2).trim();

                if (valuePart.startsWith('>')) {
                    isMultiline = true;
                    valuePart = valuePart.substring(1).trim();
                }

                if (isMultiline) {
                    inMultilineBlock = true;
                    currentValue = valuePart;
                } else {
                    const entry: CsfEntry = {
                        label: currentLabel,
                        value: valuePart
                    };
                    fileEntries.set(currentLabel.toLowerCase(), entry);
                    this.mergedLabels.set(currentLabel.toLowerCase(), entry);
                }
                isMultiline = false;
            }
        }

        if (inMultilineBlock && currentLabel && currentValue) {
            const entry: CsfEntry = {
                label: currentLabel,
                value: currentValue
            };
            fileEntries.set(currentLabel.toLowerCase(), entry);
            this.mergedLabels.set(currentLabel.toLowerCase(), entry);
        }

        this.fileLabels.set(filePath, fileEntries);
    }

    /**
     * 核心解析逻辑：移植自 C++ QDataStream 实现
     */
    private parseCsf(buffer: Buffer, filePath: string) {
        let offset = 0;

        // Helper: 读取 4 字节整数 (Little Endian)
        const readInt32 = () => {
            const val = buffer.readInt32LE(offset);
            offset += 4;
            return val;
        };

        // Helper: 读取固定长度字符串 (ASCII)
        const readStringFixed = (len: number) => {
            const str = buffer.toString('ascii', offset, offset + len);
            offset += len;
            return str;
        };

        // 1. Header Check
        if (offset + 4 > buffer.length) { return; }
        const fileId = readStringFixed(4);
        if (fileId !== ' FSC') { return; } // " FSC"

        const version = readInt32();
        const numLabels = readInt32();
        const numStrings = readInt32();
        offset += 4; // skip unused
        const language = readInt32();

        // 创建当前文件的标签映射
        const fileEntries = new Map<string, CsfEntry>();

        // 2. Loop Labels
        for (let i = 0; i < numLabels; i++) {
            if (offset + 4 > buffer.length) { break; }
            
            const labelId = readStringFixed(4);
            if (labelId !== ' LBL') { break; }

            const numPairs = readInt32();
            const labelLen = readInt32();
            const labelName = readStringFixed(labelLen);

            for (let j = 0; j < numPairs; j++) {
                if (offset + 4 > buffer.length) { break; }
                const valueId = readStringFixed(4); // " RTS" or "WRTS"
                
                if (valueId !== ' RTS' && valueId !== 'WRTS') { break; }

                const valueLen = readInt32();
                // 解码字符串值 (Unicode XOR 0xFFFF)
                const value = this.decodeCsfString(buffer, offset, valueLen);
                offset += valueLen * 2;

                let extraValue: string | undefined;
                if (valueId === 'WRTS') {
                    const extraLen = readInt32();
                    extraValue = buffer.toString('ascii', offset, offset + extraLen);
                    offset += extraLen;
                }

                const entry: CsfEntry = {
                    label: labelName,
                    value,
                    extraValue
                };

                // 存储到文件映射
                fileEntries.set(labelName.toLowerCase(), entry);
                // 存储到合并映射（后加载覆盖先加载）
                this.mergedLabels.set(labelName.toLowerCase(), entry);
            }
        }

        // 更新文件标签映射
        this.fileLabels.set(filePath, fileEntries);
    }

    private decodeCsfString(buffer: Buffer, start: number, len: number): string {
        let result = '';
        for (let i = 0; i < len; i++) {
            // 读取 uint16，然后按位取反 (XOR 0xFFFF 等价于 Bitwise NOT for uint16)
            const charCode = buffer.readUInt16LE(start + i * 2);
            // 注意：C++代码中是 val ^= 0xFFFF。在 JS 中 ~charCode 会变成 32位有符号整数
            // 所以还是用异或比较稳妥
            const decodedChar = charCode ^ 0xFFFF; 
            result += String.fromCharCode(decodedChar);
        }
        return result;
    }

    // 公共方法，用于树状视图
    public getLabelsByFile(uri: vscode.Uri): Map<string, CsfEntry> | undefined {
        return this.fileLabels.get(uri.fsPath);
    }

    public getFiles(): string[] {
        return Array.from(this.fileLabels.keys());
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