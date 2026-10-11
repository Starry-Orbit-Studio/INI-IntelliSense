/** Semantic navigation shared by the native project tree and the object table. */
export const CATALOG_GROUPS = [
    'infantry',
    'vehicles',
    'aircraft',
    'buildings',
    'superweapons',
    'weapons',
    'warheads',
    'projectiles',
    'animations',
    'particles',
    'sounds',
    'other',
] as const;
export type CatalogGroup = (typeof CATALOG_GROUPS)[number];
export const GAME_GROUPS: readonly string[] = CATALOG_GROUPS.slice(0, 5);

const TYPE_GROUPS: Readonly<Record<string, CatalogGroup>> = {
    infantrytype: 'infantry',
    unittype: 'vehicles',
    vehicletype: 'vehicles',
    aircrafttype: 'aircraft',
    buildingtype: 'buildings',
    superweapontype: 'superweapons',
    weapontype: 'weapons',
    warheadtype: 'warheads',
    projectiletype: 'projectiles',
    bullettype: 'projectiles',
    animtype: 'animations',
    voxelanimtype: 'animations',
    particletype: 'particles',
    particlesystemtype: 'particles',
    sound: 'sounds',
};

/** CSF tooltips may include several lines; navigation uses the first non-empty title. */
export function catalogLabel(value: string): string {
    return (
        value
            .split(/\r?\n|\\[nr]|↵/)
            .map((line) => line.trim())
            .find((line) => /[\p{L}\p{N}]/u.test(line)) ?? ''
    );
}

export function catalogGroup(object: { category: string; type: string; registered?: boolean }): CatalogGroup {
    if (object.category === 'sound') {
        return 'sounds';
    }
    const type = object.type.toLowerCase();
    const group = TYPE_GROUPS[type] ?? 'other';
    if (GAME_GROUPS.includes(group) && (object.category !== 'rules' || object.registered === false)) {
        return 'other';
    }
    return group;
}

export function matchesCatalogScope(group: string, scope: string): boolean {
    return scope === 'all' || scope === group || (scope === 'game' && GAME_GROUPS.includes(group));
}
