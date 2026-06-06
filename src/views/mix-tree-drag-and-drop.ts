import * as path from 'path';
import * as vscode from 'vscode';
import { ResourceNode } from '../resources/resource-node';
import { ImportExportService } from '../services/import-export-service';
import { MixUriCodec } from '../mix/fs/mix-uri-codec';

export class MixTreeDragAndDropController implements vscode.TreeDragAndDropController<ResourceNode> {
    public readonly dropMimeTypes = ['files', 'text/uri-list', 'application/vnd.code.tree.mix-files'];
    public readonly dragMimeTypes = ['text/uri-list'];

    constructor(private readonly importExportService: ImportExportService) {}

    public async handleDrag(source: readonly ResourceNode[], dataTransfer: vscode.DataTransfer): Promise<void> {
        const files = source
            .filter(node => node.kind === 'mixEntryFile')
            .map(node => node.uri.toString())
            .join('\r\n');
        if (files) {
            dataTransfer.set('text/uri-list', new vscode.DataTransferItem(files));
        }
    }

    public async handleDrop(target: ResourceNode | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
        if (!target) {
            return;
        }

        const targetUri = resolveDropTargetUri(target);

        if (!targetUri || targetUri.scheme !== 'ra2mix') {
            return;
        }

        const item = dataTransfer.get('text/uri-list');
        if (!item) {
            return;
        }

        const text = await item.asString();
        const sourceUris = text
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(Boolean)
            .map(line => vscode.Uri.parse(line));

        if (sourceUris.length > 0) {
            await this.importExportService.importIntoMix(targetUri, sourceUris);
        }
    }
}

function resolveDropTargetUri(target: ResourceNode): vscode.Uri | undefined {
    if (target.kind === 'mixDirectory' || target.kind === 'mixFile') {
        return target.uri;
    }

    if (target.kind === 'mixEntryFile') {
        const decoded = MixUriCodec.decode(target.uri);
        const parentPath = decoded.virtualPath.substring(0, decoded.virtualPath.lastIndexOf('/')) || '/';
        return MixUriCodec.toChildUri(target.uri, parentPath);
    }

    return undefined;
}
