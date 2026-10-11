import type { MediaPayload } from '../context/workbench-protocol';
import { layerBounds, layerFrame, layerVisible, unionBounds } from './scene-layout';
import { Raster, spriteRaster, thumbnailRaster } from './sprite-raster';
import { voxelRaster } from './voxel-raster';
import { encodePng } from './png';

/** Same authored anchors and layer policy as the interactive scene. */
export function sceneRaster(media: Extract<MediaPayload, { kind: 'sprite' }>, frame = 0): Raster {
    const scene = media.scene!;
    const planes: Raster[] = [];
    for (const layer of [...scene.layers].sort((a, b) => b.z - a.z)) {
        if (!layerVisible(layer, scene)) {
            continue;
        }
        if (layer.media) {
            const raster = spriteRaster(
                Buffer.from(layer.media.bytes, 'base64'),
                layer.media.file,
                layer.media.palette,
                layerFrame(layer, scene.kind, frame),
                layer.media.shadow,
                undefined,
                layer.remap
            );
            const bounds = layerBounds(layer)!;
            planes.push({ ...raster, x: bounds.x, y: bounds.y });
        } else if (layer.voxel) {
            const raster = voxelRaster(layer.voxel, 0, undefined, Math.floor(frame));
            planes.push({ ...raster, x: raster.x + layer.offset[0], y: raster.y + layer.offset[1] });
        }
    }
    const bounds = unionBounds(planes);
    if (bounds.width * bounds.height > 4 * 1024 * 1024) {
        throw new Error('Scene thumbnail exceeds canvas budget.');
    }
    const pixels = new Uint8Array(bounds.width * bounds.height * 4);
    for (const plane of planes) {
        for (let y = 0; y < plane.height; y++) {
            for (let x = 0; x < plane.width; x++) {
                const source = (y * plane.width + x) * 4;
                const at =
                    ((Math.round(plane.y - bounds.y) + y) * bounds.width + Math.round(plane.x - bounds.x) + x) * 4;
                const alpha = plane.pixels[source + 3] / 255;
                if (!alpha) {
                    continue;
                }
                const existing = pixels[at + 3] / 255,
                    combined = alpha + existing * (1 - alpha);
                for (let channel = 0; channel < 3; channel++) {
                    pixels[at + channel] = Math.round(
                        (plane.pixels[source + channel] * alpha + pixels[at + channel] * existing * (1 - alpha)) /
                            combined
                    );
                }
                pixels[at + 3] = Math.round(combined * 255);
            }
        }
    }
    return { ...bounds, pixels };
}

export function sceneThumbnail(media: Extract<MediaPayload, { kind: 'sprite' }>): Uint8Array {
    const image = thumbnailRaster(sceneRaster(media));
    return encodePng(image.width, image.height, image.pixels);
}
