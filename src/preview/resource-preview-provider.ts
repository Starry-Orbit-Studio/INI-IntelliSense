import * as path from 'path';
import * as vscode from 'vscode';
import { localize } from '../i18n';
import { PreviewContext, PreviewContextServices } from './preview-context';
import { createMapPreview } from './map-preview';
import { createPalPreview } from './pal-preview';
import { createPcxPreview } from './pcx-preview';
import { ResourcePreviewModel } from './preview-types';
import { createShpPreview, ShpPreviewModel } from './shp-preview';
import { createHvaPreview, createVxlPreview, VoxelPreviewModel, VoxelPreviewState } from './vxl-hva-preview';

interface PreviewSessionState {
    paletteUri?: vscode.Uri;
    shpFrameIndex: number;
    voxel: VoxelPreviewState;
}

export class ResourcePreviewProvider implements vscode.CustomReadonlyEditorProvider {
    public static readonly viewType = 'ra2-resource-preview.viewer';

    private readonly previewContext: PreviewContext;
    private readonly stateByUri = new Map<string, PreviewSessionState>();

    constructor(private readonly services: PreviewContextServices) {
        this.previewContext = new PreviewContext(services);
    }

    public async openCustomDocument(uri: vscode.Uri): Promise<vscode.CustomDocument> {
        return {
            uri,
            dispose: () => undefined,
        };
    }

    public async resolveCustomEditor(
        document: vscode.CustomDocument,
        webviewPanel: vscode.WebviewPanel
    ): Promise<void> {
        webviewPanel.webview.options = {
            enableScripts: true,
        };

        const key = document.uri.toString();
        const state = this.stateByUri.get(key) ?? {
            shpFrameIndex: 0,
            voxel: {
                limbIndex: 0,
                sliceIndex: 0,
                viewType: 'top',
                renderMode: 'slice',
            },
        };
        this.stateByUri.set(key, state);

        const refresh = async () => {
            const preview = await this.createPreviewModel(document.uri, state);
            webviewPanel.title = preview.title;
            webviewPanel.webview.html = renderPreviewHtml(preview, document.uri, state.paletteUri);
        };

        await refresh();

        webviewPanel.webview.onDidReceiveMessage(async message => {
            if (!message?.type) {
                return;
            }

            switch (message.type) {
                case 'choosePalette': {
                    const selected = await this.previewContext.choosePalette(document.uri);
                    if (selected?.uri) {
                        state.paletteUri = selected.uri;
                        await refresh();
                    }
                    return;
                }
                case 'resetPalette':
                    state.paletteUri = undefined;
                    await refresh();
                    return;
                case 'shpPrevFrame':
                    state.shpFrameIndex = Math.max(0, state.shpFrameIndex - 1);
                    await refresh();
                    return;
                case 'shpNextFrame':
                    state.shpFrameIndex += 1;
                    await refresh();
                    return;
                case 'voxelPrevSlice':
                    state.voxel.sliceIndex = Math.max(0, state.voxel.sliceIndex - 1);
                    await refresh();
                    return;
                case 'voxelNextSlice':
                    state.voxel.sliceIndex += 1;
                    await refresh();
                    return;
                case 'voxelSetView':
                    if (message.viewType === 'front' || message.viewType === 'side' || message.viewType === 'top') {
                        state.voxel.viewType = message.viewType;
                        await refresh();
                    }
                    return;
                case 'voxelSetMode':
                    if (message.mode === 'slice' || message.mode === 'game' || message.mode === 'perspective') {
                        state.voxel.renderMode = message.mode;
                        await refresh();
                    }
                    return;
                default:
                    return;
            }
        });

        webviewPanel.onDidDispose(() => {
            this.stateByUri.delete(key);
        });
    }

    private async createPreviewModel(uri: vscode.Uri, state: PreviewSessionState): Promise<ResourcePreviewModel> {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const title = path.posix.basename(uri.path);
        const ext = path.extname(uri.path).toLowerCase();
        switch (ext) {
            case '.pcx':
                return createPcxPreview(bytes, title);
            case '.shp':
                return createShpPreview(uri, bytes, title, this.previewContext, { frameIndex: state.shpFrameIndex }, state.paletteUri);
            case '.pal':
                return createPalPreview(bytes, title);
            case '.map':
            case '.mpr':
            case '.yrm':
                return createMapPreview(bytes, title);
            case '.vxl':
                return createVxlPreview(uri, bytes, title, this.previewContext, state.voxel, state.paletteUri);
            case '.hva':
                return createHvaPreview(uri, bytes, title, this.previewContext, state.voxel, state.paletteUri);
            default:
                return {
                    kind: 'text',
                    title,
                    content: localize('preview.unsupported.content', 'Preview for this file type is not available yet.'),
                };
        }
    }
}

