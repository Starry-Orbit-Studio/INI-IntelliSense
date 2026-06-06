import * as path from 'path';
import * as vscode from 'vscode';
import { MixUriCodec } from '../mix/fs/mix-uri-codec';
import { ResourceNode } from './resource-node';
import { ResourcePath } from './resource-path';
import { MixDetectorService } from '../services/mix-detector-service';

export class ResourceService {
    constructor(private readonly mixDetectorService: MixDetectorService) {}

    public clearCaches(): void {
        // Reserved for future resource-tree caches.
    }

    public async getWorkspaceRootNodes(): Promise<ResourceNode[]> {
        const folders = vscode.workspace.workspaceFolders ?? [];
        return folders.map(folder => ({
            kind: 'workspaceRoot',
            uri: folder.uri,
            label: folder.name,
            description: ResourcePath.relativeToWorkspace(folder.uri),
            contextValue: 'workspaceRoot',
            parentUri: undefined,
        }));
    }

    public async getChildren(node?: ResourceNode): Promise<ResourceNode[]> {
        if (!node) {
            return this.getWorkspaceRootNodes();
        }

        if (node.kind === 'mixFile' || node.kind === 'mixDirectory') {
            return this.getMixChildren(node.uri);
        }

        if (node.kind === 'workspaceRoot' || node.kind === 'directory') {
            return this.getFileChildren(node.uri);
        }

        return [];
    }

    public async getIniViewChildren(node?: ResourceNode): Promise<ResourceNode[]> {
        if (!node) {
            const roots = await this.getWorkspaceRootNodes();
            if (roots.length === 1) {
                return this.getIniViewChildren(roots[0]);
            }
            return roots;
        }

        if (node.kind === 'workspaceRoot' || node.kind === 'directory') {
            return this.getFilteredWorkspaceChildren(node.uri, 'ini');
        }

        return [];
    }

    public async getMixViewChildren(node?: ResourceNode): Promise<ResourceNode[]> {
        if (!node) {
            const roots = await this.getWorkspaceRootNodes();
            if (roots.length === 1) {
                return this.getMixViewChildren(roots[0]);
            }
            return roots;
        }

        if (node.kind === 'workspaceRoot' || node.kind === 'directory') {
            return this.getFilteredWorkspaceChildren(node.uri, 'mix');
        }

        if (node.kind === 'mixFile' || node.kind === 'mixDirectory') {
            return this.getMixChildren(node.uri);
        }

        return [];
    }

    private async getFileChildren(uri: vscode.Uri): Promise<ResourceNode[]> {
        const entries = await vscode.workspace.fs.readDirectory(uri);
        const children: ResourceNode[] = [];
        for (const [name, type] of entries) {
            const childUri = vscode.Uri.joinPath(uri, name);
            if (type === vscode.FileType.Directory) {
                children.push({
                    kind: 'directory',
                    uri: childUri,
                    label: name,
                    contextValue: 'directory',
                    parentUri: uri,
                });
                continue;
            }

            const lower = name.toLowerCase();
            const mixLike = await this.mixDetectorService.isMixLike(childUri);
            if (mixLike) {
                children.push({
                    kind: 'mixFile',
                    uri: childUri,
                    sourceUri: childUri,
                    label: name,
                    contextValue: 'mixFile',
                    parentUri: uri,
                    mixContainer: true,
                });
            } else if (lower.endsWith('.ini')) {
                children.push({
                    kind: 'iniFile',
                    uri: childUri,
                    label: name,
                    contextValue: 'iniFile',
                    parentUri: uri,
                });
            } else {
                children.push({
                    kind: 'unknownFile',
                    uri: childUri,
                    label: name,
                    contextValue: 'unknownFile',
                    parentUri: uri,
                });
            }
        }

        return sortNodes(children);
    }

    private async getFilteredWorkspaceChildren(uri: vscode.Uri, mode: 'ini' | 'mix'): Promise<ResourceNode[]> {
        const entries = await vscode.workspace.fs.readDirectory(uri);
        const children = await Promise.all(entries.map(async ([name, type]): Promise<ResourceNode | undefined> => {
            const childUri = vscode.Uri.joinPath(uri, name);
            if (type === vscode.FileType.Directory) {
                return {
                    kind: 'directory',
                    uri: childUri,
                    label: name,
                    contextValue: 'directory',
                    parentUri: uri,
                };
            }

            if (mode === 'ini') {
                if (!name.toLowerCase().endsWith('.ini')) {
                    return undefined;
                }
                return {
                    kind: 'iniFile',
                    uri: childUri,
                    label: name,
                    contextValue: 'iniFile',
                    parentUri: uri,
                };
            }

            const isMixLike = await this.mixDetectorService.isMixLike(childUri);
            if (!isMixLike) {
                return undefined;
            }
            return {
                kind: 'mixFile',
                uri: childUri,
                sourceUri: childUri,
                label: name,
                contextValue: 'mixFile',
                parentUri: uri,
                mixContainer: true,
            };
        }));

        return sortNodes(children.filter((node): node is ResourceNode => node !== undefined));
    }

    private async getMixChildren(uri: vscode.Uri): Promise<ResourceNode[]> {
        const mixRoot = uri.scheme === MixUriCodec.scheme
            ? uri
            : MixUriCodec.toRootUri(uri);
        const entries = await vscode.workspace.fs.readDirectory(mixRoot);
        const children = await Promise.all(entries.map(async ([name, type]): Promise<ResourceNode> => {
            const childUri = MixUriCodec.toChildUri(mixRoot, path.posix.join(mixRoot.path, name));
            if (type === vscode.FileType.Directory) {
                return {
                    kind: 'mixDirectory',
                    uri: childUri,
                    label: name,
                    contextValue: 'mixDirectory',
                    parentUri: mixRoot,
                };
            }

            const mixLike = await this.mixDetectorService.isMixLike(childUri);
            return {
                kind: mixLike ? 'mixFile' : 'mixEntryFile',
                uri: mixLike ? MixUriCodec.toNestedRootUri(childUri) : childUri,
                sourceUri: childUri,
                label: name,
                contextValue: mixLike ? 'mixEntryMixFile' : 'mixEntryFile',
                parentUri: mixRoot,
                mixContainer: mixLike,
            };
        }));

        return sortNodes(children);
    }
}

function sortNodes(nodes: ResourceNode[]): ResourceNode[] {
    return [...nodes].sort((left, right) => {
        const leftDir = left.kind === 'workspaceRoot' || left.kind === 'directory' || left.kind === 'mixDirectory';
        const rightDir = right.kind === 'workspaceRoot' || right.kind === 'directory' || right.kind === 'mixDirectory';
        if (leftDir !== rightDir) {
            return leftDir ? -1 : 1;
        }
        return left.label.localeCompare(right.label);
    });
}
