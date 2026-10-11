/** INI light describes ray travel. Rendering needs the opposite vector toward the source. */
export const DEFAULT_VOXEL_LIGHT = [0.2013022, -0.9101138, -0.3621709];
export function nativeLight(light: number[]): number[] {
    return [-light[2], -light[0], -light[1]];
}
export function authoredLight(native: number[]): number[] {
    return [-native[1], -native[2], -native[0]];
}
export function nativeNormal(normal: number[]): number[] {
    return [normal[1], normal[0], normal[2]];
}
