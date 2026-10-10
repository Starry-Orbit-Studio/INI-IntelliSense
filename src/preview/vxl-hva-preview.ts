import * as path from 'path';
import * as vscode from 'vscode';
import { PreviewContext } from './preview-context';
import { HtmlPreview, VoxelSceneData, VoxelSceneLimb, VoxelScenePreview } from './preview-types';
import { PaletteColor } from './palette-utils';

type VoxelViewType = 'front' | 'side' | 'top';
export type VoxelRenderMode = 'slice' | 'game' | 'perspective';

interface Voxel {
    color: number;
    normal: number;
}

interface SpanData {
    voxels: Voxel[];
}

interface LimbHeader {
    name: string;
}

interface LimbTailer {
    spanStartOffset: number;
    spanEndOffset: number;
    spanDataOffset: number;
    sizeX: number;
    sizeY: number;
    sizeZ: number;
}

interface VxlModel {
    signature: string;
    limbCount: number;
    bodySize: number;
    remapStart: number;
    remapEnd: number;
    headers: LimbHeader[];
    tailers: LimbTailer[];
    bodyData: SpanData[][];
}

export interface VoxelPreviewState {
    limbIndex: number;
    sliceIndex: number;
    viewType: VoxelViewType;
    renderMode: VoxelRenderMode;
    cameraYaw: number;
    cameraPitch: number;
    cameraZoom: number;
    cameraPanX: number;
    cameraPanY: number;
    modelYaw: number;
    modelPitch: number;
}

export type VoxelPreviewModel = VoxelScenePreview;

const DEFAULT_PERSPECTIVE_CAMERA = {
    yaw: 38,
    pitch: -24,
    zoom: 1,
    panX: 0,
    panY: 0,
    modelYaw: 0,
    modelPitch: 0,
};

const GAME_VIEW_CAMERA = {
    yaw: 45,
    pitch: -35.264,
    zoom: 1,
    panX: 0,
    panY: 0,
    modelYaw: 0,
    modelPitch: 0,
};

let bundledVplDataPromise: Promise<{ palette: number[]; lookup: number[] }> | undefined;

export async function createVxlPreview(
    uri: vscode.Uri,
    bytes: Uint8Array,
    title: string,
    previewContext: PreviewContext,
    state: VoxelPreviewState,
    paletteUri?: vscode.Uri
): Promise<VoxelPreviewModel | HtmlPreview> {
    const model = parseVxl(bytes);
    if (model.limbCount === 0 || model.tailers.length === 0) {
        throw new Error('Invalid VXL file: no limbs found.');
    }

    const limbIndex = clamp(state.limbIndex, 0, model.tailers.length - 1);
    const paletteSelection = paletteUri
        ? {
            uri: paletteUri,
            label: path.posix.basename(paletteUri.path),
            colors: await previewContext.readPalette(paletteUri),
        }
        : await resolveVoxelPalette(uri, previewContext);
    const scene = await buildVoxelSceneData(model, paletteSelection.colors, previewContext);
    const activeTailer = model.tailers[limbIndex];
    const sliceCount = getSliceCount(activeTailer, state.viewType);
    const nextState: VoxelPreviewState = {
        ...state,
        limbIndex,
        sliceIndex: clamp(state.sliceIndex, 0, Math.max(0, sliceCount - 1)),
    };
    return {
        kind: 'voxel-scene',
        title,
        description: `${model.headers[limbIndex]?.name || `Limb ${limbIndex + 1}`} preview`,
        details: [
            `Signature ${model.signature}`,
            `Limbs ${model.limbCount}`,
            `Size ${activeTailer.sizeX} x ${activeTailer.sizeY} x ${activeTailer.sizeZ}`,
            `Palette ${paletteSelection.label}`,
            `Remap ${model.remapStart}-${model.remapEnd}`,
        ],
        scene,
        state: nextState,
    };
}

