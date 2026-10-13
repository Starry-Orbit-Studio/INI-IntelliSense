import * as vscode from 'vscode';
import { ResourceNode } from '../resources/resource-node';
import { ResourceService } from '../resources/resource-service';
import { localize } from '../i18n';

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
        if (element.kind === 'mixFile') { return { command: 'ra2-ini-intellisense.browseFiles', title: localize('mix.browser.title', 'Files and MIX'), arguments: [element.uri] }; }
        if (isPreviewableResource(element)) {
            return {
                command: 'vscode.openWith',
                title: localize('resourceTree.command.preview', 'Preview'),
                arguments: [element.uri, 'ra2-resource-preview.viewer'],
            };
        }

        if (element.kind === 'iniFile' || element.kind === 'mixEntryFile' || element.kind === 'unknownFile') {
            return {
                command: 'vscode.open',
                title: localize('resourceTree.command.open', 'Open'),
                arguments: [element.uri],
            };
        }
        return undefined;
    }
}

function isPreviewableResource(element: ResourceNode): boolean {
    if (element.kind !== 'mixEntryFile' && element.kind !== 'unknownFile') {
        return false;
    }

    const lowerPath = element.uri.path.toLowerCase();
    return lowerPath.endsWith('.pcx')
        || lowerPath.endsWith('.shp')
        || lowerPath.endsWith('.pal')
        || lowerPath.endsWith('.map')
        || lowerPath.endsWith('.mpr')
        || lowerPath.endsWith('.yrm')
        || lowerPath.endsWith('.vxl')
        || lowerPath.endsWith('.hva');
}
