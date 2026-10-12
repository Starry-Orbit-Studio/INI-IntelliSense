import * as vscode from 'vscode';
import { parsePropertyLine } from './context/ini-position';

// 定义语义化令牌的类型
// 这个列表的顺序必须与 package.json 中定义的 `legend.tokenTypes` 完全一致
const tokenTypes = [
    'comment',          // 注释
    'sectionBracket',   // 节的方括号
    'sectionContent',   // 节的内容
    'sectionInherit',   // 节的继承部分
    'keyPart1',         // 键的第一部分
    'keyPart2',         // 键的第二部分
    'keyPart3',         // 键的第三部分及之后
    'operator',         // 等号
    'value',            // 值的默认
    'valueComma',       // 值之间的逗号
    'valueString',      // 被引号包裹的值
    'valueMultilineString' // 三引号包裹的多行字符串
];
const tokenModifiers: string[] = []; // 当前未使用修饰符
export const legend = new vscode.SemanticTokensLegend(tokenTypes, tokenModifiers);

// 解析状态，用于跟踪多行字符串
interface ParseState {
    inMultilineString: boolean; // 是否在多行字符串中
    multilineStartLine?: number; // 多行字符串开始的行（用于调试）
}

/**
 * 为 INI 文件提供高性能的语义化高亮。
 * 这个类实现了全量和增量两种更新方式，以达到最佳性能。
 */
export class IniSemanticTokensProvider implements vscode.DocumentSemanticTokensProvider, vscode.DocumentRangeSemanticTokensProvider {
    
    // 创建一个 Map 用于快速从类型名查找其在 legend 中的索引，提高效率
    private tokenTypeMap = new Map<string, number>(tokenTypes.map((t, i) => [t, i]));

    /**
     * VS Code 在打开文件或需要全量更新时调用此方法。
     * @param document 需要进行高亮的文本文档
     * @param token 一个取消令牌
     */
    public async provideDocumentSemanticTokens(
        document: vscode.TextDocument, 
        token: vscode.CancellationToken
    ): Promise<vscode.SemanticTokens> {
        
        const builder = new vscode.SemanticTokensBuilder(legend);
        let state: ParseState = { inMultilineString: false };
        
        // 逐行解析文档
        for (let i = 0; i < document.lineCount; i++) {
            if (token.isCancellationRequested) {
                break;
            }
            const line = document.lineAt(i);
            state = this.parseLine(line, builder, state);
        }
        
        return builder.build();
    }

    /**
     * VS Code 在文档编辑时调用此方法，只请求变更范围内的令牌。
     * 这是实现高性能实时高亮的关键。
     * @param document 被编辑的文本文档
     * @param range 发生变更的行范围
     * @param token 一个取消令牌
     */
    public async provideDocumentRangeSemanticTokens(
        document: vscode.TextDocument,
        range: vscode.Range,
        token: vscode.CancellationToken
    ): Promise<vscode.SemanticTokens> {
        const builder = new vscode.SemanticTokensBuilder(legend);
        
        // 获取范围开始前的解析状态
        let state = this.getParseStateAtLine(document, range.start.line);
        
        // 循环不再是整个文档，而是 VS Code 提供的、发生变更的范围
        for (let i = range.start.line; i <= range.end.line; i++) {
            if (token.isCancellationRequested) {
                break;
            }
            const line = document.lineAt(i);
            state = this.parseLine(line, builder, state);
        }
        
        return builder.build();
    }
    
    /**
     * 一个辅助方法，用于将解析出的令牌推送到构建器中。
     * @param builder SemanticTokensBuilder 实例
     * @param line 行号
     * @param start 起始字符
     * @param length 长度
     * @param tokenTypeKey 令牌类型的字符串键
     */
    private pushToken(builder: vscode.SemanticTokensBuilder, line: number, start: number, length: number, tokenTypeKey: string) {
        const tokenTypeIndex = this.tokenTypeMap.get(tokenTypeKey);
        if (tokenTypeIndex !== undefined && length > 0) {
            builder.push(line, start, length, tokenTypeIndex, 0);
        }
    }

