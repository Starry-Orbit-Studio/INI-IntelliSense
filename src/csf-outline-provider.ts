import * as vscode from 'vscode';
import * as path from 'path';
import { CsfManager, CsfEntry } from './csf-manager';
import { localize } from './i18n';

enum CsfOutlineItemType {
    File,
    Label
}

class CsfOutlineItem extends vscode.TreeItem {
    public itemType: CsfOutlineItemType;
    public filePath?: string;
    public labelName?: string;
    public data?: any;

    constructor(
        label: string,
        itemType: CsfOutlineItemType,
        collapsibleState: vscode.TreeItemCollapsibleState,
        options?: {
            filePath?: string;
            labelName?: string;
            data?: any;
            description?: string;
            tooltip?: string;
            command?: vscode.Command;
        }
    ) {
        super(label, collapsibleState);
        this.itemType = itemType;
        this.filePath = options?.filePath;
        this.labelName = options?.labelName;
        this.data = options?.data;
        this.description = options?.description;
        this.tooltip = options?.tooltip;
        this.contextValue = CsfOutlineItemType[itemType];
        this.iconPath = this.getIcon();

        if (options?.command) {
            this.command = options.command;
        }
    }

    private getIcon(): vscode.ThemeIcon {
        switch (this.itemType) {
            case CsfOutlineItemType.File:
                return new vscode.ThemeIcon('file-binary');
            case CsfOutlineItemType.Label:
                return new vscode.ThemeIcon('tag');
            default:
                return new vscode.ThemeIcon('circle-outline');
        }
    }
}

export class CsfOutlineProvider implements vscode.TreeDataProvider<CsfOutlineItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<CsfOutlineItem | undefined | null | void> = new vscode.EventEmitter<CsfOutlineItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<CsfOutlineItem | undefined | null | void> = this._onDidChangeTreeData.event;

    constructor(private csfManager: CsfManager) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: CsfOutlineItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: CsfOutlineItem): Promise<CsfOutlineItem[]> {
        if (!element) {
            // 检查是否已初始化
            if (!this.csfManager.isInitialized()) {
                return [new CsfOutlineItem(
                    localize('csfOutline.loading', 'Loading CSF files...'),
                    CsfOutlineItemType.File,
                    vscode.TreeItemCollapsibleState.None,
                    { description: localize('csfOutline.initializing', 'Initializing...') }
                )];
            }
            
            // 根节点：直接显示文件列表
            const files = this.csfManager.getFiles();
            if (files.length === 0) {
                return [new CsfOutlineItem(
                    localize('csfOutline.noFiles', 'No CSF files found'),
                    CsfOutlineItemType.File,
                    vscode.TreeItemCollapsibleState.None,
                    { description: localize('csfOutline.scanWorkspace', 'Scan workspace for .csf files') }
                )];
            }

            // 直接返回文件列表，不再有额外的根节点
            return files.map(filePath => {
                const fileName = path.basename(filePath);
                const fileLabels = this.csfManager.getLabelsByFile(vscode.Uri.file(filePath));
                const labelCount = fileLabels?.size || 0;
                
                return new CsfOutlineItem(
                    fileName,
                    CsfOutlineItemType.File,
                    labelCount > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
                    {
                        filePath,
                        description: `(${labelCount} labels)`,
                        tooltip: filePath
                    }
                );
            });
        }

        const { itemType } = element;

        switch (itemType) {
            case CsfOutlineItemType.File:
                // 显示文件中的标签
                if (!element.filePath) {
                    return [];
                }
                const fileLabels = this.csfManager.getLabelsByFile(vscode.Uri.file(element.filePath));
                if (!fileLabels || fileLabels.size === 0) {
                    return [];
                }

                const items: CsfOutlineItem[] = [];
                for (const [labelKey, entry] of fileLabels.entries()) {
                    // 截断过长的值用于显示
                    let displayValue = entry.value.replace(/\r?\n/g, ' ');
                    if (displayValue.length > 50) {
                        displayValue = displayValue.substring(0, 47) + '...';
                    }

                    items.push(new CsfOutlineItem(
                        entry.label,
                        CsfOutlineItemType.Label,
                        vscode.TreeItemCollapsibleState.None,
                        {
                            filePath: element.filePath,
                            labelName: entry.label,
                            description: displayValue,
                            tooltip: entry.extraValue ? 
                                `${entry.value}${entry.extraValue ? `\nExtra: ${entry.extraValue}` : ''}` : 
                                entry.value,
                            command: {
                                command: 'vscode.open',
                                title: localize('csfOutline.openFile', 'Open CSF File'),
                                arguments: [vscode.Uri.file(element.filePath!)]
                            }
                        }
                    ));
                }

                // 按标签名排序
                return items.sort((a, b) => String(a.label).localeCompare(String(b.label)));

            case CsfOutlineItemType.Label:
                // 标签没有子节点
                return [];
        }

        return [];
    }
}