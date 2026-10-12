import * as vscode from 'vscode';
import { INIManager } from './parser';
import { SchemaManager } from './schema-manager';
import { CsfManager } from './csf-manager';
import { ProjectIni } from './context/project-ini';
import { parsePropertyLine } from './context/ini-position';

/**
 * 负责在编辑器中为特定类型的值（如 bool）提供可视化的行内预览。
 * 采用高性能的视口扫描机制，支持未来扩展更多类型（如 CSF 预览）。
 */
export class ValuePreviewDecorator implements vscode.Disposable {
    /** CSF 预览文本的最大显示长度（含省略号），超过则截断 */
    private static readonly CSF_PREVIEW_MAX_LENGTH = 30;

    // 预定义装饰器样式：灰色、不可选中、右侧显示
    private boolTrueDecoration = vscode.window.createTextEditorDecorationType({
        after: { 
            contentText: '✔', 
            color: '#8FA68F88',
            backgroundColor: '#8FA68F15', // 背景
            margin: '0 0 0 6px'           // 间距
        },
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
    });
    
    private boolFalseDecoration = vscode.window.createTextEditorDecorationType({
        after: { 
            contentText: '✘', 
            color: '#A68F8F88',
            backgroundColor: '#A68F8F15', 
            margin: '0 0 0 6px'
        },
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
    });

    private csfPreviewDecoration = vscode.window.createTextEditorDecorationType({
        after: { 
            color: '#808080',             // 淡蓝色文本
            margin: '0 0 0 8px',
        },
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
    });

    public project?: ProjectIni;
    private timeout: NodeJS.Timeout | undefined = undefined;
    private disposables: vscode.Disposable[] = [];

    constructor(
        private iniManager: INIManager,
        private schemaManager: SchemaManager,
        private csfManager: CsfManager,
    ) {
        // 装饰器本身也是一种资源，需要在销毁时释放
        this.disposables.push(this.boolTrueDecoration);
        this.disposables.push(this.boolFalseDecoration);
        this.disposables.push(this.csfPreviewDecoration);
    }

    /**
     * 触发更新，包含防抖逻辑，避免频繁计算阻塞 UI 线程。
     */
    public triggerUpdate(editor: vscode.TextEditor | undefined, throttle = false) {
        if (!editor || editor.document.languageId !== 'ra2-ini') { return; }

        if (this.timeout) {
            clearTimeout(this.timeout);
            this.timeout = undefined;
        }

        if (throttle) {
            this.timeout = setTimeout(() => { void this.updateDecorations(editor).catch(error => console.error('[Value preview]', error)); }, 100);
        } else {
            void this.updateDecorations(editor).catch(error => console.error('[Value preview]', error));
        }
    }

    /**
     * 核心逻辑：扫描可见区域并应用装饰。
     */
    private async updateDecorations(editor: vscode.TextEditor) {
        const version = editor.document.version;
        await this.project?.load(editor.document.uri);
        if (editor.document.isClosed || editor.document.version !== version) { return; }
        const trueRanges: vscode.Range[] = [];
        const falseRanges: vscode.Range[] = [];
        const csfDecorations: vscode.DecorationOptions[] = [];
        
        const document = editor.document;
        const configuration = vscode.workspace.getConfiguration('ra2-ini-intellisense', document.uri);
        const docModel = this.project?.parse(document) ?? this.iniManager.getDocument(document.uri);
        if (!docModel) { return; }
        const currentFileType = this.project?.category(document.uri) ?? this.iniManager.getFileType(document.uri);

        // 仅遍历可见范围，实现极致性能
        for (const range of editor.visibleRanges) {
            const startLine = range.start.line;
            const endLine = range.end.line;

            // 获取范围内的第一个节，作为上下文推断的起点
            let currentSection = docModel.getSectionAt(startLine);

            for (let i = startLine; i <= endLine; i++) {
                // 如果行号超出了当前节的范围，更新当前节
                if (!currentSection || i > currentSection.endLine) {
                    currentSection = docModel.getSectionAt(i);
                }
                // 如果当前行不在任何节内，或者是节头本身，跳过
                if (!currentSection || i === currentSection.startLine) { continue; }

                const line = document.lineAt(i);
                const text = line.text;
                if (!text.trim() || text.trim().startsWith(';')) { continue; }

                const eqIndex = text.indexOf('=');
                if (eqIndex === -1) { continue; }

                const parsed = parsePropertyLine(text);
                if (!parsed) { continue; }
                const key = parsed.key;
                const valuePart = parsed.value.toLowerCase();
                const valueStartInLine = parsed.elements[0]?.start ?? parsed.valueStart;
                const valueRange = new vscode.Range(i, valueStartInLine, i, valueStartInLine + parsed.value.length);

                // 获取当前节的类型定义
                const typeName = this.project?.type(document.uri, currentSection.name, currentFileType) ?? this.iniManager.getTypeForSection(currentSection.name, new Set(), currentFileType);
                const keysDef = this.schemaManager.getAllKeysForType(typeName);
                const propDef = [...keysDef].find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];

                if (propDef) {
                    switch (propDef.type) {
                        case 'bool':
                            if (!configuration.get('decorations.booleanPreview.enabled', true)) { break; }
                            if (/^(yes|true|1)$/.test(valuePart)) {
                                trueRanges.push(valueRange); 
                            } else if (/^(no|false|0)$/.test(valuePart)) {
                                falseRanges.push(valueRange);
                            }
                            break;
                        case 'csf':
                            if (!configuration.get('decorations.csfPreview.enabled', true)) { break; }
                            const csfVal = this.csfManager.getLabel(valuePart); // valuePart 已经是 lowerCase 且 trimmed
                            if (csfVal) {
                                // 截断过长的文本，避免干扰布局
                                let displayText = csfVal.value.replace(/\r?\n/g, ' ');
                                const maxLength = configuration.get<number>('decorations.csfPreview.maxLength', ValuePreviewDecorator.CSF_PREVIEW_MAX_LENGTH);
                                if (displayText.length > maxLength) {
                                    displayText = displayText.substring(0, maxLength - 3) + '...';
                                }
                                csfDecorations.push({
                                    range: valueRange,
                                    renderOptions: {
                                        after: { contentText: `  ${displayText}` }
                                    }
                                });
                            }
                            break;
                    }
                }
            }
        }

        editor.setDecorations(this.boolTrueDecoration, trueRanges);
        editor.setDecorations(this.boolFalseDecoration, falseRanges);
        editor.setDecorations(this.csfPreviewDecoration, csfDecorations);
    }

    public dispose() {
        if (this.timeout) { clearTimeout(this.timeout); }
        this.disposables.forEach(d => d.dispose());
    }
}