function renderPreviewHtml(model: ResourcePreviewModel, uri: vscode.Uri, paletteUri?: vscode.Uri): string {
    const style = `
        <style>
            :root { color-scheme: light dark; }
            html, body {
                margin: 0;
                height: 100%;
                background: var(--vscode-editor-background);
                color: var(--vscode-editor-foreground);
                font-family: var(--vscode-font-family);
            }
            body {
                display: flex;
                flex-direction: column;
            }
            .toolbar {
                display: flex;
                align-items: center;
                gap: 10px;
                padding: 10px 14px;
                border-bottom: 1px solid var(--vscode-panel-border);
                background: var(--vscode-editor-background);
                position: sticky;
                top: 0;
                z-index: 10;
                flex-wrap: wrap;
            }
            .toolbar-title {
                font-size: 12px;
                color: var(--vscode-descriptionForeground);
                margin-right: auto;
            }
            .toolbar-group {
                display: inline-flex;
                gap: 8px;
                align-items: center;
                flex-wrap: wrap;
            }
            button {
                border: 1px solid var(--vscode-button-border, transparent);
                background: var(--vscode-button-background);
                color: var(--vscode-button-foreground);
                padding: 4px 10px;
                border-radius: 6px;
                cursor: pointer;
                font: inherit;
            }
            button:hover {
                background: var(--vscode-button-hoverBackground);
            }
            button.secondary {
                background: var(--vscode-button-secondaryBackground);
                color: var(--vscode-button-secondaryForeground);
            }
            button.secondary:hover {
                background: var(--vscode-button-secondaryHoverBackground);
            }
            .badge {
                padding: 2px 8px;
                border-radius: 999px;
                background: var(--vscode-badge-background);
                color: var(--vscode-badge-foreground);
                font-size: 11px;
            }
            .details {
                color: var(--vscode-descriptionForeground);
                font-size: 12px;
                display: flex;
                gap: 8px;
                flex-wrap: wrap;
            }
            .details span::after {
                content: '·';
                margin-left: 8px;
                color: var(--vscode-panel-border);
            }
            .details span:last-child::after {
                content: '';
                margin-left: 0;
            }
            .viewport {
                flex: 1;
                display: flex;
                align-items: center;
                justify-content: center;
                overflow: auto;
                padding: 24px;
                box-sizing: border-box;
            }
            .surface {
                display: inline-flex;
                flex-direction: column;
                align-items: center;
                gap: 12px;
            }
            .canvas-frame {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                border: 1px solid var(--vscode-panel-border);
                background: var(--vscode-editor-background);
                max-width: calc(100vw - 72px);
                max-height: calc(100vh - 180px);
                padding: 12px;
                border-radius: 8px;
            }
            .alpha-board {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                background:
                    linear-gradient(45deg, rgba(127,127,127,0.18) 25%, transparent 25%) -8px 0/16px 16px,
                    linear-gradient(-45deg, rgba(127,127,127,0.18) 25%, transparent 25%) -8px 0/16px 16px,
                    linear-gradient(45deg, transparent 75%, rgba(127,127,127,0.18) 75%) -8px 0/16px 16px,
                    linear-gradient(-45deg, transparent 75%, rgba(127,127,127,0.18) 75%) -8px 0/16px 16px,
                    var(--vscode-editor-background);
            }
            canvas {
                max-width: min(100%, 1600px);
                max-height: min(100%, 1200px);
                height: auto;
            }
            canvas.pixelated {
                image-rendering: pixelated;
                image-rendering: crisp-edges;
            }
            .palette {
                display: grid;
                grid-template-columns: repeat(16, minmax(24px, 1fr));
                gap: 4px;
                width: min(720px, calc(100vw - 72px));
            }
            .swatch {
                aspect-ratio: 1;
                border: 1px solid rgba(255,255,255,0.08);
                border-radius: 4px;
            }
            .info-card {
                width: min(820px, calc(100vw - 72px));
                padding: 16px 18px;
                border: 1px solid var(--vscode-panel-border);
                background: var(--vscode-editorWidget-background);
                border-radius: 10px;
                box-sizing: border-box;
            }
            .html-body {
                width: min(960px, calc(100vw - 72px));
            }
        </style>
    `;

    const toolbar = renderToolbar(model, uri, paletteUri);
    const details = renderDetails(model);

    if (model.kind === 'rgba-image') {
        const pixels = JSON.stringify(Array.from(model.pixels));
        return `<!DOCTYPE html><html><head><meta charset="utf-8" />${style}</head><body>${toolbar}<div class="viewport"><div class="surface">${details}<div class="canvas-frame alpha-board"><canvas id="preview" class="${model.pixelated === false ? '' : 'pixelated'}" width="${model.width}" height="${model.height}"></canvas></div></div></div><script>${toolbarScript()}const pixels = new Uint8ClampedArray(${pixels});const canvas = document.getElementById('preview');const ctx = canvas.getContext('2d');ctx.putImageData(new ImageData(pixels, ${model.width}, ${model.height}), 0, 0);</script></body></html>`;
    }

    if (model.kind === 'palette') {
        return `<!DOCTYPE html><html><head><meta charset="utf-8" />${style}</head><body>${toolbar}<div class="viewport"><div class="surface">${details}<div class="canvas-frame"><div class="palette">${model.colors.map(color => `<div class="swatch" style="background:${color}" title="${color}"></div>`).join('')}</div></div></div></div><script>${toolbarScript()}</script></body></html>`;
    }

    if (model.kind === 'html') {
        return `<!DOCTYPE html><html><head><meta charset="utf-8" />${style}</head><body>${toolbar}<div class="viewport"><div class="surface html-body">${details}${model.bodyHtml}</div></div><script>${toolbarScript()}</script></body></html>`;
    }

    return `<!DOCTYPE html><html><head><meta charset="utf-8" />${style}</head><body>${toolbar}<div class="viewport"><div class="surface">${details}<div class="info-card"><pre>${escapeHtml(model.content)}</pre></div></div></div><script>${toolbarScript()}</script></body></html>`;
}

