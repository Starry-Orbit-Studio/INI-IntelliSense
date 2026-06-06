import * as vscode from 'vscode';
import { SchemaManager } from './schema-manager';
import { FileTypeManager } from './file-type-manager';

/**
 * 表示 INI 文件中的一个节的元数据
 */
export interface IniSection {
    name: string;
    startLine: number;
    endLine: number;
    // 存储该节内的键值对，用于快速查找值。
    // 为了节省内存，只存储关键信息，或者仅在需要时按需解析。
    // 这里为了性能平衡，存储简单的 Key-Value 映射。
    properties: Map<string, string>;
    parentName?: string;
}

/**
 * 表示一个解析后的 INI 文档对象模型
 * 替代原本的 'ini' 库解析结果，提供更高效的行级访问和元数据支持。
 */
export class IniDocument {
    public sections: IniSection[] = [];
    private sectionMap: Map<string, IniSection> = new Map();
    
    constructor(public uri: vscode.Uri, public content: string) {
        this.parse();
    }

    public update(content: string) {
        this.content = content;
        this.parse();
    }

    /**
     * 极速解析器：只扫描行首结构，构建节的索引。
     * 相比通用的 ini parser，它忽略了值的复杂解析，专注于结构和范围。
     */
    private parse() {
        this.sections = [];
        this.sectionMap.clear();
        
        const lines = this.content.split(/\r?\n/);
        let currentSection: IniSection | null = null;

        const sectionRegex = /^\s*\[([^\]:]+)\](?::\[([^\]]+)\])?/;
        const kvRegex = /^\s*([^;=\s][^=]*?)\s*=(.*)/;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith(';')) {
                continue;
            }

            const sectionMatch = line.match(sectionRegex);
            if (sectionMatch) {
                if (currentSection) {
                    currentSection.endLine = i - 1;
                }
                const name = sectionMatch[1].trim();
                const parent = sectionMatch[2] ? sectionMatch[2].trim() : undefined;
                
                currentSection = {
                    name,
                    startLine: i,
                    endLine: lines.length - 1, // 默认为文件末尾，遇到下个节时更新
                    properties: new Map(),
                    parentName: parent
                };
                this.sections.push(currentSection);
                this.sectionMap.set(name, currentSection);
                continue;
            }

            if (currentSection) {
                const kvMatch = line.match(kvRegex);
                if (kvMatch) {
                    const key = kvMatch[1].trim();
                    // 简单存储值，去除行内注释
                    const val = kvMatch[2].split(';')[0].trim(); 
                    currentSection.properties.set(key, val);
                }
            }
        }
    }

    public getSectionAt(line: number): IniSection | undefined {
        // 二分查找优化
        let low = 0, high = this.sections.length - 1;
        while (low <= high) {
            const mid = Math.floor((low + high) / 2);
            const sec = this.sections[mid];
            if (line >= sec.startLine && line <= sec.endLine) {
                return sec;
            } else if (line < sec.startLine) {
                high = mid - 1;
            } else {
                low = mid + 1;
            }
        }
        return undefined;
    }

    public getSection(name: string): IniSection | undefined {
        return this.sectionMap.get(name);
    }

    public getAllSections(): IniSection[] {
        return this.sections;
    }
}

/**
 * INI文件管理器
 * 重构版：放弃 'ini' 库，使用自定义的 IniDocument 模型。
 * 实现了基于行的增量思维和更高效的索引维护。
 */
export class INIManager {
    // 核心数据存储：URI -> Document Model
    public documents: Map<string, IniDocument> = new Map();
    
    // 向下兼容的属性，模拟原本的 files 结构，尽可能减少对外部代码的破坏
    public get files(): Map<string, { content: string; parsed: any }> {
        const compatMap = new Map();
        for (const [path, doc] of this.documents) {
            compatMap.set(path, { 
                content: doc.content, 
                // 动态构建一个兼容旧代码的 parsed 对象
                // 注意：这在频繁调用时有性能开销，建议逐步迁移外部调用到新 API
                parsed: this.createCompatParsedObject(doc)
            });
        }
        return compatMap;
    }

