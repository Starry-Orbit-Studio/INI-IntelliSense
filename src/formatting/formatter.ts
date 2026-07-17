import * as vscode from 'vscode';
import { localize } from '../i18n';

/**
 * 计算 INI 文档指定范围内的格式化文本编辑。
 * 该函数不直接应用编辑，仅返回 TextEdit 列表，可同时供命令和格式化 Provider 使用。
 * @param document 文本文档
 * @param range 要格式化的范围
 * @param config 诊断/格式化配置对象
 * @returns 文本编辑列表
 */
function computeFormatEdits(document: vscode.TextDocument, range: vscode.Range, config: vscode.WorkspaceConfiguration): vscode.TextEdit[] {
    const edits: vscode.TextEdit[] = [];
    const startLine = range.start.line;
    const endLine = Math.min(range.end.line, document.lineCount - 1);

    for (let i = startLine; i <= endLine; i++) {
        const line = document.lineAt(i);
        // 如果是一个跨多行的选区，我们只格式化完全包含在选区内的行
        if (!range.isSingleLine && !range.contains(line.range)) {
            continue;
        }
        const newText = formatLine(line.text, config);
        if (newText !== line.text) {
            edits.push(vscode.TextEdit.replace(line.range, newText));
        }
    }

    return edits;
}

/**
 * 格式化单行文本，采用统一的分解-重组策略。
 * @param text 行文本
 * @param config 配置对象
 * @returns 格式化后的行文本
 */
export function formatLine(text: string, config: vscode.WorkspaceConfiguration): string {
    // 1. 将行分解为代码部分和注释部分
    const commentIndex = text.indexOf(';');
    const codePart = commentIndex === -1 ? text : text.substring(0, commentIndex);
    const commentPart = commentIndex === -1 ? null : text.substring(commentIndex);

    // 2. 格式化代码部分
    let formattedCode = codePart.trim();
    const equalsIndex = formattedCode.indexOf('=');
    // 确保它是一个键值对，而不是节或其他结构
    if (equalsIndex > 0 && !formattedCode.startsWith('[')) {
        const key = formattedCode.substring(0, equalsIndex).trim();
        const value = formattedCode.substring(equalsIndex + 1).trim();
        formattedCode = `${key}=${value}`;
    }

    // 3. 格式化注释部分
    let formattedComment = '';
    if (commentPart !== null) {
        const commentContent = commentPart.substring(1);
        if (config.get('spaceAfterComment') && commentContent.length > 0 && !commentContent.startsWith(' ')) {
            formattedComment = `; ${commentContent}`;
        } else {
            formattedComment = ';' + commentContent;
        }
    }

    // 4. 根据情况重组
    if (!formattedCode) {
        // 如果只有注释
        return formattedComment;
    }

    if (!formattedComment) {
        // 如果只有代码
        return formattedCode;
    }

    // 如果两者都有
    const spacesBefore = config.get<number | null>('spacesBeforeComment');
    const separator = typeof spacesBefore === 'number' ? ' '.repeat(spacesBefore) : ' ';
    
    return `${formattedCode}${separator}${formattedComment}`;
}

/**
 * INI 文档格式化编辑 Provider，接入 VS Code 的格式化 API。
 * 使 "Format Document" (Shift+Alt+F)、"Format Selection" 以及 "Format On Save" 可用。
 */
class IniFormattingEditProvider implements vscode.DocumentFormattingEditProvider, vscode.DocumentRangeFormattingEditProvider {
    provideDocumentFormattingEdits(document: vscode.TextDocument): vscode.ProviderResult<vscode.TextEdit[]> {
        const lastLine = document.lineAt(document.lineCount - 1);
        const fullRange = new vscode.Range(0, 0, lastLine.lineNumber, lastLine.range.end.character);
        const config = vscode.workspace.getConfiguration('ra2-ini-intellisense.diagnostics');
        return computeFormatEdits(document, fullRange, config);
    }

    provideDocumentRangeFormattingEdits(document: vscode.TextDocument, range: vscode.Range): vscode.ProviderResult<vscode.TextEdit[]> {
        const config = vscode.workspace.getConfiguration('ra2-ini-intellisense.diagnostics');
        return computeFormatEdits(document, range, config);
    }
}

/**
 * 注册格式化相关的命令与格式化 Provider。
 * @param context 扩展上下文，用于管理 Disposable 生命周期
 */
export function registerFormattingCommands(context: vscode.ExtensionContext) {
    const selector: vscode.DocumentSelector = { scheme: 'file', language: 'ra2-ini' };
    const provider = new IniFormattingEditProvider();

    // 接入 VS Code 格式化 API，使 Format Document / Format Selection / Format On Save 生效
    context.subscriptions.push(
        vscode.languages.registerDocumentFormattingEditProvider(selector, provider)
    );
    context.subscriptions.push(
        vscode.languages.registerDocumentRangeFormattingEditProvider(selector, provider)
    );

    // 同时保留为独立命令，便于从命令面板或键绑定显式调用
    context.subscriptions.push(vscode.commands.registerCommand('ra2-ini-intellisense.format.document', async () => {
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document.languageId === 'ra2-ini') {
            const document = editor.document;
            const lastLine = document.lineAt(document.lineCount - 1);
            const fullRange = new vscode.Range(0, 0, lastLine.lineNumber, lastLine.range.end.character);
            const config = vscode.workspace.getConfiguration('ra2-ini-intellisense.diagnostics');
            const edits = computeFormatEdits(document, fullRange, config);
            if (edits.length > 0) {
                const edit = new vscode.WorkspaceEdit();
                edit.set(document.uri, edits);
                await vscode.workspace.applyEdit(edit);
            }
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('ra2-ini-intellisense.format.selection', async () => {
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document.languageId === 'ra2-ini') {
            const range = editor.selection.isEmpty 
                ? editor.document.lineAt(editor.selection.active.line).range 
                : editor.selection;
            const config = vscode.workspace.getConfiguration('ra2-ini-intellisense.diagnostics');
            const edits = computeFormatEdits(editor.document, range, config);
            if (edits.length > 0) {
                const edit = new vscode.WorkspaceEdit();
                edit.set(editor.document.uri, edits);
                await vscode.workspace.applyEdit(edit);
            }
        }
    }));
}
