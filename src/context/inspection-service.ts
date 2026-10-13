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
import { SemanticReferences, SemanticRule, SemanticReference } from './semantic-reference';
import { parsePropertyLine, valueAtCharacter, soundValueAtCharacter } from './ini-position';
import { Inspection, ActionEdit, PointEdit, SourceLink } from './workbench-protocol';
import { resolveSpriteScene, spriteCandidates } from './sprite-scene';
import { artPaletteName, paletteName } from '../media/palette-policy';
import { spriteRemap, SpriteRole } from '../media/sprite-remap';
import { projectLighting } from '../media/project-lighting';
import { PropertyEditTarget } from './property-edit';
import { CatalogObject, objectCatalog } from './object-catalog';
import { catalogGroup } from './catalog-groups';
import { inspectMap } from './map-inspection';

export interface EditCapability {
    uri: vscode.Uri;
    section: string;
    key: string;
    original?: string;
    version: number;
    kind: 'point' | 'pixel' | 'sequence' | 'light' | 'reference';
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
    propertyEdits?: Map<string, PropertyEditTarget>;
    objects?: Map<string, CatalogObject>;
    isCurrent?: () => boolean;
}

/** Resolve references once; hover, inspector and resource editors share the result. */
export class InspectionService implements vscode.Disposable {
    public readonly ini: ProjectIni;
    private readonly semantics: SemanticReferences;
    private readonly previewTheaters = new Map<string, string>();
    private readonly previewChanged = new vscode.EventEmitter<vscode.Uri>();
    public readonly onDidChangePreview = this.previewChanged.event;
    constructor(
        public readonly resources: ProjectResources,
        private readonly media: MediaService,
        manager: INIManager,
        private readonly schema: SchemaManager,
        fileTypes: FileTypeManager,
        private readonly translate: (key: string) => string | undefined = () => undefined
    ) {
        this.ini = new ProjectIni(resources, manager, schema, fileTypes);
        this.semantics = new SemanticReferences(schema);
    }

    /** A project-scoped preview preference shared by hover, decorations and all workbench views. */
    public setPreviewTheater(origin: vscode.Uri, theater: string): void {
        if (!['tem', 'sno', 'urb', 'ubn', 'lun', 'des'].includes(theater)) {
            return;
        }
        const key = this.resources.projectRoot(origin).toString();
        if (this.previewTheaters.get(key) === theater) {
            return;
        }
        this.previewTheaters.set(key, theater);
        this.previewChanged.fire(origin);
    }

    /** Dictionary rules win; unknown keys can reference media declared in the project's registries. */
    private resolveReference(
        origin: vscode.Uri,
        owner: string,
        category: string,
        key: string,
        type: string | undefined,
        value: string,
        custom: SemanticRule[]
    ): SemanticReference | undefined {
        return this.semantics.resolve(owner, category, key, type, value, custom, (target) => {
            if (this.ini.sources(origin, target, 'rules').length || this.ini.sources(origin, target, 'art').length) {
                return this.ini.type(origin, target, 'rules');
            }
            return this.ini.sources(origin, target, 'sound').length ? 'Sound' : undefined;
        });
    }

    public dispose(): void {
        this.previewChanged.dispose();
        this.previewTheaters.clear();
    }

