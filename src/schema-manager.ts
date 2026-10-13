import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { localize } from './i18n';
import { DictionarySource } from './dictionary/source-model';
import { keyPattern, patternIndex, patternBound } from './dictionary/key-pattern';

/**
 * 定义一个属性的详细定义。
 */
export interface PropertyDefinition {
    type: string;        // 值的类型，如 'int', 'bool', 'BuildingType'
    defaultValue?: string; // 默认值
    fileType?: string;   // 该键所属的文件类型，如 'rules', 'art'。如果未定义，则通用。
    declaration?: string;
    sourcePath?: string;
    sourceLine?: number;
    owner?: string;
    source?: string;     // 键的来源（文件名，不含后缀），如 'Ares', 'Phobos'，如果是主字典则可能为空或 'INIDictionary'
}

/**
 * 存储一个Schema类型的定义。
 */
interface SchemaDefinition {
    // 该类型自身定义的键。
    keys: Map<string, PropertyDefinition>; // key -> PropertyDefinition
    // 该类型的父类名称。
    base: string | null;
}

/**
 * 描述一个数值范围限制。
 */
interface NumberLimit {
    min: number;
    max: number;
}

/**
 * 描述一个字符串格式限制。
 */
interface StringLimit {
    startWith?: string[];
    endWith?: string[];
    limitIn?: string[];
    caseSensitive?: boolean;
}

/**
 * 描述一个列表类型的定义。
 */
interface ListDefinition {
    type: string;
    minRange?: number;
    maxRange?: number;
}

/**
 * 定义值类型的分类, 用于校验分发。
 */
export enum ValueTypeCategory {
    Section,
    NumberLimit,
    StringLimit,
    List,
    Primitive,
    Unknown
}


/**
 * 管理和解析 INICodingCheck.ini 文件的核心类。
 * 负责加载Schema文件，并提供基于类型继承获取所有合法键的功能。
 */
export class SchemaManager {
    // 映射注册表节名 (如 'BuildingTypes') 到其对应的 schema 类型名 (如 'BuildingType')。
    private registries = new Map<string, string>();
    // 反向映射：从 schema 类型名到其注册表节名。
    private typeToRegistryMap = new Map<string, string>();
    // 映射 schema 类型名 (如 'AnimType') 到其对应的注册表节名 (如 'Animations')。
    private sections = new Map<string, string>();
    // 存储所有 schema 类型 (如 'BuildingType') 的详细定义 (键和基类)。
    private schemas = new Map<string, SchemaDefinition>();
    // 缓存已计算的类型键集合, 避免对同一类型的继承链进行重复遍历, 提高性能。
    private keyCache = new Map<string, Map<string, PropertyDefinition>>();
    private propertyCache = new Map<string, PropertyDefinition | undefined>();
    // 标记Schema文件是否已成功加载并解析。
    private isLoaded: boolean = false;
    private schemaFilePath: string | null = null;

    // 用于存储高级类型校验规则
    private numberLimits = new Map<string, NumberLimit>();
    private stringLimits = new Map<string, StringLimit>();
    private listDefinitions = new Map<string, ListDefinition>();

    // 用于快速反向查找类型所属的分类
    private complexTypes: Set<string> = new Set();
    private numberLimitTypes: Set<string> = new Set();
    private stringLimitTypes: Set<string> = new Set();
    private listTypes: Set<string> = new Set();
    
    // 用于防止循环 include
    private visitedPaths: Set<string> = new Set();
    private dictionaryDocuments = new Set<string>();

    /**
     * 清空所有已加载的 schema 数据，重置状态。
     */
    public clearSchema() {
        this.registries.clear();
        this.typeToRegistryMap.clear();
        this.sections.clear();
        this.schemas.clear();
        this.keyCache.clear();
        this.propertyCache.clear();
        this.isLoaded = false;
        this.schemaFilePath = null;
        
        this.numberLimits.clear();
        this.stringLimits.clear();
        this.listDefinitions.clear();

        this.complexTypes.clear();
        this.numberLimitTypes.clear();
        this.stringLimitTypes.clear();
        this.listTypes.clear();
        this.visitedPaths.clear();
        this.dictionaryDocuments.clear();
    }

