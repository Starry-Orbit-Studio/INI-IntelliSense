export interface PaletteColor {
    r: number;
    g: number;
    b: number;
}

export function readPalette(bytes: Uint8Array): PaletteColor[] {
    if (bytes.byteLength < 0x300) {
        throw new Error('Invalid PAL file: expected at least 768 bytes.');
    }

    const colors: PaletteColor[] = [];
    for (let i = 0; i < 0x100; i++) {
        colors.push({
            r: (bytes[i * 3] ?? 0) * 4,
            g: (bytes[i * 3 + 1] ?? 0) * 4,
            b: (bytes[i * 3 + 2] ?? 0) * 4,
        });
    }
    return colors;
}

export function paletteToCssColors(colors: PaletteColor[]): string[] {
    return colors.map(color => `rgb(${color.r}, ${color.g}, ${color.b})`);
}

export function createGrayscalePalette(): PaletteColor[] {
    const colors: PaletteColor[] = [];
    for (let i = 0; i < 256; i++) {
        colors.push({
            r: i,
            g: i,
            b: i,
        });
    }
    return colors;
}
