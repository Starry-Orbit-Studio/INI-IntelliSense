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
                case 'voxelSetLimb':
                    if (typeof message.limbIndex === 'number') {
                        state.voxel.limbIndex = Math.max(0, Math.trunc(message.limbIndex));
                        await refresh();
                    }
                    return;
                case 'voxelSetModelYaw':
                    if (typeof message.value === 'number') {
                        state.voxel.modelYaw = clamp(message.value, -180, 180);
                    }
                    return;
                case 'voxelSetModelPitch':
                    if (typeof message.value === 'number') {
                        state.voxel.modelPitch = clamp(message.value, -89, 89);
                    }
                    return;
                case 'voxelOrbit':
                    if (typeof message.deltaX === 'number' && typeof message.deltaY === 'number') {
                        if (state.voxel.renderMode === 'game') {
                            state.voxel.modelYaw += message.deltaX * 0.35;
                            state.voxel.modelPitch = clamp(state.voxel.modelPitch + message.deltaY * 0.28, -89, 89);
                        } else {
                            state.voxel.cameraYaw += message.deltaX * 0.35;
                            state.voxel.cameraPitch = clamp(state.voxel.cameraPitch + message.deltaY * 0.28, -89, 89);
                        }
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
                overflow: hidden;
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
            .toolbar-group.range-group {
                gap: 10px;
            }
            .range-control {
                display: inline-flex;
                align-items: center;
                gap: 8px;
            }
            .range-control label {
                font-size: 12px;
                color: var(--vscode-descriptionForeground);
            }
            .range-control input[type="range"] {
                width: 160px;
            }
            .range-value {
                min-width: 42px;
                text-align: right;
                font-size: 12px;
                color: var(--vscode-descriptionForeground);
                font-variant-numeric: tabular-nums;
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
                min-height: 0;
                display: flex;
                align-items: center;
                justify-content: center;
                overflow: hidden;
                padding: 16px;
                box-sizing: border-box;
            }
            .surface {
                display: flex;
                flex-direction: column;
                align-items: center;
                gap: 12px;
                width: 100%;
                height: 100%;
                min-height: 0;
            }
            .surface.centered {
                justify-content: center;
            }
            .canvas-frame {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                border: 1px solid var(--vscode-panel-border);
                background: var(--vscode-editor-background);
                max-width: 100%;
                max-height: 100%;
                padding: 12px;
                border-radius: 8px;
                box-sizing: border-box;
                position: relative;
                overflow: hidden;
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
                max-width: 100%;
                max-height: 100%;
                height: auto;
            }
            canvas.interactive {
                cursor: grab;
                width: auto;
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
            .frame-overlay {
                position: absolute;
                top: 12px;
                right: 12px;
                display: flex;
                flex-direction: column;
                gap: 6px;
                z-index: 2;
                max-height: calc(100% - 24px);
                overflow: auto;
            }
            .limb-button {
                text-align: left;
                min-width: 160px;
                max-width: 240px;
                padding: 6px 10px;
                border-radius: 8px;
                background: color-mix(in srgb, var(--vscode-editorWidget-background) 88%, transparent);
                backdrop-filter: blur(6px);
            }
            .limb-button.active {
                background: var(--vscode-button-background);
                color: var(--vscode-button-foreground);
            }
        </style>
    `;

    const toolbar = renderToolbar(model, uri, paletteUri);
    const details = renderDetails(model);

    if (model.kind === 'rgba-image') {
        const pixels = JSON.stringify(Array.from(model.pixels));
        const canvasClass = model.pixelated === false ? '' : 'pixelated';
        return `<!DOCTYPE html><html><head><meta charset="utf-8" />${style}</head><body>${toolbar}<div class="viewport"><div class="surface centered">${details}<div class="canvas-frame alpha-board"><canvas id="preview" class="${canvasClass}" width="${model.width}" height="${model.height}"></canvas></div></div></div><script>${toolbarScript()}const pixels = new Uint8ClampedArray(${pixels});const canvas = document.getElementById('preview');const ctx = canvas.getContext('2d');ctx.putImageData(new ImageData(pixels, ${model.width}, ${model.height}), 0, 0);</script></body></html>`;
    }

    if (model.kind === 'voxel-scene') {
        const scene = JSON.stringify(model.scene);
        const state = JSON.stringify(model.state);
        const limbOverlay = renderVoxelLimbOverlay(model);
        return `<!DOCTYPE html><html><head><meta charset="utf-8" />${style}</head><body>${toolbar}<div class="viewport"><div class="surface${model.state.renderMode === 'slice' ? ' centered' : ''}">${details}<div class="canvas-frame alpha-board">${limbOverlay}<canvas id="voxel-preview" class="interactive" width="960" height="960"></canvas></div></div></div><script>${toolbarScript()}const voxelScene = ${scene};const voxelState = ${state};${voxelSceneScript()}</script></body></html>`;
    }

    if (model.kind === 'palette') {
        return `<!DOCTYPE html><html><head><meta charset="utf-8" />${style}</head><body>${toolbar}<div class="viewport"><div class="surface centered">${details}<div class="canvas-frame"><div class="palette">${model.colors.map(color => `<div class="swatch" style="background:${color}" title="${color}"></div>`).join('')}</div></div></div></div><script>${toolbarScript()}</script></body></html>`;
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
        groups.push(`<div class="toolbar-group"><button type="button" data-action="choosePalette">${escapeHtml(localize('preview.palette.choose', 'Choose Palette'))}</button>${paletteUri ? `<span class="badge">${escapeHtml(path.posix.basename(paletteUri.path))}</span>` : ''}</div>`);
    }

    if (isShpPreview(model)) {
        groups.push(`<div class="toolbar-group"><button type="button" data-action="shpPrevFrame">${escapeHtml(localize('preview.shp.prevFrame', 'Prev Frame'))}</button><span class="badge">${model.frameIndex + 1}/${model.totalFrames}</span><button type="button" data-action="shpNextFrame">${escapeHtml(localize('preview.shp.nextFrame', 'Next Frame'))}</button></div>`);
    }

    if (isVoxelPreview(model)) {
        const limbCount = model.scene.limbs.length;
        const activeLimb = model.scene.limbs[clamp(model.state.limbIndex, 0, Math.max(0, limbCount - 1))];
        const sliceCount = activeLimb ? getVoxelSliceCount(activeLimb, model.state.viewType) : 1;
        groups.push(`<div class="toolbar-group"><button type="button" class="${model.state.renderMode === 'slice' ? '' : 'secondary'}" data-action="voxelSetMode" data-mode="slice">${escapeHtml(localize('preview.voxel.mode.slice', 'Slice'))}</button><button type="button" class="${model.state.renderMode === 'game' ? '' : 'secondary'}" data-action="voxelSetMode" data-mode="game">${escapeHtml(localize('preview.voxel.mode.game', 'Game View'))}</button><button type="button" class="${model.state.renderMode === 'perspective' ? '' : 'secondary'}" data-action="voxelSetMode" data-mode="perspective">${escapeHtml(localize('preview.voxel.mode.perspective', 'Perspective'))}</button></div>`);
        if (model.state.renderMode === 'slice') {
            groups.push(`<div class="toolbar-group"><button type="button" data-action="voxelPrevSlice" title="${escapeHtml(localize('preview.voxel.prevSlice', 'Previous Slice'))}">&lt;</button><span class="badge">${model.state.sliceIndex + 1}/${sliceCount}</span><button type="button" data-action="voxelNextSlice" title="${escapeHtml(localize('preview.voxel.nextSlice', 'Next Slice'))}">&gt;</button></div>`);
            groups.push(`<div class="toolbar-group"><button type="button" class="${model.state.viewType === 'front' ? '' : 'secondary'}" data-action="voxelSetView" data-view="front">${escapeHtml(localize('preview.voxel.view.front', 'Front'))}</button><button type="button" class="${model.state.viewType === 'side' ? '' : 'secondary'}" data-action="voxelSetView" data-view="side">${escapeHtml(localize('preview.voxel.view.side', 'Side'))}</button><button type="button" class="${model.state.viewType === 'top' ? '' : 'secondary'}" data-action="voxelSetView" data-view="top">${escapeHtml(localize('preview.voxel.view.top', 'Top'))}</button></div>`);
        } else if (model.state.renderMode === 'game') {
            groups.push(`<div class="toolbar-group range-group"><div class="range-control"><label for="model-yaw">${escapeHtml(localize('preview.voxel.modelYaw', 'Horizontal'))}</label><input id="model-yaw" type="range" min="-180" max="180" step="1" value="${Math.round(model.state.modelYaw)}" data-action="voxelSetModelYaw" /><span class="range-value" id="model-yaw-value">${Math.round(model.state.modelYaw)}°</span></div><div class="range-control"><label for="model-pitch">${escapeHtml(localize('preview.voxel.modelPitch', 'Vertical'))}</label><input id="model-pitch" type="range" min="-89" max="89" step="1" value="${Math.round(model.state.modelPitch)}" data-action="voxelSetModelPitch" /><span class="range-value" id="model-pitch-value">${Math.round(model.state.modelPitch)}°</span></div></div>`);
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

function renderVoxelLimbOverlay(model: VoxelPreviewModel): string {
    if (model.scene.limbs.length <= 1) {
        return '';
    }

    return `<div class="frame-overlay">${model.scene.limbs.map((limb, index) => `<button type="button" class="limb-button${index === model.state.limbIndex ? ' active' : ' secondary'}" data-action="voxelSetLimb" data-limb-index="${index}" title="${escapeHtml(limb.name)}">${escapeHtml(limb.name)}</button>`).join('')}</div>`;
}

function toolbarScript(): string {
    return `
const vscode = window.__ra2PreviewVsCode ?? acquireVsCodeApi();
window.__ra2PreviewVsCode = vscode;
for (const button of document.querySelectorAll('[data-action]')) {
    const eventName = button.tagName === 'INPUT' ? 'input' : 'click';
    button.addEventListener(eventName, () => {
        const payload = { type: button.dataset.action };
        if (button.dataset.view) {
            payload.viewType = button.dataset.view;
        }
        if (button.dataset.mode) {
            payload.mode = button.dataset.mode;
        }
        if (button.dataset.limbIndex) {
            payload.limbIndex = Number(button.dataset.limbIndex);
        }
        if (button.tagName === 'INPUT') {
            payload.value = Number(button.value);
            if (button.dataset.action === 'voxelSetModelYaw') {
                voxelState.modelYaw = payload.value;
                requestRender();
                scheduleSyncState();
            } else if (button.dataset.action === 'voxelSetModelPitch') {
                voxelState.modelPitch = payload.value;
                requestRender();
                scheduleSyncState();
            }
            const valueTarget = document.getElementById(button.id + '-value');
            if (valueTarget) {
                valueTarget.textContent = Math.round(Number(button.value)) + '°';
            }
        } else if (button.dataset.value) {
            payload.value = Number(button.dataset.value);
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

function applyViewRotation(vector, yaw, pitch) {
    return rotateX(rotateY(vector, yaw), pitch);
}

function applyLocalModelRotation(vector, yaw, pitch) {
    const yawRotated = rotateY(vector, yaw);
    const localRight = normalize(rotateY({ x: 1, y: 0, z: 0 }, yaw));
    return rotateAroundAxis(yawRotated, localRight, pitch);
}

function applyInverseViewRotation(vector, yaw, pitch) {
    return rotateY(rotateX(vector, -pitch), -yaw);
}

function transposeMatrix3(matrix) {
    return [
        [matrix[0][0], matrix[1][0], matrix[2][0]],
        [matrix[0][1], matrix[1][1], matrix[2][1]],
        [matrix[0][2], matrix[1][2], matrix[2][2]],
    ];
}

function multiplyMatrix3(left, right) {
    return [
        [
            left[0][0] * right[0][0] + left[0][1] * right[1][0] + left[0][2] * right[2][0],
            left[0][0] * right[0][1] + left[0][1] * right[1][1] + left[0][2] * right[2][1],
            left[0][0] * right[0][2] + left[0][1] * right[1][2] + left[0][2] * right[2][2],
        ],
        [
            left[1][0] * right[0][0] + left[1][1] * right[1][0] + left[1][2] * right[2][0],
            left[1][0] * right[0][1] + left[1][1] * right[1][1] + left[1][2] * right[2][1],
            left[1][0] * right[0][2] + left[1][1] * right[1][2] + left[1][2] * right[2][2],
        ],
        [
            left[2][0] * right[0][0] + left[2][1] * right[1][0] + left[2][2] * right[2][0],
            left[2][0] * right[0][1] + left[2][1] * right[1][1] + left[2][2] * right[2][1],
            left[2][0] * right[0][2] + left[2][1] * right[1][2] + left[2][2] * right[2][2],
        ],
    ];
}

function applyMatrix3(matrix, vector) {
    return {
        x: matrix[0][0] * vector.x + matrix[0][1] * vector.y + matrix[0][2] * vector.z,
        y: matrix[1][0] * vector.x + matrix[1][1] * vector.y + matrix[1][2] * vector.z,
        z: matrix[2][0] * vector.x + matrix[2][1] * vector.y + matrix[2][2] * vector.z,
    };
}

function rotateAroundAxis(vector, axis, angle) {
    const unitAxis = normalize(axis);
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const projection = dot(unitAxis, vector);
    const cross = {
        x: unitAxis.y * vector.z - unitAxis.z * vector.y,
        y: unitAxis.z * vector.x - unitAxis.x * vector.z,
        z: unitAxis.x * vector.y - unitAxis.y * vector.x,
    };
    return {
        x: vector.x * c + cross.x * s + unitAxis.x * projection * (1 - c),
        y: vector.y * c + cross.y * s + unitAxis.y * projection * (1 - c),
        z: vector.z * c + cross.z * s + unitAxis.z * projection * (1 - c),
    };
}

function createRotationXMatrix(angle) {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return [
        [1, 0, 0],
        [0, c, -s],
        [0, s, c],
    ];
}

function createRotationYMatrix(angle) {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return [
        [c, 0, s],
        [0, 1, 0],
        [-s, 0, c],
    ];
}

function createGameViewMatrix(yaw, pitch) {
    return multiplyMatrix3(createRotationXMatrix(pitch), createRotationYMatrix(yaw));
}

function applyGameViewRotation(vector, yaw, pitch) {
    return applyMatrix3(createGameViewMatrix(yaw, pitch), vector);
}

function applyGameViewInverseRotation(vector, yaw, pitch) {
    return applyMatrix3(transposeMatrix3(createGameViewMatrix(yaw, pitch)), vector);
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
        y: -(scene.gameNormals[offset + 2] ?? 1),
        z: scene.gameNormals[offset + 1] ?? 0,
    });
}

function invert(vector) {
    return {
        x: -vector.x,
        y: -vector.y,
        z: -vector.z,
    };
}

function readVplColor(lightLevelIndex, colorIndex) {
    const lookupIndex = lightLevelIndex * 256 + colorIndex;
    const finalColorIndex = scene.vplLookup[lookupIndex] ?? colorIndex;
    const offset = finalColorIndex * 3;
    return {
        r: scene.palette[offset] ?? 0,
        g: scene.palette[offset + 1] ?? 0,
        b: scene.palette[offset + 2] ?? 0,
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
    const rawLightDirection = normalize({ x: 0.2013022, y: -0.9101138, z: -0.3621709 });
    const gameLightDirection = rawLightDirection;
    const perspectiveSunDirection = normalize(invert(rawLightDirection));
    const perspectiveFillDirection = rawLightDirection;
    const ambient = state.renderMode === 'game' ? 0.3 : 0.35;
    const yaw = (state.renderMode === 'game' ? 45 : state.cameraYaw) * Math.PI / 180;
    const pitch = clamp(state.renderMode === 'game' ? -35.264 : state.cameraPitch, -89, 89) * Math.PI / 180;
    const modelYaw = state.modelYaw * Math.PI / 180;
    const modelPitch = clamp(state.modelPitch, -89, 89) * Math.PI / 180;
    const maxDimension = Math.max(limb.sizeX, limb.sizeY, limb.sizeZ, 1);
    const centerX = canvas.width / 2 + state.cameraPanX;
    const centerY = canvas.height / 2 + state.cameraPanY;
    const distance = (maxDimension * 2.8 + 10) / Math.max(state.cameraZoom, 0.01);
    const baseZoom = state.renderMode === 'game'
        ? Math.max(2, Math.ceil((220 / maxDimension) * state.cameraZoom))
        : 1;
    const fov = 50 * Math.PI / 180;
    const focal = (canvas.height * 0.5) / Math.tan(fov * 0.5);
    const active = buildActiveVoxelList(limb);
    const worldU = state.renderMode === 'game'
        ? normalize(applyGameViewInverseRotation({ x: 0, y: 0, z: 1 }, yaw, pitch))
        : normalize({ x: 0, y: 0, z: 1 });
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
        const modelRotated = state.renderMode === 'game'
            ? applyLocalModelRotation(local, modelYaw, modelPitch)
            : local;
        const rotated = state.renderMode === 'game'
            ? applyGameViewRotation(modelRotated, yaw, pitch)
            : applyViewRotation(local, yaw, pitch);
        const paletteOffset = voxel.color * 3;
        const base = {
            r: scene.palette[paletteOffset] ?? voxel.color,
            g: scene.palette[paletteOffset + 1] ?? voxel.color,
            b: scene.palette[paletteOffset + 2] ?? voxel.color,
        };
        const normal = readGameNormal(voxel.normal);
        let color;
        const perspectiveNormal = normalize(applyViewRotation(normal, yaw, pitch));

        if (state.renderMode === 'game') {
            const lPlusU = {
                x: gameLightDirection.x + worldU.x,
                y: gameLightDirection.y + worldU.y,
                z: gameLightDirection.z + worldU.z,
            };
            const l2 = dot(lPlusU, lPlusU) > 1e-6 ? normalize(lPlusU) : { x: 0, y: 0, z: 0 };
            const worldNormal = normalize(applyLocalModelRotation(normal, modelYaw, modelPitch));
            const f1 = dot(worldNormal, gameLightDirection);
            const f2Dot = dot(worldNormal, l2);
            const d = 3.0;
            const f2Denominator = d - (d - 1.0) * f2Dot;
            const f2 = f2Denominator > 1e-6 ? (f2Dot / f2Denominator) : 0.0;
            let lightLevelIndex = Math.floor(16.0 * (Math.max(0, f1) + Math.max(0, f2)));
            lightLevelIndex = clamp(lightLevelIndex, 0, 31);
            const baseColor = readVplColor(lightLevelIndex, voxel.color);
            color = {
                r: Math.max(0, Math.min(255, Math.round(baseColor.r))),
                g: Math.max(0, Math.min(255, Math.round(baseColor.g))),
                b: Math.max(0, Math.min(255, Math.round(baseColor.b))),
            };
        } else {
            const sunShade = Math.max(0, dot(perspectiveNormal, perspectiveSunDirection)) * 1.0;
            const fillShade = Math.max(0, dot(perspectiveNormal, perspectiveFillDirection)) * 0.25;
            const shade = ambient + sunShade + fillShade;
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
        if (state.renderMode === 'game') {
            state.modelYaw -= deltaX * 0.35;
            state.modelPitch = clamp(state.modelPitch - deltaY * 0.28, -89, 89);
        } else {
            state.cameraYaw -= deltaX * 0.35;
            state.cameraPitch = clamp(state.cameraPitch - deltaY * 0.28, -89, 89);
        }
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
        modelYaw: typeof state.modelYaw === 'number' ? state.modelYaw : undefined,
        modelPitch: typeof state.modelPitch === 'number' ? state.modelPitch : undefined,
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
