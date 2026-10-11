import { deflateSync } from 'zlib';
import { crc32 } from '../mix/core/crc32';
import { checkedPixels } from './binary-reader';

function chunk(name: string, payload: Uint8Array): Buffer {
    const output = Buffer.alloc(payload.length + 12);
    output.writeUInt32BE(payload.length, 0);
    output.write(name, 4, 'ascii');
    output.set(payload, 8);
    output.writeUInt32BE(crc32(output.subarray(4, payload.length + 8)), payload.length + 8);
    return output;
}
/** Deterministic PNG/APNG encoder; full-frame replacement keeps transparent margins stable. */
export function encodeAnimatedPng(width: number, height: number, frames: Uint8Array[], delayMs = 100): Uint8Array {
    const length = checkedPixels(width, height) * 4;
    if (
        !frames.length ||
        frames.length > 64 ||
        frames.some((frame) => frame.length !== length) ||
        length * frames.length > 16 * 1024 * 1024
    ) {
        throw new Error('Invalid thumbnail frame budget.');
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = 6;
    const chunks = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header)];
    if (frames.length > 1) {
        const animation = Buffer.alloc(8);
        animation.writeUInt32BE(frames.length);
        chunks.push(chunk('acTL', animation));
    }
    let sequence = 0;
    for (const [index, rgba] of frames.entries()) {
        if (frames.length > 1) {
            const control = Buffer.alloc(26);
            control.writeUInt32BE(sequence++);
            control.writeUInt32BE(width, 4);
            control.writeUInt32BE(height, 8);
            control.writeUInt16BE(Math.max(1, Math.min(65535, Math.round(delayMs))), 20);
            control.writeUInt16BE(1000, 22);
            chunks.push(chunk('fcTL', control));
        }
        const rows = Buffer.alloc(height * (width * 4 + 1));
        for (let y = 0; y < height; y++) {
            rows.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
        }
        const compressed = deflateSync(rows);
        if (!index) {
            chunks.push(chunk('IDAT', compressed));
        } else {
            const data = Buffer.alloc(compressed.length + 4);
            data.writeUInt32BE(sequence++);
            data.set(compressed, 4);
            chunks.push(chunk('fdAT', data));
        }
    }
    chunks.push(chunk('IEND', new Uint8Array()));
    return Buffer.concat(chunks);
}

export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
    return encodeAnimatedPng(width, height, [rgba]);
}
