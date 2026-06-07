import * as path from 'path';
import * as vscode from 'vscode';
import { createMapPreview } from './map-preview';
import { createPalPreview } from './pal-preview';
import { createPcxPreview } from './pcx-preview';
import { createShpPreview } from './shp-preview';
import { ResourcePreviewModel } from './preview-types';
import { createHvaPreview, createVxlPreview } from './vxl-hva-preview';

export class ResourcePreviewProvider implements vscode.CustomReadonlyEditorProvider {
    public static readonly viewType = 'ra2-resource-preview.viewer';

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

        const bytes = await vscode.workspace.fs.readFile(document.uri);
        const title = path.posix.basename(document.uri.path);
        const preview = await createPreviewModel(document.uri, bytes, title);
        webviewPanel.title = preview.title;
        webviewPanel.webview.html = renderPreviewHtml(preview);
    }
}

async function createPreviewModel(uri: vscode.Uri, bytes: Uint8Array, title: string): Promise<ResourcePreviewModel> {
    const ext = path.extname(uri.path).toLowerCase();
    switch (ext) {
        case '.pcx':
            return createPcxPreview(bytes, title);
        case '.shp':
            return createShpPreview(uri, bytes, title);
        case '.pal':
            return createPalPreview(bytes, title);
        case '.map':
        case '.mpr':
        case '.yrm':
            return createMapPreview(bytes, title);
        case '.vxl':
            return createVxlPreview(bytes, title);
        case '.hva':
            return createHvaPreview(bytes, title);
        default:
            return {
                kind: 'text',
                title,
                content: `Preview for ${ext || 'this file type'} is not available yet.`,
            };
    }
}

function renderPreviewHtml(model: ResourcePreviewModel): string {
    const baseStyle = `
        <style>
            body {
                margin: 0;
                padding: 16px;
                background: #11161b;
                color: #e6eef5;
                font-family: Consolas, "Courier New", monospace;
            }
            .frame {
                max-width: 100%;
            }
            .muted {
                color: #9eb0bf;
                margin-bottom: 12px;
            }
            canvas {
                image-rendering: pixelated;
                image-rendering: crisp-edges;
                background:
                    linear-gradient(45deg, #1b232b 25%, transparent 25%) -8px 0/16px 16px,
                    linear-gradient(-45deg, #1b232b 25%, transparent 25%) -8px 0/16px 16px,
                    linear-gradient(45deg, transparent 75%, #1b232b 75%) -8px 0/16px 16px,
                    linear-gradient(-45deg, transparent 75%, #1b232b 75%) -8px 0/16px 16px,
                    #10151b;
                border: 1px solid #33404d;
                max-width: 100%;
                height: auto;
            }
            .palette {
                display: grid;
                grid-template-columns: repeat(16, minmax(20px, 1fr));
                gap: 4px;
                max-width: 720px;
            }
            .swatch {
                aspect-ratio: 1;
                border: 1px solid rgba(255,255,255,0.12);
            }
            pre {
                white-space: pre-wrap;
                word-break: break-word;
                background: #151c23;
                border: 1px solid #33404d;
                padding: 12px;
            }
        </style>
    `;

    if (model.kind === 'rgba-image') {
        const pixels = JSON.stringify(Array.from(model.pixels));
        return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
${baseStyle}
</head>
<body>
<div class="muted">${escapeHtml(model.description ?? `${model.width} x ${model.height}`)}</div>
<canvas id="preview" width="${model.width}" height="${model.height}"></canvas>
<script>
const pixels = new Uint8ClampedArray(${pixels});
const canvas = document.getElementById('preview');
const ctx = canvas.getContext('2d');
const imageData = new ImageData(pixels, ${model.width}, ${model.height});
ctx.putImageData(imageData, 0, 0);
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
<div class="muted">${escapeHtml(model.description ?? '')}</div>
<div class="palette">
${model.colors.map(color => `<div class="swatch" style="background:${color}" title="${color}"></div>`).join('')}
</div>
</body>
</html>`;
    }

    if (model.kind === 'html') {
        return `<!DOCTYPE html>
<html><head><meta charset="utf-8" />${baseStyle}</head><body>${model.bodyHtml}</body></html>`;
    }

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
${baseStyle}
</head>
<body>
<pre>${escapeHtml(model.content)}</pre>
</body>
</html>`;
}

function escapeHtml(value: string): string {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
}
