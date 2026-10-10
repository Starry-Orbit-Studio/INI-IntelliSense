import * as vscode from 'vscode';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { IniDocument, INIManager } from '../parser';
import { SchemaManager } from '../schema-manager';
import { FileTypeManager } from '../file-type-manager';
import { ProjectResources, ResourceCandidate } from '../resources/project-resources';
import { MediaService, MediaOptions } from '../media/media-service';
import { parseSequenceAction, validateSequence, isShpFilename } from '../media/shp';
import { BagSample } from '../media/audio';
import { localize } from '../i18n';
import { ProjectIni, EffectiveProperty } from './project-ini';
import { SemanticReferences, SemanticRule } from './semantic-reference';
import { parsePropertyLine, valueAtCharacter, soundValueAtCharacter } from './ini-position';
import { Inspection, ActionEdit, PointEdit, SourceLink } from './workbench-protocol';
import { resolveSpriteScene, spriteCandidates } from './sprite-scene';

export interface EditCapability {
    uri: vscode.Uri;
    section: string;
    key: string;
    original?: string;
    version: number;
    kind: 'point' | 'sequence' | 'light' | 'reference';
    linked?: { key: string; original?: string };
}
export interface InspectionSession {
    inspection: Inspection;
    origin: vscode.Uri;
    position: vscode.Position;
    assets: Map<string, { candidate: ResourceCandidate; options: MediaOptions }>;
    links: Map<string, vscode.Location>;
    edits: Map<string, EditCapability>;
    options: MediaOptions;
    selected?: string;
    replacement?: {
        uri: vscode.Uri;
        version: number;
        range: vscode.Range;
        original: string;
        category?: string;
        extension?: string;
        type?: string;
    };
}

/** Resolve references once; hover, inspector and resource editors share the result. */
export class InspectionService {
    public readonly ini: ProjectIni;
    private readonly semantics: SemanticReferences;
    constructor(
        public readonly resources: ProjectResources,
        private readonly media: MediaService,
        manager: INIManager,
        schema: SchemaManager,
        fileTypes: FileTypeManager
    ) {
        this.ini = new ProjectIni(resources, manager, schema, fileTypes);
        this.semantics = new SemanticReferences(schema);
    }

    /** Cheap classification for audits; binary work begins only for recognized references. */
    public async inspectResource(
        candidate: ResourceCandidate,
        token: vscode.CancellationToken
    ): Promise<InspectionSession | undefined> {
        await this.ini.load(candidate.uri);
        const base = path.posix.basename(candidate.name, path.posix.extname(candidate.name)).toLowerCase();
        const documents = this.ini.documents(candidate.uri);
        const art = documents
            .filter((doc) => this.ini.category(doc.uri) === 'art')
            .flatMap((doc) => doc.sections)
            .find(
                (section) =>
                    (
                        [...section.properties].find(([key]) => key.toLowerCase() === 'image')?.[1] ?? section.name
                    ).toLowerCase() === base
            );
        if (!art) {
            return undefined;
        }
        const owner = documents
            .filter((doc) => this.ini.category(doc.uri) === 'rules')
            .flatMap((doc) => doc.sections.map((section) => ({ doc, section })))
            .find(
                ({ section }) =>
                    (
                        [...section.properties].find(([key]) => key.toLowerCase() === 'image')?.[1] ?? section.name
                    ).toLowerCase() === art.name.toLowerCase()
            );
        if (!owner) {
            return undefined;
        }
        return this.inspect(
            await vscode.workspace.openTextDocument(owner.doc.uri),
            new vscode.Position(owner.section.startLine, 0),
            token
        );
    }

    /** Cheap classification for audits; binary work begins only for recognized references. */
    public isReference(document: vscode.TextDocument, line: number): boolean {
        const property = parsePropertyLine(document.lineAt(line).text);
        const section = this.ini.parse(document).getSectionAt(line);
        if (!property || !section) {
            return false;
        }
        const category = this.ini.category(document.uri);
        let type = this.ini.type(document.uri, section.name, category);
        if (category === 'art' && type === 'Unknown') {
            type = this.ownerTypeForArt(document.uri, section.name);
        }
        const rules = vscode.workspace
            .getConfiguration('ra2-ini-intellisense', document.uri)
            .get<SemanticRule[]>('media.semanticRules', []);
        const reference = this.semantics.resolve(
            type,
            category,
            property.key,
            this.ini.propertyType(type, property.key),
            property.value,
            rules
        );
        return !!reference && ['object', 'animation', 'sound', 'image', 'palette', 'sequence'].includes(reference.kind);
    }

