import type { MediaPayload } from '../context/workbench-protocol';
import { voxelRaster } from './voxel-raster';
import { encodePng } from './png';
import { thumbnailRaster } from './sprite-raster';

/** Preserve the thumbnail contract while sharing native game projection with turrets. */
export function voxelThumbnail(media: Extract<MediaPayload, { kind: 'voxel' }>): Uint8Array {
    const raster = thumbnailRaster(voxelRaster(media), 84, true);
    const pixels = new Uint8Array(96 * 96 * 4);
    const left = Math.floor((96 - raster.width) / 2),
        top = Math.floor((96 - raster.height) / 2);
    for (let y = 0; y < raster.height; y++) {
        pixels.set(
            raster.pixels.subarray(y * raster.width * 4, (y + 1) * raster.width * 4),
            ((y + top) * 96 + left) * 4
        );
    }
    return encodePng(96, 96, pixels);
}
