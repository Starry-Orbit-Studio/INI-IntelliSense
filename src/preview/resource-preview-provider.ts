import * as path from 'path';
import * as vscode from 'vscode';
import { localize } from '../i18n';
import { PreviewContext, PreviewContextServices } from './preview-context';
import { createMapPreview } from './map-preview';
import { createPalPreview } from './pal-preview';
import { createPcxPreview } from './pcx-preview';
import { ResourcePreviewModel } from './preview-types';
import { createShpPreview } from './shp-preview';
import { createHvaPreview, createVxlPreview } from './vxl-hva-preview';

interface PreviewSessionState {
    paletteUri?: vscode.Uri;
}

interface PreviewStateStoreEntry {
    session: PreviewSessionState;
    panel: vscode.WebviewPanel;
    document: vscode.CustomDocument;
}

export class ResourcePreviewProvider implements vscode.CustomReadonlyEditorProvider {
    public static readonly viewType = 'ra2-resource-preview.viewer';

    private readonly previewContext: PreviewContext;
    private readonly stateByUri = new Map<string, PreviewStateStoreEntry>();

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
        const existing = this.stateByUri.get(key);
        const state: PreviewSessionState = existing?.session ?? {};
        this.stateByUri.set(key, {
            session: state,
            panel: webviewPanel,
            document,
        });

        const refresh = async () => {
            const preview = await this.createPreviewModel(document.uri, state.paletteUri);
            webviewPanel.title = preview.title;
            webviewPanel.webview.html = renderPreviewHtml(webviewPanel.webview, preview, document.uri, state.paletteUri);
        };

        await refresh();

        webviewPanel.webview.onDidReceiveMessage(async message => {
            if (message?.type === 'choosePalette') {
                const selected = await this.previewContext.choosePalette(document.uri);
                if (selected?.uri) {
                    state.paletteUri = selected.uri;
                    await refresh();
                }
                return;
            }

            if (message?.type === 'resetPalette') {
                state.paletteUri = undefined;
                await refresh();
            }
        });

        webviewPanel.onDidDispose(() => {
            this.stateByUri.delete(key);
        });
    }

    private async createPreviewModel(uri: vscode.Uri, paletteUri?: vscode.Uri): Promise<ResourcePreviewModel> {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const title = path.posix.basename(uri.path);
        const ext = path.extname(uri.path).toLowerCase();
        switch (ext) {
            case '.pcx':
                return createPcxPreview(bytes, title);
            case '.shp':
                return createShpPreview(uri, bytes, title, this.previewContext, paletteUri);
            case '.pal':
                return createPalPreview(bytes, title);
            case '.map':
            case '.mpr':
            case '.yrm':
                return createMapPreview(bytes, title);
            case '.vxl':
                return createVxlPreview(uri, bytes, title, this.previewContext);
            case '.hva':
                return createHvaPreview(uri, bytes, title, this.previewContext);
            default:
                return {
                    kind: 'text',
                    title,
                    content: localize('preview.unsupported.content', 'Preview for this file type is not available yet.'),
                };
        }
    }
}

