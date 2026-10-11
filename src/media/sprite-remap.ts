export type SpriteRole = 'techno' | 'animation' | 'particle' | 'cameo' | 'raw';

/** Remapping belongs to the game drawer, not to the SHP format or palette filename. */
export function spriteRemap(role: SpriteRole, altPalette = false, unitDrawer = false): boolean {
    return role === 'techno' || (role === 'animation' && (altPalette || unitDrawer));
}
