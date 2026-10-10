import { deflateSync } from 'zlib';
import { crc32 } from '../mix/core/crc32';
import { checkedPixels } from './binary-reader';

/** Small deterministic PNG encoder for editor decorations and hover thumbnails. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
    if (rgba.length !== checkedPixels(width, height) * 4) {
        throw new Error('Invalid thumbnail pixels.');
    }
    const chunk = (name: string, payload: Uint8Array): Buffer => {
        const output = Buffer.alloc(payload.length + 12);
        output.writeUInt32BE(payload.length, 0);
        output.write(name, 4, 'ascii');
        output.set(payload, 8);
        output.writeUInt32BE(crc32(output.subarray(4, payload.length + 8)), payload.length + 8);
        return output;
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = 6;
    const rows = Buffer.alloc(height * (width * 4 + 1));
    for (let y = 0; y < height; y++) {
        rows.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
    }
    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk('IHDR', header),
        chunk('IDAT', deflateSync(rows)),
        chunk('IEND', new Uint8Array()),
    ]);
}
