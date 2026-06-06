import * as vscode from 'vscode';
import { MixUriCodec } from '../mix/fs/mix-uri-codec';
import { ResourceNode } from '../resources/resource-node';
import { ResourceService } from '../resources/resource-service';
import { ResourceTreeBase } from './resource-tree-base';

export class MixFilesProvider extends ResourceTreeBase {
    constructor(resourceService: ResourceService) {
        super(resourceService);
    }

    public async getChildren(element?: ResourceNode): Promise<ResourceNode[]> {
        if (!element) {
            const roots = await this.resourceService.getWorkspaceRootNodes();
            if (roots.length === 1) {
                return this.resourceService.getChildren(roots[0]);
            }
            return roots;
        }

        const children = await this.resourceService.getChildren(element);
        return children.filter(node =>
            node.kind === 'directory' ||
            node.kind === 'mixFile' ||
            node.kind === 'mixDirectory' ||
            node.kind === 'mixEntryFile');
    }

    protected override getCommand(element: ResourceNode): vscode.Command | undefined {
        if (element.kind === 'mixEntryFile') {
            return {
                command: 'vscode.open',
                title: 'Open',
                arguments: [element.uri],
            };
        }

        if (element.kind === 'mixFile' && element.uri.scheme === MixUriCodec.scheme) {
            return {
                command: 'ra2-ini-intellisense.mix.openAsWorkspace',
                title: 'Open MIX as Workspace',
                arguments: [element],
            };
        }

        return super.getCommand(element);
    }
}