    public async inspect(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<InspectionSession | undefined> {
        await this.ini.load(document.uri);
        if (token.isCancellationRequested) {
            return undefined;
        }
        const parsed = this.ini.parse(document);
        const section = parsed.getSectionAt(position.line);
        if (!section) {
            return undefined;
        }
        const category = this.ini.category(document.uri);
        let type = this.ini.type(document.uri, section.name, category);
        const properties = this.ini.effective(document.uri, section.name, category);
        const property = parsePropertyLine(document.lineAt(position.line).text);
        const element =
            property &&
            (category === 'sound' && property.key.toLowerCase() === 'sounds'
                ? soundValueAtCharacter(document.lineAt(position.line).text, property, position.character)
                : valueAtCharacter(property, position.character));
        let contextualSound = false;
        const configured = vscode.workspace
            .getConfiguration('ra2-ini-intellisense', document.uri)
            .get<SemanticRule[]>('media.semanticRules', []);
        let reference =
            property && position.character <= property.valueEnd
                ? this.semantics.resolve(
                      type,
                      category,
                      property.key,
                      this.ini.propertyType(type, property.key),
                      element?.value ?? property.value,
                      configured.filter((rule) => rule && typeof rule === 'object')
                  )
                : undefined;
        // Compatibility for dictionaries that do not yet type art sections.
        if (category === 'art' && type === 'Unknown') {
            type = this.ownerTypeForArt(document.uri, section.name);
            if (property) {
                reference = this.semantics.resolve(
                    type,
                    category,
                    property.key,
                    this.ini.propertyType(type, property.key),
                    element?.value ?? property.value,
                    configured
                );
            }
        }
        if (!reference && category === 'sound') {
            contextualSound = true;
            reference = { kind: 'sound', value: section.name, type: 'Sound' };
        }
        if (
            !reference &&
            category === 'art' &&
            [...section.properties.values()].some((val) => parseSequenceAction('', val))
        ) {
            const owner = this.ini
                .documents(document.uri)
                .filter((doc) => this.ini.category(doc.uri) === 'art')
                .flatMap((doc) => doc.sections)
                .find((item) =>
                    [...item.properties].some(
                        ([key, val]) =>
                            key.toLowerCase() === 'sequence' && val.toLowerCase() === section.name.toLowerCase()
                    )
                );
            if (owner) {
                reference = { kind: 'sequence', value: section.name };
            }
        }
        const targets =
            reference && !element && property && ['object', 'animation', 'image', 'palette'].includes(reference.kind)
                ? property.elements.filter((item) => item.value).map((item) => item.value)
                : [];
        if (reference && targets.length) {
            reference = { ...reference, value: targets[0] };
        }
        const inspection: Inspection = {
            id: randomUUID(),
            owner: section.name,
            type,
            focus: reference?.value ?? section.name,
            properties: [],
            sources: [],
            assets: [],
            paletteOptions: [],
            references: [],
            warnings: [],
        };
        const session: InspectionSession = {
            inspection,
            origin: document.uri,
            position,
            assets: new Map(),
            links: new Map(),
            edits: new Map(),
            options: {},
        };
        const source = (uri: vscode.Uri, line: number, label: string): SourceLink => {
            const id = randomUUID();
            session.links.set(id, new vscode.Location(uri, new vscode.Position(line, 0)));
            return { id, label };
        };
        if (
            property &&
            element &&
            (reference || (category === 'art' && property.key.toLowerCase() === 'image')) &&
            !contextualSound
        ) {
            const artImage = category === 'art' && property.key.toLowerCase() === 'image';
            const replacementCategory = artImage
                ? undefined
                : reference?.kind === 'sound'
                  ? 'sound'
                  : ['animation', 'sequence'].includes(reference?.kind ?? '') ||
                      (reference?.kind === 'object' && property.key.toLowerCase() === 'image')
                    ? 'art'
                    : reference?.kind === 'object'
                      ? 'rules'
                      : undefined;
            const extension = artImage
                ? /^(yes|true|1)$/i.test(properties.get('voxel')?.value ?? '')
                    ? '.vxl'
                    : '.shp'
                : reference?.kind === 'image' || reference?.kind === 'palette'
                  ? reference.extension
                  : undefined;
            if (replacementCategory || extension) {
                session.replacement = {
                    uri: document.uri,
                    version: document.version,
                    range: new vscode.Range(position.line, element.start, position.line, element.end),
                    original: element.value,
                    category: replacementCategory,
                    extension,
                    type: reference?.type,
                };
                inspection.canReplace = true;
            }
        }
        inspection.properties = [...properties.values()]
            .filter((item) => !/^\$?inherits$/i.test(item.key))
            .map((item) => ({
                key: item.key,
                value: item.value,
                inherited: item.inherited,
                source: source(
                    item.uri,
                    item.line,
                    item.section + ' · ' + path.posix.basename(item.uri.path) + ':' + (item.line + 1)
                ),
            }));
        inspection.sources = this.ini
            .sources(document.uri, section.name, category)
            .map((item) =>
                source(item.document.uri, item.section.startLine, path.posix.basename(item.document.uri.path))
            );
        for (const item of this.ini.incoming(document.uri, section.name)) {
            inspection.references.push(
                source(
                    item.uri,
                    item.line,
                    path.posix.basename(item.uri.path) + ':' + (item.line + 1) + ' · ' + item.key
                )
            );
        }
        const value = (values: Map<string, EffectiveProperty>, key: string): string | undefined =>
            values.get(key.toLowerCase())?.value;
        const add = (candidate: ResourceCandidate, options: MediaOptions): string => {
            const id = randomUUID();
            session.assets.set(id, { candidate, options });
            inspection.assets.push({
                id,
                name: candidate.name,
                source: this.resources.label(document.uri, candidate.uri),
                priority: candidate.priority,
                role: candidate.role,
            });
            return id;
        };
        const capability = async (
            name: string,
            key: string,
            kind: EditCapability['kind'],
            original?: EffectiveProperty
        ): Promise<string | undefined> => {
            const own =
                this.ini.sources(document.uri, name, 'art')[0] ?? this.ini.sources(document.uri, name, category)[0];
            const uri = original && !original.inherited ? original.uri : own?.document.uri;
            if (!uri) {
                return undefined;
            }
            const text = await vscode.workspace.openTextDocument(uri);
            const id = randomUUID();
            session.edits.set(id, {
                uri,
                section: name,
                key,
                original: original?.inherited ? undefined : original?.value,
                version: text.version,
                kind,
            });
            return id;
        };

        let image = value(properties, 'Image') ?? section.name;
        let artName = category === 'art' ? section.name : image;
        let targetType = type;
        let targetProperties = properties;
        if (reference && (reference.kind === 'object' || reference.kind === 'animation')) {
            // An Image key already points to art; another object reference starts at rules.
            const target = reference.value;
            targetProperties =
                property?.key.toLowerCase() === 'image'
                    ? properties
                    : this.ini.effective(document.uri, target, 'rules');
            image = property?.key.toLowerCase() === 'image' ? target : (value(targetProperties, 'Image') ?? target);
            artName = image;
            targetType =
                reference.kind === 'animation'
                    ? 'AnimType'
                    : property?.key.toLowerCase() === 'image'
                      ? type
                      : (reference.type ?? this.ini.type(document.uri, target, 'rules'));
        }
        let art = this.ini.effective(document.uri, artName, 'art');
        let base = value(art, 'Image') ?? image;
        const audioVisual = this.ini.effective(document.uri, 'AudioVisual', 'rules');
        const numbers = (text?: string): number[] => {
            const elements = text?.split(',').map((item) => item.trim()) ?? [];
            return elements.length && elements.every((item) => item.length && Number.isFinite(Number(item)))
                ? elements.map(Number)
                : [];
        };
        const light = numbers(value(audioVisual, 'VoxelLightSource'));
        const points: PointEdit[] = [];
        for (const entry of art.values()) {
            if (
                /^(PrimaryFireFLH|SecondaryFireFLH|ElitePrimaryFireFLH|EliteSecondaryFireFLH|Weapon\d+FLH)$/i.test(
                    entry.key
                )
            ) {
                const point = numbers(entry.value);
                const id = await capability(artName, entry.key, 'point', entry);
                if (point.length === 3 && id) {
                    points.push({ id, name: entry.key, value: point });
                }
            }
        }
        const options: MediaOptions = {
            origin: document.uri,
            animation: reference?.kind === 'animation' || this.semantics.inherits(targetType, 'AnimType'),
            shadow: /^(yes|true|1)$/i.test(
                value(art, 'Shadow') ??
                    value(targetProperties, 'Shadow') ??
                    (['InfantryType', 'BuildingType'].includes(targetType) ? 'yes' : 'no')
            ),
            points,
            light: light.length === 3 ? light : undefined,
            fixed: /^(yes|true|1)$/i.test(value(audioVisual, 'UseFixedVoxelLighting') ?? ''),
            turret: /^(yes|true|1)$/i.test(
                value(
                    category === 'art'
                        ? this.ini.effective(
                              document.uri,
                              this.ownerNameForArt(document.uri, artName) ?? artName,
                              'rules'
                          )
                        : targetProperties,
                    'Turret'
                ) ?? ''
            ),
            turretOffset: numbers(value(art, 'TurretOffset')),
        };
        const customPalette = value(art, 'CustomPalette') ?? value(art, 'Palette');
        if (property && /^(cameo|altcameo)$/i.test(property.key)) {
            options.paletteName = 'cameo.pal';
        }
        if (customPalette) {
            const theater = vscode.workspace
                .getConfiguration('ra2-ini-intellisense', document.uri)
                .get<string>('media.theater', 'tem');
            options.paletteName =
                customPalette.replace(/~~~/g, theater) + (/\.pal$/i.test(customPalette) ? '' : '.pal');
        }
        session.options = options;
        if (reference?.kind === 'lighting' || reference?.kind === 'flh') {
            inspection.focus = property!.key;
        }
        const lightSource = audioVisual.get('voxellightsource');
        const lightOwner = this.ini.sources(document.uri, 'AudioVisual', 'rules')[0];
        if (lightOwner) {
            const lightDoc = await vscode.workspace.openTextDocument(lightOwner.document.uri);
            const ownSection = new IniDocument(lightDoc.uri, lightDoc.getText()).getSection(lightOwner.section.name);
            const id = randomUUID();
            session.edits.set(id, {
                uri: lightDoc.uri,
                section: 'AudioVisual',
                key: 'VoxelLightSource',
                original: lightSource?.value,
                version: lightDoc.version,
                kind: 'light',
                linked: {
                    key: 'UseFixedVoxelLighting',
                    original:
                        ownSection &&
                        [...ownSection.properties].find(([key]) => key.toLowerCase() === 'usefixedvoxellighting')?.[1],
                },
            });
            inspection.lightEdit = id;
        }
        if (reference?.kind === 'sound') {
            const events = (
                contextualSound
                    ? [section.name]
                    : element
                      ? [element.value]
                      : property && reference.value !== section.name
                        ? property.elements.map((item) => item.value)
                        : [reference.value]
            ).filter(Boolean);
            for (const event of events) {
                const missing: string[] = [];
                const sound = this.ini.effective(document.uri, event, 'sound');
                const samples =
                    contextualSound && property?.key.toLowerCase() === 'sounds' && element
                        ? [element.value]
                        : (value(sound, 'Sounds') ?? '').split(/[\s,]+/).filter(Boolean);
                if (contextualSound && element && property?.key.toLowerCase() === 'sounds') {
                    inspection.focus = element.value;
                }
                if (!samples.length) {
                    inspection.warnings.push(localize('workbench.noSamples', 'No samples are defined for {0}.', event));
                }
                for (const sampleName of samples) {
                    const found = await this.media.samples(document.uri, sampleName);
                    if (!found.length) {
                        missing.push(sampleName);
                    }
                    for (const item of found) {
                        const rawVolume = value(sound, 'Volume') ?? '100';
                        const parsedVolume = Number(rawVolume.replace(/%$/, ''));
                        const volume = parsedVolume > 1 || /%$/.test(rawVolume) ? parsedVolume / 100 : parsedVolume;
                        add(item.candidate, {
                            sample: item.sample,
                            volume: Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 1,
                            loop: /\b(loop|loops)\b/i.test(value(sound, 'Control') ?? ''),
                        });
                    }
                }
                if (missing.length) {
                    inspection.warnings.push(
                        localize(
                            'workbench.missingSamples',
                            'Samples not found for {0}: {1}',
                            event,
                            missing.join(', ')
                        ),
                        ...this.media.audioDiagnostics(document.uri)
                    );
                }
                for (const item of this.ini.sources(document.uri, event, 'sound')) {
                    inspection.sources.push(
                        source(
                            item.document.uri,
                            item.section.startLine,
                            event + ' · ' + path.posix.basename(item.document.uri.path)
                        )
                    );
                }
            }
        } else {
            const direct = reference?.kind === 'image' || reference?.kind === 'palette';
            if (direct) {
                base = reference!.value;
            }
            if (reference?.kind === 'sequence') {
                const owner = this.ini
                    .documents(document.uri)
                    .flatMap((doc) => doc.sections)
                    .find((item) =>
                        [...item.properties].some(
                            ([key, val]) => key.toLowerCase() === 'sequence' && val === reference!.value
                        )
                    );
                if (owner) {
                    artName = owner.name;
                    art = this.ini.effective(document.uri, artName, 'art');
                    base = value(art, 'Image') ?? artName;
                }
            }
            const voxel = /^(yes|true|1)$/i.test(value(art, 'Voxel') ?? '');
            const filename = path.posix.extname(base)
                ? base
                : base +
                  (direct
                      ? category === 'art' && property?.key.toLowerCase() === 'image' && voxel
                          ? '.vxl'
                          : (reference!.extension ?? '.shp')
                      : voxel
                        ? '.vxl'
                        : '.shp');
            const sceneKind =
                !direct || property?.key.toLowerCase() === 'image'
                    ? this.semantics.inherits(targetType, 'BuildingType')
                        ? 'building'
                        : options.animation
                          ? 'animation'
                          : undefined
                    : undefined;
            const resolved =
                !voxel && isShpFilename(filename)
                    ? await spriteCandidates(
                          this.resources,
                          document.uri,
                          base,
                          art,
                          this.semantics.inherits(targetType, 'BuildingType')
                      )
                    : { names: [filename], candidates: await this.resources.find(document.uri, filename, token) };
            const found = resolved.candidates;
            if (sceneKind) {
                options.scene = await resolveSpriteScene(
                    this.ini,
                    this.resources,
                    document.uri,
                    artName,
                    sceneKind,
                    options
                );
            }
            for (const entry of art.values()) {
                inspection.sources.push(source(entry.uri, entry.line, artName + ' · ' + entry.key));
            }
            for (const candidate of found) {
                add(candidate, options);
            }
            for (const target of targets.slice(1, 32)) {
                const targetRules = this.ini.effective(document.uri, target, 'rules');
                const targetArtName = value(targetRules, 'Image') ?? target;
                const targetArt = this.ini.effective(document.uri, targetArtName, 'art');
                const targetBase = direct ? target : (value(targetArt, 'Image') ?? targetArtName);
                const targetVoxel = /^(yes|true|1)$/i.test(value(targetArt, 'Voxel') ?? '');
                const targetFile = path.posix.extname(targetBase)
                    ? targetBase
                    : targetBase + (direct ? (reference!.extension ?? '.shp') : targetVoxel ? '.vxl' : '.shp');
                for (const candidate of await this.resources.find(document.uri, targetFile, token)) {
                    add(candidate, { ...options, actions: undefined, points: [], turret: false });
                }
            }
            if (!found.length) {
                inspection.warnings.push(
                    localize('workbench.missingResource', 'Resource not found: {0}', resolved.names.join(' / '))
                );
            }
            const sequenceName = reference?.kind === 'sequence' ? reference.value : value(art, 'Sequence');
            if (sequenceName) {
                const sequence = this.ini.effective(document.uri, sequenceName, 'art');
                const users = this.ini
                    .documents(document.uri)
                    .flatMap((doc) => doc.sections)
                    .filter((item) =>
                        [...item.properties].some(
                            ([key, val]) =>
                                key.toLowerCase() === 'sequence' && val.toLowerCase() === sequenceName.toLowerCase()
                        )
                    ).length;
                const actions: ActionEdit[] = [];
                for (const entry of sequence.values()) {
                    const action = parseSequenceAction(entry.key, entry.value);
                    const id = action && (await capability(sequenceName, entry.key, 'sequence', entry));
                    if (action && id) {
                        actions.push({ id, action, users, valid: true });
                    }
                }
                options.actions = actions;
            }
            const cameo = value(art, 'Cameo') ?? value(properties, 'Cameo');
            if (cameo) {
                const file = (
                    await this.resources.find(document.uri, path.posix.extname(cameo) ? cameo : cameo + '.shp', token)
                )[0];
                if (file) {
                    try {
                        inspection.cameo = await this.media.load(
                            file,
                            { paletteName: 'cameo.pal', origin: document.uri },
                            token
                        );
                    } catch (error) {
                        inspection.warnings.push(
                            localize('workbench.cameoError', 'Cameo could not be decoded: {0}', String(error))
                        );
                    }
                }
            }
        }
        const palettes = await this.resources.list(document.uri, ['.pal']);
        inspection.paletteOptions = palettes.map((candidate) => {
            const id = randomUUID();
            session.assets.set(id, { candidate, options: {} });
            return {
                id,
                name: candidate.name,
                source: this.resources.label(document.uri, candidate.uri),
                priority: candidate.priority,
                role: candidate.role,
            };
        });
        if (inspection.assets.length) {
            await this.select(session, inspection.assets[0].id, token);
        }
        return session;
    }

    private ownerNameForArt(origin: vscode.Uri, name: string): string | undefined {
        const owners = this.ini
            .documents(origin)
            .filter((doc) => this.ini.category(doc.uri) === 'rules')
            .flatMap((doc) => doc.sections);
        const owner = owners.find((section) => {
            const image = [...section.properties].find(([key]) => key.toLowerCase() === 'image')?.[1] ?? section.name;
            return image.toLowerCase() === name.toLowerCase();
        });
        return owner?.name;
    }

    private ownerTypeForArt(origin: vscode.Uri, name: string): string {
        const owner = this.ownerNameForArt(origin, name);
        return owner ? this.ini.type(origin, owner, 'rules') : 'Unknown';
    }

    public async select(
        session: InspectionSession,
        id: string,
        token: vscode.CancellationToken,
        paletteId?: string
    ): Promise<void> {
        const asset = session.assets.get(id);
        if (!asset) {
            return;
        }
        const palette = paletteId && session.assets.get(paletteId)?.candidate.uri;
        const options = { ...asset.options, ...(palette ? { palette } : {}) };
        try {
            const media = await this.media.load(asset.candidate, options, token);
            if (token.isCancellationRequested) {
                return;
            }
            if (media.kind === 'sprite') {
                for (const action of media.actions) {
                    action.valid = validateSequence(action.action, media.file.frames.length, 8);
                    if (!action.valid) {
                        session.inspection.warnings.push(
                            localize(
                                'workbench.actionBounds',
                                'Action {0} exceeds the available sprite frames.',
                                action.action.name
                            )
                        );
                    }
                }
            }
            session.selected = id;
            session.inspection.selectedAsset = id;
            session.inspection.selectedPalette = paletteId;
            session.inspection.mediaRevision = (session.inspection.mediaRevision ?? 0) + 1;
            session.inspection.media = media;
        } catch (error) {
            if (token.isCancellationRequested) {
                return;
            }
            session.inspection.media = undefined;
            session.inspection.warnings.push(
                localize(
                    'workbench.decodeError',
                    'Preview failed: {0}',
                    error instanceof Error ? error.message : String(error)
                )
            );
        }
    }
}