    /**
     * 检查 schema 是否已成功加载。
     */
    public isSchemaLoaded(): boolean {
        return this.isLoaded;
    }

    /**
     * 检查一个给定的名称是否是一个已知的 Schema 类型（即，在 INICodingCheck.ini 中有一个对应的 [...] 节）。
     * @param typeName 要检查的类型名称
     */
    public isSchemaType(typeName: string): boolean {
        return this.schemas.has(typeName);
    }
    
    /**
     * 检查一个给定的名称是否是在 [Sections] 中定义的复杂对象类型。
     * @param typeName 要检查的类型名称
     */
    public isComplexType(typeName: string): boolean {
        return this.complexTypes.has(typeName);
    }

    /**
     * 获取一个类型的 Schema 定义。
     * @param typeName 类型名称
     */
    public getSchema(typeName: string): SchemaDefinition | undefined {
        return this.schemas.get(typeName);
    }

    /**
     * 手动逐行加载并解析 schema 文件的内容。
     * 采用两遍扫描法，第一遍建立结构，第二遍填充内容。
     * @param content INICodingCheck.ini 文件的字符串内容
     * @param filePath INICodingCheck.ini 文件的绝对路径
     */
    public loadSchema(content: string, filePath: string) {
        console.log(`[SchemaManager] Starting to load schema from: ${filePath}`);
        const startTime = Date.now();

        this.clearSchema();
        this.schemaFilePath = filePath;
        for (const entry of new DictionarySource(content).inSection('Description')) {
            if (entry.value) { this.dictionaryDocuments.add(path.resolve(path.dirname(filePath), entry.value).toLowerCase()); }
        }

        // 开始递归解析
        this.parseFileRecursively(filePath, content);

        if (this.registries.size > 0 || this.schemas.size > 0) {
            this.isLoaded = true;
        }

        const endTime = Date.now();
        console.log(`[SchemaManager] Schema loaded in ${endTime - startTime}ms. Visited files: ${this.visitedPaths.size}`);
    }

    /**
     * 递归解析单个文件
     * @param filePath 文件的绝对路径
     */
    private parseFileRecursively(filePath: string, suppliedContent?: string) {
        this.dictionaryDocuments.add(path.resolve(filePath).toLowerCase());
        if (this.visitedPaths.has(filePath)) {
            return;
        }
        this.visitedPaths.add(filePath);

        let content: string;
        try {
            content = suppliedContent ?? fs.readFileSync(filePath, 'utf-8');
        } catch (e) {
            console.error(`[SchemaManager] Failed to read file: ${filePath}`, e);
            return;
        }

        const lines = content.split(/\r?\n/);
        const dirName = path.dirname(filePath);
        const sourceName = path.parse(filePath).name; // 获取文件名作为来源，不含后缀

        for (const entry of new DictionarySource(content).inSection('#include')) {
            const include = entry.value ?? entry.key;
            if (include) { this.parseFileRecursively(path.resolve(dirName, include)); }
        }

        // 解析当前文件内容
        this.parseContent(content, sourceName, filePath);
    }

    /**
     * 解析具体的 Schema 内容字符串并合并到内存数据结构中
     * @param content 文件内容
     * @param sourceName 来源标识（文件名）
     */
    private parseContent(content: string, sourceName: string, filePath: string) {
        const lines = content.split(/\r?\n/);
        const original = new DictionarySource(content);
        
        // 第一遍扫描：识别节结构
        const preParsed = new Map<string, { base: string | null, contentLines: string[] }>();
        let currentSection: { base: string | null, contentLines: string[] } | null = null;

        for (const line of lines) {
            const trimmedLine = line.trim();
            if (trimmedLine === '' || trimmedLine.startsWith(';')) { continue; }

            const sectionMatch = trimmedLine.match(/^\[([^\]:]+)\](?::\[([^\]]+)\])?/);

