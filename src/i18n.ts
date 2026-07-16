import * as path from 'path';
import * as fs from 'fs';
import { ExtensionContext } from 'vscode';

// 这个对象将存储最终合并后的所有语言字符串。
let messages: { [key: string]: string } = {};

/**
 * 在扩展激活时必须调用的初始化函数。
 * 这个函数现在将完全负责加载和准备所有的翻译字符串。
 * @param context 扩展上下文
 */
export function initializeNls(context: ExtensionContext) {
    // 1. 获取当前 VS Code 的语言环境，如果获取失败则默认为 'en'
    const locale = process.env.VSCODE_NLS_CONFIG ? JSON.parse(process.env.VSCODE_NLS_CONFIG).locale : 'en';
    
    // 修复路径，确保在打包后也能正确找到i18n文件
    const bundleBasePath = path.join(context.extensionPath, 'i18n', 'bundle.nls');
    const defaultMessagesPath = `${bundleBasePath}.json`;
    const languageMessagesPath = `${bundleBasePath}.${locale}.json`;

    // 2. 加载默认的英文语言包作为回退基础
    try {
        if (fs.existsSync(defaultMessagesPath)) {
            const content = fs.readFileSync(defaultMessagesPath, 'utf8');
            messages = JSON.parse(content);
        }
    } catch (e) {
        console.error('[NLS] Failed to load or parse default language bundle.', e);
    }
    
    // 3. 如果当前不是英文，尝试加载特定语言包并与基础包合并
    if (locale !== 'en') {
        try {
            if (fs.existsSync(languageMessagesPath)) {
                const content = fs.readFileSync(languageMessagesPath, 'utf8');
                const localizedMessages = JSON.parse(content);
                // 使用 Object.assign 将翻译的字符串合并到 messages 对象中。
                // 这会用中文值覆盖同名的英文键，同时保留所有未被翻译的键的英文值。
                Object.assign(messages, localizedMessages);
            }
        } catch (e) {
            console.error(`[NLS] Failed to load or parse language bundle for locale '${locale}'.`, e);
        }
    }
}

/**
 * 本地化一个字符串。
 * @param key 字符串的唯一键。
 * @param message 默认的英文消息。在 vscode-nls-dev 提取时作为来源；运行时当语言包中缺少该键时作为回退值。
 * @param args 用于替换占位符（如 {0}, {1}）的参数。
 */
export function localize(key: string, message: string, ...args: any[]): string {
    const text = messages[key] ?? message;

    // 处理占位符，例如 "{0}", "{1}"
    return text.replace(/\{(\d+)\}/g, (match, index) => {
        const argIndex = parseInt(index, 10);
        return args[argIndex] !== undefined ? String(args[argIndex]) : match;
    });
}