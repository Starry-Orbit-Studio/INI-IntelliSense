import { ResourceNode } from '../resources/resource-node';
import { ResourceService } from '../resources/resource-service';
import { ResourceTreeBase } from './resource-tree-base';

export class IniFilesProvider extends ResourceTreeBase {
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
        return children.filter(node => node.kind === 'directory' || node.kind === 'iniFile');
    }
}
