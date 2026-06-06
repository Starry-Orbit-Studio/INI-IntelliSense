import * as vscode from 'vscode';
import { IniDiagnostic } from './diagnostic';
import { ErrorCode } from './error-codes';
import { ValidationRule } from './rules';
import { SchemaManager } from '../schema-manager';
import { INIManager } from '../parser';
import { styleRules } from './rules/style-rules';
import { typeRules } from './rules/type-rules';
import { logicRules } from './rules/logic-rules';

/**
 * 诊断管理器
 * 实现“全量缓存 + 局部计算 + 视口优先”的极限性能架构。
 */
export class DiagnosticManager implements vscode.Disposable {
    private diagnosticCollection: vscode.DiagnosticCollection;
    private rules: ValidationRule[];
    
    // 缓存：Uri -> (LineNumber -> Diagnostics[])
    // 使用 Map<number, ...> 允许我们只更新特定行的错误，而不影响其他行
    private fileCache: Map<string, Map<number, IniDiagnostic[]>> = new Map();
    
    // 调度器定时器
    private backgroundTimer: NodeJS.Timeout | undefined;
    private pendingValidationFiles: Set<string> = new Set();

    constructor(
        private context: vscode.ExtensionContext,
        private schemaManager: SchemaManager,
        private iniManager: INIManager
    ) {
        this.diagnosticCollection = vscode.languages.createDiagnosticCollection('ini');
        this.context.subscriptions.push(this.diagnosticCollection);
        
        this.rules = [
            ...styleRules,
            ...typeRules,
            ...logicRules
        ];
    }

    public dispose() {
        this.diagnosticCollection.dispose();
        if (this.backgroundTimer) {
            clearTimeout(this.backgroundTimer);
        }
    }

    /**
     * 外部入口：处理文档变更
     * 这是一个“热更新”入口，优先处理视口和变更区域。
     */
    public handleDocumentChange(document: vscode.TextDocument, changedRanges?: vscode.Range[]) {
        if (document.languageId !== 'ra2-ini') { return; }
        
        // 1. 如果有具体的变更范围（打字），立即分析这些行
        if (changedRanges) {
            this.analyzeRanges(document, changedRanges);
        } else {
            // 如果没有具体范围（如刚打开文件），则先分析视口
            const editor = vscode.window.visibleTextEditors.find(e => e.document === document);
            if (editor) {
                this.analyzeRanges(document, editor.visibleRanges);
            } else {
                // 如果不可见，放入后台队列
                this.scheduleBackgroundValidation(document);
                return;
            }
        }

        // 2. 刷新 UI（将缓存中的错误提交给 VS Code）
        this.flushDiagnostics(document);

        // 3. 安排后台任务处理剩余部分或逻辑检查
        this.scheduleBackgroundValidation(document);
    }

    /**
     * 外部入口：处理视口滚动
     * 当用户滚动时，优先检查新进入视口的区域。
     */
    public handleViewportChange(editor: vscode.TextEditor) {
        if (editor.document.languageId !== 'ra2-ini') { return; }
        
        // 分析当前所有可见范围
        this.analyzeRanges(editor.document, editor.visibleRanges);
        this.flushDiagnostics(editor.document);
    }

    /**
     * 核心：分析指定范围内的行
     * 这是局部计算，速度极快。
     */
    private analyzeRanges(document: vscode.TextDocument, ranges: readonly vscode.Range[]) {
        const uriKey = document.uri.toString();
        let lineCache = this.fileCache.get(uriKey);
        if (!lineCache) {
            lineCache = new Map();
            this.fileCache.set(uriKey, lineCache);
        }

        const config = vscode.workspace.getConfiguration('ra2-ini-intellisense.diagnostics');
        if (!config.get<boolean>('enabled', true)) {
            return;
        }

        const contextBase = {
            document,
            schemaManager: this.schemaManager,
            iniManager: this.iniManager,
            config,
            disabledErrorCodes: this.getDisabledCodes(config),
            severityOverrides: this.getSeverityOverrides(config),
            outputChannel: undefined as any // 暂时不需要输出通道
        };

        // 获取文档对应的 INI Document Model，用于快速查找 Section
        const iniDoc = this.iniManager.getDocument(document.uri);

        for (const range of ranges) {
            for (let i = range.start.line; i <= range.end.line; i++) {
                if (i >= document.lineCount) { break; }
                
                const line = document.lineAt(i);
                
                // 构建行级上下文
                // 优化：直接从 IniDocument 获取 Section，不再回溯扫描
                const currentSection = iniDoc ? iniDoc.getSectionAt(i) : undefined;
                // 简单的适配层
                const sectionContext = {
                    name: currentSection?.name || null,
                    typeName: currentSection ? this.iniManager.getTypeForSection(currentSection.name) : null,
                    keys: currentSection ? this.schemaManager.getAllKeysForType(this.iniManager.getTypeForSection(currentSection.name)) : null
                };
                
                const commentIndex = line.text.indexOf(';');
                const codePart = commentIndex === -1 ? line.text : line.text.substring(0, commentIndex);
                const commentPart = commentIndex === -1 ? null : line.text.substring(commentIndex);

                const lineContext = {
                    ...contextBase,
                    line,
                    lineNumber: i,
                    codePart,
                    commentPart,
                    currentSection: sectionContext,
                    seenRegistryKeys: new Set<string>() // 局部检查难以做完整的重复键检查，暂时置空或仅检查当行
                };

                // 运行规则
                const lineDiagnostics: IniDiagnostic[] = [];
                for (const rule of this.rules) {
                    lineDiagnostics.push(...rule(lineContext));
                }

                // 更新缓存：直接替换该行的错误列表
                if (lineDiagnostics.length > 0) {
                    lineCache.set(i, this.filterDiagnostics(lineDiagnostics, contextBase));
                } else {
                    lineCache.delete(i); // 如果没错误，删除条目以节省内存
                }
            }
        }
    }

