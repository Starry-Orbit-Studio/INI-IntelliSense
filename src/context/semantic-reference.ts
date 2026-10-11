import { SchemaManager } from '../schema-manager';

export type ReferenceKind = 'object' | 'animation' | 'sound' | 'image' | 'palette' | 'sequence' | 'flh' | 'lighting';
export interface SemanticReference {
    kind: ReferenceKind;
    value: string;
    extension?: string;
    type?: string;
}
export interface SemanticRule {
    owner?: string;
    category?: string;
    key?: string;
    valueType?: string;
    kind: ReferenceKind;
    extension?: string;
}

const RULES: SemanticRule[] = [
    { category: 'art', key: 'Image', kind: 'image' },
    { owner: 'AnimType', key: 'Image', kind: 'animation' },
    { owner: 'ObjectType', key: 'Image', kind: 'object' },
    { owner: 'TechnoType', category: 'art', key: 'Sequence', kind: 'sequence' },
    { owner: 'InfantryType', key: 'Sequence', kind: 'sequence' },
    { owner: 'AudioVisual', key: 'VoxelLightSource', kind: 'lighting' },
    { category: 'art', key: 'Sequence', kind: 'sequence' },
    { key: 'Cameo', kind: 'image', extension: '.shp' },
    { key: 'AltCameo', kind: 'image', extension: '.shp' },
    { key: 'CameoPCX', kind: 'image', extension: '.pcx' },
    { key: 'AltCameoPCX', kind: 'image', extension: '.pcx' },
    { key: 'AnimList', kind: 'animation', valueType: undefined },
    { valueType: 'Sound', kind: 'sound' },
    { valueType: 'AnimType', kind: 'animation' },
    { valueType: 'Shape', kind: 'image', extension: '.shp' },
    { valueType: 'SHPFile', kind: 'image', extension: '.shp' },
    { valueType: 'PCXFile', kind: 'image', extension: '.pcx' },
    { valueType: 'PALFile', kind: 'palette', extension: '.pal' },
    { valueType: 'Palette', kind: 'palette', extension: '.pal' },
    ...['UnitType', 'AircraftType', 'InfantryType', 'BuildingType', 'TechnoType', 'VoxelAnimType'].map((valueType) => ({
        valueType,
        kind: 'object' as const,
    })),
];

/** Additive rules keep validation types and shared dictionaries compatible. */
export class SemanticReferences {
    constructor(private readonly schema: SchemaManager) {}
    public inherits(type: string, target: string): boolean {
        const base: Record<string, string> = {
            UnitType: 'TechnoType',
            AircraftType: 'TechnoType',
            InfantryType: 'TechnoType',
            BuildingType: 'TechnoType',
            TechnoType: 'ObjectType',
            AnimType: 'ObjectType',
            VoxelAnimType: 'ObjectType',
        };
        const visited = new Set<string>();
        while (type && !visited.has(type)) {
            if (type.toLowerCase() === target.toLowerCase()) {
                return true;
            }
            visited.add(type);
            type = this.schema.getSchema(type)?.base ?? base[type] ?? '';
        }
        return false;
    }
    public resolve(
        owner: string,
        category: string,
        key: string,
        type: string | undefined,
        value: string,
        custom: SemanticRule[] = []
    ): SemanticReference | undefined {
        for (const rule of [...custom, ...RULES]) {
            if (
                !rule ||
                typeof rule !== 'object' ||
                ['owner', 'category', 'key', 'valueType', 'extension'].some(
                    (field) =>
                        rule[field as keyof SemanticRule] !== undefined &&
                        typeof rule[field as keyof SemanticRule] !== 'string'
                )
            ) {
                continue;
            }
            if (
                !['object', 'animation', 'sound', 'image', 'palette', 'sequence', 'flh', 'lighting'].includes(rule.kind)
            ) {
                continue;
            }
            if (rule.owner && !this.inherits(owner, rule.owner)) {
                continue;
            }
            if (rule.category && rule.category.toLowerCase() !== category.toLowerCase()) {
                continue;
            }
            if (rule.key && rule.key.toLowerCase() !== key.toLowerCase()) {
                continue;
            }
            if (rule.valueType && rule.valueType !== type) {
                continue;
            }
            return { kind: rule.kind, value, extension: rule.extension, type };
        }
        if (
            /^Voice(Select|Move|Attack|Feedback|SpecialAttack|Enter|Deploy|Undeploy|Harvest|PrimaryWeaponAttack|SecondaryWeaponAttack)$/i.test(
                key
            ) ||
            /^(MoveSound|DieSound|CrashingSound|ImpactSound|CreateSound|Report)$/i.test(key)
        ) {
            return { kind: 'sound', value, type: 'Sound' };
        }
        if (
            /^(primaryfireflh|secondaryfireflh|eliteprimaryfireflh|elitesecondaryfireflh|weapon\d+flh)$/i.test(key) &&
            category === 'art'
        ) {
            return { kind: 'flh', value };
        }
        return undefined;
    }
}