    private schemaManager?: SchemaManager;
    private fileTypeManager?: FileTypeManager;
    
    // 索引
    private sectionToRegistryMap: Map<string, string> = new Map();
    private sectionInheritance: Map<string, Map<string, string>> = new Map();
    public valueReferences: Map<string, vscode.Location[]> = new Map();
    public inheritanceReferences: Map<string, vscode.Location[]> = new Map();
    private sectionLocations: Map<string, vscode.Location[]> = new Map();
    
    // 缓存
    private inferredTypeCache = new Map<string, string>();

    private createCompatParsedObject(doc: IniDocument): any {
        const obj: any = {};
        for (const sec of doc.sections) {
            const props: any = {};
            for (const [k, v] of sec.properties) {
                props[k] = v;
            }
            obj[sec.name] = props;
        }
        return obj;
    }

    private clearAllIndexes() {
        this.sectionToRegistryMap.clear();
        this.valueReferences.clear();
        this.inheritanceReferences.clear();
        this.sectionInheritance.clear();
        this.sectionLocations.clear();
        this.inferredTypeCache.clear();
    }

    setSchemaManager(manager: SchemaManager) {
        this.schemaManager = manager;
    }

    setFileTypeManager(manager: FileTypeManager) {
        this.fileTypeManager = manager;
    }

    async indexFiles(fileUris: vscode.Uri[]) {
        this.documents.clear();
        this.clearAllIndexes();

        for (const fileUri of fileUris) {
            try {
                const fileContentBytes = await vscode.workspace.fs.readFile(fileUri);
                const content = Buffer.from(fileContentBytes).toString('utf8');
                this.documents.set(fileUri.toString(), new IniDocument(fileUri, content));
            } catch (error) {
                console.error(`Failed to parse INI file ${fileUri.toString()}:`, error);
            }
        }
        this.rebuildAllIndexes();
    }

    async updateFile(uri: vscode.Uri, content?: string) {
        try {
            const fileContent = content ?? Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
            const doc = this.documents.get(uri.toString());
            if (doc) {
                doc.update(fileContent);
            } else {
                this.documents.set(uri.toString(), new IniDocument(uri, fileContent));
            }
            
            // 策略：为了保证全局引用的正确性，目前仍执行全量索引重建。
            // 在极限性能优化中，这里可以是下一步的优化点（只更新当前文件的索引贡献）。
            // 但由于我们已经优化了 parsing 过程（不再生成大对象），这里的重建速度已经大幅提升。
            this.rebuildAllIndexes();
        } catch (error) {
            console.error(`Failed to update index for file ${uri.toString()}:`, error);
        }
    }

    removeFile(uri: vscode.Uri) {
        if (this.documents.has(uri.toString())) {
            this.documents.delete(uri.toString());
            this.rebuildAllIndexes();
        }
    }

    // --- 新增 API：直接基于文档模型查询 ---

    public getDocument(uriOrKey: string | vscode.Uri): IniDocument | undefined {
        const key = typeof uriOrKey === 'string'
            ? uriOrKey
            : uriOrKey.toString();
        return this.documents.get(key);
    }

    // --- 索引构建逻辑 (适配新模型) ---

    private rebuildAllIndexes() {
        this.clearAllIndexes();
        this.buildRegistryIndex();
        this.buildCrossReferencesIndex();
    }

    private buildRegistryIndex() {
        if (!this.schemaManager) {return;}
        const idListRegistryNames = this.schemaManager.getIdListRegistryNames();
        if (idListRegistryNames.size === 0) {return;}
    
        for (const [filePath, doc] of this.documents) {
            for (const sec of doc.sections) {
                if (idListRegistryNames.has(sec.name)) {
                    for (const [key, value] of sec.properties) {
                        // 注册表项通常是 Index=ID，但也可能只有 ID
                        if (value) {
                            this.sectionToRegistryMap.set(value, sec.name);
                        }
                    }
                }
            }
        }
    }

