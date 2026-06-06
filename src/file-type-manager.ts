import * as vscode from 'vscode';
import * as path from 'path';
import { ResourcePath } from './resources/resource-path';

/**
 * 管理文件类型的分类和匹配。
 * 它读取配置中的 glob 模式，并确定给定文件属于哪个类别。
 */
export class FileTypeManager {
    private categories: Map<string, RegExp[]> = new Map();

    constructor() {
        this.reloadConfig();
    }

    /**
     * 从配置中重新加载文件分类规则。
     */
    public reloadConfig() {
        this.categories.clear();
        const config = vscode.workspace.getConfiguration('ra2-ini-intellisense.indexing');
        const categoryConfig = config.get<{[key: string]: string[]}>('fileCategories', {});

        for (const [category, patterns] of Object.entries(categoryConfig)) {
            const regexes = patterns.map(p => this.globToRegex(p));
            this.categories.set(category, regexes);
        }
    }

    /**
     * 获取所有已配置分类中的 glob 模式总集合。
     * 用于传递给 INIManager 进行文件索引。
     */
    public getAllCategoryPatterns(): string[] {
        const config = vscode.workspace.getConfiguration('ra2-ini-intellisense.indexing');
        const categoryConfig = config.get<{[key: string]: string[]}>('fileCategories', {});
        const allPatterns: string[] = [];
        for (const patterns of Object.values(categoryConfig)) {
            allPatterns.push(...patterns);
        }
        return allPatterns;
    }

    /**
     * 确定给定文件的类型。
     * @param uri 文件的 URI
     * @returns 文件类型名称（如 "Rules", "Art"），如果未匹配则返回 "INI"
     */
    public getFileType(uri: vscode.Uri): string {
        const fileName = ResourcePath.basename(uri);
        // 优先匹配完整路径，其次匹配文件名
        const relativePath = vscode.workspace.asRelativePath(uri);
        
        for (const [category, regexes] of this.categories.entries()) {
            for (const regex of regexes) {
                if (regex.test(relativePath) || regex.test(fileName)) {
                    return category;
                }
            }
        }
        return 'INI';
    }

    /**
     * 一个简单的 glob 转 regex 转换器，避免引入额外依赖。
     * 支持 * 和 ? 通配符。
     */
    private globToRegex(glob: string): RegExp {
        // 转义特殊正则字符
        let regexString = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        // 替换 glob 通配符
        regexString = regexString
            .replace(/\*/g, '.*')
            .replace(/\?/g, '.');
        
        // 确保匹配整个字符串（文件名或路径）
        return new RegExp(`^${regexString}$`, 'i');
    }
}
