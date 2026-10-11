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

/** Keep the authored game-view light fixed on screen while the inspection camera orbits. */
export function cameraLockedLight(light: number[], yaw: number, pitch: number): number[] {
    const y = (yaw * Math.PI) / 180,
        p = (pitch * Math.PI) / 180;
    const axes = [
        [Math.cos(y), -Math.sin(y), 0],
        [Math.sin(y) * Math.sin(p), Math.cos(y) * Math.sin(p), Math.cos(p)],
        [-Math.sin(y) * Math.cos(p), -Math.cos(y) * Math.cos(p), Math.sin(p)],
    ];
    const coordinates = [GAME_LIGHT_FRAME.right, GAME_LIGHT_FRAME.up, GAME_LIGHT_FRAME.eye].map((axis) =>
        axis.reduce((sum, value, index) => sum + value * light[index], 0)
    );
    return [0, 1, 2].map((index) =>
        axes.reduce((sum, axis, coordinate) => sum + axis[index] * coordinates[coordinate], 0)
    );
}