    private buildCrossReferencesIndex() {
        for (const [filePath, doc] of this.documents) {
            const fileUri = doc.uri;
            const currentFileType = this.fileTypeManager?.getFileType(fileUri) || 'INI';
            const lines = doc.content.split(/\r?\n/); // 仍需行访问计算精确列号

            for (const sec of doc.sections) {
                // 1. 节定义位置
                const nameIndex = lines[sec.startLine].indexOf(sec.name);
                if (nameIndex !== -1) {
                    const loc = new vscode.Location(fileUri, new vscode.Position(sec.startLine, nameIndex));
                    const existing = this.sectionLocations.get(sec.name) || [];
                    existing.push(loc);
                    this.sectionLocations.set(sec.name, existing);
                }

                // 2. 继承引用
                if (sec.parentName) {
                    if (!this.sectionInheritance.has(currentFileType)) {
                        this.sectionInheritance.set(currentFileType, new Map());
                    }
                    this.sectionInheritance.get(currentFileType)!.set(sec.name, sec.parentName);

                    const parentIndex = lines[sec.startLine].lastIndexOf(sec.parentName);
                    if (parentIndex !== -1) {
                        const loc = new vscode.Location(fileUri, new vscode.Range(sec.startLine, parentIndex, sec.startLine, parentIndex + sec.parentName.length));
                        const refs = this.inheritanceReferences.get(sec.parentName) || [];
                        refs.push(loc);
                        this.inheritanceReferences.set(sec.parentName, refs);
                    }
                }

                // 3. 值引用
                // 遍历属性（不需要再次正则匹配，直接用 properties）
                // 但为了获取行号，我们可能需要稍微反查一下，或者在解析时存储 Key 的行号
                // 为了内存效率，解析时没存 Key 行号。这里局部扫描一下节范围即可，速度很快。
                for (let i = sec.startLine + 1; i <= sec.endLine; i++) {
                    const line = lines[i];
                    const eqIdx = line.indexOf('=');
                    if (eqIdx === -1) { continue; }
                    
                    const valPart = line.substring(eqIdx + 1).split(';')[0];
                    if (!valPart.trim()) { continue; }

                    const values = valPart.split(',');
                    let currentSearchIdx = eqIdx + 1;
                    
                    for (const v of values) {
                        const trimmed = v.trim();
                        if (trimmed) {
                            const idx = line.indexOf(trimmed, currentSearchIdx);
                            if (idx !== -1) {
                                const range = new vscode.Range(i, idx, i, idx + trimmed.length);
                                const refs = this.valueReferences.get(trimmed) || [];
                                refs.push(new vscode.Location(fileUri, range));
                                this.valueReferences.set(trimmed, refs);
                                currentSearchIdx = idx + trimmed.length;
                            }
                        }
                    }
                }
            }
        }
    }

    // --- 查询 API (保持或适配) ---

    findSection(name: string, filterFileType?: string): { file: string; content: string }[] {
        const results: { file: string; content: string }[] = [];
        const locations = this.sectionLocations.get(name) || [];

        for (const location of locations) {
            if (filterFileType && filterFileType !== 'INI' && this.fileTypeManager) {
                const currentFileCategory = this.fileTypeManager.getFileType(location.uri);
                if (currentFileCategory !== filterFileType) {
                    continue;
                }
            }
            const doc = this.documents.get(location.uri.toString());
            if (doc) {
                // 为了保持 findSection 签名的兼容性，这里传递整个 content
                // 实际上外部调用者通常只需要 content 来再次切分行，这有点浪费
                // 但为了不破坏太多外部逻辑，暂且如此
                results.push({ file: location.uri.toString(), content: doc.content });
            }
        }
        return results;
    }

    findSectionLocations(name: string): vscode.Location[] {
        return this.sectionLocations.get(name) || [];
    }

    findSectionInContent(content: string, sectionName: string): number | null {
        // 这个辅助函数是静态的逻辑，可以用正则
        const escaped = sectionName.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
        const regex = new RegExp(`^\\[${escaped}\\]`, 'm');
        const match = content.match(regex);
        if (match && match.index !== undefined) {
            // 计算行号
            return content.substring(0, match.index).split('\n').length - 1;
        }
        return null;
    }
    
