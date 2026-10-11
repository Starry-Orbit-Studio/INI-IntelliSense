/** Palette decisions are independent of resource discovery and manual selections. */
export function paletteName(
    explicit: string | undefined,
    theater = 'tem',
    role: 'unit' | 'animation' | 'cameo' = 'unit',
    parent?: string
): string {
    if (explicit?.trim()) {
        const name = explicit.trim().replace(/~~~/g, theater);
        return /\.pal$/i.test(name) ? name : name + '.pal';
    }
    return parent ?? (role === 'animation' ? 'anim.pal' : role === 'cameo' ? 'cameo.pal' : 'unit' + theater + '.pal');
}

/** Palette is a theater prefix; CustomPalette is an exact filename/template. */
export function artPaletteName(
    custom: string | undefined,
    prefix: string | undefined,
    theater: string,
    role: 'unit' | 'animation' | 'cameo',
    parent?: string
): string {
    const explicit = custom ?? (prefix && !/\.pal$|~~~/i.test(prefix) ? prefix + theater : prefix);
    return paletteName(explicit, theater, role, parent);
}
