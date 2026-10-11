import { decodeShpFrame, ShpFile } from './shp';
import { DEFAULT_HOUSE_COLOR } from './render-defaults';

export interface RasterRect {
    x: number;
    y: number;
    width: number;
    height: number;
}
export interface Raster extends RasterRect {
    pixels: Uint8Array;
}

const boundsCache = new WeakMap<ShpFile, RasterRect>();

/** Union all authored frame rectangles once; empty frames do not enlarge the canvas. */
export function spriteBounds(file: ShpFile): RasterRect {
    const cached = boundsCache.get(file);
    if (cached) {
        return { ...cached };
    }
    const frames = file.frames.filter((frame) => frame.offset && frame.width && frame.height);
    const x = frames.length ? Math.min(...frames.map((frame) => frame.x)) : 0;
    const y = frames.length ? Math.min(...frames.map((frame) => frame.y)) : 0;
    const bounds = {
        x,
        y,
        width: frames.length ? Math.max(...frames.map((frame) => frame.x + frame.width)) - x : 1,
        height: frames.length ? Math.max(...frames.map((frame) => frame.y + frame.height)) - y : 1,
    };
    boundsCache.set(file, bounds);
    return { ...bounds };
}

/** Shared remap/shadow conversion for static hover and interactive frames. */
export function spriteRaster(
    bytes: Uint8Array,
    file: ShpFile,
    palette: number[],
    frame: number,
    shadow = false,
    color = DEFAULT_HOUSE_COLOR,
    remap = true,
    trim = true
): Raster {
    const indexed = decodeShpFrame(bytes, file, frame);
    const shadowIndex = frame + Math.floor(file.frames.length / 2);
    const shade = shadow && shadowIndex < file.frames.length ? decodeShpFrame(bytes, file, shadowIndex) : undefined;
    return indexedRaster(indexed, shade, file, palette, color, remap, trim);
}

/** Cached indexed frames share the exact same conversion in both decoder workers. */
export function indexedRaster(
    indexed: Uint8Array,
    shade: Uint8Array | undefined,
    file: ShpFile,
    palette: number[],
    color = DEFAULT_HOUSE_COLOR,
    remap = true,
    trim = true
): Raster {
    const bounds = trim ? spriteBounds(file) : { x: 0, y: 0, width: file.width, height: file.height };
    const pixels = new Uint8Array(bounds.width * bounds.height * 4);
    const lookup = new Uint8Array(768);
    for (let value = 1; value < 256; value++) {
        for (let channel = 0; channel < 3; channel++) {
            lookup[value * 3 + channel] =
                remap && value >= 16 && value <= 31
                    ? Math.round(color[channel] * (0.28 + ((31 - value) / 15) * 0.72))
                    : palette[value * 3 + channel];
        }
    }
    for (let y = 0; y < bounds.height; y++) {
        for (let x = 0; x < bounds.width; x++) {
            const index = (y + bounds.y) * file.width + x + bounds.x,
                value = indexed[index],
                at = (y * bounds.width + x) * 4;
            if (value) {
                pixels[at] = lookup[value * 3];
                pixels[at + 1] = lookup[value * 3 + 1];
                pixels[at + 2] = lookup[value * 3 + 2];
                pixels[at + 3] = 255;
            } else if (shade?.[index]) {
                pixels[at + 3] = 105;
            }
        }
    }
    return { ...bounds, pixels };
}

export function thumbnailRaster(image: RasterRect & { pixels: Uint8Array }, side = 128, upscale = false): Raster {
    const ratio = Math.min(upscale ? Infinity : 1, side / Math.max(image.width, image.height));
    const width = Math.max(1, Math.round(image.width * ratio)),
        height = Math.max(1, Math.round(image.height * ratio));
    const pixels = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const source =
                (Math.min(image.height - 1, Math.floor(y / ratio)) * image.width +
                    Math.min(image.width - 1, Math.floor(x / ratio))) *
                4;
            pixels.set(image.pixels.subarray(source, source + 4), (y * width + x) * 4);
        }
    }
    return { x: 0, y: 0, width, height, pixels };
}
