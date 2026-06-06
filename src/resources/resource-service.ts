import * as path from 'path';
import * as vscode from 'vscode';
import { MixUriCodec } from '../mix/fs/mix-uri-codec';
import { ResourceNode } from './resource-node';
import { ResourcePath } from './resource-path';
import { MixDetectorService } from '../services/mix-detector-service';

export class ResourceService {
    private readonly iniDirectoryCache = new Map<string, boolean>();

    constructor(private readonly mixDetectorService: MixDetectorService) {}

    public clearCaches(): void {
        this.iniDirectoryCache.clear();
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
        const children: ResourceNode[] = [];
        for (const [name, type] of entries) {
            const childUri = vscode.Uri.joinPath(uri, name);
            if (type === vscode.FileType.Directory) {
                const containsRelevant = mode === 'ini'
                    ? await this.directoryContainsIni(childUri)
                    : await this.directoryContainsMix(childUri);
                if (!containsRelevant) {
                    continue;
                }

                children.push({
                    kind: 'directory',
                    uri: childUri,
                    label: name,
                    contextValue: 'directory',
                    parentUri: uri,
                });
                continue;
            }

            if (mode === 'ini') {
                if (!name.toLowerCase().endsWith('.ini')) {
                    continue;
                }
                children.push({
                    kind: 'iniFile',
                    uri: childUri,
                    label: name,
                    contextValue: 'iniFile',
                    parentUri: uri,
                });
                continue;
            }

            const isMixLike = await this.mixDetectorService.isMixLike(childUri);
            if (!isMixLike) {
                continue;
            }
            children.push({
                kind: 'mixFile',
                uri: childUri,
                sourceUri: childUri,
                label: name,
                contextValue: 'mixFile',
                parentUri: uri,
                mixContainer: true,
            });
        }

        return sortNodes(children);
    }

    private async getMixChildren(uri: vscode.Uri): Promise<ResourceNode[]> {
        const mixRoot = uri.scheme === MixUriCodec.scheme
            ? uri
            : MixUriCodec.toRootUri(uri);
        const entries = await vscode.workspace.fs.readDirectory(mixRoot);
        const children: ResourceNode[] = [];
        for (const [name, type] of entries) {
            const childUri = MixUriCodec.toChildUri(mixRoot, path.posix.join(mixRoot.path, name));
            if (type === vscode.FileType.Directory) {
                children.push({
                    kind: 'mixDirectory',
                    uri: childUri,
                    label: name,
                    contextValue: 'mixDirectory',
                    parentUri: mixRoot,
                });
                continue;
            }

            const mixLike = await this.mixDetectorService.isMixLike(childUri);
            children.push({
                kind: mixLike ? 'mixFile' : 'mixEntryFile',
                uri: mixLike ? MixUriCodec.toNestedRootUri(childUri) : childUri,
                sourceUri: childUri,
                label: name,
                contextValue: mixLike ? 'mixEntryMixFile' : 'mixEntryFile',
                parentUri: mixRoot,
                mixContainer: mixLike,
            });
        }

        return sortNodes(children);
    }

    private async directoryContainsIni(uri: vscode.Uri): Promise<boolean> {
        const key = uri.toString();
        const cached = this.iniDirectoryCache.get(key);
        if (cached !== undefined) {
            return cached;
        }

        const result = await this.directoryContains(uri, async (childUri, fileName) => fileName.toLowerCase().endsWith('.ini'), this.iniDirectoryCache);
        return result;
    }

    private async directoryContainsMix(uri: vscode.Uri): Promise<boolean> {
        return this.mixDetectorService.directoryContainsMix(uri);
    }

    private async directoryContains(
        uri: vscode.Uri,
        matcher: (childUri: vscode.Uri, fileName: string) => Promise<boolean>,
        cache: Map<string, boolean>
    ): Promise<boolean> {
        const key = uri.toString();
        const cached = cache.get(key);
        if (cached !== undefined) {
            return cached;
        }

        const entries = await vscode.workspace.fs.readDirectory(uri);
        for (const [name, type] of entries) {
            const childUri = vscode.Uri.joinPath(uri, name);
            if (type === vscode.FileType.Directory) {
                if (await this.directoryContains(childUri, matcher, cache)) {
                    cache.set(key, true);
                    return true;
                }
                continue;
            }

            if (await matcher(childUri, name)) {
                cache.set(key, true);
                return true;
            }
        }

        cache.set(key, false);
        return false;
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
