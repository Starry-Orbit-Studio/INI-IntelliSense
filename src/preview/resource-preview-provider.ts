import * as path from 'path';
import * as vscode from 'vscode';
import { localize } from '../i18n';
import { PreviewContext, PreviewContextServices } from './preview-context';
import { createMapPreview } from './map-preview';
import { createPalPreview } from './pal-preview';
import { createPcxPreview } from './pcx-preview';
import { ResourcePreviewModel } from './preview-types';
import { createShpPreview, ShpPreviewModel } from './shp-preview';
import {
    createDefaultVoxelPreviewState,
    createHvaPreview,
    createVxlPreview,
    resetVoxelCamera,
    VoxelPreviewModel,
    VoxelPreviewState
} from './vxl-hva-preview';

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
            voxel: createDefaultVoxelPreviewState(),
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
                        resetVoxelCamera(state.voxel, message.mode);
                        await refresh();
                    }
                    return;
                case 'voxelPrevLimb':
                    state.voxel.limbIndex = Math.max(0, state.voxel.limbIndex - 1);
                    await refresh();
                    return;
                case 'voxelNextLimb':
                    state.voxel.limbIndex += 1;
                    await refresh();
                    return;
                case 'voxelResetCamera':
                    resetVoxelCamera(state.voxel);
                    await refresh();
                    return;
                case 'voxelOrbit':
                    if (typeof message.deltaX === 'number' && typeof message.deltaY === 'number') {
                        state.voxel.cameraYaw += message.deltaX * 0.35;
                        state.voxel.cameraPitch = clamp(state.voxel.cameraPitch + message.deltaY * 0.28, -89, 89);
                    }
                    return;
                case 'voxelPan':
                    if (typeof message.deltaX === 'number' && typeof message.deltaY === 'number') {
                        state.voxel.cameraPanX += message.deltaX;
                        state.voxel.cameraPanY += message.deltaY;
                    }
                    return;
                case 'voxelZoom':
                    if (typeof message.delta === 'number') {
                        const factor = message.delta > 0 ? 0.92 : 1.08;
                        state.voxel.cameraZoom = clamp(state.voxel.cameraZoom * factor, 0.2, 6);
                    }
                    return;
                case 'voxelSyncState':
                    if (message.state) {
                        state.voxel = {
                            ...state.voxel,
                            ...sanitizeVoxelState(message.state),
                        };
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
            canvas.interactive {
                cursor: grab;
                width: min(100%, 960px);
                height: auto;
            }
            canvas.interactive.dragging {
                cursor: grabbing;
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
            .hint {
                color: var(--vscode-descriptionForeground);
                font-size: 12px;
                text-align: center;
            }
        </style>
    `;

    const toolbar = renderToolbar(model, uri, paletteUri);
    const details = renderDetails(model);

    if (model.kind === 'rgba-image') {
        const pixels = JSON.stringify(Array.from(model.pixels));
        const canvasClass = model.pixelated === false ? '' : 'pixelated';
        return `<!DOCTYPE html><html><head><meta charset="utf-8" />${style}</head><body>${toolbar}<div class="viewport"><div class="surface">${details}<div class="canvas-frame alpha-board"><canvas id="preview" class="${canvasClass}" width="${model.width}" height="${model.height}"></canvas></div></div></div><script>${toolbarScript()}const pixels = new Uint8ClampedArray(${pixels});const canvas = document.getElementById('preview');const ctx = canvas.getContext('2d');ctx.putImageData(new ImageData(pixels, ${model.width}, ${model.height}), 0, 0);</script></body></html>`;
    }

    if (model.kind === 'voxel-scene') {
        const scene = JSON.stringify(model.scene);
        const state = JSON.stringify(model.state);
        const interactionHint = `<div class="hint">${escapeHtml(localize('preview.voxel.interaction.hint', 'Drag to orbit, Shift+Drag to pan, and use the mouse wheel to zoom.'))}</div>`;
        return `<!DOCTYPE html><html><head><meta charset="utf-8" />${style}</head><body>${toolbar}<div class="viewport"><div class="surface">${details}${interactionHint}<div class="canvas-frame alpha-board"><canvas id="voxel-preview" class="interactive" width="960" height="960"></canvas></div></div></div><script>${toolbarScript()}const voxelScene = ${scene};const voxelState = ${state};${voxelSceneScript()}</script></body></html>`;
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
        const limbCount = model.scene.limbs.length;
        const activeLimb = model.scene.limbs[clamp(model.state.limbIndex, 0, Math.max(0, limbCount - 1))];
        const sliceCount = activeLimb ? getVoxelSliceCount(activeLimb, model.state.viewType) : 1;
        groups.push(`<div class="toolbar-group"><button type="button" class="${model.state.renderMode === 'slice' ? '' : 'secondary'}" data-action="voxelSetMode" data-mode="slice">${escapeHtml(localize('preview.voxel.mode.slice', 'Slice'))}</button><button type="button" class="${model.state.renderMode === 'game' ? '' : 'secondary'}" data-action="voxelSetMode" data-mode="game">${escapeHtml(localize('preview.voxel.mode.game', 'Game View'))}</button><button type="button" class="${model.state.renderMode === 'perspective' ? '' : 'secondary'}" data-action="voxelSetMode" data-mode="perspective">${escapeHtml(localize('preview.voxel.mode.perspective', 'Perspective'))}</button></div>`);
        groups.push(`<div class="toolbar-group"><button type="button" data-action="voxelPrevLimb">${escapeHtml(localize('preview.voxel.prevLimb', 'Prev Limb'))}</button><span class="badge">${model.state.limbIndex + 1}/${limbCount}</span><button type="button" data-action="voxelNextLimb">${escapeHtml(localize('preview.voxel.nextLimb', 'Next Limb'))}</button></div>`);
        if (model.state.renderMode === 'slice') {
            groups.push(`<div class="toolbar-group"><button type="button" data-action="voxelPrevSlice">${escapeHtml(localize('preview.voxel.prevSlice', 'Prev Slice'))}</button><span class="badge">${model.state.sliceIndex + 1}/${sliceCount}</span><button type="button" data-action="voxelNextSlice">${escapeHtml(localize('preview.voxel.nextSlice', 'Next Slice'))}</button></div>`);
            groups.push(`<div class="toolbar-group"><button type="button" class="${model.state.viewType === 'front' ? '' : 'secondary'}" data-action="voxelSetView" data-view="front">${escapeHtml(localize('preview.voxel.view.front', 'Front'))}</button><button type="button" class="${model.state.viewType === 'side' ? '' : 'secondary'}" data-action="voxelSetView" data-view="side">${escapeHtml(localize('preview.voxel.view.side', 'Side'))}</button><button type="button" class="${model.state.viewType === 'top' ? '' : 'secondary'}" data-action="voxelSetView" data-view="top">${escapeHtml(localize('preview.voxel.view.top', 'Top'))}</button></div>`);
        } else {
            groups.push(`<div class="toolbar-group"><button type="button" class="secondary" data-action="voxelResetCamera">${escapeHtml(localize('preview.voxel.resetCamera', 'Reset Camera'))}</button></div>`);
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
const vscode = window.__ra2PreviewVsCode ?? acquireVsCodeApi();
window.__ra2PreviewVsCode = vscode;
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

function voxelSceneScript(): string {
    return `
const canvas = document.getElementById('voxel-preview');
const previewApi = window.__ra2PreviewVsCode ?? acquireVsCodeApi();
window.__ra2PreviewVsCode = previewApi;
const ctx = canvas.getContext('2d', { alpha: true });
const state = voxelState;
const scene = voxelScene;
let rafId = 0;
let dragging = false;
let panMode = false;
let lastX = 0;
let lastY = 0;
let syncHandle = 0;

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function rotateX(vector, angle) {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return {
        x: vector.x,
        y: vector.y * c - vector.z * s,
        z: vector.y * s + vector.z * c,
    };
}

function rotateY(vector, angle) {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return {
        x: vector.x * c + vector.z * s,
        y: vector.y,
        z: -vector.x * s + vector.z * c,
    };
}

function normalize(vector) {
    const length = Math.hypot(vector.x, vector.y, vector.z) || 1;
    return {
        x: vector.x / length,
        y: vector.y / length,
        z: vector.z / length,
    };
}

function dot(a, b) {
    return a.x * b.x + a.y * b.y + a.z * b.z;
}

function readGameNormal(normalIndex) {
    const offset = Math.max(0, Math.min(255, normalIndex)) * 3;
    return normalize({
        x: scene.gameNormals[offset] ?? 0,
        y: scene.gameNormals[offset + 2] ?? 1,
        z: scene.gameNormals[offset + 1] ?? 0,
    });
}

function readVplColor(lightLevelIndex, colorIndex) {
    const lookupIndex = lightLevelIndex * 256 + colorIndex;
    const finalColorIndex = scene.vplLookup[lookupIndex] ?? colorIndex;
    const offset = finalColorIndex * 3;
    return {
        r: scene.vplPalette[offset] ?? 0,
        g: scene.vplPalette[offset + 1] ?? 0,
        b: scene.vplPalette[offset + 2] ?? 0,
    };
}

function buildActiveVoxelList(limb) {
    const active = [];
    let index = 0;
    for (let z = 0; z < limb.sizeZ; z++) {
        for (let y = 0; y < limb.sizeY; y++) {
            for (let x = 0; x < limb.sizeX; x++) {
                const color = limb.voxels[index++];
                const normal = limb.voxels[index++];
                if (color === 0) {
                    continue;
                }
                active.push({ x, y, z, color, normal });
            }
        }
    }
    return active;
}

function drawPixel(buffer, width, x, y, depth, color, depthBuffer) {
    if (x < 0 || y < 0 || x >= width || y >= canvas.height) {
        return;
    }
    const index = y * width + x;
    if (depth >= depthBuffer[index]) {
        return;
    }
    depthBuffer[index] = depth;
    const offset = index * 4;
    buffer[offset] = color.r;
    buffer[offset + 1] = color.g;
    buffer[offset + 2] = color.b;
    buffer[offset + 3] = 255;
}

function drawBlock(buffer, width, x, y, depth, size, color, depthBuffer) {
    const centerX = Math.round(x);
    const centerY = Math.round(y);
    const half = Math.floor(size / 2);
    for (let py = 0; py < size; py++) {
        for (let px = 0; px < size; px++) {
            drawPixel(buffer, width, centerX - half + px, centerY - half + py, depth, color, depthBuffer);
        }
    }
}

function renderSlice(limb) {
    let width = 1;
    let height = 1;
    if (state.viewType === 'front') {
        width = limb.sizeX;
        height = limb.sizeY;
    } else if (state.viewType === 'side') {
        width = limb.sizeZ;
        height = limb.sizeY;
    } else {
        width = limb.sizeX;
        height = limb.sizeZ;
    }
    canvas.width = Math.max(1, width);
    canvas.height = Math.max(1, height);
    const image = ctx.createImageData(canvas.width, canvas.height);
    const pixels = image.data;
    const maxSlice = state.viewType === 'front'
        ? limb.sizeZ
        : state.viewType === 'side'
            ? limb.sizeX
            : limb.sizeY;
    state.sliceIndex = clamp(state.sliceIndex, 0, Math.max(0, maxSlice - 1));
    let index = 0;
    for (let z = 0; z < limb.sizeZ; z++) {
        for (let y = 0; y < limb.sizeY; y++) {
            for (let x = 0; x < limb.sizeX; x++) {
                const color = limb.voxels[index++];
                index++;
                if (color === 0) {
                    continue;
                }
                const matches = state.viewType === 'front'
                    ? z === state.sliceIndex
                    : state.viewType === 'side'
                        ? x === state.sliceIndex
                        : y === state.sliceIndex;
                if (!matches) {
                    continue;
                }
                const paletteOffset = color * 3;
                const px = state.viewType === 'front'
                    ? x
                    : state.viewType === 'side'
                        ? z
                        : x;
                const py = state.viewType === 'front'
                    ? (limb.sizeY - 1 - y)
                    : state.viewType === 'side'
                        ? (limb.sizeY - 1 - y)
                        : (limb.sizeZ - 1 - z);
                const dst = (py * canvas.width + px) * 4;
                pixels[dst] = scene.palette[paletteOffset] ?? color;
                pixels[dst + 1] = scene.palette[paletteOffset + 1] ?? color;
                pixels[dst + 2] = scene.palette[paletteOffset + 2] ?? color;
                pixels[dst + 3] = 255;
            }
        }
    }
    ctx.putImageData(image, 0, 0);
}

function renderVoxelView(limb) {
    canvas.width = 960;
    canvas.height = 960;
    const image = ctx.createImageData(canvas.width, canvas.height);
    const pixels = image.data;
    const depthBuffer = new Float32Array(canvas.width * canvas.height);
    depthBuffer.fill(Number.POSITIVE_INFINITY);
    const lightDirection = normalize(state.renderMode === 'game'
        ? { x: 0.2013022, y: -0.9101138, z: -0.3621709 }
        : { x: -0.7, y: 1.0, z: 0.4 });
    const ambient = state.renderMode === 'game' ? 0.4 : 0.35;
    const diffuseStrength = state.renderMode === 'game' ? 0.6 : 0.65;
    const yaw = state.cameraYaw * Math.PI / 180;
    const pitch = clamp(state.cameraPitch, -89, 89) * Math.PI / 180;
    const maxDimension = Math.max(limb.sizeX, limb.sizeY, limb.sizeZ, 1);
    const centerX = canvas.width / 2 + state.cameraPanX;
    const centerY = canvas.height / 2 + state.cameraPanY;
    const distance = state.renderMode === 'game'
        ? maxDimension * 2.1 + 6
        : (maxDimension * 2.8 + 10) / Math.max(state.cameraZoom, 0.01);
    const baseZoom = state.renderMode === 'game'
        ? Math.max(5, Math.floor(340 / maxDimension)) * state.cameraZoom
        : 1;
    const fov = 50 * Math.PI / 180;
    const focal = (canvas.height * 0.5) / Math.tan(fov * 0.5);
    const active = buildActiveVoxelList(limb);
    const worldU = normalize({ x: 0, y: 0, z: 1 });
    active.sort((left, right) => {
        const leftScore = left.x + left.y + left.z;
        const rightScore = right.x + right.y + right.z;
        return leftScore - rightScore;
    });

    for (const voxel of active) {
        const local = {
            x: voxel.x - limb.sizeX / 2,
            y: voxel.y - limb.sizeY / 2,
            z: voxel.z - limb.sizeZ / 2,
        };
        const rotated = rotateY(rotateX(local, pitch), yaw);
        const paletteOffset = voxel.color * 3;
        const base = {
            r: scene.palette[paletteOffset] ?? voxel.color,
            g: scene.palette[paletteOffset + 1] ?? voxel.color,
            b: scene.palette[paletteOffset + 2] ?? voxel.color,
        };
        const normal = readGameNormal(voxel.normal);
        let color;

        if (state.renderMode === 'game') {
            const lPlusU = {
                x: lightDirection.x + worldU.x,
                y: lightDirection.y + worldU.y,
                z: lightDirection.z + worldU.z,
            };
            const l2 = dot(lPlusU, lPlusU) > 1e-6 ? normalize(lPlusU) : { x: 0, y: 0, z: 0 };
            const f1 = dot(normal, lightDirection);
            const f2Dot = dot(normal, l2);
            const d = 3.0;
            const f2Denominator = d - (d - 1.0) * f2Dot;
            const f2 = f2Denominator > 1e-6 ? (f2Dot / f2Denominator) : 0.0;
            let lightLevelIndex = Math.floor(16.0 * (Math.max(0, f1) + Math.max(0, f2)));
            lightLevelIndex = clamp(lightLevelIndex, 0, 31);
            const vplColor = readVplColor(lightLevelIndex, voxel.color);
            color = {
                r: Math.max(0, Math.min(255, Math.round(vplColor.r * (ambient + diffuseStrength)))),
                g: Math.max(0, Math.min(255, Math.round(vplColor.g * (ambient + diffuseStrength)))),
                b: Math.max(0, Math.min(255, Math.round(vplColor.b * (ambient + diffuseStrength)))),
            };
        } else {
            const shade = ambient + Math.max(0, dot(normal, lightDirection)) * diffuseStrength;
            color = {
                r: Math.max(0, Math.min(255, Math.round(base.r * shade))),
                g: Math.max(0, Math.min(255, Math.round(base.g * shade))),
                b: Math.max(0, Math.min(255, Math.round(base.b * shade))),
            };
        }

        if (state.renderMode === 'game') {
            const screenX = rotated.x * baseZoom + centerX;
            const screenY = -rotated.y * baseZoom + centerY;
            drawBlock(pixels, canvas.width, screenX, screenY, rotated.z, Math.max(1, Math.round(baseZoom)), color, depthBuffer);
            continue;
        }

        const cameraZ = rotated.z + distance;
        if (cameraZ <= 0.01) {
            continue;
        }
        const scale = focal / cameraZ;
        const screenX = rotated.x * scale + centerX;
        const screenY = -rotated.y * scale + centerY;
        drawBlock(pixels, canvas.width, screenX, screenY, cameraZ, Math.max(1, Math.round(scale * 1.2)), color, depthBuffer);
    }

    ctx.putImageData(image, 0, 0);
}

function render() {
    const limb = scene.limbs[Math.min(scene.limbs.length - 1, Math.max(0, state.limbIndex))];
    if (!limb) {
        return;
    }
    if (state.renderMode === 'slice') {
        renderSlice(limb);
    } else {
        renderVoxelView(limb);
    }
}

function requestRender() {
    if (rafId) {
        return;
    }
    rafId = requestAnimationFrame(() => {
        rafId = 0;
        render();
    });
}

function scheduleSyncState() {
    if (syncHandle) {
        return;
    }
    syncHandle = window.setTimeout(() => {
        syncHandle = 0;
        previewApi.postMessage({
            type: 'voxelSyncState',
            state,
        });
    }, 120);
}

canvas.addEventListener('mousedown', event => {
    dragging = true;
    panMode = event.shiftKey || event.button === 1;
    lastX = event.clientX;
    lastY = event.clientY;
    canvas.classList.add('dragging');
});

window.addEventListener('mouseup', () => {
    dragging = false;
    canvas.classList.remove('dragging');
});

window.addEventListener('mousemove', event => {
    if (!dragging || state.renderMode === 'slice') {
        return;
    }
    const deltaX = event.clientX - lastX;
    const deltaY = event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;
    if (panMode) {
        state.cameraPanX -= deltaX;
        state.cameraPanY += deltaY;
    } else {
        state.cameraYaw -= deltaX * 0.35;
        state.cameraPitch = clamp(state.cameraPitch - deltaY * 0.28, -89, 89);
    }
    requestRender();
    scheduleSyncState();
});

canvas.addEventListener('wheel', event => {
    if (state.renderMode === 'slice') {
        return;
    }
    event.preventDefault();
    const factor = event.deltaY > 0 ? 0.92 : 1.08;
    state.cameraZoom = clamp(state.cameraZoom * factor, 0.2, 6);
    requestRender();
    scheduleSyncState();
}, { passive: false });

requestRender();
`;
}

function isShpPreview(model: ResourcePreviewModel): model is ShpPreviewModel {
    return model.kind === 'rgba-image' && 'totalFrames' in model && 'frameIndex' in model;
}

function isVoxelPreview(model: ResourcePreviewModel): model is VoxelPreviewModel {
    return model.kind === 'voxel-scene';
}

function escapeHtml(value: string): string {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function sanitizeVoxelState(value: unknown): Partial<VoxelPreviewState> {
    if (!value || typeof value !== 'object') {
        return {};
    }
    const state = value as Record<string, unknown>;
    return {
        limbIndex: typeof state.limbIndex === 'number' ? state.limbIndex : undefined,
        sliceIndex: typeof state.sliceIndex === 'number' ? state.sliceIndex : undefined,
        viewType: state.viewType === 'front' || state.viewType === 'side' || state.viewType === 'top' ? state.viewType : undefined,
        renderMode: state.renderMode === 'slice' || state.renderMode === 'game' || state.renderMode === 'perspective' ? state.renderMode : undefined,
        cameraYaw: typeof state.cameraYaw === 'number' ? state.cameraYaw : undefined,
        cameraPitch: typeof state.cameraPitch === 'number' ? state.cameraPitch : undefined,
        cameraZoom: typeof state.cameraZoom === 'number' ? state.cameraZoom : undefined,
        cameraPanX: typeof state.cameraPanX === 'number' ? state.cameraPanX : undefined,
        cameraPanY: typeof state.cameraPanY === 'number' ? state.cameraPanY : undefined,
    };
}

function getVoxelSliceCount(limb: { sizeX: number; sizeY: number; sizeZ: number }, viewType: VoxelPreviewState['viewType']): number {
    switch (viewType) {
        case 'front':
            return limb.sizeZ;
        case 'side':
            return limb.sizeX;
        case 'top':
            return limb.sizeY;
    }
}
