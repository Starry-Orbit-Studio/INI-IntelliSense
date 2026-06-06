import { ResourceNode } from '../resources/resource-node';
import { ResourceService } from '../resources/resource-service';
import { ResourceTreeBase } from './resource-tree-base';

export class IniFilesProvider extends ResourceTreeBase {
    constructor(resourceService: ResourceService) {
        super(resourceService);
    }

    public async getChildren(element?: ResourceNode): Promise<ResourceNode[]> {
        return this.resourceService.getIniViewChildren(element);
    }
}
