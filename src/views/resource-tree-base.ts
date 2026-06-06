import * as vscode from 'vscode';
import { ResourceNode } from '../resources/resource-node';
import { ResourceService } from '../resources/resource-service';

export abstract class ResourceTreeBase implements vscode.TreeDataProvider<ResourceNode> {
    private readonly changeEmitter = new vscode.EventEmitter<ResourceNode | undefined | null | void>();
    public readonly onDidChangeTreeData = this.changeEmitter.event;

    constructor(protected readonly resourceService: ResourceService) {}

    public refresh(): void {
        this.changeEmitter.fire();
    }

    public getTreeItem(element: ResourceNode): vscode.TreeItem {
        const collapsible = this.hasChildren(element)
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None;
        const item = new vscode.TreeItem(element.label, collapsible);
        item.resourceUri = element.uri;
        item.contextValue = element.contextValue;
        item.description = element.description;
        item.iconPath = this.getIcon(element);
        item.command = this.getCommand(element);
        return item;
    }

    public abstract getChildren(element?: ResourceNode): Promise<ResourceNode[]>;

    protected hasChildren(element: ResourceNode): boolean {
        return element.kind === 'workspaceRoot' || element.kind === 'directory' || element.kind === 'mixFile' || element.kind === 'mixDirectory';
    }

    protected getIcon(element: ResourceNode): vscode.ThemeIcon | undefined {
        switch (element.kind) {
            case 'workspaceRoot':
            case 'directory':
            case 'mixDirectory':
                return new vscode.ThemeIcon('folder');
            case 'mixFile':
                return new vscode.ThemeIcon('archive');
            case 'iniFile':
                return new vscode.ThemeIcon('notebook');
            default:
                return undefined;
        }
    }

    protected getCommand(element: ResourceNode): vscode.Command | undefined {
        if (element.kind === 'iniFile' || element.kind === 'mixEntryFile' || element.kind === 'unknownFile') {
            return {
                command: 'vscode.open',
                title: 'Open',
                arguments: [element.uri],
            };
        }
        return undefined;
    }
}
