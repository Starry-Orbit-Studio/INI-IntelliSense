import * as path from 'path';
import * as vscode from 'vscode';
import { MixUriCodec } from '../mix/fs/mix-uri-codec';
import { ResourceNode } from './resource-node';
import { ResourcePath } from './resource-path';

export class ResourceService {
    public async getWorkspaceRootNodes(): Promise<ResourceNode[]> {
        const folders = vscode.workspace.workspaceFolders ?? [];
        return folders.map(folder => ({
            kind: 'workspaceRoot',
            uri: folder.uri,
            label: folder.name,
            description: ResourcePath.relativeToWorkspace(folder.uri),
            contextValue: 'workspaceRoot',
        }));
    }

    public async getChildren(node?: ResourceNode): Promise<ResourceNode[]> {
        if (!node) {
            return this.getWorkspaceRootNodes();
        }

        if (node.kind === 'workspaceRoot' || node.kind === 'directory') {
            return this.getFileChildren(node.uri);
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
                });
                continue;
            }

            const lower = name.toLowerCase();
            if (lower.endsWith('.mix')) {
                children.push({
                    kind: 'mixFile',
                    uri: childUri,
                    label: name,
                    contextValue: 'mixFile',
                });
            } else if (lower.endsWith('.ini')) {
                children.push({
                    kind: 'iniFile',
                    uri: childUri,
                    label: name,
                    contextValue: 'iniFile',
                });
            } else {
                children.push({
                    kind: 'unknownFile',
                    uri: childUri,
                    label: name,
                    contextValue: 'unknownFile',
                });
            }
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
                });
                continue;
            }

            const lower = name.toLowerCase();
            children.push({
                kind: lower.endsWith('.mix') ? 'mixFile' : 'mixEntryFile',
                uri: childUri,
                label: name,
                contextValue: lower.endsWith('.mix') ? 'mixEntryMixFile' : 'mixEntryFile',
            });
        }

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
