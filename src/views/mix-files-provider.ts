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
        return this.resourceService.getMixViewChildren(element);
    }

    protected override getCommand(element: ResourceNode): vscode.Command | undefined {
        if (element.kind === 'mixEntryFile') {
            return {
                command: 'vscode.open',
                title: 'Open',
                arguments: [element.uri],
            };
        }

        return super.getCommand(element);
    }
}
