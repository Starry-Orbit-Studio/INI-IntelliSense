import { PalettePreview } from './preview-types';
import { paletteToCssColors, readPalette } from './palette-utils';

export function createPalPreview(bytes: Uint8Array, title: string): PalettePreview {
    const colors = paletteToCssColors(readPalette(bytes));

    return {
        kind: 'palette',
        title,
        colors,
        description: '256 colors',
        details: ['6-bit RGB palette'],
    };
}