export async function createHvaPreview(
    uri: vscode.Uri,
    bytes: Uint8Array,
    title: string,
    previewContext: PreviewContext,
    state: VoxelPreviewState,
    paletteUri?: vscode.Uri
): Promise<VoxelPreviewModel | HtmlPreview> {
    const info = parseHva(bytes);
    const siblingName = `${path.posix.basename(uri.path, path.posix.extname(uri.path))}.vxl`;
    const vxlUri = await previewContext.findSiblingUri(uri, siblingName);
    if (!vxlUri) {
        return {
            kind: 'html',
            title,
            details: [
                `Frames ${info.frameCount}`,
                `Sections ${info.sectionCount}`,
            ],
            bodyHtml: `
                <div class="info-card">
                    <h2>HVA Preview</h2>
                    <p><strong>Signature:</strong> <code>${escapeHtml(info.signature)}</code></p>
                    <p><strong>Frames:</strong> ${info.frameCount}</p>
                    <p><strong>Sections:</strong> ${info.sectionCount}</p>
                    <p>${escapeHtml('A sibling VXL file was not found, so only animation metadata is available.')}</p>
                </div>
            `,
        };
    }

    const vxlBytes = await vscode.workspace.fs.readFile(vxlUri);
    const preview = await createVxlPreview(vxlUri, vxlBytes, title, previewContext, state, paletteUri);
    if (preview.kind === 'voxel-scene') {
        preview.details = [
            `HVA Frames ${info.frameCount}`,
            `Sections ${info.sectionCount}`,
            ...(preview.details ?? []),
        ];
    }
    return preview;
}

