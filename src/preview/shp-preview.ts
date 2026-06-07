import * as path from 'path';
import * as vscode from 'vscode';
import { PreviewContext } from './preview-context';
import { RgbaImagePreview } from './preview-types';
import { PaletteColor } from './palette-utils';

interface ShpFrameHeader {
    x: number;
    y: number;
    width: number;
    height: number;
    flags: number;
    offset: number;
}

export async function createShpPreview(
    uri: vscode.Uri,
    bytes: Uint8Array,
    title: string,
    previewContext: PreviewContext,
    paletteUri?: vscode.Uri
): Promise<RgbaImagePreview> {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.byteLength < 8) {
        throw new Error('Invalid SHP file.');
    }

    const width = view.getUint16(2, true);
    const height = view.getUint16(4, true);
    const frameCount = view.getUint16(6, true);
    if (frameCount <= 0) {
        throw new Error('SHP file contains no frames.');
    }

    const frame = readFrameHeader(bytes, 8);
    const framePixels = decodeFrame(bytes, frame);
    const paletteSelection = paletteUri
        ? {
            uri: paletteUri,
            label: path.posix.basename(paletteUri.path),
            colors: await previewContext.readPalette(paletteUri),
            source: 'manual' as const,
        }
        : await previewContext.resolvePaletteForShp(uri);
    const palette = paletteSelection.colors;
    const pixels = new Uint8ClampedArray(frame.width * frame.height * 4);

    for (let i = 0; i < framePixels.length; i++) {
        const value = framePixels[i];
        const dst = i * 4;
        if (value === 0) {
            pixels[dst + 3] = 0;
            continue;
        }

        const color = palette?.[value];
        if (color) {
            pixels[dst] = color.r;
            pixels[dst + 1] = color.g;
            pixels[dst + 2] = color.b;
        } else {
            pixels[dst] = value;
            pixels[dst + 1] = value;
            pixels[dst + 2] = value;
        }
        pixels[dst + 3] = 255;
    }

    return {
        kind: 'rgba-image',
        title,
        width: frame.width,
        height: frame.height,
        pixels,
        description: `${frameCount} frame(s)`,
        details: [
            `Canvas ${width} x ${height}`,
            `Frame 1 ${frame.width} x ${frame.height}`,
            `Palette ${paletteSelection.label}`,
            paletteSelection.source === 'manual' ? 'Manual palette' : paletteSelection.source === 'fallback' ? 'Fallback palette' : 'Auto palette',
        ],
        pixelated: true,
    };
}

function readFrameHeader(bytes: Uint8Array, offset: number): ShpFrameHeader {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 20);
    return {
        x: view.getUint16(0, true),
        y: view.getUint16(2, true),
        width: view.getUint16(4, true),
        height: view.getUint16(6, true),
        flags: bytes[offset + 8],
        offset: view.getUint32(16, true),
    };
}

function decodeFrame(bytes: Uint8Array, frame: ShpFrameHeader): Uint8Array {
    const output = new Uint8Array(frame.width * frame.height);
    if ((frame.flags & 0x2) === 0) {
        return bytes.slice(frame.offset, frame.offset + output.length);
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let cursor = frame.offset;
    for (let y = 0; y < frame.height; y++) {
        const lineLength = view.getUint16(cursor, true);
        cursor += 2;
        const lineEnd = cursor + Math.max(0, lineLength - 2);
        let x = 0;
        while (cursor < lineEnd && x < frame.width) {
            const value = bytes[cursor++];
            if (value === 0x00) {
                const transparentCount = bytes[cursor++] ?? 0;
                x += transparentCount;
                continue;
            }
            output[y * frame.width + x] = value;
            x++;
        }
    }

    return output;
}
