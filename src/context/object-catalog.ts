import * as vscode from 'vscode';
import { SchemaManager } from '../schema-manager';
import { ProjectIni, SectionSource } from './project-ini';
import { resolveProperties, PropertyResolution } from './property-resolution';
import { parsePropertyLine } from './ini-position';

export interface CatalogObject {
    name: string;
    label: string;
    category: string;
    type: string;
    source: SectionSource;
    definitions: number;
    properties: Map<string, PropertyResolution>;
}

/** One immutable source snapshot powers object browsing, comparison and editing. */
export async function objectCatalog(
    ini: ProjectIni,
    schema: SchemaManager,
    origin: vscode.Uri,
    token: vscode.CancellationToken,
    translate: (key: string) => string | undefined
): Promise<CatalogObject[]> {
    await ini.load(origin);
    const snapshot = ini.snapshot(origin);
    const registries: Record<string, string> = {
        UnitTypes: 'UnitType',
        VehicleTypes: 'UnitType',
        InfantryTypes: 'InfantryType',
        AircraftTypes: 'AircraftType',
        BuildingTypes: 'BuildingType',
        Animations: 'AnimType',
        VoxelAnims: 'VoxelAnimType',
        Particles: 'ParticleType',
        ParticleSystems: 'ParticleSystemType',
    };
    for (const registry of schema.getRegistryNames()) {
        registries[registry] ??= schema.getTypeForRegistry(registry) ?? 'Unknown';
    }
    const types = new Map<string, string>();
    for (const [registry, type] of Object.entries(registries)) {
        for (const property of resolveProperties(
            registry,
            (name) => snapshot.sources(name, 'rules'),
            parsePropertyLine
        ).values()) {
            types.set(property.effective.value.toLowerCase(), type);
        }
    }
    const registryNames = new Set(Object.keys(registries).map((name) => name.toLowerCase()));
    const objects: CatalogObject[] = [];
    for (const name of snapshot.names) {
        if (token.isCancellationRequested) {
            return [];
        }
        if (name === '#include' || registryNames.has(name)) {
            continue;
        }
        for (const category of new Set(snapshot.sources(name).map((item) => item.category))) {
            const sources = snapshot.sources(name, category);
            const owner = sources.filter((source) => source.document === sources[0].document).at(-1)!;
            const properties = resolveProperties(
                name,
                (target) => snapshot.sources(target, category),
                parsePropertyLine
            );
            const value = (key: string) => properties.get(key)?.effective.value;
            const uiName = value('uiname');
            objects.push({
                name: sources[0].section.name,
                category,
                label: (uiName && translate(uiName)) || value('name') || '',
                type:
                    category === 'sound'
                        ? 'Sound'
                        : (types.get(name) ??
                          (schema.isSchemaType(sources[0].section.name) ? sources[0].section.name : 'Unknown')),
                source: owner,
                definitions: sources.length,
                properties,
            });
        }
        if (objects.length % 100 === 0) {
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
    }
    const byName = new Map<string, CatalogObject[]>();
    objects.forEach((object) => {
        const id = object.name.toLowerCase();
        byName.set(id, [...(byName.get(id) ?? []), object]);
    });
    // Propagate only dictionary-backed section references; scalar strings do not infer types.
    for (let pass = 0; pass < 8; pass++) {
        let changed = false;
        for (const object of objects) {
            if (token.isCancellationRequested) {
                return [];
            }
            if (object.type === 'Unknown') {
                for (const parent of object.source.section.parentNames) {
                    const type = byName
                        .get(parent.toLowerCase())
                        ?.find((item) => item.category === object.category)?.type;
                    if (type && type !== 'Unknown') {
                        object.type = type;
                        changed = true;
                        break;
                    }
                }
            }
            for (const [key, definition] of schema.getAllKeysForType(object.type)) {
                let type = definition.type;
                const visited = new Set<string>();
                while (schema.getListDefinition(type) && !visited.has(type)) {
                    visited.add(type);
                    type = schema.getListDefinition(type)!.type;
                }
                if (!schema.isComplexType(type)) {
                    continue;
                }
                for (const name of object.properties.get(key.toLowerCase())?.effective.value.split(',') ?? []) {
                    for (const target of byName.get(name.trim().toLowerCase()) ?? []) {
                        if (target.category === object.category && target.type === 'Unknown') {
                            target.type = type;
                            changed = true;
                        }
                    }
                }
            }
        }
        if (!changed || token.isCancellationRequested) {
            break;
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return objects;
}