function parseHva(bytes: Uint8Array): { signature: string; frameCount: number; sectionCount: number } {
    if (bytes.byteLength < 24) {
        throw new Error('Invalid HVA file.');
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return {
        signature: decodeAscii(bytes.slice(0, 16)),
        frameCount: view.getUint32(16, true),
        sectionCount: view.getUint32(20, true),
    };
}

function parseVxl(bytes: Uint8Array): VxlModel {
    if (bytes.byteLength < 802) {
        throw new Error('Invalid VXL file.');
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const signature = decodeAscii(bytes.slice(0, 16));
    const limbCount = view.getUint32(20, true);
    const bodySize = view.getUint32(28, true);
    const remapStart = bytes[32] ?? 0;
    const remapEnd = bytes[33] ?? 0;

    let offset = 802;
    const headers: LimbHeader[] = [];
    for (let i = 0; i < limbCount; i++) {
        headers.push({
            name: decodeAscii(bytes.slice(offset, offset + 16)),
        });
        offset += 28;
    }

    const bodyStart = offset;
    const tailerStart = bodyStart + bodySize;
    const tailers: LimbTailer[] = [];
    for (let i = 0; i < limbCount; i++) {
        const tailerOffset = tailerStart + i * 92;
        tailers.push({
            spanStartOffset: view.getUint32(tailerOffset, true),
            spanEndOffset: view.getUint32(tailerOffset + 4, true),
            spanDataOffset: view.getUint32(tailerOffset + 8, true),
            sizeX: bytes[tailerOffset + 88] ?? 0,
            sizeY: bytes[tailerOffset + 89] ?? 0,
            sizeZ: bytes[tailerOffset + 90] ?? 0,
        });
    }

    const bodyData: SpanData[][] = [];
    for (let i = 0; i < limbCount; i++) {
        const tailer = tailers[i];
        const spanCount = tailer.sizeX * tailer.sizeY;
        const spanStarts: number[] = [];
        const spanEnds: number[] = [];

        for (let j = 0; j < spanCount; j++) {
            spanStarts.push(view.getUint32(bodyStart + tailer.spanStartOffset + j * 4, true));
            spanEnds.push(view.getUint32(bodyStart + tailer.spanEndOffset + j * 4, true));
        }

        const spans: SpanData[] = [];
        for (let j = 0; j < spanCount; j++) {
            const voxels = Array.from({ length: tailer.sizeZ }, () => ({ color: 0, normal: 0 }));
            const start = spanStarts[j];
            const end = spanEnds[j];
            if (start !== 0xffffffff && end !== 0xffffffff) {
                let cursor = bodyStart + tailer.spanDataOffset + start;
                const endOffset = bodyStart + tailer.spanDataOffset + end;
                let currentVoxelIndex = 0;
                while (cursor <= endOffset) {
                    const skipCount = bytes[cursor++] ?? 0;
                    const voxelCount = bytes[cursor++] ?? 0;
                    currentVoxelIndex += skipCount;
                    for (let k = 0; k < voxelCount && currentVoxelIndex + k < voxels.length; k++) {
                        voxels[currentVoxelIndex + k] = {
                            color: bytes[cursor++] ?? 0,
                            normal: bytes[cursor++] ?? 0,
                        };
                    }
                    currentVoxelIndex += voxelCount;
                    cursor++;
                }
            }
            spans.push({ voxels });
        }
        bodyData.push(spans);
    }

    return {
        signature,
        limbCount,
        bodySize,
        remapStart,
        remapEnd,
        headers,
        tailers,
        bodyData,
    };
}

async function resolveVoxelPalette(uri: vscode.Uri, previewContext: PreviewContext): Promise<{ label: string; colors: PaletteColor[] }> {
    const directName = `${path.posix.basename(uri.path, path.posix.extname(uri.path))}.pal`;
    const directPaletteUri = await previewContext.findSiblingUri(uri, directName);
    if (directPaletteUri) {
        return {
            label: path.posix.basename(directPaletteUri.path),
            colors: await previewContext.readPalette(directPaletteUri),
        };
    }

    const fallback = await previewContext.resolvePaletteForShp(uri.with({ path: replaceLeafExtension(uri.path, '.shp') }));
    return {
        label: fallback.label,
        colors: fallback.colors,
    };
}

function voxelLh(model: VxlModel, limbIndex: number, x: number, y: number, z: number): Voxel {
    return voxelRh(model, limbIndex, z, x, y);
}

function voxelRh(model: VxlModel, limbIndex: number, x: number, y: number, z: number): Voxel {
    const tailer = model.tailers[limbIndex];
    if (x < 0 || y < 0 || z < 0 || x >= tailer.sizeX || y >= tailer.sizeY || z >= tailer.sizeZ) {
        return { color: 0, normal: 0 };
    }

    const spanIndex = y * tailer.sizeX + x;
    const span = model.bodyData[limbIndex]?.[spanIndex];
    return span?.voxels[z] ?? { color: 0, normal: 0 };
}

function getSliceCount(tailer: LimbTailer, viewType: VoxelViewType): number {
    switch (viewType) {
        case 'front':
            return tailer.sizeX;
        case 'side':
            return tailer.sizeY;
        case 'top':
            return tailer.sizeZ;
    }
}

async function buildVoxelSceneData(model: VxlModel, palette: PaletteColor[], previewContext: PreviewContext): Promise<VoxelSceneData> {
    const limbs: VoxelSceneLimb[] = model.tailers.map((tailer, limbIndex) => {
        const voxels: number[] = [];
        for (let z = 0; z < tailer.sizeX; z++) {
            for (let y = 0; y < tailer.sizeZ; y++) {
                for (let x = 0; x < tailer.sizeY; x++) {
                    const voxel = voxelLh(model, limbIndex, x, y, z);
                    voxels.push(voxel.color, voxel.normal);
                }
            }
        }
        return {
            name: model.headers[limbIndex]?.name || `Limb ${limbIndex + 1}`,
            sizeX: tailer.sizeY,
            sizeY: tailer.sizeZ,
            sizeZ: tailer.sizeX,
            voxels,
        };
    });

    const flatPalette = new Array<number>(256 * 3).fill(0);
    for (let i = 0; i < 256; i++) {
        const color = palette[i] ?? { r: i, g: i, b: i };
        const offset = i * 3;
        flatPalette[offset] = color.r;
        flatPalette[offset + 1] = color.g;
        flatPalette[offset + 2] = color.b;
    }

    const vpl = await getBundledVplData(previewContext);

    return {
        signature: model.signature,
        remapStart: model.remapStart,
        remapEnd: model.remapEnd,
        palette: flatPalette,
        vplPalette: vpl.palette,
        vplLookup: vpl.lookup,
        gameNormals: GAME_NORMALS.flatMap(normal => [normal.x, normal.y, normal.z]),
        limbs,
    };
}

async function getBundledVplData(previewContext: PreviewContext): Promise<{ palette: number[]; lookup: number[] }> {
    if (!bundledVplDataPromise) {
        bundledVplDataPromise = (async () => {
            const bytes = await previewContext.readBundledAsset(['assets', 'palettes', 'voxels.vpl']);
            return parseVpl(bytes);
        })();
    }
    return bundledVplDataPromise;
}

function parseVpl(bytes: Uint8Array): { palette: number[]; lookup: number[] } {
    if (bytes.byteLength < 16 + 768) {
        throw new Error('Invalid VPL file.');
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const sectionCount = view.getUint32(8, true);
    const paletteOffset = 16;
    const lookupOffset = paletteOffset + 768;
    const lookupSize = sectionCount * 256;
    if (bytes.byteLength < lookupOffset + lookupSize) {
        throw new Error('Invalid VPL file size.');
    }

    const palette = new Array<number>(256 * 3).fill(0);
    for (let i = 0; i < 256; i++) {
        const src = paletteOffset + i * 3;
        const dst = i * 3;
        palette[dst] = (bytes[src] ?? 0) * 4;
        palette[dst + 1] = (bytes[src + 1] ?? 0) * 4;
        palette[dst + 2] = (bytes[src + 2] ?? 0) * 4;
    }

    const lookup = Array.from(bytes.subarray(lookupOffset, lookupOffset + lookupSize));
    return { palette, lookup };
}

import { GAME_NORMALS } from '../media/voxel-normals';

function decodeAscii(bytes: Uint8Array): string {
    return new TextDecoder('latin1').decode(bytes).replace(/\0+$/, '').trim();
}

function replaceLeafExtension(filePath: string, extension: string): string {
    const leaf = path.posix.basename(filePath, path.posix.extname(filePath));
    const index = filePath.lastIndexOf('/');
    const parent = index === -1 ? '' : filePath.slice(0, index + 1);
    return `${parent}${leaf}${extension}`;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

export function createDefaultVoxelPreviewState(): VoxelPreviewState {
    return {
        limbIndex: 0,
        sliceIndex: 0,
        viewType: 'top',
        renderMode: 'game',
        cameraYaw: GAME_VIEW_CAMERA.yaw,
        cameraPitch: GAME_VIEW_CAMERA.pitch,
        cameraZoom: GAME_VIEW_CAMERA.zoom,
        cameraPanX: GAME_VIEW_CAMERA.panX,
        cameraPanY: GAME_VIEW_CAMERA.panY,
        modelYaw: GAME_VIEW_CAMERA.modelYaw,
        modelPitch: GAME_VIEW_CAMERA.modelPitch,
    };
}

export function resetVoxelCamera(state: VoxelPreviewState, mode: VoxelRenderMode = state.renderMode): void {
    const preset = mode === 'game' ? GAME_VIEW_CAMERA : DEFAULT_PERSPECTIVE_CAMERA;
    state.cameraYaw = preset.yaw;
    state.cameraPitch = preset.pitch;
    state.cameraZoom = preset.zoom;
    state.cameraPanX = preset.panX;
    state.cameraPanY = preset.panY;
    state.modelYaw = preset.modelYaw;
    state.modelPitch = preset.modelPitch;
}

function escapeHtml(value: string): string {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
}
