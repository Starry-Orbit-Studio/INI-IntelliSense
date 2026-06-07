import { PalettePreview } from './preview-types';

export function createPalPreview(bytes: Uint8Array, title: string): PalettePreview {
    if (bytes.byteLength < 0x300) {
        throw new Error('Invalid PAL file: expected at least 768 bytes.');
    }

    const colors: string[] = [];
    for (let i = 0; i < 0x100; i++) {
        const r = (bytes[i * 3] ?? 0) * 4;
        const g = (bytes[i * 3 + 1] ?? 0) * 4;
        const b = (bytes[i * 3 + 2] ?? 0) * 4;
        colors.push(`rgb(${r}, ${g}, ${b})`);
    }

    return {
        kind: 'palette',
        title,
        colors,
        description: `256 colors`,
    };
}
