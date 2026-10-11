/** Malformed or zero INI vectors fall back to the game default at the decoding boundary. */
export function projectLighting(source: string | undefined, fixed: string | undefined) {
    const elements = source?.split(',').map((value) => value.trim()) ?? [];
    const light = elements.map(Number);
    return {
        light:
            elements.length === 3 &&
            elements.every(Boolean) &&
            light.every(Number.isFinite) &&
            Math.hypot(...light) > 0.000001
                ? light
                : undefined,
        fixed: /^(yes|true|1)$/i.test(fixed ?? ''),
    };
}
