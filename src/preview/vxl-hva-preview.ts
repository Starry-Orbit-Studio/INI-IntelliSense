import * as path from 'path';
import * as vscode from 'vscode';
import { PreviewContext } from './preview-context';
import { HtmlPreview, RgbaImagePreview } from './preview-types';
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
}

export interface VoxelPreviewModel extends RgbaImagePreview {
    sliceIndex: number;
    sliceCount: number;
    viewType: VoxelViewType;
    limbIndex: number;
    limbCount: number;
    renderMode: VoxelRenderMode;
}

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
    const tailer = model.tailers[limbIndex];
    const sliceCount = getSliceCount(tailer, state.viewType);
    const sliceIndex = clamp(state.sliceIndex, 0, Math.max(0, sliceCount - 1));
    const paletteSelection = paletteUri
        ? {
            uri: paletteUri,
            label: path.posix.basename(paletteUri.path),
            colors: await previewContext.readPalette(paletteUri),
        }
        : await resolveVoxelPalette(uri, previewContext);

    const image = state.renderMode === 'game'
        ? generateGameViewImage(model, limbIndex, paletteSelection.colors)
        : state.renderMode === 'perspective'
            ? generatePerspectiveImage(model, limbIndex, paletteSelection.colors)
            : generateSliceImage(model, limbIndex, sliceIndex, state.viewType, paletteSelection.colors);
    return {
        kind: 'rgba-image',
        title,
        width: image.width,
        height: image.height,
        pixels: image.pixels,
        description: `${model.headers[limbIndex]?.name || `Limb ${limbIndex + 1}`} preview`,
        details: [
            `Signature ${model.signature}`,
            `Limbs ${model.limbCount}`,
            `Size ${tailer.sizeX} x ${tailer.sizeY} x ${tailer.sizeZ}`,
            `Palette ${paletteSelection.label}`,
            `Remap ${model.remapStart}-${model.remapEnd}`,
        ],
        pixelated: true,
        sliceIndex,
        sliceCount: state.renderMode === 'slice' ? sliceCount : 1,
        viewType: state.viewType,
        limbIndex,
        limbCount: model.limbCount,
        renderMode: state.renderMode,
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
    if (preview.kind === 'rgba-image') {
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

function generateSliceImage(
    model: VxlModel,
    limbIndex: number,
    sliceIndex: number,
    viewType: VoxelViewType,
    palette: PaletteColor[]
): { width: number; height: number; pixels: Uint8ClampedArray } {
    const tailer = model.tailers[limbIndex];
    let width = 0;
    let height = 0;
    switch (viewType) {
        case 'front':
            width = tailer.sizeY;
            height = tailer.sizeZ;
            break;
        case 'side':
            width = tailer.sizeX;
            height = tailer.sizeZ;
            break;
        case 'top':
            width = tailer.sizeX;
            height = tailer.sizeY;
            break;
    }

    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const voxel = viewType === 'front'
                ? voxelRh(model, limbIndex, sliceIndex, x, tailer.sizeZ - 1 - y)
                : viewType === 'side'
                    ? voxelRh(model, limbIndex, x, sliceIndex, tailer.sizeZ - 1 - y)
                    : voxelRh(model, limbIndex, x, tailer.sizeY - 1 - y, sliceIndex);
            const dst = (y * width + x) * 4;
            if (voxel.color === 0) {
                pixels[dst + 3] = 0;
                continue;
            }

            const color = palette[voxel.color];
            pixels[dst] = color?.r ?? voxel.color;
            pixels[dst + 1] = color?.g ?? voxel.color;
            pixels[dst + 2] = color?.b ?? voxel.color;
            pixels[dst + 3] = 255;
        }
    }

    return { width, height, pixels };
}

function generateGameViewImage(
    model: VxlModel,
    limbIndex: number,
    palette: PaletteColor[]
): { width: number; height: number; pixels: Uint8ClampedArray } {
    const tailer = model.tailers[limbIndex];
    const width = 512;
    const height = 512;
    const pixels = new Uint8ClampedArray(width * height * 4);
    const depthBuffer = new Float32Array(width * height);
    depthBuffer.fill(Number.POSITIVE_INFINITY);

    const zoom = Math.max(4, Math.floor(240 / Math.max(tailer.sizeX, tailer.sizeY, tailer.sizeZ, 1)));
    const centerX = width / 2;
    const centerY = height / 2;

    const pitch = degToRad(-35.264);
    const yaw = degToRad(45.0);
    const lightDirection = normalize3({ x: -0.8, y: 1.2, z: 0.6 });
    const ambient = 0.42;
    const diffuseStrength = 0.58;

    for (let z = 0; z < tailer.sizeX; z++) {
        for (let y = 0; y < tailer.sizeZ; y++) {
            for (let x = 0; x < tailer.sizeY; x++) {
                const voxel = voxelLh(model, limbIndex, x, y, z);
                if (voxel.color === 0) {
                    continue;
                }

                const localX = x - tailer.sizeY / 2;
                const localY = y - tailer.sizeZ / 2;
                const localZ = z - tailer.sizeX / 2;
                const rotated = rotateY(rotateX({ x: localX, y: localY, z: localZ }, pitch), yaw);
                const screenX = rotated.x * zoom + centerX;
                const screenY = -rotated.y * zoom + centerY;
                const depth = rotated.z;

                const shade = computeApproximateShade(voxel.normal, lightDirection, ambient, diffuseStrength);
                const base = palette[voxel.color] ?? { r: voxel.color, g: voxel.color, b: voxel.color };
                const color = {
                    r: clamp255(Math.round(base.r * shade)),
                    g: clamp255(Math.round(base.g * shade)),
                    b: clamp255(Math.round(base.b * shade)),
                };

                drawBlock(pixels, depthBuffer, width, height, screenX, screenY, depth, Math.max(1, zoom), color);
            }
        }
    }

    return { width, height, pixels };
}