    /**
     * 获取在指定行之前的解析状态。
     * 通过扫描文档从开头到指定行（不包括）来确定当前是否在多行字符串中。
     */
    private getParseStateAtLine(document: vscode.TextDocument, lineNumber: number): ParseState {
        const state: ParseState = { inMultilineString: false };
        for (let i = 0; i < lineNumber; i++) {
            const lineText = document.lineAt(i).text;
            const property = parsePropertyLine(lineText);
            const commentIndex = property ? property.valueEnd < lineText.length ? property.valueEnd : -1 : lineText.indexOf(';');
            const lineWithoutComment = commentIndex !== -1 ? lineText.substring(0, commentIndex) : lineText;
            
            // 检查是否进入或退出多行字符串
            if (state.inMultilineString) {
                // 在多行字符串中，查找结束标记
                if (lineWithoutComment.includes('"""')) {
                    state.inMultilineString = false;
                }
            } else {
                // 不在多行字符串中，查找开始标记
                // 只在键值对的值部分查找开始标记
                const kvMatch = lineWithoutComment.match(/^[^=]*=\s*(.*)/);
                if (kvMatch) {
                    const valuePart = kvMatch[1];
                    // 简单检测：值部分是否包含 """
                    if (valuePart.includes('"""')) {
                        // 检查是否成对出现（开始和结束在同一行）
                        const tripleQuoteCount = (valuePart.match(/"""/g) || []).length;
                        if (tripleQuoteCount % 2 === 1) {
                            // 奇数个 """，说明多行字符串开始且未结束
                            state.inMultilineString = true;
                        }
                    }
                }
            }
        }
        return state;
    }

    /**
     * 解析单行文本，并根据其语法结构生成对应的语义化令牌。
     * 这个方法被全量更新和增量更新两种模式共用。
     * @param line 当前要解析的行
     * @param builder SemanticTokensBuilder 实例
     * @param state 当前的解析状态（是否在多行字符串中）
     * @returns 更新后的解析状态
     */
    private parseLine(line: vscode.TextLine, builder: vscode.SemanticTokensBuilder, state: ParseState): ParseState {
        const lineText = line.text;
        const lineNumber = line.lineNumber;
        let newState = { ...state };

        // 优先级 1: 注释（但如果在多行字符串中，注释无效）
        const property = parsePropertyLine(lineText);
        const commentIndex = newState.inMultilineString ? -1 : property ? property.valueEnd < lineText.length ? property.valueEnd : -1 : lineText.indexOf(';');
        let lineWithoutComment = lineText;
        if (commentIndex !== -1) {
            this.pushToken(builder, lineNumber, commentIndex, lineText.length - commentIndex, 'comment');
            lineWithoutComment = lineText.substring(0, commentIndex);
        }

        // 如果在多行字符串中，将整行标记为多行字符串内容
        if (newState.inMultilineString) {
            // 查找结束标记
            const endIndex = lineWithoutComment.indexOf('"""');
            if (endIndex !== -1) {
                // 结束标记之前的部分是多行字符串内容
                if (endIndex > 0) {
                    this.pushToken(builder, lineNumber, 0, endIndex, 'valueMultilineString');
                }
                // 结束标记本身
                this.pushToken(builder, lineNumber, endIndex, 3, 'valueMultilineString');
                newState.inMultilineString = false;
                
                // 结束标记之后的部分需要正常解析
                const remainingText = lineWithoutComment.substring(endIndex + 3);
                if (remainingText.trim().length > 0) {
                    // 递归解析剩余部分（简化处理）
                    // 实际上，多行字符串结束后不太可能在同一行有其他内容
                    // 但为了安全，我们可以创建一个虚拟行进行解析
                    // 这里简化处理：只返回新状态
                }
            } else {
                // 没有结束标记，整行都是多行字符串内容
                this.pushToken(builder, lineNumber, 0, lineWithoutComment.length, 'valueMultilineString');
            }
            return newState;
        }

        // 优先级 2: 带继承的节，例如 [Section]:[Base]
        const inheritMatch = lineWithoutComment.match(/^\s*(\[)([^\]:]+)(\]:\[)([^\]]+)(\])/);
        if (inheritMatch) {
            let offset = lineWithoutComment.indexOf('[');
            this.pushToken(builder, lineNumber, offset, 1, 'sectionBracket');
            offset += 1;
            this.pushToken(builder, lineNumber, offset, inheritMatch[2].length, 'sectionContent');
            offset += inheritMatch[2].length;
            this.pushToken(builder, lineNumber, offset, 3, 'sectionInherit'); // ']:['
            offset += 3;
            this.pushToken(builder, lineNumber, offset, inheritMatch[4].length, 'sectionInherit');
            offset += inheritMatch[4].length;
            this.pushToken(builder, lineNumber, offset, 1, 'sectionBracket');
            return newState; // 行已解析完毕，无需继续
        }

