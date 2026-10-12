
import * as vscode from 'vscode';
import { INIManager } from './parser';
import { SchemaManager } from './schema-manager';
import { FileTypeManager } from './file-type-manager';
import { ProjectIni } from './context/project-ini';

/**
 * 负责检测并高亮显示覆盖了父类键的子类键。
 */
export class OverrideDecorator implements vscode.Disposable {
    public project?: ProjectIni;
    private decorationType: vscode.TextEditorDecorationType;
    private timeout: NodeJS.Timeout | undefined = undefined;
    private allEditorsTimeout: NodeJS.Timeout | undefined;
    private disposables: vscode.Disposable[] = [];
    private isEnabled = true;

    constructor(
        private context: vscode.ExtensionContext,
        private iniManager: INIManager,
        private schemaManager: SchemaManager,
        private fileTypeManager: FileTypeManager
    ) {
        this.decorationType = this.createDecoration();
        this.updateEnabledStatus();

        // onDidChangeTextDocument 和 onDidChangeTextEditorVisibleRanges 由 extension.ts 统一调度，
        // 此处不再重复注册，避免同一事件触发两遍装饰更新。
        this.disposables.push(vscode.window.onDidChangeActiveTextEditor(editor => {
            if (editor && this.isEnabled) {
                this.triggerUpdateDecorations(editor);
            }
        }));
    }

    private createDecoration(): vscode.TextEditorDecorationType {
        return vscode.window.createTextEditorDecorationType({
            gutterIconPath: this.context.asAbsolutePath('assets/override-icon.svg'),
            gutterIconSize: 'contain',
        });
    }

    private updateEnabledStatus() {
        this.isEnabled = vscode.workspace.getConfiguration('ra2-ini-intellisense.decorations.overrideIndicator').get('enabled', true);
    }

    public reload() {
        this.updateEnabledStatus();
        this.decorationType.dispose();
        this.decorationType = this.createDecoration();
        this.triggerUpdateDecorationsForAllVisibleEditors();
    }

    public triggerUpdateDecorationsForAllVisibleEditors() {
        if (this.allEditorsTimeout) {
            clearTimeout(this.allEditorsTimeout);
        }
        this.allEditorsTimeout = setTimeout(() => {
            vscode.window.visibleTextEditors.forEach(editor => {
                if (editor.document.languageId === 'ra2-ini') {
                    this.triggerUpdateDecorations(editor);
                }
            });
            this.allEditorsTimeout = undefined;
        }, 100);
    }

    // 修改：不再只接受 URI，而是直接接受 Editor 对象，因为我们需要获取可见范围
    public triggerUpdateDecorations(editor: vscode.TextEditor | undefined, throttle = false) {
        if (!editor) {
            return;
        }

        if (this.timeout) {
            clearTimeout(this.timeout);
        }

        const callback = () => {
            void this.updateDecorations(editor!).catch(error => console.error('[Override indicator]', error));
        };

        if (throttle) {
            this.timeout = setTimeout(callback, 100); // 稍微缩短防抖时间，提高响应速度
        } else {
            callback();
        }
    }

    /**
     * 核心更新逻辑：仅扫描可见范围并应用装饰。
     */
    private async updateDecorations(editor: vscode.TextEditor) {
        const enabled = vscode.workspace.getConfiguration('ra2-ini-intellisense', editor.document.uri).get('decorations.overrideIndicator.enabled', true);
        if (!enabled || !this.schemaManager.isSchemaLoaded()) {
            editor.setDecorations(this.decorationType, []);
            return;
        }
        
        const document = editor.document, version = document.version;
        await this.project?.load(document.uri);
        if (document.isClosed || document.version !== version) { return; }
        const overrideDecorations: vscode.DecorationOptions[] = [];
        
        const sectionRegex = /^\s*\[([^\]:]+)\]/;
        const kvRegex = /^\s*([a-zA-Z0-9_\-\.]+)\s*=/;
        
        // 获取当前文件的类型，用于在查找父类时进行过滤
        const currentFileType = this.fileTypeManager.getFileType(document.uri);

        // 遍历所有可见范围（通常只有一个，但分屏或折叠时可能有多个）
        for (const range of editor.visibleRanges) {
            const startLine = range.start.line;
            const endLine = range.end.line;

            // 为了正确获取当前节的上下文，我们需要从可见范围的顶部向上回溯，找到最近的节头
            let currentSectionName: string | null = null;
            for (let i = startLine; i >= 0; i--) {
                const lineText = document.lineAt(i).text;
                const match = lineText.match(sectionRegex);
                if (match) {
                    currentSectionName = match[1].trim();
                    break;
                }
            }

            // 只要当前行仍在同一个节内，就保持这个节名
            // 开始扫描可见行
            for (let i = startLine; i <= endLine; i++) {
                const line = document.lineAt(i);
                const text = line.text;

                if (!text.trim() || text.trim().startsWith(';')) {
                    continue;
                }

                const sectionMatch = text.match(sectionRegex);
                if (sectionMatch) {
                    currentSectionName = sectionMatch[1].trim();
                    continue;
                }

                if (currentSectionName) {
                    const kvMatch = text.match(kvRegex);
                    if (kvMatch) {
                        const key = kvMatch[1].trim();
                        // 性能瓶颈点：这里只对可见的几十行进行查找，速度极快
                        const inherited = this.project?.explain(document.uri, currentSectionName, currentFileType).get(key.toLowerCase())?.declarations.some(property => property.inherited);
                        const parentKeyInfo = this.project ? { location: inherited } : this.iniManager.findInheritedKeyLocation(currentSectionName, key, currentFileType);
                        
                        if (parentKeyInfo.location) {
                            const keyStartIndex = text.indexOf(key);
                            if (keyStartIndex !== -1) {
                                const decorationRange = new vscode.Range(i, keyStartIndex, i, keyStartIndex + key.length);
                                overrideDecorations.push({ range: decorationRange });
                            }
                        }
                    }
                }
            }
        }
        
        editor.setDecorations(this.decorationType, overrideDecorations);
    }
    
    public dispose() {
        if (this.timeout) {
            clearTimeout(this.timeout);
        }
        if (this.allEditorsTimeout) {
            clearTimeout(this.allEditorsTimeout);
        }
        this.decorationType.dispose();
        this.disposables.forEach(d => d.dispose());
    }
}