function generatePerspectiveImage(
    model: VxlModel,
    limbIndex: number,
    palette: PaletteColor[]
): { width: number; height: number; pixels: Uint8ClampedArray } {
    const tailer = model.tailers[limbIndex];
    const width = 512;
    const height = 512;
    const pixels = new Uint8ClampedArray(width * height * 4);
    const depthBuffer = new Float32Array(width * height);
    depthBuffer.fill(Number.POSITIVE_INFINITY);

    const distance = Math.max(tailer.sizeX, tailer.sizeY, tailer.sizeZ) * 2.6 + 8;
    const fov = degToRad(50);
    const focal = (height * 0.5) / Math.tan(fov * 0.5);
    const centerX = width / 2;
    const centerY = height / 2;
    const pitch = degToRad(-28);
    const yaw = degToRad(35);
    const lightDirection = normalize3({ x: -0.7, y: 1.0, z: 0.4 });

    for (let z = 0; z < tailer.sizeX; z++) {
        for (let y = 0; y < tailer.sizeZ; y++) {
            for (let x = 0; x < tailer.sizeY; x++) {
                const voxel = voxelLh(model, limbIndex, x, y, z);
                if (voxel.color === 0) {
                    continue;
                }

                const localX = x - tailer.sizeY / 2;
                const localY = y - tailer.sizeZ / 2;
                const localZ = z - tailer.sizeX / 2;
                const rotated = rotateY(rotateX({ x: localX, y: localY, z: localZ }, pitch), yaw);
                const cameraZ = rotated.z + distance;
                if (cameraZ <= 0.01) {
                    continue;
                }

                const perspectiveScale = focal / cameraZ;
                const screenX = rotated.x * perspectiveScale + centerX;
                const screenY = -rotated.y * perspectiveScale + centerY;
                const shade = computeApproximateShade(voxel.normal, lightDirection, 0.35, 0.65);
                const base = palette[voxel.color] ?? { r: voxel.color, g: voxel.color, b: voxel.color };
                const color = {
                    r: clamp255(Math.round(base.r * shade)),
                    g: clamp255(Math.round(base.g * shade)),
                    b: clamp255(Math.round(base.b * shade)),
                };
                const blockSize = Math.max(1, Math.round(perspectiveScale));
                drawBlock(pixels, depthBuffer, width, height, screenX, screenY, cameraZ, blockSize, color);
            }
        }
    }

    return { width, height, pixels };
}

function drawBlock(
    pixels: Uint8ClampedArray,
    depthBuffer: Float32Array,
    width: number,
    height: number,
    screenX: number,
    screenY: number,
    depth: number,
    blockSize: number,
    color: { r: number; g: number; b: number }
): void {
    const centerX = Math.round(screenX);
    const centerY = Math.round(screenY);
    const half = Math.floor(blockSize / 2);

    for (let py = 0; py < blockSize; py++) {
        const y = centerY - half + py;
        if (y < 0 || y >= height) {
            continue;
        }
        for (let px = 0; px < blockSize; px++) {
            const x = centerX - half + px;
            if (x < 0 || x >= width) {
                continue;
            }
            const index = y * width + x;
            if (depth >= depthBuffer[index]) {
                continue;
            }
            depthBuffer[index] = depth;
            const dst = index * 4;
            pixels[dst] = color.r;
            pixels[dst + 1] = color.g;
            pixels[dst + 2] = color.b;
            pixels[dst + 3] = 255;
        }
    }
}

function voxelLh(model: VxlModel, limbIndex: number, x: number, y: number, z: number): Voxel {
    return voxelRh(model, limbIndex, z, x, y);
}

function computeApproximateShade(normalIndex: number, lightDirection: Vec3, ambient: number, diffuseStrength: number): number {
    const normal = voxelNormalApprox(normalIndex);
    const diffuse = Math.max(0, dot3(normal, lightDirection));
    return ambient + diffuse * diffuseStrength;
}

type Vec3 = { x: number; y: number; z: number };

function rotateX(vector: Vec3, angle: number): Vec3 {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return {
        x: vector.x,
        y: vector.y * c - vector.z * s,
        z: vector.y * s + vector.z * c,
    };
}

function rotateY(vector: Vec3, angle: number): Vec3 {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return {
        x: vector.x * c + vector.z * s,
        y: vector.y,
        z: -vector.x * s + vector.z * c,
    };
}

function normalize3(vector: Vec3): Vec3 {
    const length = Math.hypot(vector.x, vector.y, vector.z) || 1;
    return {
        x: vector.x / length,
        y: vector.y / length,
        z: vector.z / length,
    };
}

function dot3(a: Vec3, b: Vec3): number {
    return a.x * b.x + a.y * b.y + a.z * b.z;
}

function voxelNormalApprox(normalIndex: number): Vec3 {
    const theta = ((normalIndex % 16) / 16) * Math.PI * 2;
    const phi = (Math.floor(normalIndex / 16) / 15) * Math.PI;
    return normalize3({
        x: Math.cos(theta) * Math.sin(phi),
        y: Math.cos(phi),
        z: Math.sin(theta) * Math.sin(phi),
    });
}

function degToRad(value: number): number {
    return value * Math.PI / 180;
}

function clamp255(value: number): number {
    return Math.max(0, Math.min(255, value));
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

function escapeHtml(value: string): string {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
}