    public async catalog(origin: vscode.Uri, token: vscode.CancellationToken): Promise<InspectionSession> {
        await this.ini.load(origin);
        const snapshot = this.ini.snapshot(origin);
        const objects = await objectCatalog(this.ini, this.schema, origin, token, this.translate);
        if (!snapshot.isCurrent()) {
            throw new Error(
                localize('workbench.staleEdit', 'The document changed. Refresh the preview before applying this edit.')
            );
        }
        const columns = vscode.workspace
            .getConfiguration('ra2-ini-intellisense', origin)
            .get<string[]>('project.objectColumns', ['Strength', 'Cost', 'Speed', 'Armor']);
        const safeColumns = [
            ...new Set(columns.filter((key) => typeof key === 'string' && /^[\w.$-]+$/.test(key))),
        ].slice(0, 12);
        const session: InspectionSession = {
            origin,
            position: new vscode.Position(0, 0),
            assets: new Map(),
            links: new Map(),
            edits: new Map(),
            options: {},
            objects: new Map(),
            isCurrent: snapshot.isCurrent,
            inspection: {
                id: randomUUID(),
                owner: localize('workbench.objects', 'Project objects'),
                type: '',
                focus: '',
                properties: [],
                sources: [],
                assets: [],
                paletteOptions: [],
                references: [],
                warnings: [],
                resolution: this.ini.context(origin),
                objects: [],
                objectColumns: safeColumns,
            },
        };
        for (const object of objects) {
            const id = randomUUID();
            session.objects!.set(id, object);
            const source = object.source;
            session.links.set(
                id,
                new vscode.Location(source.document.uri, new vscode.Position(source.section.startLine, 0))
            );
            session.inspection.objects!.push({
                id,
                name: object.name,
                group: catalogGroup(object),
                label: object.label,
                category: object.category,
                type: object.type,
                source: this.resources.label(origin, source.document.uri) + ':' + (source.section.startLine + 1),
                definitions: object.definitions,
                values: Object.fromEntries(
                    safeColumns.map((key) => [key, object.properties.get(key.toLowerCase())?.effective.value ?? ''])
                ),
            });
        }
        return session;
    }

    public propertyDefinition(type: string, key: string) {
        const definition = this.schema.getProperty(type, key);
        return {
            definition,
            limits: definition && this.schema.getNumberLimit(definition.type),
            strings: definition && this.schema.getStringLimit(definition.type),
        };
    }

    public async projectMediaOptions(origin: vscode.Uri): Promise<MediaOptions> {
        await this.ini.load(origin);
        const properties = this.ini.effective(origin, 'AudioVisual', 'rules');
        return {
            origin,
            ...projectLighting(
                properties.get('voxellightsource')?.value,
                properties.get('usefixedvoxellighting')?.value
            ),
        };
    }

    /** Return every matching declaration; raw file previews must not infer a unique owner from the first match. */
    public async resourceOwners(
        candidate: ResourceCandidate,
        token: vscode.CancellationToken
    ): Promise<{ uri: vscode.Uri; position: vscode.Position; label: string; category: string }[]> {
        await this.ini.load(candidate.uri);
        const base = path.posix.basename(candidate.name, path.posix.extname(candidate.name)).toLowerCase();
        const name = candidate.name.toLowerCase();
        const documents = this.ini.documents(candidate.uri);
        const result: { uri: vscode.Uri; position: vscode.Position; label: string; category: string }[] = [];
        const artNames = new Set<string>();
        for (const doc of documents) {
            if (this.ini.category(doc.uri) !== 'art') {
                continue;
            }
            for (const section of doc.sections) {
                const image =
                    [...section.properties].find(([key]) => key.toLowerCase() === 'image')?.[1] ?? section.name;
                if (image.toLowerCase() === base || image.toLowerCase() === name) {
                    artNames.add(section.name.toLowerCase());
                }
            }
        }
        for (const doc of documents) {
            if (token.isCancellationRequested) {
                return [];
            }
            for (const section of doc.sections) {
                const image =
                    [...section.properties].find(([key]) => key.toLowerCase() === 'image')?.[1] ?? section.name;
                const category = this.ini.category(doc.uri);
                const matches =
                    (category === 'art' && artNames.has(section.name.toLowerCase())) ||
                    (category === 'rules' && artNames.has(image.toLowerCase())) ||
                    [...section.properties].some(
                        ([key, value]) =>
                            /^(image|cameo|altcameo|bibshape|turretanim|buildup|palette|filename)$/i.test(key) &&
                            value.split(',').some((part) => [base, name].includes(part.trim().toLowerCase()))
                    );
                if (matches) {
                    result.push({
                        category,
                        uri: doc.uri,
                        position: new vscode.Position(section.startLine, 0),
                        label: '[' + section.name + '] · ' + this.resources.label(candidate.uri, doc.uri),
                    });
                }
            }
        }
        return result;
    }

