import type { SpriteLayer, SpriteScene } from '../context/workbench-protocol';
import { voxelTransform, transformPoint } from './voxel-math';
import { spriteBounds, RasterRect } from './sprite-raster';

/** One state policy drives hover playback and the interactive scene. */
export function layerVisible(layer: SpriteLayer, scene: SpriteScene, state = 'normal', damaged = false): boolean {
    if (state === 'construction') {
        return layer.state === 'construction';
    }
    if (layer.damaged && !damaged) {
        return false;
    }
    if (
        damaged &&
        !layer.damaged &&
        scene.layers.some(
            (other) =>
                other.damaged &&
                (other.media || other.voxel) &&
                other.tag.replace(/Damaged(?=\/|$)/i, '').toLowerCase() === layer.tag.toLowerCase()
        )
    ) {
        return false;
    }
    if (layer.pointName && scene.points?.find((point) => point.name === layer.pointName)?.absent) {
        return false;
    }
    return layer.state === state || (['normal', 'damaged'].includes(layer.state) && state !== 'next');
}

export function layerFrame(layer: SpriteLayer, kind: SpriteScene['kind'], frame = 0, damaged = false): number {
    if (!layer.media) {
        return 0;
    }
    const limit = layer.media.shadow ? layer.media.file.frames.length / 2 : layer.media.file.frames.length;
    if (kind === 'building' && /^(body|BibShape)$/i.test(layer.tag)) {
        return Math.min(damaged ? 1 : 0, limit - 1);
    }
    const start = Math.min(Math.max(0, layer.start), limit - 1),
        end = layer.end > start ? Math.min(limit, layer.end) : limit;
    return start + (Math.floor((frame * (layer.rate ?? 225)) / 225) % Math.max(1, end - start));
}

/** Keep the original sprite center as scene origin despite trimming empty margins. */
export function layerBounds(layer: SpriteLayer): RasterRect | undefined {
    if (layer.voxel) {
        let radius = 1,
            bottom = 0,
            top = 0;
        for (const part of layer.voxel.model.parts) {
            const matrix = voxelTransform(part, 0, 0);
            for (const x of [0, part.size[0]]) {
                for (const y of [0, part.size[1]]) {
                    for (const z of [0, part.size[2]]) {
                        const point = transformPoint(matrix, [x, y, z]);
                        radius = Math.max(radius, Math.hypot(point[0], point[1]));
                        bottom = Math.min(bottom, point[2]);
                        top = Math.max(top, point[2]);
                    }
                }
            }
        }
        return {
            x: layer.offset[0] - radius - 2,
            y: layer.offset[1] - radius / 2 - (top * Math.sqrt(3)) / 2 - 2,
            width: radius * 2 + 4,
            height: radius + ((top - bottom) * Math.sqrt(3)) / 2 + 4,
        };
    }
    if (!layer.media) {
        return undefined;
    }
    const bounds = spriteBounds(layer.media.file);
    return {
        ...bounds,
        x: bounds.x - layer.media.file.width / 2 + layer.offset[0],
        y: bounds.y - layer.media.file.height / 2 + layer.offset[1],
    };
}

export function unionBounds(rects: RasterRect[]): RasterRect {
    if (!rects.length) {
        return { x: -1, y: -1, width: 2, height: 2 };
    }
    const x = Math.floor(Math.min(...rects.map((rect) => rect.x))),
        y = Math.floor(Math.min(...rects.map((rect) => rect.y)));
    return {
        x,
        y,
        width: Math.max(1, Math.ceil(Math.max(...rects.map((rect) => rect.x + rect.width))) - x),
        height: Math.max(1, Math.ceil(Math.max(...rects.map((rect) => rect.y + rect.height))) - y),
    };
}
