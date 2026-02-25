import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { localize } from './i18n';

/**
 * 解析包含多行字符串的INI文件。
 * 支持使用 """ 包裹的多行字符串值。
 */
export class MultilineIniParser {
    /**
     * 解析INI文件内容，返回节到键值对的映射。
     * 值中的多行字符串会被完整保留。
     * @param content 文件内容
     * @returns 映射：section -> key -> value
     */
    parse(content: string): Map<string, Map<string, string>> {
        const result = new Map<string, Map<string, string>>();
        let currentSection = '';
        let currentKey = '';
        let currentValue = '';
        let inMultilineString = false;
        let multilineStringIndent = 0;
        
        const lines = content.split(/\r?\n/);
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            
            if (inMultilineString) {
                // 在多行字符串中，查找结束标记
                const endIndex = line.indexOf('"""');
                if (endIndex !== -1) {
                    // 找到结束标记
                    // 添加结束标记之前的内容（包括缩进）
                    currentValue += '\n' + line.substring(0, endIndex);
                    // 结束多行字符串
                    inMultilineString = false;
                    // 保存当前键值对
                    this.saveKeyValue(result, currentSection, currentKey, currentValue);
                    currentKey = '';
                    currentValue = '';
                    
                    // 结束标记之后可能还有内容（理论上不应该，但处理一下）
                    const remaining = line.substring(endIndex + 3).trim();
                    if (remaining) {
                        // 如果还有内容，需要重新解析这一行的剩余部分
                        // 简化处理：忽略，因为描述文件中不太可能出现这种情况
                    }
                } else {
                    // 没有结束标记，整行都是字符串内容
                    currentValue += '\n' + line;
                }
                continue;
            }
            
            // 不在多行字符串中
            const trimmedLine = line.trim();
            
            // 跳过空行
            if (trimmedLine === '') {
                continue;
            }
            
            // 处理注释
            if (trimmedLine.startsWith(';')) {
                continue;
            }
            
            // 处理节
            const sectionMatch = trimmedLine.match(/^\[([^\]:]+)(?::\[([^\]]+)\])?\]$/);
            if (sectionMatch) {
                // 保存之前的键值对（如果有）
                if (currentKey && currentValue) {
                    this.saveKeyValue(result, currentSection, currentKey, currentValue);
                }
                
                currentSection = sectionMatch[1];
                currentKey = '';
                currentValue = '';
                
                // 初始化节的映射（如果不存在）
                if (!result.has(currentSection)) {
                    result.set(currentSection, new Map<string, string>());
                }
                continue;
            }
            
            // 处理键值对
            const equalsIndex = line.indexOf('=');
            if (equalsIndex !== -1) {
                // 保存之前的键值对（如果有）
                if (currentKey && currentValue) {
                    this.saveKeyValue(result, currentSection, currentKey, currentValue);
                }
                
                const key = line.substring(0, equalsIndex).trim();
                let value = line.substring(equalsIndex + 1).trim();
                
                // 检查是否是多行字符串的开始
                if (value.startsWith('"""')) {
                    // 多行字符串开始
                    inMultilineString = true;
                    currentKey = key;
                    currentValue = value.substring(3); // 移除开始的 """
                    
                    // 检查是否在同一行结束
                    const endIndex = currentValue.indexOf('"""');
                    if (endIndex !== -1) {
                        // 在同一行开始和结束
                        currentValue = currentValue.substring(0, endIndex);
                        inMultilineString = false;
                        this.saveKeyValue(result, currentSection, currentKey, currentValue);
                        currentKey = '';
                        currentValue = '';
                    }
                } else {
                    // 单行值
                    currentKey = key;
                    currentValue = value;
                    // 立即保存（对于单行值）
                    this.saveKeyValue(result, currentSection, currentKey, currentValue);
                    currentKey = '';
                    currentValue = '';
                }
                continue;
            }
            
            // 如果不是以上任何情况，可能是上一行键值对的延续（对于多行字符串已处理）
            // 或者格式错误，忽略
        }
        
        // 处理文件末尾未保存的键值对
        if (currentKey && currentValue) {
            this.saveKeyValue(result, currentSection, currentKey, currentValue);
        }
        
        return result;
    }
    
    private saveKeyValue(
        result: Map<string, Map<string, string>>,
        section: string,
        key: string,
        value: string
    ): void {
        if (!section || !key) {
            return;
        }
        
        if (!result.has(section)) {
            result.set(section, new Map<string, string>());
        }
        
        const sectionMap = result.get(section)!;
        sectionMap.set(key, value);
    }
}

/**
 * 管理INI键的描述信息。
 * 支持多语言和多行字符串描述。
 */
export class DescriptionManager {
    private parser = new MultilineIniParser();
    private descriptions = new Map<string, Map<string, Map<string, string>>>();
    private currentLanguage: string = 'en-US';
    private descriptionDir: string | null = null;
    
    /**
     * 设置描述文件的存储目录。
     */
    setDescriptionDir(dir: string): void {
        this.descriptionDir = dir;
    }
    
    /**
     * 设置当前语言。
     * @param language 语言代码，如 'zh-CN', 'en-US'
     */
    setLanguage(language: string): void {
        this.currentLanguage = language;
    }
    
