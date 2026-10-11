import type { MediaPayload } from '../context/workbench-protocol';
import { voxelTransform, transformPoint, normalTransform, rotateVector } from './voxel-math';
import { nativeLight, nativeNormal } from './voxel-light';
import { DEFAULT_HOUSE_COLOR } from './render-defaults';

/** Game orthographic projection with the same native normals, VPL lighting and default remap as WebGL. */
export function voxelRaster(
    media: Extract<MediaPayload, { kind: 'voxel' }>,
    heading = 0,
    color = DEFAULT_HOUSE_COLOR,
    frame = 0
): { x: number; y: number; width: number; height: number; pixels: Uint8Array } {
    const vertices: { x: number; y: number; depth: number; color: number }[] = [];
    let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
    const lightLength = Math.hypot(...media.light) || 1,
        light = nativeLight(media.light).map((value) => value / lightLength);
    // The game's additional lighting vector is vertical, independent of the camera.
    const eye = [0, 0, 1];
    const secondary = light.map((value, axis) => value + (!media.fixed ? eye[axis] : 0));
    const secondaryLength = Math.hypot(...secondary) || 1,
        half = secondary.map((value) => value / secondaryLength);
    const project = (point: number[]) => [
        (point[0] + point[1]) / Math.sqrt(2),
        (point[0] - point[1]) / Math.sqrt(8) - (point[2] * Math.sqrt(3)) / 2,
        (-point[0] + point[1]) * Math.sqrt(3 / 8) - point[2] / 2,
    ];
    for (const part of media.model.parts) {
        const matrix = voxelTransform(part, frame, 0),
            normalMatrix = normalTransform(matrix);
        for (let index = 0; index < part.voxels.length; index += 5) {
            const world = transformPoint(
                matrix,
                part.voxels.slice(index, index + 3).map((value) => value + 0.5)
            );
            const [x, y, z] = project(rotateVector(world, heading)),
                authored = nativeNormal([
                    media.normals[part.voxels[index + 4] * 3] ?? 0,
                    media.normals[part.voxels[index + 4] * 3 + 1] ?? 0,
                    media.normals[part.voxels[index + 4] * 3 + 2] ?? 1,
                ]);
            const normal = [0, 1, 2].map(
                (row) =>
                    normalMatrix[row] * authored[0] +
                    normalMatrix[row + 3] * authored[1] +
                    normalMatrix[row + 6] * authored[2]
            );
            const rotated = rotateVector(normal, heading);
            normal.splice(0, 3, ...rotated);
            const length = Math.hypot(...normal) || 1;
            normal.forEach((value, axis) => (normal[axis] = value / length));
            const dot = (a: number[], b: number[]) => a.reduce((sum, value, axis) => sum + value * b[axis], 0);
            const h = dot(normal, half),
                level = Math.max(
                    0,
                    Math.min(
                        media.vpl.length / 256 - 1,
                        Math.floor(16 * (Math.max(0, dot(normal, light)) + Math.max(0, h / (3 - 2 * h))))
                    )
                );
            vertices.push({
                x,
                y,
                depth: z,
                color: media.vpl[level * 256 + part.voxels[index + 3]] ?? part.voxels[index + 3],
            });
            minX = Math.min(minX, x);
            maxX = Math.max(maxX, x);
            minY = Math.min(minY, y);
            maxY = Math.max(maxY, y);
        }
    }
    if (!vertices.length) {
        return { x: 0, y: 0, width: 1, height: 1, pixels: new Uint8Array(4) };
    }
    const left = Math.floor(minX) - 2,
        top = Math.floor(minY) - 2;
    const width = Math.ceil(maxX) - left + 3,
        height = Math.ceil(maxY) - top + 3;
    if (width > 2048 || height > 2048) {
        throw new Error('Voxel raster exceeds canvas budget.');
    }
    const pixels = new Uint8Array(width * height * 4),
        depth = new Float64Array(width * height).fill(Infinity);
    const radius = 0;
    for (const vertex of vertices) {
        const x = Math.round(vertex.x - left),
            y = Math.round(vertex.y - top);
        for (let dy = -radius; dy <= radius; dy++) {
            for (let dx = -radius; dx <= radius; dx++) {
                const px = x + dx,
                    py = y + dy;
                if (px < 0 || px >= width || py < 0 || py >= height) {
                    continue;
                }
                const index = py * width + px;
                if (vertex.depth >= depth[index]) {
                    continue;
                }
                depth[index] = vertex.depth;
                const remapped = vertex.color >= media.model.remapStart && vertex.color <= media.model.remapEnd;
                const intensity =
                    0.28 +
                    (0.72 * (media.model.remapEnd - vertex.color)) /
                        Math.max(1, media.model.remapEnd - media.model.remapStart);
                pixels.set(
                    remapped
                        ? color.map((value) => Math.round(value * intensity))
                        : media.palette.slice(vertex.color * 3, vertex.color * 3 + 3),
                    index * 4
                );
                pixels[index * 4 + 3] = 255;
            }
        }
    }
    return { x: left, y: top, width, height, pixels };
}
