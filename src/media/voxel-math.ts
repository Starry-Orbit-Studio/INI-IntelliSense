import type { VoxelPart } from './voxel';

export const IDENTITY_TRANSFORM = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
export function rotateVector(point: number[], angle: number): number[] {
    const c = Math.cos(angle),
        s = Math.sin(angle);
    return [point[0] * c - point[1] * s, point[0] * s + point[1] * c, point[2]];
}
export function transformPoint(matrix: number[], point: number[], translation = true): number[] {
    return [0, 1, 2].map(
        (row) =>
            matrix[row * 4] * point[0] +
            matrix[row * 4 + 1] * point[1] +
            matrix[row * 4 + 2] * point[2] +
            (translation ? matrix[row * 4 + 3] : 0)
    );
}
/** Bounds precede limb rotation. Turret offset follows rotation, in body coordinates. */
export function voxelTransform(part: VoxelPart, frame: number, turret: number): number[] {
    const matrix =
        part.animation?.[frame % part.animation.length] ??
        (part.matrix.some((value) => value !== 0) ? part.matrix : IDENTITY_TRANSFORM);
    const step = part.size.map((size, axis) => (part.bounds[axis + 3] - part.bounds[axis]) / size);
    const angle = part.role === 'body' ? 0 : turret;
    const origin = rotateVector(
        transformPoint(matrix, part.bounds.slice(0, 3), false).map(
            (value, axis) => value + matrix[axis * 4 + 3] * part.scale * step[axis]
        ),
        angle
    ).map((value, axis) => value + (part.offset?.[axis] ?? 0));
    const columns = [0, 1, 2].map((column) =>
        rotateVector(
            [matrix[column], matrix[4 + column], matrix[8 + column]].map((value) => value * step[column]),
            angle
        )
    );
    return Array.from({ length: 12 }, (_, i) =>
        i % 4 === 3 ? origin[(i - 3) / 4] : columns[i % 4][Math.floor(i / 4)]
    );
}
/** Column-major inverse transpose for WebGL normals, including nonuniform scale. */
export function normalTransform(matrix: number[]): number[] {
    const a = matrix[0],
        b = matrix[1],
        c = matrix[2],
        d = matrix[4],
        e = matrix[5],
        f = matrix[6],
        g = matrix[8],
        h = matrix[9],
        i = matrix[10];
    const cofactors = [
        e * i - f * h,
        f * g - d * i,
        d * h - e * g,
        c * h - b * i,
        a * i - c * g,
        b * g - a * h,
        b * f - c * e,
        c * d - a * f,
        a * e - b * d,
    ];
    const determinant = a * cofactors[0] + b * cofactors[1] + c * cofactors[2];
    if (Math.abs(determinant) < 1e-12) {
        return [1, 0, 0, 0, 1, 0, 0, 0, 1];
    }
    return [
        cofactors[0],
        cofactors[3],
        cofactors[6],
        cofactors[1],
        cofactors[4],
        cofactors[7],
        cofactors[2],
        cofactors[5],
        cofactors[8],
    ].map((value) => value / determinant);
}