function renderToolbar(model: ResourcePreviewModel, uri: vscode.Uri, paletteUri?: vscode.Uri): string {
    const ext = path.extname(uri.path).toLowerCase();
    const groups: string[] = [];

    if (ext === '.shp' || ext === '.vxl' || ext === '.hva') {
        groups.push(`<div class="toolbar-group"><button type="button" data-action="choosePalette">${escapeHtml(localize('preview.palette.choose', 'Choose Palette'))}</button><button type="button" class="secondary" data-action="resetPalette">${escapeHtml(localize('preview.palette.reset', 'Auto Palette'))}</button>${paletteUri ? `<span class="badge">${escapeHtml(path.posix.basename(paletteUri.path))}</span>` : ''}</div>`);
    }

    if (isShpPreview(model)) {
        groups.push(`<div class="toolbar-group"><button type="button" data-action="shpPrevFrame">${escapeHtml(localize('preview.shp.prevFrame', 'Prev Frame'))}</button><span class="badge">${model.frameIndex + 1}/${model.totalFrames}</span><button type="button" data-action="shpNextFrame">${escapeHtml(localize('preview.shp.nextFrame', 'Next Frame'))}</button></div>`);
    }

    if (isVoxelPreview(model)) {
        groups.push(`<div class="toolbar-group"><button type="button" class="${model.renderMode === 'slice' ? '' : 'secondary'}" data-action="voxelSetMode" data-mode="slice">${escapeHtml(localize('preview.voxel.mode.slice', 'Slice'))}</button><button type="button" class="${model.renderMode === 'game' ? '' : 'secondary'}" data-action="voxelSetMode" data-mode="game">${escapeHtml(localize('preview.voxel.mode.game', 'Game View'))}</button><button type="button" class="${model.renderMode === 'perspective' ? '' : 'secondary'}" data-action="voxelSetMode" data-mode="perspective">${escapeHtml(localize('preview.voxel.mode.perspective', 'Perspective'))}</button></div>`);
        if (model.renderMode === 'slice') {
            groups.push(`<div class="toolbar-group"><button type="button" data-action="voxelPrevSlice">${escapeHtml(localize('preview.voxel.prevSlice', 'Prev Slice'))}</button><span class="badge">${model.sliceIndex + 1}/${model.sliceCount}</span><button type="button" data-action="voxelNextSlice">${escapeHtml(localize('preview.voxel.nextSlice', 'Next Slice'))}</button></div>`);
            groups.push(`<div class="toolbar-group"><button type="button" class="${model.viewType === 'front' ? '' : 'secondary'}" data-action="voxelSetView" data-view="front">${escapeHtml(localize('preview.voxel.view.front', 'Front'))}</button><button type="button" class="${model.viewType === 'side' ? '' : 'secondary'}" data-action="voxelSetView" data-view="side">${escapeHtml(localize('preview.voxel.view.side', 'Side'))}</button><button type="button" class="${model.viewType === 'top' ? '' : 'secondary'}" data-action="voxelSetView" data-view="top">${escapeHtml(localize('preview.voxel.view.top', 'Top'))}</button></div>`);
        }
    }

    return `<div class="toolbar"><div class="toolbar-title">${escapeHtml(model.title)}</div>${groups.join('')}</div>`;
}

function renderDetails(model: ResourcePreviewModel): string {
    const detailItems = [...(model.details ?? [])];
    const description = 'description' in model ? model.description : undefined;
    if (description) {
        detailItems.unshift(description);
    }
    if (detailItems.length === 0) {
        return '';
    }
    return `<div class="details">${detailItems.map(item => `<span>${escapeHtml(item)}</span>`).join('')}</div>`;
}

function toolbarScript(): string {
    return `
const vscode = acquireVsCodeApi();
for (const button of document.querySelectorAll('[data-action]')) {
    button.addEventListener('click', () => {
        const payload = { type: button.dataset.action };
        if (button.dataset.view) {
            payload.viewType = button.dataset.view;
        }
        if (button.dataset.mode) {
            payload.mode = button.dataset.mode;
        }
        vscode.postMessage(payload);
    });
}
`;
}

function isShpPreview(model: ResourcePreviewModel): model is ShpPreviewModel {
    return model.kind === 'rgba-image' && 'totalFrames' in model && 'frameIndex' in model;
}

function isVoxelPreview(model: ResourcePreviewModel): model is VoxelPreviewModel {
    return model.kind === 'rgba-image' && 'sliceCount' in model && 'viewType' in model;
}

function escapeHtml(value: string): string {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
}
