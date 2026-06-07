import * as path from 'path';
import * as vscode from 'vscode';
import { RgbaImagePreview } from './preview-types';

interface ShpFrameHeader {
    x: number;
    y: number;
    width: number;
    height: number;
    flags: number;
    offset: number;
}

export async function createShpPreview(uri: vscode.Uri, bytes: Uint8Array, title: string): Promise<RgbaImagePreview> {
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
    const palette = await resolvePalette(uri);
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
            pixels[dst] = color[0];
            pixels[dst + 1] = color[1];
            pixels[dst + 2] = color[2];
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
        description: `${frameCount} frame(s), canvas ${width} x ${height}${palette ? '' : ', grayscale fallback'}`,
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

async function resolvePalette(uri: vscode.Uri): Promise<Array<[number, number, number]> | undefined> {
    const candidates = buildPaletteCandidates(uri);
    for (const candidate of candidates) {
        try {
            const bytes = await vscode.workspace.fs.readFile(candidate);
            if (bytes.byteLength < 0x300) {
                continue;
            }
            return readPalette(bytes);
        } catch {
            continue;
        }
    }
    return undefined;
}

function buildPaletteCandidates(uri: vscode.Uri): vscode.Uri[] {
    const extless = uri.path.slice(0, -path.extname(uri.path).length);
    const parent = uri.path.substring(0, uri.path.lastIndexOf('/')) || '/';
    const names = [
        `${path.posix.basename(extless)}.pal`,
        'unittem.pal',
        'temperat.pal',
        'cameo.pal',
        'palette.pal',
    ];

    return names.map(name => uri.with({ path: `${parent}/${name}` }));
}

function readPalette(bytes: Uint8Array): Array<[number, number, number]> {
    const colors: Array<[number, number, number]> = [];
    for (let i = 0; i < 256; i++) {
        colors.push([
            (bytes[i * 3] ?? 0) * 4,
            (bytes[i * 3 + 1] ?? 0) * 4,
            (bytes[i * 3 + 2] ?? 0) * 4,
        ]);
    }
    return colors;
}
