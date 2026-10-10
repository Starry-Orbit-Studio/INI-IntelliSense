import type { MediaPayload } from '../context/workbench-protocol';
import { voxelTransform, transformPoint, normalTransform } from './voxel-math';
import { encodePng } from './png';

/** A bounded software projection for editor images; the interactive view uses WebGL. */
export function voxelThumbnail(media: Extract<MediaPayload, { kind: 'voxel' }>): Uint8Array {
    const side = 96,
        pixels = new Uint8Array(side * side * 4),
        depth = new Float64Array(side * side).fill(Infinity);
    const vertices: { x: number; y: number; depth: number; color: number }[] = [];
    let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
    const lightLength = Math.hypot(...media.light) || 1,
        light = media.light.map((value) => value / lightLength);
    const secondary = light.map((value, axis) => value + (!media.fixed && axis === 2 ? 1 : 0));
    const secondaryLength = Math.hypot(...secondary) || 1,
        half = secondary.map((value) => value / secondaryLength);
    const project = (point: number[]) => [
        (point[0] - point[1]) / Math.sqrt(2),
        (point[0] + point[1]) / Math.sqrt(6) - point[2] * Math.sqrt(2 / 3),
        -(point[0] + point[1]) * Math.sqrt(1 / 3) - point[2] / Math.sqrt(3),
    ];
    for (const part of media.model.parts) {
        const matrix = voxelTransform(part, 0, 0),
            normalMatrix = normalTransform(matrix);
        for (let index = 0; index < part.voxels.length; index += 5) {
            const world = transformPoint(
                matrix,
                part.voxels.slice(index, index + 3).map((value) => value + 0.5)
            );
            const [x, y, z] = project(world),
                authored = media.normals.slice(part.voxels[index + 4] * 3, part.voxels[index + 4] * 3 + 3);
            const normal = [0, 1, 2].map(
                (row) =>
                    normalMatrix[row] * authored[0] +
                    normalMatrix[row + 3] * authored[1] +
                    normalMatrix[row + 6] * authored[2]
            );
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
        return encodePng(side, side, pixels);
    }
    const scale = 84 / Math.max(maxX - minX, maxY - minY, 1),
        cx = (minX + maxX) / 2,
        cy = (minY + maxY) / 2;
    const radius = Math.min(8, Math.max(0, Math.ceil(scale / 2)));
    for (const vertex of vertices) {
        const x = Math.round((vertex.x - cx) * scale + side / 2),
            y = Math.round((vertex.y - cy) * scale + side / 2);
        for (let dy = -radius; dy <= radius; dy++) {
            for (let dx = -radius; dx <= radius; dx++) {
                const px = x + dx,
                    py = y + dy;
                if (px < 0 || px >= side || py < 0 || py >= side) {
                    continue;
                }
                const index = py * side + px;
                if (vertex.depth >= depth[index]) {
                    continue;
                }
                depth[index] = vertex.depth;
                pixels.set(media.palette.slice(vertex.color * 3, vertex.color * 3 + 3), index * 4);
                pixels[index * 4 + 3] = 255;
            }
        }
    }
    return encodePng(side, side, pixels);
}