    /** Cheap classification for audits; binary work begins only for recognized references. */
    public async inspectResource(
        candidate: ResourceCandidate,
        token: vscode.CancellationToken,
        selectedTheater?: string
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
            const document = documents.find((doc) => doc.sections.includes(art));
            return document
                ? this.inspect(
                      await vscode.workspace.openTextDocument(document.uri),
                      new vscode.Position(art.startLine, 0),
                      token,
                      selectedTheater
                  )
                : undefined;
        }
        return this.inspect(
            await vscode.workspace.openTextDocument(owner.doc.uri),
            new vscode.Position(owner.section.startLine, 0),
            token,
            selectedTheater
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
        const reference = this.resolveReference(
            document.uri,
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
        token: vscode.CancellationToken,
        selectedTheater?: string
    ): Promise<InspectionSession | undefined> {
        selectedTheater ??= this.previewTheaters.get(this.resources.projectRoot(document.uri).toString());
        if (/\.(map|mpr|yrm)$/i.test(document.uri.path)) {
            return inspectMap(document, position);
        }
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
                ? this.resolveReference(
                      document.uri,
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
                reference = this.resolveReference(
                    document.uri,
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
            resolution: this.ini.context(document.uri),
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
        session.propertyEdits = new Map();
        const definitions = this.schema.getAllKeysForType(type);
        const ownerSources = this.ini.sources(document.uri, section.name, category);
        const editSection = parsed.sections
            .filter((item) => item.name.toLowerCase() === section.name.toLowerCase())
            .at(-1)!;
        const localKeys = new Set([...editSection.properties.keys()].map((key) => key.toLowerCase()));
        const editSource = source(
            document.uri,
            editSection.startLine,
            section.name + ' · ' + path.posix.basename(document.uri.path) + ':' + (editSection.startLine + 1)
        );
        inspection.properties = [...this.ini.explain(document.uri, section.name, category).values()]
            .filter(({ effective }) => !/^\$?inherits$/i.test(effective.key))
            .map(({ effective: item, declarations }) => {
                const definition = this.schema.getProperty(type, item.key);
                const limits = definition && this.schema.getNumberLimit(definition.type);
                const strings = definition && this.schema.getStringLimit(definition.type);
                const editable =
                    ['file', 'vscode-remote', 'untitled'].includes(document.uri.scheme) &&
                    ownerSources[0]?.document.uri.toString() === document.uri.toString();
                const editId = editable ? randomUUID() : undefined;
                if (editId) {
                    session.propertyEdits!.set(editId, {
                        uri: document.uri,
                        version: document.version,
                        section: section.name,
                        sectionLine: editSection.startLine,
                        key: item.key,
                        valueType: definition?.type,
                        minimum: limits?.min,
                        maximum: limits?.max,
                        allowedValues: strings?.limitIn,
                        caseSensitive: strings?.caseSensitive,
                    });
                }
                const links = declarations.map((declaration, index) => ({
                    value: declaration.value,
                    via: declaration.via,
                    effective: index === 0,
                    source: source(
                        declaration.uri,
                        declaration.line,
                        declaration.section +
                            ' · ' +
                            path.posix.basename(declaration.uri.path) +
                            ':' +
                            (declaration.line + 1)
                    ),
                }));
                return {
                    key: item.key,
                    value: item.value,
                    inherited: item.inherited,
                    source: links[0].source,
                    declarations: links,
                    editId,
                    editSource,
                    local: localKeys.has(item.key.toLowerCase()),
                    valueType: definition?.type,
                    minimum: limits?.min,
                    maximum: limits?.max,
                    allowedValues: strings?.limitIn,
                };
            });
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
        if (reference && ['object', 'animation'].includes(reference.kind)) {
            inspection.focusType = targetType;
        }
        let base = value(art, 'Image') ?? image;
        const audioVisual = this.ini.effective(document.uri, 'AudioVisual', 'rules');
        const numbers = (text?: string): number[] => {
            const elements = text?.split(',').map((item) => item.trim()) ?? [];
            return elements.length && elements.every((item) => item.length && Number.isFinite(Number(item)))
                ? elements.map(Number)
                : [];
        };
        const lighting = projectLighting(
            value(audioVisual, 'VoxelLightSource'),
            value(audioVisual, 'UseFixedVoxelLighting')
        );
        const points: PointEdit[] = [];
        for (const entry of art.values()) {
            if (
                /^(?:(?:Elite)?(?:Primary|Secondary)(?:Fire|Crawling|Prone)FLH|(?:Elite)?Weapon\d+FLH|AlternateFLH\d+)(?:\.Burst\d+)?$/i.test(
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
            ...lighting,
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
        const contextRules =
            category === 'art'
                ? this.ini.effective(document.uri, this.ownerNameForArt(document.uri, artName) ?? artName, 'rules')
                : targetProperties;
        const fireAngle = Number(value(contextRules, 'FireAngle'));
        options.fireAngle = Number.isFinite(fireAngle) ? Math.max(0, Math.min(64, fireAngle)) : undefined;
        const theater =
            selectedTheater ??
            vscode.workspace.getConfiguration('ra2-ini-intellisense', document.uri).get<string>('media.theater', 'tem');
        options.theater = selectedTheater;
        inspection.theater = theater;
        const isCameo = property && /^(cameo|altcameo)(pcx)?$/i.test(property.key);
        const particle = this.semantics.inherits(targetType, 'ParticleType');
        const role: SpriteRole = isCameo
            ? 'cameo'
            : reference?.kind === 'image' && property?.key.toLowerCase() !== 'image'
              ? 'raw'
              : particle
                ? 'particle'
                : options.animation
                  ? 'animation'
                  : this.semantics.inherits(targetType, 'TechnoType')
                    ? 'techno'
                    : 'raw';
        options.remap = spriteRemap(role, /^(yes|true|1)$/i.test(value(art, 'AltPalette') ?? ''));
        const particlePalette = particle ? value(targetProperties, 'Palette') : undefined;
        options.paletteName = particlePalette
            ? paletteName(particlePalette, theater, 'animation')
            : artPaletteName(
                  isCameo ? undefined : value(art, 'CustomPalette'),
                  isCameo ? undefined : value(art, 'Palette'),
                  theater,
                  isCameo ? 'cameo' : particle || (options.animation && !options.remap) ? 'animation' : 'unit'
              );
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
                base =
                    reference?.kind === 'palette' && category === 'art' && property?.key.toLowerCase() === 'palette'
                        ? options.paletteName!
                        : reference!.value;
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
            const voxel =
                this.semantics.inherits(targetType, 'VoxelAnimType') ||
                /^(yes|true|1)$/i.test(value(art, 'Voxel') ?? '');
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
                          this.semantics.inherits(targetType, 'BuildingType'),
                          options.theater
                      )
                    : { names: [filename], candidates: await this.resources.find(document.uri, filename, token) };
            const found = resolved.candidates;
            if (sceneKind && !voxel) {
                options.scene = await resolveSpriteScene(
                    this.ini,
                    this.resources,
                    document.uri,
                    artName,
                    sceneKind,
                    options,
                    contextRules
                );
                if (sceneKind === 'building') {
                    const scenePoints: PointEdit[] = [];
                    for (let index = 0; index < 8; index++) {
                        const key = 'DamageFireOffset' + index;
                        const entry = art.get(key.toLowerCase());
                        const id = await capability(artName, key, 'pixel', entry);
                        const point = numbers(entry?.value);
                        if (id) {
                            scenePoints.push({
                                id,
                                name: key,
                                value: point.length === 2 ? point : [0, 0],
                                space: 'pixel',
                                absent: !entry,
                                deletable: !!entry && !entry.inherited,
                            });
                        }
                    }
                    options.scene.points = scenePoints;
                }
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
                const memberType = this.ini.type(document.uri, target, 'rules');
                const animation = reference?.kind === 'animation' || this.semantics.inherits(memberType, 'AnimType');
                const memberParticle = this.semantics.inherits(memberType, 'ParticleType');
                const remap = spriteRemap(
                    isCameo
                        ? 'cameo'
                        : direct
                          ? 'raw'
                          : memberParticle
                            ? 'particle'
                            : animation
                              ? 'animation'
                              : this.semantics.inherits(memberType, 'TechnoType')
                                ? 'techno'
                                : 'raw',
                    /^(yes|true|1)$/i.test(value(targetArt, 'AltPalette') ?? '')
                );
                const memberPalette = memberParticle ? value(targetRules, 'Palette') : undefined;
                const memberOptions: MediaOptions = {
                    ...options,
                    scene: undefined,
                    actions: undefined,
                    points: [],
                    turret: false,
                    turretOffset: undefined,
                    fireAngle: undefined,
                    animation,
                    remap,
                    paletteName: memberPalette
                        ? paletteName(memberPalette, theater, 'animation')
                        : artPaletteName(
                              isCameo ? undefined : value(targetArt, 'CustomPalette'),
                              isCameo ? undefined : value(targetArt, 'Palette'),
                              theater,
                              isCameo ? 'cameo' : memberParticle || (animation && !remap) ? 'animation' : 'unit'
                          ),
                    shadow: /^(yes|true|1)$/i.test(
                        value(targetArt, 'Shadow') ??
                            value(targetRules, 'Shadow') ??
                            (this.semantics.inherits(memberType, 'TechnoType') ? 'yes' : 'no')
                    ),
                };
                if (animation && !direct) {
                    memberOptions.scene = await resolveSpriteScene(
                        this.ini,
                        this.resources,
                        document.uri,
                        targetArtName,
                        'animation',
                        memberOptions,
                        targetRules
                    );
                }
                const targetBase = direct ? target : (value(targetArt, 'Image') ?? targetArtName);
                const targetVoxel =
                    this.semantics.inherits(this.ini.type(document.uri, target, 'rules'), 'VoxelAnimType') ||
                    /^(yes|true|1)$/i.test(value(targetArt, 'Voxel') ?? '');
                const targetFile = path.posix.extname(targetBase)
                    ? targetBase
                    : targetBase + (direct ? (reference!.extension ?? '.shp') : targetVoxel ? '.vxl' : '.shp');
                for (const candidate of await this.resources.find(document.uri, targetFile, token)) {
                    add(candidate, memberOptions);
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
            inspection.cameos = [];
            for (const tag of ['Cameo', 'AltCameo']) {
                const pcx = value(art, tag + 'PCX') ?? value(targetProperties, tag + 'PCX');
                const cameo = pcx ?? value(art, tag) ?? value(targetProperties, tag);
                if (!cameo || /^(none|<none>)$/i.test(cameo)) {
                    continue;
                }
                const file = (
                    await this.resources.find(
                        document.uri,
                        path.posix.extname(cameo) ? cameo : cameo + (pcx ? '.pcx' : '.shp'),
                        token
                    )
                )[0];
                if (file) {
                    try {
                        const media = await this.media.load(
                            file,
                            { paletteName: 'cameo.pal', origin: document.uri, remap: false },
                            token
                        );
                        inspection.cameos.push({ tag, media });
                        if (tag === 'Cameo') {
                            inspection.cameo = media;
                        }
                    } catch (error) {
                        inspection.warnings.push(
                            localize('workbench.cameoError', 'Cameo could not be decoded: {0}', String(error))
                        );
                    }
                }
            }
        }
        const palettes = reference?.kind === 'sound' ? [] : await this.resources.list(document.uri, ['.pal']);
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
        paletteId?: string,
        layerId?: string
    ): Promise<void> {
        const asset = session.assets.get(id);
        if (!asset) {
            return;
        }
        if (paletteId && !session.inspection.paletteOptions.some((option) => option.id === paletteId)) {
            return;
        }
        const palette = paletteId && session.assets.get(paletteId)?.candidate.uri;
        if (layerId) {
            const layer = asset.options.scene?.layers.find((entry) => entry.layer.id === layerId);
            if (!layer) {
                return;
            }
            layer.options.palette = palette || undefined;
            layer.layer.selectedPalette = paletteId;
        }
        const selectedPalette = layerId ? session.inspection.selectedPalette : paletteId;
        const rootPalette = selectedPalette && session.assets.get(selectedPalette)?.candidate.uri;
        const options = { ...asset.options, palette: rootPalette || undefined };
        if (options.scene) {
            options.scene = {
                ...options.scene,
                layers: options.scene.layers.map((entry) =>
                    entry.layer.tag === 'body' || (entry.layer.paletteInherited && !entry.layer.selectedPalette)
                        ? { ...entry, options: { ...entry.options, palette: rootPalette || undefined } }
                        : entry
                ),
            };
        }
        try {
            const media = await this.media.load(asset.candidate, options, token);
            if (token.isCancellationRequested) {
                return;
            }
            if (media.kind === 'sprite') {
                for (const action of media.actions) {
                    action.valid = validateSequence(
                        action.action,
                        media.shadow ? Math.floor(media.file.frames.length / 2) : media.file.frames.length,
                        8
                    );
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
            session.inspection.selectedPalette = selectedPalette;
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
