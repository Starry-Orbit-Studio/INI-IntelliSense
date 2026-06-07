import { RgbaImagePreview } from './preview-types';

interface PcxHeader {
    manufacturer: number;
    version: number;
    encoding: number;
    bitsPerPixel: number;
    xmin: number;
    ymin: number;
    xmax: number;
    ymax: number;
    palette: Uint8Array;
    colorPlanes: number;
    bytesPerLine: number;
}

export function createPcxPreview(bytes: Uint8Array, title: string): RgbaImagePreview {
    if (bytes.byteLength < 128) {
        throw new Error('Invalid PCX file: header is too small.');
    }

    const header = readHeader(bytes);
    if (header.manufacturer !== 10) {
        throw new Error('Invalid PCX file: unsupported manufacturer.');
    }

    const width = header.xmax - header.xmin + 1;
    const height = header.ymax - header.ymin + 1;
    if (width <= 0 || height <= 0) {
        throw new Error('Invalid PCX file: invalid dimensions.');
    }

    if (header.bitsPerPixel === 8 && header.colorPlanes === 1) {
        return {
            kind: 'rgba-image',
            title,
            width,
            height,
            pixels: decodeIndexedPcx(bytes, header, width, height),
        };
    }

    if (header.bitsPerPixel === 8 && header.colorPlanes === 3) {
        return {
            kind: 'rgba-image',
            title,
            width,
            height,
            pixels: decodeRgbPcx(bytes, header, width, height),
        };
    }

    throw new Error('Unsupported PCX format.');
}

function readHeader(bytes: Uint8Array): PcxHeader {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return {
        manufacturer: bytes[0],
        version: bytes[1],
        encoding: bytes[2],
        bitsPerPixel: bytes[3],
        xmin: view.getUint16(4, true),
        ymin: view.getUint16(6, true),
        xmax: view.getUint16(8, true),
        ymax: view.getUint16(10, true),
        palette: bytes.slice(16, 64),
        colorPlanes: bytes[65],
        bytesPerLine: view.getUint16(66, true),
    };
}

function decodeIndexedPcx(bytes: Uint8Array, header: PcxHeader, width: number, height: number): Uint8ClampedArray {
    const palette = readIndexedPalette(bytes, header);
    const decoded = decodeRle(bytes.slice(128), header.bytesPerLine * height);
    const pixels = new Uint8ClampedArray(width * height * 4);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const value = decoded[y * header.bytesPerLine + x];
            const dst = (y * width + x) * 4;
            pixels[dst] = palette[value * 3];
            pixels[dst + 1] = palette[value * 3 + 1];
            pixels[dst + 2] = palette[value * 3 + 2];
            pixels[dst + 3] = 255;
        }
    }

    return pixels;
}

function readIndexedPalette(bytes: Uint8Array, header: PcxHeader): Uint8Array {
    if (bytes.byteLength > 769 && bytes[bytes.byteLength - 769] === 12) {
        return bytes.slice(bytes.byteLength - 768);
    }

    const palette = new Uint8Array(768);
    for (let i = 0; i < 16; i++) {
        palette[i * 3] = header.palette[i * 3];
        palette[i * 3 + 1] = header.palette[i * 3 + 1];
        palette[i * 3 + 2] = header.palette[i * 3 + 2];
    }
    return palette;
}

function decodeRgbPcx(bytes: Uint8Array, header: PcxHeader, width: number, height: number): Uint8ClampedArray {
    const planeSize = header.bytesPerLine * height;
    const decoded = decodeRle(bytes.slice(128), planeSize * 3);
    const pixels = new Uint8ClampedArray(width * height * 4);

    const rOffset = 0;
    const gOffset = planeSize;
    const bOffset = planeSize * 2;

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const src = y * header.bytesPerLine + x;
            const dst = (y * width + x) * 4;
            pixels[dst] = decoded[rOffset + src];
            pixels[dst + 1] = decoded[gOffset + src];
            pixels[dst + 2] = decoded[bOffset + src];
            pixels[dst + 3] = 255;
        }
    }

    return pixels;
}

function decodeRle(bytes: Uint8Array, expectedLength: number): Uint8Array {
    const output = new Uint8Array(expectedLength);
    let src = 0;
    let dst = 0;

    while (src < bytes.length && dst < expectedLength) {
        const value = bytes[src++];
        if ((value & 0xc0) === 0xc0) {
            const count = value & 0x3f;
            if (src >= bytes.length) {
                break;
            }
            const repeated = bytes[src++];
            output.fill(repeated, dst, Math.min(dst + count, expectedLength));
            dst += count;
            continue;
        }

        output[dst++] = value;
    }

    return output;
}