    // 优化：直接利用 Section 索引
    findSectionRange(content: string, sectionName: string): vscode.Range | null {
        // 由于 content 是传入的字符串，无法直接用 documents 里的缓存
        // 必须重新扫描。如果传入的是已有文件的 content，应尽量改用 getDocument
        // 这里为了兼容性保持原逻辑，但建议调用方优化
        const lines = content.split(/\r?\n/);
        const escaped = sectionName.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
        const sectionRegex = new RegExp(`^\\[${escaped}\\]`, 'i');
        const nextSectionRegex = /^\s*\[.+\]/;

        let startLine = -1;
        for (let i = 0; i < lines.length; i++) {
            if (sectionRegex.test(lines[i].trim())) {
                startLine = i;
                break;
            }
        }
        if (startLine === -1) { return null; }
        
        let endLine = lines.length;
        for (let i = startLine + 1; i < lines.length; i++) {
            if (nextSectionRegex.test(lines[i].trim())) {
                endLine = i;
                break;
            }
        }
        return new vscode.Range(startLine, 0, endLine - 1, lines[endLine - 1].length);
    }

    public findKeyLocation(sectionName: string, keyName: string, contextFileType?: string): { location: vscode.Location; lineText: string } | null {
        // 优化：使用 Section 索引快速定位范围
        const locations = this.findSectionLocations(sectionName);
        for (const loc of locations) {
            if (contextFileType && contextFileType !== 'INI' && this.fileTypeManager) {
                if (this.fileTypeManager.getFileType(loc.uri) !== contextFileType) { continue; }
            }
            
            const doc = this.documents.get(loc.uri.toString());
            if (!doc) { continue; }

            const section = doc.getSectionAt(loc.range.start.line);
            if (!section) { continue; }

            // 只在节的范围内查找
            const lines = doc.content.split(/\r?\n/);
            const keyRegex = new RegExp(`^\\s*${keyName.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}\\s*=`, 'i');
            
            for (let i = section.startLine + 1; i <= section.endLine; i++) {
                const line = lines[i];
                if (keyRegex.test(line)) {
                    const keyIdx = line.toLowerCase().indexOf(keyName.toLowerCase());
                    const range = new vscode.Range(i, keyIdx, i, keyIdx + keyName.length);
                    return { location: new vscode.Location(loc.uri, range), lineText: line.trim() };
                }
            }
        }
        return null;
    }

    public findKeyLocationRecursive(
        sectionName: string, 
        keyName: string,
        contextFileType?: string
    ): { location: vscode.Location | null; lineText: string | null, definer: string | null } {
        let currentSection: string | null = sectionName;
        const visited = new Set<string>();

        while (currentSection && !visited.has(currentSection)) {
            visited.add(currentSection);
            const result = this.findKeyLocation(currentSection, keyName, contextFileType);
            if (result) {
                return { ...result, definer: currentSection };
            }
            currentSection = this.getInheritance(currentSection, contextFileType) ?? null;
        }
        return { location: null, lineText: null, definer: null };
    }

    public getTypeForSection(sectionName: string, visited: Set<string> = new Set()): string {
        if (!this.schemaManager) {return sectionName;}
        if (visited.has(sectionName)) { return sectionName; }
        visited.add(sectionName);
        
        if (this.inferredTypeCache.has(sectionName)) { return this.inferredTypeCache.get(sectionName)!; }
        
        if (this.schemaManager.isSchemaType(sectionName)) {
            this.inferredTypeCache.set(sectionName, sectionName);
            return sectionName;
        }
        
        const registryName = this.findRegistryForSection(sectionName);
        if (registryName) {
            const typeName = this.schemaManager.getTypeForRegistry(registryName) ?? sectionName;
            this.inferredTypeCache.set(sectionName, typeName);
            return typeName;
        }

        // 上下文推断：如果这个节被某个 Key 引用了，看看那个 Key 需要什么类型
        const refs = this.valueReferences.get(sectionName);
        if (refs && refs.length > 0) {
            // 只需要检查一个引用即可推断
            const loc = refs[0];
            const doc = this.documents.get(loc.uri.toString());
            if (doc) {
                const contextSec = doc.getSectionAt(loc.range.start.line);
                if (contextSec) {
                    const contextTypeName = this.getTypeForSection(contextSec.name, visited);
                    const allKeys = this.schemaManager.getAllKeysForType(contextTypeName);
                    
                    // 找到引用行的 Key
                    const line = doc.content.split(/\r?\n/)[loc.range.start.line];
                    const kvMatch = line.match(/^\s*([^;=\s][^=]*?)\s*=/);
                    if (kvMatch) {
                        const key = kvMatch[1].trim();
                        for (const [k, propDef] of allKeys) {
                            if (k.toLowerCase() === key.toLowerCase()) {
                                if (this.schemaManager.isComplexType(propDef.type)) {
                                    this.inferredTypeCache.set(sectionName, propDef.type);
                                    return propDef.type;
                                }
                            }
                        }
                    }
                }
            }
        }

        this.inferredTypeCache.set(sectionName, sectionName);
        return sectionName;
    }

