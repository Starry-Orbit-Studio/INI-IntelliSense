import { decodeShpFrame, ShpFile } from '../../src/media/shp';
import { ByteCache } from '../../src/media/byte-cache';

let cache = new ByteCache<Uint8Array>(32 * 1024 * 1024);
let bytes = new Uint8Array();
let file: ShpFile;
let palette: number[];

self.onmessage = (event: MessageEvent) => {
    const message = event.data;
    try {
        if (message.type === 'load') {
            bytes = message.bytes;
            file = message.file;
            palette = message.palette;
            cache = new ByteCache<Uint8Array>(
                Math.max(1024 * 1024, Math.min(32 * 1024 * 1024, Number(message.cacheBudget) || 32 * 1024 * 1024))
            );
            return;
        }
        if (message.type !== 'frame' || !file) {
            return;
        }
        const indexed = (frame: number) => {
            const key = String(frame);
            let value = cache.get(key);
            if (!value) {
                value = decodeShpFrame(bytes, file, frame);
                cache.set(key, value, value.length);
            }
            return value;
        };
        const pixels = indexed(message.frame);
        const shadowFrame = message.frame + Math.floor(file.frames.length / 2);
        const shadow = message.shadow && shadowFrame < file.frames.length ? indexed(shadowFrame) : undefined;
        const rgba = new Uint8ClampedArray(pixels.length * 4);
        const color = message.color as number[];
        for (let i = 0; i < pixels.length; i++) {
            const value = pixels[i],
                offset = i * 4;
            if (value) {
                if (value >= 16 && value <= 31) {
                    const intensity = 0.28 + ((31 - value) / 15) * 0.72;
                    rgba[offset] = color[0] * intensity;
                    rgba[offset + 1] = color[1] * intensity;
                    rgba[offset + 2] = color[2] * intensity;
                } else {
                    rgba[offset] = palette[value * 3];
                    rgba[offset + 1] = palette[value * 3 + 1];
                    rgba[offset + 2] = palette[value * 3 + 2];
                }
                rgba[offset + 3] = 255;
            } else if (shadow?.[i]) {
                rgba[offset + 3] = 105;
            }
        }
        self.postMessage(
            { type: 'frame', id: message.id, frame: message.frame, rgba, width: file.width, height: file.height },
            { transfer: [rgba.buffer] }
        );
    } catch (error) {
        self.postMessage({
            type: 'error',
            id: message.id,
            error: error instanceof Error ? error.message : String(error),
        });
    }
};
