import * as vscode from 'vscode';
import * as path from 'path';
import { ProjectIni, EffectiveProperty } from './project-ini';
import { ProjectResources, ResourceCandidate } from '../resources/project-resources';
import { MediaOptions, SpriteSceneRecipe } from '../media/media-service';
import { SpriteLayer } from './workbench-protocol';
import { localize } from '../i18n';

const yes = (value?: string) => /^(yes|true|1)$/i.test(value ?? '');
const value = (properties: Map<string, EffectiveProperty>, name: string) => properties.get(name.toLowerCase())?.value;

/** Game filename rules are shared by the body, attached animation and buildup resolvers. */
export async function spriteCandidates(
    resources: ProjectResources,
    origin: vscode.Uri,
    base: string,
    art: Map<string, EffectiveProperty>,
    building = false
): Promise<{ names: string[]; candidates: ResourceCandidate[] }> {
    const theater = vscode.workspace
        .getConfiguration('ra2-ini-intellisense', origin)
        .get<string>('media.theater', 'tem')
        .toLowerCase();
    const theaterCode: Record<string, string> = { tem: 'T', sno: 'A', urb: 'U', ubn: 'N', lun: 'L', des: 'D' };
    const extension = path.posix.extname(base),
        stem = extension ? base.slice(0, -extension.length) : base;
    const names: string[] = [];
    const suffix = yes(value(art, 'Theater')) ? '.' + theater : extension || '.shp';
    const inferredTheater = building && value(art, 'NewTheater') === undefined;
    // Keep an explicit Image filename first when only the building context supplies
    // theater naming. Explicit NewTheater=no disables this fallback.
    if (inferredTheater) {
        names.push(stem + suffix);
    }
    if ((yes(value(art, 'NewTheater')) || inferredTheater) && stem.length > 1) {
        names.push(stem[0] + (theaterCode[theater] ?? 'T') + stem.slice(2) + suffix);
        names.push(stem[0] + 'G' + stem.slice(2) + suffix);
    }
    names.push(stem + suffix);
    const candidates: ResourceCandidate[] = [];
    for (const name of [...new Set(names)]) {
        candidates.push(...(await resources.find(origin, name)));
    }
    return {
        names: [...new Set(names)],
        candidates: [...new Map(candidates.map((candidate) => [candidate.uri.toString(), candidate])).values()],
    };
}

/** A bounded scene graph preserves provenance and missing layers instead of silently substituting images. */
export async function resolveSpriteScene(
    ini: ProjectIni,
    resources: ProjectResources,
    origin: vscode.Uri,
    artName: string,
    kind: SpriteSceneRecipe['kind'],
    options: MediaOptions
): Promise<SpriteSceneRecipe> {
    const art = ini.effective(origin, artName, 'art');
    const recipe: SpriteSceneRecipe = { kind, foundation: [], trace: [], layers: [] };
    const foundation = value(art, 'Foundation') ?? '';
    const size = /^(\d+)x(\d+)$/i.exec(foundation);
    if (size) {
        for (let x = 0; x < Math.min(32, Number(size[1])); x++) {
            for (let y = 0; y < Math.min(32, Number(size[2])); y++) {
                recipe.foundation.push([x, y]);
            }
        }
    } else if (/^custom$/i.test(foundation)) {
        for (const property of art.values()) {
            if (/^Foundation\.\d+$/i.test(property.key)) {
                const cell = property.value.split(',').map(Number);
                if (cell.length === 2 && cell.every(Number.isFinite) && recipe.foundation.length < 1024) {
                    recipe.foundation.push(cell);
                }
            }
        }
    }
    const seen = new Set<string>();
    const add = async (
        name: string,
        tag: string,
        state: SpriteLayer['state'],
        owner: Map<string, EffectiveProperty>,
        depth = 0
    ) => {
        const identity = tag + ':' + name.toLowerCase();
        if (seen.has(identity)) {
            return;
        }
        if (recipe.layers.length >= 32 || depth > 8) {
            recipe.trace.push(localize('workbench.sceneLimit', '{0} → {1}: scene traversal limit reached.', tag, name));
            return;
        }
        seen.add(identity);
        const properties =
            tag === 'body' || tag.toLowerCase() === 'buildup' ? owner : ini.effective(origin, name, 'art');
        const base = tag.toLowerCase() === 'buildup' ? name : (value(properties, 'Image') ?? name);
        const resolved = await spriteCandidates(
            resources,
            origin,
            base,
            properties.size ? properties : owner,
            kind === 'building'
        );
        const candidate = resolved.candidates[0];
        const number = (key: string, fallback = 0) => {
            const parsed = Number(value(owner, key));
            return Number.isFinite(parsed) ? parsed : fallback;
        };
        const layer: Omit<SpriteLayer, 'media'> = {
            id: identity,
            name,
            tag,
            state,
            source: candidate ? resources.label(origin, candidate.uri) : resolved.names.join(' / '),
            offset: [number(tag + 'X'), number(tag + 'Y') + (Number(value(properties, 'YDrawOffset')) || 0)],
            z: number(tag + 'ZAdjust'),
            start: Math.max(0, Number(value(properties, 'LoopStart') ?? value(properties, 'Start') ?? 0) || 0),
            end: Number(value(properties, 'LoopEnd') ?? value(properties, 'End') ?? -1),
        };
        recipe.layers.push({
            layer,
            candidate,
            options: {
                ...options,
                scene: undefined,
                actions: [],
                animation: tag !== 'body' || kind === 'animation',
                shadow: yes(value(properties, 'Shadow') ?? (kind === 'building' ? 'yes' : 'no')),
                paletteName: value(properties, 'CustomPalette') ?? options.paletteName,
            },
        });
        recipe.trace.push(
            localize(
                candidate ? 'workbench.layerResolved' : 'workbench.layerMissing',
                candidate ? '{0} → {1} → {2}' : '{0} → {1} → missing: {2}',
                tag,
                name,
                layer.source
            )
        );
        if (kind === 'animation') {
            for (const key of ['ConcurrentAnim', 'Next']) {
                const next = value(properties, key);
                for (const member of next
                    ?.split(',')
                    .map((item) => item.trim())
                    .filter(Boolean) ?? []) {
                    if (!seen.has(key + ':' + member.toLowerCase())) {
                        await add(member, key, key === 'Next' ? 'next' : state, properties, depth + 1);
                    }
                }
            }
        }
    };
    await add(artName, 'body', 'normal', art);
    if (kind === 'building') {
        for (const entry of art.values()) {
            if (
                /^(ActiveAnim(?:Two|Three|Four)?|IdleAnim|ProductionAnim|SpecialAnim|SuperAnim)(Damaged)?$/i.test(
                    entry.key
                )
            ) {
                await add(
                    entry.value,
                    entry.key,
                    /damaged$/i.test(entry.key)
                        ? 'damaged'
                        : /production/i.test(entry.key)
                          ? 'production'
                          : /idle/i.test(entry.key)
                            ? 'idle'
                            : 'normal',
                    art
                );
            }
        }
        const buildup = value(art, 'Buildup');
        if (buildup) {
            await add(buildup, 'Buildup', 'construction', art);
        }
    }
    for (const entry of art.values()) {
        if (/^(TurretAnim|BibShape|AlphaImage|PowerUp\d+Anim)$/i.test(entry.key)) {
            recipe.trace.push(
                localize(
                    'workbench.layerUnsupported',
                    '{0}={1}: separate effect, not composed in this preview.',
                    entry.key,
                    entry.value
                )
            );
        }
    }
    return recipe;
}
