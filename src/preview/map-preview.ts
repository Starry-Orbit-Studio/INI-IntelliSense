import { RgbaImagePreview } from './preview-types';

export function createMapPreview(bytes: Uint8Array, title: string): RgbaImagePreview {
    const text = decodeMapText(bytes);
    const previewSize = parsePreviewSize(text);
    const packedBase64 = parsePreviewPack(text);
    if (!previewSize || !packedBase64) {
        throw new Error('Map preview data not found.');
    }

    const packedBytes = Uint8Array.from(Buffer.from(packedBase64, 'base64'));
    const pixelData = decompressBlocks(packedBytes);
    const expectedLength = previewSize.width * previewSize.height * 3;
    if (pixelData.byteLength !== expectedLength) {
        throw new Error('Invalid map preview data size.');
    }

    const pixels = new Uint8ClampedArray(previewSize.width * previewSize.height * 4);
    for (let i = 0, src = 0; i < pixels.length; i += 4, src += 3) {
        pixels[i] = pixelData[src + 2] ?? 0;
        pixels[i + 1] = pixelData[src + 1] ?? 0;
        pixels[i + 2] = pixelData[src] ?? 0;
        pixels[i + 3] = 255;
    }

    return {
        kind: 'rgba-image',
        title,
        width: previewSize.width,
        height: previewSize.height,
        pixels,
    };
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

    const parts = sizeLine.split(',').map(part => Number.parseInt(part.trim(), 10));
    if (parts.length < 4 || parts.some(Number.isNaN)) {
        return undefined;
    }

    return {
        width: parts[2] - parts[0],
        height: parts[3] - parts[1],
    };
}

function parsePreviewPack(text: string): string | undefined {
    const section = getSection(text, 'PreviewPack');
    if (!section) {
        return undefined;
    }

    const lines = section
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => {
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

    return lines.map(line => line.value).join('');
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
    const chunks: Uint8Array[] = [];

    while (offset + 4 <= source.byteLength) {
        const view = new DataView(source.buffer, source.byteOffset + offset, 4);
        const inputSize = view.getUint16(0, true);
        const outputSize = view.getUint16(2, true);
        const block = source.slice(offset + 4, offset + 4 + inputSize);
        if (block.byteLength !== inputSize) {
            break;
        }

        chunks.push(decompressLzoBlock(block, outputSize));
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

function decompressLzoBlock(block: Uint8Array, outputSize: number): Uint8Array {
    const output = new Uint8Array(outputSize);
    let ip = 0;
    let op = 0;
    let t = block[ip++];

    if (t > 17) {
        t -= 17;
        while (t-- > 0 && ip < block.length && op < output.length) {
            output[op++] = block[ip++];
        }
        t = block[ip++];
    }

    while (true) {
        if (t < 16) {
            if (t === 0) {
                while (ip < block.length && block[ip] === 0) {
                    t += 255;
                    ip++;
                }
                if (ip >= block.length) {
                    break;
                }
                t += 15 + block[ip++];
            }
            t += 3;
            while (t-- > 0 && ip < block.length && op < output.length) {
                output[op++] = block[ip++];
            }
            if (ip >= block.length) {
                break;
            }
            t = block[ip++];
            if (t < 16) {
                const mPos = op - 0x801 - (t >> 2) - (block[ip++] << 2);
                if (mPos < 0) {
                    break;
                }
                output[op++] = output[mPos];
                output[op++] = output[mPos + 1];
                output[op++] = output[mPos + 2];
                if ((t & 3) === 0) {
                    t = block[ip - 2] & 3;
                    if (ip >= block.length) {
                        break;
                    }
                    t = block[ip++];
                } else {
                    t &= 3;
                }
                continue;
            }
        }

        let mPos: number;
        let length: number;
        if (t >= 64) {
            mPos = op - 1 - ((t >> 2) & 7) - (block[ip++] << 3);
            length = (t >> 5) - 1;
        } else if (t >= 32) {
            length = t & 31;
            if (length === 0) {
                while (ip < block.length && block[ip] === 0) {
                    length += 255;
                    ip++;
                }
                if (ip >= block.length) {
                    break;
                }
                length += 31 + block[ip++];
            }
            mPos = op - 1 - (block[ip] >> 2) - (block[ip + 1] << 6);
            ip += 2;
        } else {
            mPos = op - 1 - (t >> 2) - (block[ip++] << 2);
            length = 0;
        }

        if (mPos < 0) {
            break;
        }

        if (t >= 16) {
            mPos -= 0x4000;
            length = (t & 7) + 2;
            if (mPos === op) {
                break;
            }
        }

        while (length-- >= 0 && op < output.length) {
            output[op] = output[mPos];
            op++;
            mPos++;
        }

        if (ip >= block.length) {
            break;
        }
        t = block[ip++];
    }

    return output;
}
