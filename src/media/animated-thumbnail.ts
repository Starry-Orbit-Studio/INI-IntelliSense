import type { MediaPayload } from '../context/workbench-protocol';
import { encodeAnimatedPng } from './png';
import { sceneRaster } from './scene-thumbnail';
import { layerVisible, unionBounds } from './scene-layout';
import { Raster, spriteRaster, thumbnailRaster } from './sprite-raster';
import { spriteClip } from './sprite-playback';
import { voxelRaster } from './voxel-raster';

// VS Code truncates Markdown at 100,000 characters; base64 and labels need room as well.
export const MAX_HOVER_PNG_BYTES = 64 * 1024;

/** Reduce temporal/spatial sampling until the complete data URI fits a native hover. */
export function encodeHoverAnimation(images: Raster[], duration: number): Uint8Array {
    if (!images.length || !Number.isFinite(duration) || duration <= 0) {
        throw new Error('Hover animation requires frames and a positive finite duration.');
    }
    let count = images.length,
        side = 128;
    for (;;) {
        const sampled = Array.from({ length: count }, (_, index) =>
            thumbnailRaster(images[Math.floor((index * images.length) / count)], side)
        );
        const png = encodeAnimatedPng(
            sampled[0].width,
            sampled[0].height,
            sampled.map((image) => image.pixels),
            (Math.min(10, duration) * 1000) / count
        );
        if (png.length <= MAX_HOVER_PNG_BYTES) {
            return png;
        }
        if (count > 8) {
            count = Math.max(8, Math.floor(count / 2));
        } else {
            side = Math.max(1, Math.floor(side * 0.8));
        }
    }
}

/** Worker-only bounded APNG generation. Decorations continue using static thumbnails. */
export function animatedThumbnail(media: Extract<MediaPayload, { kind: 'sprite' | 'voxel' }>): Uint8Array {
    let duration = 1 / 15,
        work = 1,
        frames = 1;
    let raster: (tick: number) => Raster;
    if (media.kind === 'voxel') {
        frames = Math.max(1, ...media.model.parts.map((part) => part.animation?.length ?? 1));
        work = Math.max(1, media.model.parts.reduce((sum, part) => sum + part.voxels.length / 5, 0) * 16);
        duration = frames / 15;
        raster = (tick) => voxelRaster(media, 0, undefined, Math.floor(tick));
    } else if (media.scene) {
        const visible = media.scene.layers.filter((layer) => layerVisible(layer, media.scene!));
        work = Math.max(
            1,
            visible.reduce(
                (sum, layer) =>
                    sum +
                    (layer.media
                        ? layer.media.file.width * layer.media.file.height
                        : (layer.voxel?.model.parts.reduce((n, part) => n + part.voxels.length / 5, 0) ?? 0) * 16),
                0
            )
        );
        for (const layer of visible) {
            if (media.scene.kind === 'building' && /^(body|BibShape)$/i.test(layer.tag)) {
                continue;
            }
            const count = layer.media
                ? Math.max(
                      1,
                      (layer.end > layer.start
                          ? Math.min(layer.end, layer.media.file.frames.length / (layer.media.shadow ? 2 : 1))
                          : layer.media.file.frames.length / (layer.media.shadow ? 2 : 1)) - layer.start
                  )
                : Math.max(1, ...(layer.voxel?.model.parts.map((part) => part.animation?.length ?? 1) ?? []));
            frames = Math.max(frames, count);
            duration = Math.max(duration, (count * 225) / ((layer.rate ?? 225) * 15));
        }
        raster = (tick) => sceneRaster(media, tick);
    } else {
        const action =
            media.actions.find(
                (entry) => entry.valid && /^(ready|guard)$/i.test(entry.action.name) && entry.action.count > 1
            )?.action ?? media.actions.find((entry) => entry.valid && entry.action.count > 1)?.action;
        const clip = spriteClip(media.file.frames.length, media.shadow, action);
        frames = clip.count;
        duration = frames / 15;
        work = media.file.width * media.file.height;
        const bytes = Buffer.from(media.bytes, 'base64');
        raster = (tick) =>
            spriteRaster(
                bytes,
                media.file,
                media.palette,
                clip.frame(Math.floor(tick)),
                media.shadow,
                undefined,
                media.remap === true
            );
    }
    // Cap decoding work, duration, output frames and final pixels independently.
    const count = Math.max(1, Math.min(32, frames, Math.floor((24 * 1024 * 1024) / work)));
    const images = Array.from({ length: count }, (_, index) => raster((index * duration * 15) / count));
    const bounds = unionBounds(images);
    if (bounds.width * bounds.height * count > 16 * 1024 * 1024) {
        const first = thumbnailRaster(images[0]);
        return encodeHoverAnimation([first], duration);
    }
    const output = images.map((image) => {
        const pixels = new Uint8Array(bounds.width * bounds.height * 4);
        for (let y = 0; y < image.height; y++) {
            const at = ((Math.round(image.y - bounds.y) + y) * bounds.width + Math.round(image.x - bounds.x)) * 4;
            pixels.set(image.pixels.subarray(y * image.width * 4, (y + 1) * image.width * 4), at);
        }
        return thumbnailRaster({ ...bounds, pixels });
    });
    return encodeHoverAnimation(output, duration);
}
