import * as vscode from 'vscode';
import * as path from 'path';
import { INIManager } from './parser';
import { localize } from './i18n';

enum OutlineItemType {
    Directory,
    File,
    Section,
    Key
}

class OutlineItem extends vscode.TreeItem {
    public itemType: OutlineItemType;
    public filePath: string;
    public sectionName?: string;
    public keyPath?: string;
    public data?: any; 

    constructor(
        label: string,
        itemType: OutlineItemType,
        filePath: string,
        collapsibleState: vscode.TreeItemCollapsibleState,
        options?: {
            sectionName?: string;
            keyPath?: string;
            lineNumber?: number;
            data?: any;
            description?: string;
        }
    ) {
        super(label, collapsibleState);
        this.itemType = itemType;
        this.filePath = filePath;
        this.sectionName = options?.sectionName;
        this.keyPath = options?.keyPath;
        this.data = options?.data;
        this.description = options?.description;
        this.contextValue = OutlineItemType[itemType]; 
        this.iconPath = this.getIcon();

        if (options?.lineNumber !== undefined) {
            const uri = vscode.Uri.file(this.filePath);
            const position = new vscode.Position(options.lineNumber, 0);
            this.command = {
                command: 'vscode.open',
                title: localize('outline.goToDefinition', 'Go to Definition'),
                arguments: [uri, { selection: new vscode.Range(position, position) }]
            };
        }
    }

    private getIcon(): vscode.ThemeIcon {
        switch (this.itemType) {
            case OutlineItemType.Directory:
                return new vscode.ThemeIcon('folder');
            case OutlineItemType.File:
                return new vscode.ThemeIcon('notebook');
            case OutlineItemType.Section:
                return new vscode.ThemeIcon('symbol-namespace');
            case OutlineItemType.Key:
                return new vscode.ThemeIcon('symbol-key');
            default:
                return new vscode.ThemeIcon('circle-outline');
        }
    }
}

export class INIOutlineProvider implements vscode.TreeDataProvider<OutlineItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<OutlineItem | undefined | null | void> = new vscode.EventEmitter<OutlineItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<OutlineItem | undefined | null | void> = this._onDidChangeTreeData.event;

    constructor(private context: vscode.ExtensionContext, private iniManager: INIManager) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: OutlineItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: OutlineItem): Promise<OutlineItem[]> {
        if (!vscode.workspace.workspaceFolders) {
            vscode.window.showInformationMessage(localize('outline.noFiles', 'No INI files in empty workspace'));
            return [];
        }

        if (!element) {
            const fileUris = Array.from(this.iniManager.documents.values())
                .map(doc => doc.uri)
                .filter(uri => uri.scheme === 'file')
                .map(uri => uri.fsPath)
                .filter(p => !p.includes('INIConfigCheck.ini')); 

            const tree = this.buildFileTree(fileUris);
            return this.createTreeItemsFromNode(tree, vscode.workspace.workspaceFolders[0].uri.fsPath);
        }

        const { itemType, filePath } = element;

        switch (itemType) {
            case OutlineItemType.Directory:
                return this.createTreeItemsFromNode(element.data, filePath);
            
            case OutlineItemType.File:
                const doc = this.iniManager.getDocument(vscode.Uri.file(filePath));
                if (!doc) {return [];}
                
                return doc.sections.map(sec => {
                    return new OutlineItem(
                        `[${sec.name}]`, 
                        OutlineItemType.Section, 
                        filePath, 
                        sec.properties.size > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None, 
                        { sectionName: sec.name, lineNumber: sec.startLine }
                    );
                });

            case OutlineItemType.Section:
                // 使用 Document Model 直接获取属性，替代旧的 parsed 对象
                const sectionDoc = this.iniManager.getDocument(vscode.Uri.file(filePath));
                const section = sectionDoc?.getSection(element.sectionName!);
                
                if (!section) { return []; }

                // 由于属性没有行号索引，需要重新扫描一下该节的范围
                // 但我们在 buildCrossReferencesIndex 里已经知道如何扫描了
                // 为了大纲的性能，这里做一次局部扫描
                const items: OutlineItem[] = [];
                const lines = sectionDoc!.content.split(/\r?\n/);
                
                // 这里只列出直接属性，不支持旧版的嵌套对象（因为 INI 本质是扁平的）
                for (const [key, value] of section.properties) {
                    // 简单查找行号
                    let lineNum = section.startLine;
                    // 优化：从节头开始往下找
                    for(let i = section.startLine + 1; i <= section.endLine; i++) {
                        const line = lines[i];
                        const eqIdx = line.indexOf('=');
                        if (eqIdx !== -1 && line.substring(0, eqIdx).trim() === key) {
                            lineNum = i;
                            break;
                        }
                    }
                    
                    items.push(new OutlineItem(
                        key,
                        OutlineItemType.Key,
                        filePath,
                        vscode.TreeItemCollapsibleState.None,
                        {
                            sectionName: element.sectionName,
                            keyPath: key,
                            lineNumber: lineNum,
                            description: value
                        }
                    ));
                }
                return items;
            
            // Key 级别不再有子级
            case OutlineItemType.Key:
                return [];
        }

        return [];
    }

    private buildFileTree(filePaths: string[]): any {
        const tree: { [key: string]: any } = {};
        const workspaceRoot = vscode.workspace.workspaceFolders![0].uri.fsPath;

        for (const filePath of filePaths) {
            const relativePath = path.relative(workspaceRoot, filePath);
            const parts = relativePath.split(path.sep);
            let currentNode: { [key: string]: any } = tree; 

            for (let i = 0; i < parts.length; i++) {
                const part = parts[i];
                if (!currentNode[part]) {
                    currentNode[part] = i === parts.length - 1 ? { __is_file__: true, __full_path__: filePath } : {};
                }
                currentNode = currentNode[part];
            }
        }
        return tree;
    }

    private createTreeItemsFromNode(node: any, parentPath: string): OutlineItem[] {
        const items = Object.entries(node).map(([name, childNode]: [string, any]) => {
            const currentPath = path.join(parentPath, name);
            if (childNode.__is_file__) {
                return new OutlineItem(name, OutlineItemType.File, childNode.__full_path__, vscode.TreeItemCollapsibleState.Collapsed);
            } else {
                return new OutlineItem(name, OutlineItemType.Directory, currentPath, vscode.TreeItemCollapsibleState.Collapsed, { data: childNode });
            }
        });

        return items.sort((a, b) => {
            if (a.itemType !== b.itemType) {
                return a.itemType === OutlineItemType.Directory ? -1 : 1;
            }
            return String(a.label!).localeCompare(String(b.label!));
        });
    }
}