    /**
     * 从文件加载描述。
     * @param filePath 描述文件路径
     * @param language 语言代码
     */
    loadFromFile(filePath: string, language: string): boolean {
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const parsed = this.parser.parse(content);
            this.descriptions.set(language, parsed);
            console.log(`[DescriptionManager] Loaded descriptions for ${language} from ${filePath}`);
            return true;
        } catch (error) {
            console.error(`[DescriptionManager] Failed to load descriptions from ${filePath}:`, error);
            return false;
        }
    }
    
    /**
     * 根据主字典文件路径加载描述文件。
     * 主字典文件中包含 [Description] 节，指定了各语言的描述文件路径。
     * @param mainDictPath 主字典文件路径（INIDictionary.ini）
     */
    loadFromDictionary(mainDictPath: string): boolean {
        if (!this.descriptionDir) {
            console.error('[DescriptionManager] Description directory not set');
            return false;
        }
        
        try {
            const content = fs.readFileSync(mainDictPath, 'utf-8');
            const lines = content.split(/\r?\n/);
            let inDescriptionSection = false;
            const languageFiles = new Map<string, string>();
            
            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed === '[Description]') {
                    inDescriptionSection = true;
                    continue;
                }
                if (trimmed.startsWith('[') && trimmed !== '[Description]') {
                    inDescriptionSection = false;
                    continue;
                }
                
                if (inDescriptionSection && trimmed && !trimmed.startsWith(';')) {
                    const equalsIndex = trimmed.indexOf('=');
                    if (equalsIndex !== -1) {
                        const language = trimmed.substring(0, equalsIndex).trim();
                        const filePath = trimmed.substring(equalsIndex + 1).trim();
                        languageFiles.set(language, filePath);
                    }
                }
            }
            
            let loadedAny = false;
            for (const [language, relPath] of languageFiles.entries()) {
                const fullPath = path.isAbsolute(relPath) 
                    ? relPath 
                    : path.join(path.dirname(mainDictPath), relPath);
                
                if (fs.existsSync(fullPath)) {
                    if (this.loadFromFile(fullPath, language)) {
                        loadedAny = true;
                    }
                } else {
                    console.warn(`[DescriptionManager] Description file not found: ${fullPath}`);
                }
            }
            
            return loadedAny;
        } catch (error) {
            console.error(`[DescriptionManager] Failed to load descriptions from dictionary ${mainDictPath}:`, error);
            return false;
        }
    }
    
    /**
     * 获取指定节和键的描述。
     * 支持沿继承链查找（如果描述文件中有继承语法）。
     * @param sectionName 节名称
     * @param keyName 键名称
     * @returns 描述文本（Markdown格式），如果未找到则返回 undefined
     */
    getDescription(sectionName: string, keyName: string): string | undefined {
        // 首先尝试当前语言
        let desc = this.getDescriptionForLanguage(sectionName, keyName, this.currentLanguage);
        if (desc !== undefined) {
            return desc;
        }
        
        // 回退到英语
        if (this.currentLanguage !== 'en-US') {
            desc = this.getDescriptionForLanguage(sectionName, keyName, 'en-US');
            if (desc !== undefined) {
                return desc;
            }
        }
        
        // 如果还没有，尝试沿继承链查找
        // 描述文件中可能包含继承语法，如 [ChildType]:[ParentType]
        // 这里简化处理：直接返回 undefined
        // 未来可以添加继承链查找
        return undefined;
    }
    
    /**
     * 获取指定语言的描述。
     */
    private getDescriptionForLanguage(sectionName: string, keyName: string, language: string): string | undefined {
        const langDescriptions = this.descriptions.get(language);
        if (!langDescriptions) {
            return undefined;
        }
        
        // 直接查找
        const sectionMap = langDescriptions.get(sectionName);
        if (sectionMap) {
            const desc = sectionMap.get(keyName);
            if (desc !== undefined && desc !== '') {
                return desc;
            }
        }
        
        // 尝试查找继承节（如 [ChildType]:[ParentType]）
        // 首先检查是否有带继承的节
        for (const [sectionKey, sectionDescMap] of langDescriptions.entries()) {
            // 检查节键是否包含继承语法
            const match = sectionKey.match(/^([^:]+):\[([^\]]+)\]$/);
            if (match) {
                const childSection = match[1];
                const parentSection = match[2];
                if (childSection === sectionName) {
                    // 首先在父节中查找
                    const parentDesc = this.getDescriptionForLanguage(parentSection, keyName, language);
                    if (parentDesc !== undefined) {
                        return parentDesc;
                    }
                }
            }
        }
        
        return undefined;
    }
    
    /**
     * 检查是否已加载指定语言的描述。
     */
    hasLanguage(language: string): boolean {
        return this.descriptions.has(language);
    }
    
    /**
     * 获取已加载的语言列表。
     */
    getLoadedLanguages(): string[] {
        return Array.from(this.descriptions.keys());
    }
    
    /**
     * 清空所有已加载的描述。
     */
    clear(): void {
        this.descriptions.clear();
    }
}