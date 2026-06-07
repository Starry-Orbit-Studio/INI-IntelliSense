import * as path from 'path';
import * as vscode from 'vscode';
import { PreviewContext } from './preview-context';
import { HtmlPreview, RgbaImagePreview } from './preview-types';
import { PaletteColor } from './palette-utils';

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

export async function createVxlPreview(
    uri: vscode.Uri,
    bytes: Uint8Array,
    title: string,
    previewContext: PreviewContext
): Promise<RgbaImagePreview | HtmlPreview> {
    const model = parseVxl(bytes);
    if (model.limbCount === 0 || model.tailers.length === 0) {
        throw new Error('Invalid VXL file: no limbs found.');
    }

    const paletteSelection = await resolveVoxelPalette(uri, previewContext);
    const firstLimbTailer = model.tailers[0];
    const viewType = 'top';
    const sliceIndex = Math.max(0, Math.floor(firstLimbTailer.sizeZ / 2));
    const image = generateSliceImage(model, 0, sliceIndex, viewType, paletteSelection.colors);

    return {
        kind: 'rgba-image',
        title,
        width: image.width,
        height: image.height,
        pixels: image.pixels,
        description: `${model.headers[0]?.name || 'Limb 0'} preview`,
        details: [
            `Limbs ${model.limbCount}`,
            `Size ${firstLimbTailer.sizeX} x ${firstLimbTailer.sizeY} x ${firstLimbTailer.sizeZ}`,
            `Slice ${sliceIndex + 1}/${firstLimbTailer.sizeZ}`,
            `Palette ${paletteSelection.label}`,
            `Remap ${model.remapStart}-${model.remapEnd}`,
        ],
        pixelated: true,
    };
}

export async function createHvaPreview(
    uri: vscode.Uri,
    bytes: Uint8Array,
    title: string,
    previewContext: PreviewContext
): Promise<RgbaImagePreview | HtmlPreview> {
    const info = parseHva(bytes);
    const vxlBytes = await previewContext.readSiblingBytes(uri, `${path.posix.basename(uri.path, '.hva')}.vxl`);
    if (!vxlBytes) {
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

    const vxlTitle = `${title} (${localizeFrame(info.frameCount)})`;
    const preview = await createVxlPreview(uri.with({ path: replaceLeafExtension(uri.path, '.vxl') }), vxlBytes, vxlTitle, previewContext);
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
    const bodySize = view.getUint32(24, true);
    const remapStart = bytes[28];
    const remapEnd = bytes[29];

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
        const tailerView = new DataView(bytes.buffer, bytes.byteOffset + tailerStart + i * 92, 92);
        tailers.push({
            sizeX: bytes[tailerStart + i * 92 + 88],
            sizeY: bytes[tailerStart + i * 92 + 89],
            sizeZ: bytes[tailerStart + i * 92 + 90],
        });
        void tailerView;
    }

    const bodyData: SpanData[][] = [];
    for (let i = 0; i < limbCount; i++) {
        const tailerOffset = tailerStart + i * 92;
        const spanStartOffset = view.getUint32(tailerOffset, true);
        const spanEndOffset = view.getUint32(tailerOffset + 4, true);
        const spanDataOffset = view.getUint32(tailerOffset + 8, true);
        const tailer = tailers[i];
        const spanCount = tailer.sizeX * tailer.sizeY;
        const spanStarts: number[] = [];
        const spanEnds: number[] = [];

        for (let j = 0; j < spanCount; j++) {
            spanStarts.push(view.getUint32(bodyStart + spanStartOffset + j * 4, true));
            spanEnds.push(view.getUint32(bodyStart + spanEndOffset + j * 4, true));
        }

        const spans: SpanData[] = [];
        for (let j = 0; j < spanCount; j++) {
            const voxels = Array.from({ length: tailer.sizeZ }, () => ({ color: 0, normal: 0 }));
            if (spanStarts[j] !== 0xffffffff && spanEnds[j] !== 0xffffffff) {
                let cursor = bodyStart + spanDataOffset + spanStarts[j];
                const end = bodyStart + spanDataOffset + spanEnds[j];
                let currentVoxelIndex = 0;
                do {
                    const skipCount = bytes[cursor++];
                    const voxelCount = bytes[cursor++];
                    currentVoxelIndex += skipCount;
                    for (let k = 0; k < voxelCount; k++) {
                        voxels[currentVoxelIndex + k] = {
                            color: bytes[cursor++],
                            normal: bytes[cursor++],
                        };
                    }
                    currentVoxelIndex += voxelCount;
                    cursor++;
                } while (cursor <= end);
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
    const directPalette = await previewContext.readSiblingBytes(uri, `${path.posix.basename(uri.path, path.posix.extname(uri.path))}.pal`);
    if (directPalette) {
        return {
            label: `${path.posix.basename(uri.path, path.posix.extname(uri.path))}.pal`,
            colors: await previewContext.readPalette(uri.with({ path: replaceLeafExtension(uri.path, '.pal') })),
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
    viewType: 'front' | 'side' | 'top',
    palette: PaletteColor[]
): { width: number; height: number; pixels: Uint8ClampedArray } {
    const tailer = model.tailers[limbIndex];
    const width = viewType === 'front' ? tailer.sizeY : tailer.sizeX;
    const height = viewType === 'top' ? tailer.sizeY : tailer.sizeZ;
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

function voxelRh(model: VxlModel, limbIndex: number, x: number, y: number, z: number): Voxel {
    const tailer = model.tailers[limbIndex];
    if (x < 0 || y < 0 || z < 0 || x >= tailer.sizeX || y >= tailer.sizeY || z >= tailer.sizeZ) {
        return { color: 0, normal: 0 };
    }

    const spanIndex = y * tailer.sizeX + x;
    const span = model.bodyData[limbIndex]?.[spanIndex];
    return span?.voxels[z] ?? { color: 0, normal: 0 };
}

function decodeAscii(bytes: Uint8Array): string {
    return new TextDecoder('latin1').decode(bytes).replace(/\0+$/, '').trim();
}

function escapeHtml(value: string): string {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
}

function replaceLeafExtension(filePath: string, extension: string): string {
    const leaf = path.posix.basename(filePath, path.posix.extname(filePath));
    const index = filePath.lastIndexOf('/');
    const parent = index === -1 ? '' : filePath.slice(0, index + 1);
    return `${parent}${leaf}${extension}`;
}

function localizeFrame(frameCount: number): string {
    return `${frameCount} frame${frameCount === 1 ? '' : 's'}`;
}
