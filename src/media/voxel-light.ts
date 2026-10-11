/** Phobos and the native VPL renderer use the same XYZ space as VXL normals. */
export const DEFAULT_VOXEL_LIGHT = [0.2013022, -0.9101138, -0.3621709];
export function nativeLight(light: number[]): number[] {
    return [...light];
}
export function authoredLight(native: number[]): number[] {
    return [...native];
}
export function nativeNormal(normal: number[]): number[] {
    return [...normal];
}
