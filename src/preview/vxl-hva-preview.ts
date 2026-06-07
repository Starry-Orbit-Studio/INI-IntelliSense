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
}

export type VoxelPreviewModel = VoxelScenePreview;

const DEFAULT_PERSPECTIVE_CAMERA = {
    yaw: 38,
    pitch: -24,
    zoom: 1,
    panX: 0,
    panY: 0,
};

const GAME_VIEW_CAMERA = {
    yaw: 45,
    pitch: -35.264,
    zoom: 1,
    panX: 0,
    panY: 0,
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

const GAME_NORMALS = [
    { x: 0.526578, y: -0.359621, z: -0.770317 },
    { x: 0.150482, y: 0.435984, z: 0.887284 },
    { x: 0.414195, y: 0.738255, z: -0.532374 },
    { x: 0.075152, y: 0.916249, z: -0.393498 },
    { x: -0.316149, y: 0.930736, z: -0.183793 },
    { x: -0.773819, y: 0.623334, z: -0.11251 },
    { x: -0.900842, y: 0.428537, z: -0.069568 },
    { x: -0.998942, y: -0.010971, z: 0.044665 },
    { x: -0.979761, y: -0.15767, z: -0.123324 },
    { x: -0.911274, y: -0.362371, z: -0.19562 },
    { x: -0.624069, y: -0.720941, z: -0.301301 },
    { x: -0.310173, y: -0.809345, z: -0.498752 },
    { x: 0.146613, y: -0.815819, z: -0.559414 },
    { x: -0.716516, y: -0.694356, z: -0.066888 },
    { x: 0.503972, y: -0.114202, z: -0.856137 },
    { x: 0.455491, y: 0.872627, z: -0.176211 },
    { x: -0.00501, y: -0.114373, z: -0.993425 },
    { x: -0.104675, y: -0.327701, z: -0.938965 },
    { x: 0.560412, y: 0.752589, z: -0.345756 },
    { x: -0.060576, y: 0.821628, z: -0.566796 },
    { x: -0.302341, y: 0.797007, z: -0.522847 },
    { x: -0.671543, y: 0.67074, z: -0.314863 },
    { x: -0.778401, y: -0.128357, z: 0.614505 },
    { x: -0.92405, y: 0.278382, z: -0.261985 },
    { x: -0.699773, y: -0.550491, z: -0.455278 },
    { x: -0.568248, y: -0.517189, z: -0.640008 },
    { x: 0.054098, y: -0.932864, z: -0.356143 },
    { x: 0.758382, y: 0.572893, z: -0.310888 },
    { x: 0.00362, y: 0.305026, z: -0.952337 },
    { x: -0.06085, y: -0.986886, z: -0.149511 },
    { x: 0.63523, y: 0.045478, z: -0.770983 },
    { x: 0.521705, y: 0.241309, z: -0.818287 },
    { x: 0.269404, y: 0.635425, z: -0.723641 },
    { x: 0.045676, y: 0.672754, z: -0.738455 },
    { x: -0.180511, y: 0.674657, z: -0.715719 },
    { x: -0.397131, y: 0.63664, z: -0.661042 },
    { x: -0.552004, y: 0.472515, z: -0.687038 },
    { x: -0.77217, y: 0.08309, z: -0.62996 },
    { x: -0.669819, y: -0.119533, z: -0.73284 },
    { x: -0.540455, y: -0.318444, z: -0.778782 },
    { x: -0.386135, y: -0.522789, z: -0.759994 },
    { x: -0.261466, y: -0.688567, z: -0.676395 },
    { x: -0.019412, y: -0.696103, z: -0.71768 },
    { x: 0.303569, y: -0.481844, z: -0.821993 },
    { x: 0.681939, y: -0.195129, z: -0.7049 },
    { x: -0.244889, y: -0.116562, z: -0.962519 },
    { x: 0.800759, y: -0.022979, z: -0.598546 },
    { x: -0.370275, y: 0.095584, z: -0.923991 },
    { x: -0.330671, y: -0.326578, z: -0.88544 },
    { x: -0.16322, y: -0.527579, z: -0.833679 },
    { x: 0.12639, y: -0.313146, z: -0.941257 },
    { x: 0.349548, y: -0.272226, z: -0.896498 },
    { x: 0.239918, y: -0.085825, z: -0.966992 },
    { x: 0.390845, y: 0.081537, z: -0.916838 },
    { x: 0.255267, y: 0.268697, z: -0.928785 },
    { x: 0.146245, y: 0.480438, z: -0.864749 },
    { x: -0.326016, y: 0.478456, z: -0.815349 },
    { x: -0.469682, y: -0.112519, z: -0.875636 },
    { x: 0.81844, y: -0.25852, z: -0.513151 },
    { x: -0.474318, y: 0.292238, z: -0.830433 },
    { x: 0.778943, y: 0.395842, z: -0.486371 },
    { x: 0.624094, y: 0.393773, z: -0.67487 },
    { x: 0.740886, y: 0.203834, z: -0.639953 },
    { x: 0.480217, y: 0.565768, z: -0.670297 },
    { x: 0.38093, y: 0.424535, z: -0.821378 },
    { x: -0.093422, y: 0.501124, z: -0.860318 },
    { x: -0.236485, y: 0.296198, z: -0.925387 },
    { x: -0.131531, y: 0.093959, z: -0.986849 },
    { x: -0.823562, y: 0.295777, z: -0.484006 },
    { x: 0.611066, y: -0.624304, z: -0.486664 },
    { x: 0.069496, y: -0.52033, z: -0.851133 },
    { x: 0.226522, y: -0.664879, z: -0.711775 },
    { x: 0.471308, y: -0.568904, z: -0.673957 },
    { x: 0.388425, y: -0.742624, z: -0.54556 },
    { x: 0.783675, y: -0.480729, z: -0.393385 },
    { x: 0.962394, y: 0.135676, z: -0.235349 },
    { x: 0.876607, y: 0.172034, z: -0.449406 },
    { x: 0.633405, y: 0.589793, z: -0.500941 },
    { x: 0.182276, y: 0.800658, z: -0.570721 },
    { x: 0.177003, y: 0.764134, z: 0.620297 },
    { x: -0.544016, y: 0.675515, z: -0.497721 },
    { x: -0.679297, y: 0.286467, z: -0.675642 },
    { x: -0.590391, y: 0.091369, z: -0.801929 },
    { x: -0.82436, y: -0.133124, z: -0.550189 },
    { x: -0.715794, y: -0.334542, z: -0.612961 },
    { x: 0.174286, y: -0.892484, z: 0.416049 },
    { x: -0.082528, y: -0.837123, z: -0.540753 },
    { x: 0.283331, y: -0.880874, z: -0.379189 },
    { x: 0.675134, y: -0.426627, z: -0.601817 },
    { x: 0.84372, y: -0.512335, z: -0.160156 },
    { x: 0.977304, y: -0.098556, z: -0.18752 },
    { x: 0.846295, y: 0.522672, z: -0.102947 },
    { x: 0.677141, y: 0.721325, z: -0.145501 },
    { x: 0.320965, y: 0.870892, z: -0.372194 },
    { x: -0.178978, y: 0.911533, z: -0.370236 },
    { x: -0.447169, y: 0.826701, z: -0.341474 },
    { x: -0.703203, y: 0.496328, z: -0.509081 },
    { x: -0.977181, y: 0.063563, z: -0.202674 },
    { x: -0.87817, y: -0.412938, z: 0.241455 },
    { x: -0.835831, y: -0.35855, z: -0.415728 },
    { x: -0.499174, y: -0.693433, z: -0.519592 },
    { x: -0.188789, y: -0.923753, z: -0.333225 },
    { x: 0.192254, y: -0.969361, z: -0.152896 },
    { x: 0.51594, y: -0.783907, z: -0.345392 },
    { x: 0.905925, y: -0.300952, z: -0.297871 },
    { x: 0.991112, y: -0.127746, z: 0.037107 },
    { x: 0.995135, y: 0.098424, z: -0.004383 },
    { x: 0.760123, y: 0.646277, z: 0.067367 },
    { x: 0.205221, y: 0.95958, z: -0.192591 },
    { x: -0.04275, y: 0.979513, z: -0.196791 },
    { x: -0.438017, y: 0.898927, z: 0.008492 },
    { x: -0.821994, y: 0.480785, z: -0.305239 },
    { x: -0.899917, y: 0.08171, z: -0.428337 },
    { x: -0.926612, y: -0.144618, z: -0.347096 },
    { x: -0.79366, y: -0.557792, z: -0.242839 },
    { x: -0.43135, y: -0.847779, z: -0.308558 },
    { x: -0.005492, y: -0.965, z: 0.262193 },
    { x: 0.587905, y: -0.804026, z: -0.08894 },
    { x: 0.699493, y: -0.667686, z: -0.254765 },
    { x: 0.889303, y: 0.359795, z: -0.282291 },
    { x: 0.780972, y: 0.197037, z: 0.592672 },
    { x: 0.520121, y: 0.506696, z: 0.687557 },
    { x: 0.403895, y: 0.693961, z: 0.59606 },
    { x: -0.154983, y: 0.899236, z: 0.40909 },
    { x: -0.657338, y: 0.537168, z: 0.528543 },
    { x: -0.746195, y: 0.334091, z: 0.575827 },
    { x: -0.624952, y: -0.049144, z: 0.779115 },
    { x: 0.318141, y: -0.254715, z: 0.913185 },
    { x: -0.555897, y: 0.405294, z: 0.725752 },
    { x: -0.794434, y: 0.099406, z: 0.59916 },
    { x: -0.640361, y: -0.689463, z: 0.338495 },
    { x: -0.126713, y: -0.734095, z: 0.66712 },
    { x: 0.105457, y: -0.780817, z: 0.615795 },
    { x: 0.407993, y: -0.480916, z: 0.776055 },
    { x: 0.695136, y: -0.54512, z: 0.468647 },
    { x: 0.973191, y: -0.006489, z: 0.229908 },
    { x: 0.946894, y: 0.317509, z: -0.050799 },
    { x: 0.563583, y: 0.825612, z: 0.027183 },
    { x: 0.325773, y: 0.945423, z: 0.006949 },
    { x: -0.171821, y: 0.985097, z: -0.007815 },
    { x: -0.670441, y: 0.739939, z: 0.054769 },
    { x: -0.822981, y: 0.554962, z: 0.121322 },
    { x: -0.966193, y: 0.117857, z: 0.229307 },
    { x: -0.953769, y: -0.294704, z: 0.058945 },
    { x: -0.864387, y: -0.502728, z: -0.010015 },
    { x: -0.530609, y: -0.842006, z: -0.097366 },
    { x: -0.162618, y: -0.984075, z: 0.071772 },
    { x: 0.081447, y: -0.996011, z: 0.036439 },
    { x: 0.745984, y: -0.665963, z: 0.000762 },
    { x: 0.942057, y: -0.329269, z: -0.064106 },
    { x: 0.939702, y: -0.28109, z: 0.194803 },
    { x: 0.771214, y: 0.55067, z: 0.319363 },
    { x: 0.641348, y: 0.73069, z: 0.234021 },
    { x: 0.080682, y: 0.996691, z: 0.009879 },
    { x: -0.046725, y: 0.976643, z: 0.209725 },
    { x: -0.531076, y: 0.821001, z: 0.209562 },
    { x: -0.695815, y: 0.65599, z: 0.292435 },
    { x: -0.976122, y: 0.216709, z: -0.014913 },
    { x: -0.961661, y: -0.144129, z: 0.233314 },
    { x: -0.772084, y: -0.613647, z: 0.165299 },
    { x: -0.4496, y: -0.83606, z: 0.314426 },
    { x: -0.3927, y: -0.914616, z: 0.096247 },
    { x: 0.390589, y: -0.91947, z: 0.04489 },
    { x: 0.582529, y: -0.799198, z: 0.148127 },
    { x: 0.866431, y: -0.489812, z: 0.096864 },
    { x: 0.904587, y: 0.111498, z: 0.41145 },
    { x: 0.953537, y: 0.23233, z: 0.191806 },
    { x: 0.497311, y: 0.770803, z: 0.398177 },
    { x: 0.194066, y: 0.95632, z: 0.218611 },
    { x: 0.422876, y: 0.882276, z: 0.206797 },
    { x: -0.373797, y: 0.849566, z: 0.372174 },
    { x: -0.534497, y: 0.714023, z: 0.4522 },
    { x: -0.881827, y: 0.23716, z: 0.407598 },
    { x: -0.904948, y: -0.014069, z: 0.425289 },
    { x: -0.751827, y: -0.512817, z: 0.414458 },
    { x: -0.501015, y: -0.697917, z: 0.511758 },
    { x: -0.23519, y: -0.925923, z: 0.295555 },
    { x: 0.228983, y: -0.95394, z: 0.193819 },
    { x: 0.734025, y: -0.634898, z: 0.241062 },
    { x: 0.913753, y: -0.063253, z: -0.401316 },
    { x: 0.905735, y: -0.161487, z: 0.391875 },
    { x: 0.85893, y: 0.342446, z: 0.380749 },
    { x: 0.624486, y: 0.607581, z: 0.490777 },
    { x: 0.289264, y: 0.857479, z: 0.425508 },
    { x: 0.069968, y: 0.902169, z: 0.425671 },
    { x: -0.28618, y: 0.9407, z: 0.182165 },
    { x: -0.574013, y: 0.805119, z: -0.149309 },
    { x: 0.111258, y: 0.099718, z: -0.988776 },
    { x: -0.305393, y: -0.944228, z: -0.12316 },
    { x: -0.601166, y: -0.789576, z: 0.123163 },
    { x: -0.290645, y: -0.81214, z: 0.505919 },
    { x: -0.06492, y: -0.877163, z: 0.475785 },
    { x: 0.408301, y: -0.862216, z: 0.299789 },
    { x: 0.566097, y: -0.725566, z: 0.391264 },
    { x: 0.839364, y: -0.427387, z: 0.335869 },
    { x: 0.8189, y: -0.041305, z: 0.572448 },
    { x: 0.719784, y: 0.414997, z: 0.556497 },
    { x: 0.881744, y: 0.45027, z: 0.140659 },
    { x: 0.401823, y: -0.89822, z: -0.178152 },
    { x: -0.05402, y: 0.791344, z: 0.60898 },
    { x: -0.293774, y: 0.763994, z: 0.574465 },
    { x: -0.450798, y: 0.610347, z: 0.651351 },
    { x: -0.638221, y: 0.186694, z: 0.746873 },
    { x: -0.87287, y: -0.257127, z: 0.414708 },
    { x: -0.587257, y: -0.52171, z: 0.618828 },
    { x: -0.353658, y: -0.641974, z: 0.680291 },
    { x: 0.041649, y: -0.611273, z: 0.790323 },
    { x: 0.348342, y: -0.779183, z: 0.521087 },
    { x: 0.499167, y: -0.622441, z: 0.602826 },
    { x: 0.790019, y: -0.303831, z: 0.5325 },
    { x: 0.660118, y: 0.060733, z: 0.748702 },
    { x: 0.604921, y: 0.294161, z: 0.73996 },
    { x: 0.385697, y: 0.379346, z: 0.841032 },
    { x: 0.239693, y: 0.207876, z: 0.948332 },
    { x: 0.012623, y: 0.258532, z: 0.96592 },
    { x: -0.100557, y: 0.457147, z: 0.883688 },
    { x: 0.046967, y: 0.628588, z: 0.776319 },
    { x: -0.430391, y: -0.445405, z: 0.785097 },
    { x: -0.434291, y: -0.196228, z: 0.879139 },
    { x: -0.256637, y: -0.336867, z: 0.905902 },
    { x: -0.131372, y: -0.15891, z: 0.978514 },
    { x: 0.102379, y: -0.208767, z: 0.972592 },
    { x: 0.195687, y: -0.450129, z: 0.871258 },
    { x: 0.627319, y: -0.423148, z: 0.653771 },
    { x: 0.687439, y: -0.171583, z: 0.705682 },
    { x: 0.27592, y: -0.021255, z: 0.960946 },
    { x: 0.459367, y: 0.157466, z: 0.874178 },
    { x: 0.285395, y: 0.583184, z: 0.760556 },
    { x: -0.812174, y: 0.460303, z: 0.358461 },
    { x: -0.189068, y: 0.641223, z: 0.743698 },
    { x: -0.338875, y: 0.47648, z: 0.811252 },
    { x: -0.920994, y: 0.347186, z: 0.176727 },
    { x: 0.040639, y: 0.024465, z: 0.998874 },
    { x: -0.739132, y: -0.353747, z: 0.57319 },
    { x: -0.603512, y: -0.286615, z: 0.74406 },
    { x: -0.188676, y: -0.547059, z: 0.815554 },
    { x: -0.026045, y: -0.39782, z: 0.917094 },
    { x: 0.267897, y: -0.649041, z: 0.712023 },
    { x: 0.518246, y: -0.284891, z: 0.806386 },
    { x: 0.493451, y: -0.066533, z: 0.867225 },
    { x: -0.328188, y: 0.140251, z: 0.934143 },
    { x: -0.328188, y: 0.140251, z: 0.934143 },
    { x: -0.328188, y: 0.140251, z: 0.934143 },
    { x: -0.328188, y: 0.140251, z: 0.934143 },
    { x: -0.328188, y: 0.140251, z: 0.934143 },
    { x: 0, y: 0, z: 1 },
    { x: 0, y: 0, z: 1 },
    { x: 0, y: 0, z: 1 },
    { x: 0, y: 0, z: 1 },
    { x: 0, y: 0, z: 1 },
    { x: 0, y: 0, z: 1 },
    { x: 0, y: 0, z: 1 },
    { x: 0, y: 0, z: 1 },
    { x: 0, y: 0, z: 1 },
    { x: 0, y: 0, z: 1 },
    { x: 0, y: 0, z: 1 },
];

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
        renderMode: 'slice',
        cameraYaw: DEFAULT_PERSPECTIVE_CAMERA.yaw,
        cameraPitch: DEFAULT_PERSPECTIVE_CAMERA.pitch,
        cameraZoom: DEFAULT_PERSPECTIVE_CAMERA.zoom,
        cameraPanX: DEFAULT_PERSPECTIVE_CAMERA.panX,
        cameraPanY: DEFAULT_PERSPECTIVE_CAMERA.panY,
    };
}

export function resetVoxelCamera(state: VoxelPreviewState, mode: VoxelRenderMode = state.renderMode): void {
    const preset = mode === 'game' ? GAME_VIEW_CAMERA : DEFAULT_PERSPECTIVE_CAMERA;
    state.cameraYaw = preset.yaw;
    state.cameraPitch = preset.pitch;
    state.cameraZoom = preset.zoom;
    state.cameraPanX = preset.panX;
    state.cameraPanY = preset.panY;
}

function escapeHtml(value: string): string {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
}
