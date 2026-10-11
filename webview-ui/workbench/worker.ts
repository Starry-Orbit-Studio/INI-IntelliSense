import { decodeShpFrame, ShpFile } from '../../src/media/shp';
import { voxelRaster } from '../../src/media/voxel-raster';
import type { MediaPayload } from '../../src/context/workbench-protocol';
import { indexedRaster } from '../../src/media/sprite-raster';
import { ByteCache } from '../../src/media/byte-cache';

let cache = new ByteCache<Uint8Array>(32 * 1024 * 1024);
let bytes = new Uint8Array();
let file: ShpFile;
let palette: number[];
let voxel: Extract<MediaPayload, { kind: 'voxel' }> | undefined;

self.onmessage = (event: MessageEvent) => {
    const message = event.data;
    try {
        if (message.type === 'load-voxel') {
            voxel = message.media;
            return;
        }
        if (message.type === 'voxel' && voxel) {
            const raster = voxelRaster(voxel, message.heading, message.color);
            const rgba = new Uint8ClampedArray(raster.pixels);
            self.postMessage(
                { type: 'frame', id: message.id, ...raster, pixels: undefined, rgba },
                { transfer: [rgba.buffer] }
            );
            return;
        }
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
        const raster = indexedRaster(
            pixels,
            shadow,
            file,
            palette,
            message.color,
            message.remap !== false,
            !!message.trim
        );
        const output = new Uint8ClampedArray(raster.pixels.buffer);
        const { x, y, width, height } = raster;
        self.postMessage(
            { type: 'frame', id: message.id, frame: message.frame, rgba: output, x, y, width, height },
            { transfer: [output.buffer] }
        );
    } catch (error) {
        self.postMessage({
            type: 'error',
            id: message.id,
            error: error instanceof Error ? error.message : String(error),
        });
    }
};