    public getInheritance(sectionName: string, fileType: string = 'INI'): string | undefined {
        const typeMap = this.sectionInheritance.get(fileType);
        return typeMap ? typeMap.get(sectionName) : undefined;
    }
    
    public getSectionNameAtLine(uriOrKey: string | vscode.Uri, lineNumber: number): string | null {
        const key = typeof uriOrKey === 'string'
            ? uriOrKey
            : uriOrKey.toString();
        const doc = this.documents.get(key);
        if (doc) {
            const sec = doc.getSectionAt(lineNumber);
            return sec ? sec.name : null;
        }
        return null;
    }

    public findRegistryForSection(sectionName: string): string | undefined {
        return this.sectionToRegistryMap.get(sectionName);
    }

    // 适配：获取节的简单数据对象
    public getSectionData(sectionName: string): { [key: string]: any } | undefined {
        for (const doc of this.documents.values()) {
            const sec = doc.getSection(sectionName);
            if (sec) {
                const obj: any = {};
                for (const [k, v] of sec.properties) {
                    obj[k] = v;
                }
                return obj;
            }
        }
        return undefined;
    }

    public findReferences(name: string): vscode.Location[] {
        return this.valueReferences.get(name) || [];
    }

    public getRegistryMapSize(): number {
        return this.sectionToRegistryMap.size;
    }

    public getAllSectionNames(): Set<string> {
        const names = new Set<string>();
        for (const doc of this.documents.values()) {
            for (const sec of doc.sections) {
                names.add(sec.name);
            }
        }
        return names;
    }
    
    public getValuesForKey(keyName: string): Set<string> {
        const values = new Set<string>();
        for (const doc of this.documents.values()) {
            for (const sec of doc.sections) {
                if (sec.properties.has(keyName)) {
                    const val = sec.properties.get(keyName)!;
                    val.split(',').forEach(v => {
                        const t = v.trim();
                        if (t) { values.add(t); }
                    });
                }
            }
        }
        return values;
    }

    public getValuesForRegistry(registryName: string): Set<string> {
        const values = new Set<string>();
        if (!registryName) {return values;}

        for (const doc of this.documents.values()) {
            const sec = doc.getSection(registryName);
            if (sec) {
                for (const [k, v] of sec.properties) {
                    if (v) { values.add(v); }
                }
            }
        }
        return values;
    }

    getSectionComment(content: string, sectionName: string) {
        // 简单实现，假设 content 是完整的
        // 由于这个功能只在 hover 时调用一次，可以使用线性扫描
        const lines = content.split('\n');
        let sectionIndex = -1;
        let inlineComment = null;
    
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line.startsWith(`[${sectionName}]`)) {
                sectionIndex = i;
                const inlineIndex = line.indexOf(';');
                if (inlineIndex !== -1) {
                    inlineComment = line.substring(inlineIndex + 1).trim();
                }
                break;
            }
        }
        if (sectionIndex === -1) {return null;}
        const comments = [];
        for (let i = sectionIndex - 1; i >= 0; i--) {
            const line = lines[i].trim();
            if (line.startsWith(';')) {
                comments.unshift(line.substring(1).trim() + '\n');
            } else if (line.length > 0) {
                break;
            }
        }
        return comments.length > 0 ? comments.join('\n') : inlineComment;
    }
}
