import * as vscode from 'vscode';
import { ResourcePath } from './resources/resource-path';

/** Compile category globs: single wildcards stay within a path segment. */
export function compileFileCategoryGlob(glob: string): RegExp {
    const pattern = glob.replace(/\\/g, '/');
    let expression = '';
    for (let index = 0; index < pattern.length; index++) {
        const character = pattern[index];
        if (character === '*' && pattern[index + 1] === '*') {
            index++;
            if (pattern[index + 1] === '/') {
                expression += '(?:[^/]+/)*';
                index++;
            } else {
                expression += '.*';
            }
        } else if (character === '*') {
            expression += '[^/]*';
        } else if (character === '?') {
            expression += '[^/]';
        } else {
            expression += character.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        }
    }
    return new RegExp(`^${expression}$`, 'i');
}

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
        const categoryConfig = config.get<{ [key: string]: string[] }>('fileCategories', {});

        for (const [category, patterns] of Object.entries(categoryConfig)) {
            const regexes = patterns.map(compileFileCategoryGlob);
            this.categories.set(category, regexes);
        }
    }

    /**
     * 获取所有已配置分类中的 glob 模式总集合。
     * 用于传递给 INIManager 进行文件索引。
     */
    public getAllCategoryPatterns(): string[] {
        const config = vscode.workspace.getConfiguration('ra2-ini-intellisense.indexing');
        const categoryConfig = config.get<{ [key: string]: string[] }>('fileCategories', {});
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
        const relativePath = vscode.workspace.asRelativePath(uri).replace(/\\/g, '/');

        for (const [category, regexes] of this.categories.entries()) {
            for (const regex of regexes) {
                if (regex.test(relativePath) || regex.test(fileName)) {
                    return category;
                }
            }
        }
        return 'INI';
    }
}