function renderPreviewHtml(webview: vscode.Webview, model: ResourcePreviewModel, uri: vscode.Uri, paletteUri?: vscode.Uri): string {
    const baseStyle = `
        <style>
            :root {
                color-scheme: light dark;
            }
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
                background: color-mix(in srgb, var(--vscode-editor-background) 90%, var(--vscode-editorWidget-background) 10%);
                position: sticky;
                top: 0;
                z-index: 10;
            }
            .toolbar-title {
                font-size: 12px;
                color: var(--vscode-descriptionForeground);
                margin-right: auto;
            }
            .toolbar-actions {
                display: flex;
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
            .secondary {
                background: var(--vscode-button-secondaryBackground);
                color: var(--vscode-button-secondaryForeground);
            }
            .secondary:hover {
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
                justify-content: center;
                gap: 12px;
            }
            .canvas-frame {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                border: 1px solid var(--vscode-panel-border);
                background: var(--vscode-editor-background);
                box-shadow: 0 8px 30px rgba(0, 0, 0, 0.18);
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
            .info-card h2 {
                margin: 0 0 12px;
                font-size: 16px;
            }
            .info-card pre {
                margin: 0;
                white-space: pre-wrap;
                word-break: break-word;
                color: var(--vscode-editor-foreground);
                background: transparent;
            }
            .html-body {
                width: min(960px, calc(100vw - 72px));
            }
            .html-body table {
                border-collapse: collapse;
            }
            .html-body td, .html-body th {
                padding: 6px 10px;
                border: 1px solid var(--vscode-panel-border);
            }
        </style>
    `;

    const toolbar = renderToolbar(webview, model, uri, paletteUri);
    const details = renderDetails(model);

    if (model.kind === 'rgba-image') {
        const pixels = JSON.stringify(Array.from(model.pixels));
        return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
${baseStyle}
</head>
<body>
${toolbar}
<div class="viewport">
    <div class="surface">
        ${details}
        <div class="canvas-frame alpha-board">
            <canvas id="preview" class="${model.pixelated === false ? '' : 'pixelated'}" width="${model.width}" height="${model.height}"></canvas>
        </div>
    </div>
</div>
<script>
const vscode = acquireVsCodeApi();
const pixels = new Uint8ClampedArray(${pixels});
const canvas = document.getElementById('preview');
const ctx = canvas.getContext('2d');
const imageData = new ImageData(pixels, ${model.width}, ${model.height});
ctx.putImageData(imageData, 0, 0);
bindPreviewToolbar(vscode);
</script>
</body>
</html>`;
    }

    if (model.kind === 'palette') {
        return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
${baseStyle}
</head>
<body>
${toolbar}
<div class="viewport">
    <div class="surface">
        ${details}
        <div class="canvas-frame">
            <div class="palette">
            ${model.colors.map(color => `<div class="swatch" style="background:${color}" title="${color}"></div>`).join('')}
            </div>
        </div>
    </div>
</div>
<script>bindPreviewToolbar(acquireVsCodeApi());</script>
</body>
</html>`;
    }

    if (model.kind === 'html') {
        return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
${baseStyle}
</head>
<body>
${toolbar}
<div class="viewport">
    <div class="surface html-body">
        ${details}
        ${model.bodyHtml}
    </div>
</div>
<script>bindPreviewToolbar(acquireVsCodeApi());</script>
</body>
</html>`;
    }

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
${baseStyle}
</head>
<body>
${toolbar}
<div class="viewport">
    <div class="surface">
        ${details}
        <div class="info-card">
            <pre>${escapeHtml(model.content)}</pre>
        </div>
    </div>
</div>
<script>bindPreviewToolbar(acquireVsCodeApi());</script>
</body>
</html>`;
}

function renderToolbar(webview: vscode.Webview, model: ResourcePreviewModel, uri: vscode.Uri, paletteUri?: vscode.Uri): string {
    const ext = path.extname(uri.path).toLowerCase();
    const actions: string[] = [];

    if (ext === '.shp' || ext === '.vxl' || ext === '.hva') {
        actions.push(`<button type="button" data-action="choosePalette">${escapeHtml(localize('preview.palette.choose', 'Choose Palette'))}</button>`);
        actions.push(`<button type="button" class="secondary" data-action="resetPalette">${escapeHtml(localize('preview.palette.reset', 'Auto Palette'))}</button>`);
    }

    if (paletteUri) {
        actions.push(`<span class="badge">${escapeHtml(path.posix.basename(paletteUri.path))}</span>`);
    }

    return `<div class="toolbar">
    <div class="toolbar-title">${escapeHtml(model.title)}</div>
    <div class="toolbar-actions">${actions.join('')}</div>
</div>
<script>
function bindPreviewToolbar(vscode) {
    for (const button of document.querySelectorAll('[data-action]')) {
        button.addEventListener('click', () => {
            vscode.postMessage({ type: button.dataset.action });
        });
    }
}
</script>`;
}

function renderDetails(model: ResourcePreviewModel): string {
    const detailItems = model.details ?? [];
    const description = 'description' in model ? model.description : undefined;
    if (description) {
        detailItems.unshift(description);
    }

    if (detailItems.length === 0) {
        return '';
    }

    return `<div class="details">${detailItems.map(item => `<span>${escapeHtml(item)}</span>`).join('')}</div>`;
}

function escapeHtml(value: string): string {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
}