        // 优先级 3: 简单节，例如 [Section]
        const simpleMatch = lineWithoutComment.match(/^\s*(\[)([^\]:]+)(\])/);
        if (simpleMatch) {
            let offset = lineWithoutComment.indexOf('[');
            this.pushToken(builder, lineNumber, offset, 1, 'sectionBracket');
            offset += 1;
            this.pushToken(builder, lineNumber, offset, simpleMatch[2].length, 'sectionContent');
            offset += simpleMatch[2].length;
            this.pushToken(builder, lineNumber, offset, 1, 'sectionBracket');
            return newState; // 行已解析完毕
        }

        // 优先级 4: 键值对，例如 Key.Part1=Value1,Value2
        const kvMatch = lineWithoutComment.match(/^(\s*[^\s=]+(?:\.[^\s=]+)*)\s*(=)\s*(.*)/);
        if (kvMatch) {
            const keyFull = kvMatch[1];
            const operator = kvMatch[2];
            const valuePart = kvMatch[3];

            // 解析键 (Key)，支持多级部分
            const keyParts = keyFull.trim().split('.');
            let keyOffset = lineWithoutComment.indexOf(keyParts[0]);
            keyParts.forEach((part, index) => {
                const styleKey = `keyPart${Math.min(index + 1, 3)}`;
                this.pushToken(builder, lineNumber, keyOffset, part.length, styleKey);
                keyOffset += part.length + 1; // +1 for the dot separator
            });

            // 解析操作符 (Operator)
            const opOffset = lineWithoutComment.indexOf(operator, keyFull.length);
            this.pushToken(builder, lineNumber, opOffset, operator.length, 'operator');

            // 解析值 (Value)
            const valueOffset = lineWithoutComment.indexOf(valuePart, opOffset);
            // Emit disjoint spans: Monaco does not support overlapping semantic tokens.
            let offset = 0;
            while (offset < valuePart.length) {
                let end: number, type = 'value';
                if (valuePart.startsWith('"""', offset)) {
                    const closing = valuePart.indexOf('"""', offset + 3);
                    end = closing < 0 ? valuePart.length : closing + 3;
                    type = 'valueMultilineString';
                    if (closing < 0) { newState.inMultilineString = true; }
                } else if (valuePart[offset] === '"' || valuePart[offset] === "'") {
                    const quote = valuePart[offset]; end = offset + 1;
                    while (end < valuePart.length && (valuePart[end] !== quote || valuePart[end - 1] === '\\')) { end++; }
                    if (end < valuePart.length) { end++; } type = 'valueString';
                } else if (valuePart[offset] === ',') { end = offset + 1; type = 'valueComma'; }
                else {
                    end = offset + 1;
                    while (end < valuePart.length && ![',', '"', "'"].includes(valuePart[end])) { end++; }
                }
                this.pushToken(builder, lineNumber, valueOffset + offset, end - offset, type);
                offset = end;
            }
        }
        
        return newState;
    }
}