    /**
     * 将缓存中的错误扁平化并提交给 VS Code
     */
    private flushDiagnostics(document: vscode.TextDocument) {
        const uriKey = document.uri.toString();
        const lineCache = this.fileCache.get(uriKey);
        if (!lineCache) { return; }

        const allDiagnostics: vscode.Diagnostic[] = [];
        
        // 合并内部缓存的错误
        for (const diags of lineCache.values()) {
            allDiagnostics.push(...diags);
        }
        
        // 保留外部验证器（INI Validator）的错误
        // 我们假设外部错误存储在 collection 中，并且 source 为 'INI Validator'
        // 但由于 collection.set 是全量替换，我们需要手动维护或合并外部错误
        // 这里简化处理：假设本类独占管理 'ini' collection，外部验证器若使用需另行处理或集成至此
        // 在 extension.ts 中可以看到 validator 使用了同一个 collection，这会导致冲突
        // 最佳实践：使用不同的 Collection，或者在这里能够读取并合并
        // 鉴于 validator 是独立逻辑，建议在 extension 中使用单独的 collection，
        // 这里我们只负责 "ra2-ini-internal" 的错误。
        // 为了不破坏现有架构，我们假设 diagnostics 变量在外部被共享，或者我们在这里只设置内部错误
        // *重要修改*：我们在构造函数中创建了自己的 collection，避免与 validator 冲突。
        
        this.diagnosticCollection.set(document.uri, allDiagnostics);
    }

    /**
     * 调度后台任务：分批处理剩余文件
     */
    private scheduleBackgroundValidation(document: vscode.TextDocument) {
        this.pendingValidationFiles.add(document.uri.toString());
        
        if (this.backgroundTimer) {
            clearTimeout(this.backgroundTimer);
        }

        this.backgroundTimer = setTimeout(() => {
            this.processPendingFiles();
        }, 1000); // 1秒防抖，完全不影响打字
    }

    private async processPendingFiles() {
        for (const uriStr of this.pendingValidationFiles) {
            const uri = vscode.Uri.parse(uriStr);
            const document = await vscode.workspace.openTextDocument(uri); // 确保文档已打开
            if (document.isClosed) { 
                this.fileCache.delete(uriStr);
                this.pendingValidationFiles.delete(uriStr);
                continue; 
            }

            // 这里可以实现分块逻辑 (Chunking)，例如每次处理 500 行
            // 简单起见，我们在 idle 时全量跑一次全文件逻辑检查
            // 这里的全量是指：对所有行运行，但由于是后台任务，不会阻塞 UI
            const fullRange = new vscode.Range(0, 0, document.lineCount - 1, 0);
            
            // 注意：这里我们复用 analyzeRanges，它会更新缓存
            // 实际生产中应使用 setImmediate 拆分循环
            await this.analyzeRangesBatched(document);
            
            this.flushDiagnostics(document);
            this.pendingValidationFiles.delete(uriStr);
        }
    }

    /**
     * 分批次分析整个文档，避免卡顿
     */
    private async analyzeRangesBatched(document: vscode.TextDocument) {
        const chunkSize = 500;
        for (let i = 0; i < document.lineCount; i += chunkSize) {
            const end = Math.min(i + chunkSize - 1, document.lineCount - 1);
            const range = new vscode.Range(i, 0, end, 0);
            this.analyzeRanges(document, [range]);
            
            // 让出主线程
            await new Promise(resolve => setTimeout(resolve, 0));
        }
    }

    // --- 辅助函数 ---

    private getDisabledCodes(config: vscode.WorkspaceConfiguration): Set<string> {
        const raw = config.get<string[]>('disable', []);
        return new Set(raw.map(String));
    }

    private getSeverityOverrides(config: vscode.WorkspaceConfiguration): Map<string, vscode.DiagnosticSeverity | null> {
        const overrides = new Map<string, vscode.DiagnosticSeverity | null>();
        const severityConfig = config.get<{[key: string]: string}>('severity', {});
        
        for (const [code, level] of Object.entries(severityConfig)) {
            overrides.set(code, this.parseSeverity(level));
        }
        
        // Legacy settings mapping
        if (config.get('leadingWhitespace') === false) { overrides.set(ErrorCode.STYLE_LEADING_WHITESPACE, null); }
        if (config.get('spaceBeforeEquals') === false) { overrides.set(ErrorCode.STYLE_SPACE_BEFORE_EQUALS, null); }
        if (config.get('spaceAfterEquals') === false) { overrides.set(ErrorCode.STYLE_SPACE_AFTER_EQUALS, null); }
        if (config.get('spaceAfterComment') === false) { overrides.set(ErrorCode.STYLE_MISSING_SPACE_AFTER_COMMENT, null); }

        return overrides;
    }

    private parseSeverity(level: string): vscode.DiagnosticSeverity | null {
        switch (level.toLowerCase()) {
            case 'error': return vscode.DiagnosticSeverity.Error;
            case 'warning': return vscode.DiagnosticSeverity.Warning;
            case 'information': return vscode.DiagnosticSeverity.Information;
            case 'hint': return vscode.DiagnosticSeverity.Hint;
            case 'none': return null;
            default: return null;
        }
    }

    private filterDiagnostics(diagnostics: IniDiagnostic[], context: any): IniDiagnostic[] {
        return diagnostics.filter(diag => {
            const code = String(diag.errorCode);
            const override = context.severityOverrides.get(code);
            if (override === null) { return false; }
            if (override !== undefined) { diag.severity = override; }
            if (context.disabledErrorCodes.has(code)) { return false; }
            return true;
        });
    }
}
