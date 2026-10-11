import { decompressLzo } from './lzo';
import { localize } from '../i18n';
import { RgbaImagePreview, TextPreview } from './preview-types';

export function createMapPreview(bytes: Uint8Array, title: string): RgbaImagePreview | TextPreview {
    try {
        const text = decodeMapText(bytes);
        const previewSize = parsePreviewSize(text);
        const packedBase64 = parsePreviewPack(text);
        if (!previewSize || !packedBase64) {
            return {
                kind: 'text',
                title,
                content: localize('preview.map.noPreviewData', 'No preview image found in this map file.'),
            };
        }

        if (
            previewSize.width < 1 ||
            previewSize.height < 1 ||
            previewSize.width * previewSize.height > 16 * 1024 * 1024 ||
            packedBase64.length > 64 * 1024 * 1024
        ) {
            throw new Error('Map preview exceeds the decoding limit.');
        }

        if (packedBase64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(packedBase64)) {
            throw new Error('Invalid map preview base64.');
        }
        const packedBytes = Uint8Array.from(Buffer.from(packedBase64, 'base64'));
        const pixelData = decompressBlocks(packedBytes);
        const expectedLength = previewSize.width * previewSize.height * 3;
        if (pixelData.byteLength !== expectedLength) {
            throw new Error(`Data size mismatch: expected ${expectedLength}, got ${pixelData.byteLength}`);
        }

        const pixels = new Uint8ClampedArray(previewSize.width * previewSize.height * 4);
        for (let i = 0, src = 0; i < pixels.length; i += 4, src += 3) {
            pixels[i] = pixelData[src];
            pixels[i + 1] = pixelData[src + 1] ?? 0;
            pixels[i + 2] = pixelData[src + 2];
            pixels[i + 3] = 255;
        }

        return {
            kind: 'rgba-image',
            title,
            width: previewSize.width,
            height: previewSize.height,
            pixels,
        };
    } catch (error) {
        return {
            kind: 'text',
            title,
            content: localize(
                'preview.error',
                'Failed to load preview: {0}',
                error instanceof Error ? error.message : String(error)
            ),
        };
    }
}

function decodeMapText(bytes: Uint8Array): string {
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
        return new TextDecoder('utf-8').decode(bytes.slice(3));
    }

    try {
        return new TextDecoder('gbk').decode(bytes);
    } catch {
        return new TextDecoder('latin1').decode(bytes);
    }
}

function parsePreviewSize(text: string): { width: number; height: number } | undefined {
    const section = getSection(text, 'Preview');
    if (!section) {
        return undefined;
    }

    const sizeLine = getKeyValue(section, 'Size');
    if (!sizeLine) {
        return undefined;
    }

    const parts = sizeLine.split(',').map((part) => Number(part.trim()));
    if (parts.length !== 4 || parts.some((part) => !Number.isSafeInteger(part))) {
        return undefined;
    }

    return {
        width: parts[2],
        height: parts[3],
    };
}

function parsePreviewPack(text: string): string | undefined {
    const section = getSection(text, 'PreviewPack');
    if (!section) {
        return undefined;
    }

    const lines = section
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
            const match = line.match(/^(\d+)\s*=\s*(.*)$/);
            if (!match) {
                return undefined;
            }
            return {
                key: Number.parseInt(match[1], 10),
                value: match[2].trim(),
            };
        })
        .filter((item): item is { key: number; value: string } => item !== undefined)
        .sort((left, right) => left.key - right.key);

    if (lines.length === 0) {
        return undefined;
    }

    return lines.map((line) => line.value).join('');
}

function getSection(text: string, name: string): string | undefined {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = text.match(new RegExp(`\\[${escaped}\\]([\\s\\S]*?)(?=\\n\\[[^\\]]+\\]|$)`, 'i'));
    return match?.[1];
}

function getKeyValue(sectionText: string, key: string): string | undefined {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = sectionText.match(new RegExp(`^\\s*${escaped}\\s*=\\s*(.+)$`, 'im'));
    return match?.[1]?.trim();
}

function decompressBlocks(source: Uint8Array): Uint8Array {
    let offset = 0;
    let expanded = 0;
    const chunks: Uint8Array[] = [];

    while (offset < source.byteLength) {
        if (offset + 4 > source.byteLength) {
            throw new Error('Truncated map preview block header.');
        }
        const view = new DataView(source.buffer, source.byteOffset + offset, 4);
        const inputSize = view.getUint16(0, true);
        const outputSize = view.getUint16(2, true);
        expanded += outputSize;
        if (expanded > 48 * 1024 * 1024) {
            throw new Error('Map preview exceeds the decoding limit.');
        }
        const block = source.slice(offset + 4, offset + 4 + inputSize);
        if (!inputSize || !outputSize || block.byteLength !== inputSize) {
            throw new Error('Truncated or empty map preview block.');
        }

        chunks.push(decompressLzo(block, outputSize));
        offset += 4 + inputSize;
    }

    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const result = new Uint8Array(totalLength);
    let cursor = 0;
    for (const chunk of chunks) {
        result.set(chunk, cursor);
        cursor += chunk.byteLength;
    }
    return result;
}