            if (sectionMatch) {
                const typeName = sectionMatch[1].trim();
                // 忽略 [#include] 节，因为已经在上一层处理过了
                if (typeName.toLowerCase() === '#include') {
                    currentSection = null;
                    continue;
                }
                const baseName = sectionMatch[2] ? sectionMatch[2].trim() : null;
                currentSection = preParsed.get(typeName) ?? { base: baseName, contentLines: [] };
                if (baseName) { currentSection.base = baseName; }
                preParsed.set(typeName, currentSection);
            } else if (currentSection) {
                currentSection.contentLines.push(trimmedLine);
            }
        }

        // 填充类型集合
        const processCategory = (categoryName: string, typeSet: Set<string>) => {
            const data = preParsed.get(categoryName);
            if (data) {
                data.contentLines.forEach(line => {
                    const [key] = this.parseKeyValue(line);
                    if (key) { typeSet.add(key); }
                });
            }
        };

        processCategory('Sections', this.complexTypes);
        processCategory('NumberLimits', this.numberLimitTypes);
        processCategory('Limits', this.stringLimitTypes);
        processCategory('Lists', this.listTypes);

        // 填充具体定义
        for (const [typeName, data] of preParsed.entries()) {
            if (typeName === 'Registries') {
                for (const line of data.contentLines) {
                    const [key, value] = this.parseKeyValue(line);
                    if (key && value) {
                        this.registries.set(key, value);
                        this.typeToRegistryMap.set(value, key);
                    }
                }
            } else if (typeName === 'Sections') {
                for (const line of data.contentLines) {
                    const [key, value] = this.parseKeyValue(line);
                    if (key && value) { this.sections.set(key, value); }
                }
            } else if (this.numberLimitTypes.has(typeName)) {
                // 对于 Limit 类型，通常是原子替换，而不是合并
                const rangeLine = data.contentLines.find(l => l.trim().toLowerCase().startsWith('range'));
                if (rangeLine) {
                    const [, value] = this.parseKeyValue(rangeLine);
                    const [min, max] = (value || "0,0").split(',').map(v => parseInt(v.trim(), 10));
                    this.numberLimits.set(typeName, { min: min ?? -2147483648, max: max ?? 2147483647 });
                }
            } else if (this.stringLimitTypes.has(typeName)) {
                const limit: StringLimit = {};
                for (const line of data.contentLines) {
                    const [key, value] = this.parseKeyValue(line);
                    if (!key || value === null) { continue; }
                    const lowerKey = key.toLowerCase();
                    if (lowerKey === 'startwith') { limit.startWith = value.split(',').map(v => v.trim()); }
                    else if (lowerKey === 'endwith') { limit.endWith = value.split(',').map(v => v.trim()); }
                    else if (lowerKey === 'limitin' || lowerKey.startsWith('limitin.')) {
                        const newValues = value.split(',').map(v => v.trim()).filter(v => v.length > 0);
                        if (!limit.limitIn) {
                            limit.limitIn = [];
                        }
                        limit.limitIn.push(...newValues);
                    }
                    else if (lowerKey === 'casesensitive') { limit.caseSensitive = ['true', 'yes', '1'].includes(value.toLowerCase()); }
                }
                this.stringLimits.set(typeName, limit);
            } else if (this.listTypes.has(typeName)) {
                const definition: ListDefinition = { type: 'string' };
                for (const line of data.contentLines) {
                    const [key, value] = this.parseKeyValue(line);
                    if (!key || value === null) { continue; }
                    const lowerKey = key.toLowerCase();
                    if (lowerKey === 'type') { definition.type = value; }
                    else if (lowerKey === 'range') {
                        const [min, max] = value.split(',').map(v => parseInt(v.trim(), 10));
                        if (!isNaN(min)) { definition.minRange = min; }
                        if (!isNaN(max)) { definition.maxRange = max; }
                    }
                }
                this.listDefinitions.set(typeName, definition);
            } else { 
                // 普通类型定义：需要合并 Keys
                let definition = this.schemas.get(typeName);
                if (!definition) {
                    definition = { keys: new Map(), base: null };
                    this.schemas.set(typeName, definition);
                }
                
                // 更新基类（如果当前文件指定了基类）
                if (data.base) { definition.base = data.base; }

                for (const line of data.contentLines) {
                    const [key, value] = this.parseKeyValue(line);
                    if (key) {
                        const keyName = key.trim();
                        const propertyDef = this.parsePropertyDefinition(value || 'string', sourceName);
                        const declaration = original.find(typeName, keyName);
                        Object.assign(propertyDef, { declaration: keyName, owner: typeName, sourcePath: filePath, sourceLine: declaration?.line });
                        const old = [...definition.keys.keys()].find(name => name.toLowerCase() === keyName.toLowerCase());
                        if (old) { definition.keys.delete(old); }
                        definition.keys.set(keyName, propertyDef);
                    }
                }
            }
        }
    }

    /**
     * 解析属性定义字符串。
     * @param valueString 定义字符串
     * @param sourceName 来源文件名
     */
    private parsePropertyDefinition(valueString: string, sourceName: string): PropertyDefinition {
        const parts = valueString.split(',').map(p => p.trim());
        
        const type = parts[0] || 'string';
        const defaultValue = parts.length > 1 && parts[1] !== '' ? parts[1] : undefined;
        const fileType = parts.length > 2 && parts[2] !== '' ? parts[2] : undefined;

        return {
            type,
            defaultValue,
            fileType,
            source: sourceName // 注入来源
        };
    }

    /**
     * 一个辅助函数，用于从一行文本中解析出键和值。
     * @param line 一行文本
     * @returns 一个包含 [key, value] 的元组
     */
    private parseKeyValue(line: string): [string | null, string | null] {
        const lineWithoutComment = line.split(';')[0];
        const equalsIndex = lineWithoutComment.indexOf('=');

        if (equalsIndex !== -1) {
            const key = lineWithoutComment.substring(0, equalsIndex).trim();
            const value = lineWithoutComment.substring(equalsIndex + 1).trim();
            return [key, value];
        } else {
            const key = lineWithoutComment.trim();
            return [key, null]; // 对于没有等号的行，值为 null
        }
    }
    
    /**
     * 根据类型名称反向查找其所属的分类。
     * @param typeName 要查询的类型名称
     */
    public getValueTypeCategory(typeName: string): ValueTypeCategory {
        if (this.complexTypes.has(typeName)) {return ValueTypeCategory.Section;}
        if (this.numberLimitTypes.has(typeName)) {return ValueTypeCategory.NumberLimit;}
        if (this.stringLimitTypes.has(typeName)) {return ValueTypeCategory.StringLimit;}
        if (this.listTypes.has(typeName)) {return ValueTypeCategory.List;}
        if (['int', 'float', 'double', 'string', 'bool'].includes(typeName)) {return ValueTypeCategory.Primitive;}
        return ValueTypeCategory.Unknown;
    }

    public getNumberLimit(typeName: string): NumberLimit | undefined { return this.numberLimits.get(typeName); }
    public getStringLimit(typeName: string): StringLimit | undefined { return this.stringLimits.get(typeName); }
    public getListDefinition(typeName: string): ListDefinition | undefined { return this.listDefinitions.get(typeName); }

    public getSchemaPath(): string | null { return this.schemaFilePath; }
    public isDictionaryDocument(uri: vscode.Uri): boolean {
        return uri.scheme === 'file' && this.dictionaryDocuments.has(path.resolve(uri.fsPath).toLowerCase());
    }

    public getTypeNames(): string[] {
        return [...new Set([...this.schemas.keys(), ...this.numberLimits.keys(), ...this.stringLimits.keys(), ...this.listDefinitions.keys(), 'int', 'float', 'double', 'string', 'bool'])];
    }

    /** One resolver is shared by hover, completion, references and diagnostics. */
    public getProperty(typeName: string, key: string): PropertyDefinition | undefined {
        const id = typeName.toLowerCase() + ':' + key.toLowerCase();
        if (this.propertyCache.has(id)) { return this.propertyCache.get(id); }
        const keys = this.getAllKeysForType(typeName);
        const result = [...keys].find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1]
            ?? [...keys].find(([name]) => patternIndex(name, key) !== undefined)?.[1];
        this.propertyCache.set(id, result); return result;
    }

    public expandedKeys(typeName: string, read: (key: string) => string | undefined): Map<string, PropertyDefinition> {
        const result = new Map<string, PropertyDefinition>();
        for (const [name, property] of this.getAllKeysForType(typeName)) {
            const pattern = keyPattern(name);
            if (!pattern) { result.set(name, property); continue; }
            const min = patternBound(pattern.minimum, read), max = patternBound(pattern.maximum, read);
            if (min === undefined || max === undefined || max < min) { continue; }
            for (let index = min; index <= Math.min(max, min + 255); index++) {
                result.set(pattern.prefix + index + pattern.suffix, property);
            }
        }
        return result;
    }

    public isAssignable(actual: string, expected: string): boolean {
        const visited = new Set<string>();
        while (actual && !visited.has(actual.toLowerCase())) {
            if (actual.toLowerCase() === expected.toLowerCase()) { return true; }
            visited.add(actual.toLowerCase());
            actual = this.getSchema(actual)?.base ?? '';
        }
        return false;
    }

    /**
     * 根据注册表名获取其对应的类型名。
     * @param registryName 注册表名, 如 'BuildingTypes'
     * @returns 类型名, 如 'BuildingType', 或 undefined
     */
    public getTypeForRegistry(registryName: string): string | undefined {
        return [...this.registries].find(([name]) => name.toLowerCase() === registryName.toLowerCase())?.[1];
    }
    
    /**
     * 根据类型名获取其对应的注册表名 (来自[Registries])。
     * @param typeName 类型名, 如 'BuildingType'
     * @returns 注册表名, 如 'BuildingTypes', 或 undefined
     */
    public getRegistryForType(typeName: string): string | undefined {
        return this.typeToRegistryMap.get(typeName);
    }
    
    /**
     * 根据类型名获取其对应的注册表名 (来自[Sections])。
     * @param typeName 类型名, 如 'AnimType'
     * @returns 注册表名, 如 'Animations', 或 undefined
     */
    public getRegistryForComplexType(typeName: string): string | undefined {
        return this.sections.get(typeName);
    }

    /**
     * 获取所有在 [Registries] 中定义的注册表名称。
     * @returns 包含所有注册表名的 Set
     */
    public getRegistryNames(): Set<string> {
        return new Set(this.registries.keys());
    }

    /**
     * 获取那些映射到复杂对象类型（在[Sections]中定义）的注册表名称。
     * 这些是真正的“ID列表”注册表，应该被 `INIManager` 索引。
     * @returns 包含ID列表注册表名称的 Set
     */
    public getIdListRegistryNames(): Set<string> {
        const idListRegistries = new Set<string>();
        for (const [registryName, typeName] of this.registries.entries()) {
            if (this.complexTypes.has(typeName)) {
                idListRegistries.add(registryName);
            }
        }
        return idListRegistries;
    }

    /**
     * 获取指定类型的所有合法键，包括从所有父类递归继承的键。
     * @param typeName 类型名, 如 'BuildingType'
     * @returns 一个包含所有键及其完整定义的 Map
     */
    public getAllKeysForType(typeName: string, visited = new Set<string>()): Map<string, PropertyDefinition> {
        if (visited.has(typeName)) { return new Map(); }
        visited.add(typeName);
        // 优先从缓存中读取, 避免重复计算。
        if (this.keyCache.has(typeName)) {
            return this.keyCache.get(typeName)!;
        }

        const schema = this.schemas.get(typeName);
        if (!schema) {
            return new Map();
        }

        // 递归地获取父类的所有键。
        const baseKeys = schema.base ? this.getAllKeysForType(schema.base, visited) : new Map();
        
        // 合并父类的键和当前类型的键。
        // Map的构造函数特性确保了子类键会覆盖父类的同名键。
        const allKeys = new Map(baseKeys);
        for (const [key, property] of schema.keys) {
            const old = [...allKeys.keys()].find(name => name.toLowerCase() === key.toLowerCase());
            if (old) { allKeys.delete(old); }
            allKeys.set(key, property);
        }

        // 将计算结果存入缓存。
        this.keyCache.set(typeName, allKeys);
        return allKeys;
    }

    /**
     * 沿着类型继承链向上查找，确定是哪个基类首次定义了给定的键。
     * @param typeName 起始类型名
     * @param keyName 要查找的键名
     * @returns 返回包含定义者类型名和其位置信息的对象
     */
    public findKeyDefiner(typeName: string, keyName: string): { definerTypeName: string, locationInfo: { location: vscode.Location; lineText: string } | null } | null {
        let currentTypeName: string | null = typeName;
        let definerTypeName: string | null = null;
    
        while (currentTypeName) {
            const schema = this.schemas.get(currentTypeName);
            if (schema?.keys.has(keyName)) {
                definerTypeName = currentTypeName;
            }
            currentTypeName = schema?.base ?? null;
        }
    
        if (!definerTypeName) {
            return null;
        }

        const locationInfo = this.findKeyLocationInSchema(definerTypeName, keyName);
        return { definerTypeName, locationInfo };
    }

    /**
     * 在 Schema 文件中查找特定类型内某个键的精确位置和内容。
     * @param typeName 要搜索的类型名 (必须是定义键的那个确切类型)
     * @param keyName 要查找的键名
     * @returns 包含位置和行文本的对象，如果未找到则返回 null
     */
    private findKeyLocationInSchema(typeName: string, keyName: string): { location: vscode.Location; lineText: string } | null {
        if (!this.schemaFilePath) {
            return null;
        }

        try {
            const content = fs.readFileSync(this.schemaFilePath, 'utf-8');
            const lines = content.split(/\r?\n/);
            
            const escapeRegex = (str: string) => str.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
            const sectionRegex = new RegExp(`^\\[${escapeRegex(typeName)}\\]`);
            const keyRegex = new RegExp(`^\\s*${escapeRegex(keyName)}\\s*(=|\\()`);
            const nextSectionRegex = /^\s*\[.+\]/;

            let inSection = false;
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                const trimmedLine = line.trim();
                if (sectionRegex.test(trimmedLine)) {
                    inSection = true;
                    continue;
                }

                if (inSection) {
                    if (keyRegex.test(line)) {
                        const keyStartIndex = line.indexOf(keyName);
                        const range = new vscode.Range(i, keyStartIndex, i, keyStartIndex + keyName.length);
                        const location = new vscode.Location(vscode.Uri.file(this.schemaFilePath), range);
                        return { location, lineText: line.trim() };
                    }
                    if (nextSectionRegex.test(trimmedLine)) {
                        break;
                    }
                }
            }
        } catch (error) {
            console.error(`Error reading schema file for key location: ${error}`);
            return null;
        }
        
        return null;
    }

    /**
     * 为指定类型生成一个详细的、用于调试的继承链分析报告。
     * @param typeName 要分析的类型名
     * @returns 一个字符串数组，每一行都是报告的一部分
     */
    public getDebugInfoForType(typeName: string): string[] {
        const lines: string[] = [];
        const analyzed = new Set<string>();

        const analyze = (name: string, indent: string) => {
            if (analyzed.has(name)) {
                lines.push(`${indent}- ${localize('debug.analysis.circularRef', "(Error: Circular inheritance detected at '{0}')", name)}`);
                return;
            }
            analyzed.add(name);

            const definition = this.schemas.get(name);
            lines.push(`${indent}- ${localize('debug.analysis.analyzingType', "Analyzing type '{0}'...", name)}`);

            if (!definition) {
                lines.push(`${indent}  - ${localize('debug.analysis.typeNotFound', "❌ Error: Definition for this type not found in the schema.")}`);
                return;
            }

            lines.push(`${indent}  - ${localize('debug.analysis.nativeKeys', "Native keys: {0}", definition.keys.size)}`);
            if (definition.base) {
                lines.push(`${indent}  - ${localize('debug.analysis.inheritsFrom', "Inherits from: '{0}'", definition.base)}`);
                analyze(definition.base, indent + "  ");
            } else {
                lines.push(`${indent}  - ${localize('debug.analysis.inheritanceTop', "Reached the top of the inheritance chain.")}`);
            }
        };

        analyze(typeName, "");
        return lines;
    }
}
