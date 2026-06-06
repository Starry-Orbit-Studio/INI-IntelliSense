import * as path from 'path';
import * as vscode from 'vscode';
import { ResourceNode } from '../resources/resource-node';
import { ImportExportService } from '../services/import-export-service';

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

        const targetUri = target.kind === 'mixDirectory' || target.kind === 'mixFile'
            ? target.uri
            : target.kind === 'mixEntryFile'
                ? vscode.Uri.joinPath(target.uri, '..')
                : undefined;

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
