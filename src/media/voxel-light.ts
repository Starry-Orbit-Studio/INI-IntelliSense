/** Phobos and the native VPL renderer use the same XYZ space as VXL normals. */
export const DEFAULT_VOXEL_LIGHT = [0.2013022, -0.9101138, -0.3621709];
/** The light control uses the game's fixed 30-degree frame, independent of inspection camera orbit. */
export const GAME_LIGHT_FRAME = {
    right: [Math.SQRT1_2, Math.SQRT1_2, 0],
    up: [-1 / Math.sqrt(8), 1 / Math.sqrt(8), Math.sqrt(3) / 2],
    eye: [Math.sqrt(3 / 8), -Math.sqrt(3 / 8), 0.5],
} as const;
export function nativeLight(light: number[]): number[] {
    return [...light];
}
export function authoredLight(native: number[]): number[] {
    return [...native];
}
export function nativeNormal(normal: number[]): number[] {
    return [...normal];
}
