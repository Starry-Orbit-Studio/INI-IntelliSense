import * as vscode from 'vscode';
import { IniDocument, IniSection, INIManager } from '../parser';
import { SchemaManager } from '../schema-manager';
import { FileTypeManager } from '../file-type-manager';
import { ProjectResources } from '../resources/project-resources';
import { parsePropertyLine } from './ini-position';
import { TextContentService } from '../services/text-content-service';
import * as path from 'path';
import { PropertyResolution, resolveProperties, registryValues } from './property-resolution';
import { localize } from '../i18n';

export interface EffectiveProperty {
    key: string;
    value: string;
    uri: vscode.Uri;
    line: number;
    section: string;
    inherited: boolean;
}

export interface SectionSource {
    document: IniDocument;
    section: IniSection;
    category: string;
}

export interface ProjectResolutionContext {
    mode?: 'project' | 'standalone';
    compatibility?: string;
    configured: boolean;
    complete: boolean;
    documents: number;
    entries: string[];
    issues: string[];
}

/** Scoped queries use open document text first, including unsaved MIX documents. */
export class ProjectIni {
    private parsed = new Map<string, { version: number; document: IniDocument }>();
    private snapshots = new Map<string, IniDocument>();
    private categories = new Map<string, string>();
    private order = new Map<string, number>();
    private loaded = new Map<string, Promise<void>>();
    private generation = 0;
    private activeDocuments = new Map<string, Set<string>>();
    private dependencies = new Map<string, string[]>();
    private contexts = new Map<string, ProjectResolutionContext>();
    private typeIndexes = new Map<string, { sources: Map<string, SectionSource[]>; types: Map<string, string> }>();
    private queries = new Map<string, { signature: string[]; sources: Map<string, SectionSource[]> }>();
    private incomingQueries = new Map<
        string,
        { document: IniDocument; references: Map<string, { line: number; key: string }[]> }
    >();

    constructor(
        private readonly resources: ProjectResources,
        private readonly manager: INIManager,
        private readonly schema: SchemaManager,
        private readonly fileTypes: FileTypeManager
    ) {}

    public invalidate(): void {
        this.generation++;
        this.loaded.clear();
        this.snapshots.clear();
        this.categories.clear();
        this.order.clear();
        this.parsed.clear();
        this.queries.clear();
        this.typeIndexes.clear();
        this.incomingQueries.clear();
        this.activeDocuments.clear();
        this.dependencies.clear();
        this.contexts.clear();
    }

    /** Include edits alter the load graph; ordinary value edits use the open-document cache. */
    public documentChanged(document: vscode.TextDocument): void {
        const previous =
            this.snapshots.get(document.uri.toString()) ?? this.parsed.get(document.uri.toString())?.document;
        const include = (parsed: IniDocument) => JSON.stringify([...(parsed.getSection('#include')?.properties ?? [])]);
        if (previous && include(previous) !== include(new IniDocument(document.uri, document.getText()))) {
            this.invalidate();
        }
    }

    public async load(origin: vscode.Uri): Promise<void> {
        const generation = this.generation;
        const key = this.resources.projectRoot(origin).toString();
        let pending = this.loaded.get(key);
        if (!pending) {
            pending = this.resources
                .listDocuments(origin)
                .then(async (files) => {
                    const configuration = vscode.workspace
                        .getConfiguration('ra2-ini-intellisense', origin)
                        .get<Record<string, string[]>>('project.entryPoints', {});
                    const entries = Object.entries(configuration ?? {}).filter(
                        ([, values]) =>
                            Array.isArray(values) && values.some((value) => typeof value === 'string' && value.trim())
                    );
                    const context: ProjectResolutionContext = {
                        configured: entries.length > 0,
                        complete: entries.length > 0 || files.length <= 2000,
                        documents: 0,
                        entries: [],
                        issues: [],
                    };
                    if (!context.configured && files.length > 2000) {
                        context.issues.push(
                            localize(
                                'workbench.indexLimit',
                                'Only the first {0} INI files were indexed. Narrow the project resource roots.',
                                2000
                            )
                        );
                    }
                    const compatibility = vscode.workspace
                        .getConfiguration('ra2-ini-intellisense', origin)
                        .get<string>('project.compatibility', 'compatible');
                    context.compatibility = compatibility;
                    context.mode = 'project';
                    const reader = new TextContentService();
                    const readErrors = new Map<string, string>();
                    const canonical = (uri: vscode.Uri) =>
                        uri.scheme === 'file' && /^\/[a-z]:/i.test(uri.path)
                            ? uri.toString().toLowerCase()
                            : uri.toString();
                    const known = new Map(files.map((item) => [canonical(item.uri), item.uri]));
                    const names = new Map<string, vscode.Uri[]>();
                    for (const file of files) {
                        const name = file.name.toLowerCase();
                        names.set(name, [...(names.get(name) ?? []), file.uri]);
                    }
                    // The game's flat file lookup can find a root patch while its
                    // including INI lives in Rules. Relative matches remain first.
                    const includedUri = (parent: vscode.Uri, name: string): vscode.Uri | undefined => {
                        const normalized = name.replace(/\\/g, '/');
                        const relative = vscode.Uri.joinPath(
                            parent.with({ path: path.posix.dirname(parent.path) }),
                            normalized
                        );
                        const root = vscode.Uri.joinPath(this.resources.projectRoot(origin), normalized);
                        const exact = known.get(canonical(relative)) ?? known.get(canonical(root));
                        if (exact) {
                            return exact;
                        }
                        const matching = names.get(normalized.toLowerCase());
                        return matching?.length === 1 ? matching[0] : undefined;
                    };
                    const roots = entries.flatMap(([, values]) =>
                        values
                            .filter((value) => typeof value === 'string' && value.trim())
                            .map((value) =>
                                includedUri(
                                    vscode.Uri.joinPath(this.resources.projectRoot(origin), '__entry__.ini'),
                                    value
                                )
                            )
                            .filter((uri): uri is vscode.Uri => !!uri)
                    );
                    const reads = [
                        ...new Map(
                            [...roots, ...files.map((file) => file.uri)].map((uri) => [uri.toString(), uri])
                        ).values(),
                    ];
                    const queued = new Set(reads.map((uri) => uri.toString()));
                    for (let offset = 0; offset < Math.min(reads.length, 2000);) {
                        const batch = reads.slice(offset, Math.min(offset + 16, 2000));
                        await Promise.allSettled(
                            batch.map(async (uri) => {
                                try {
                                    const open = vscode.workspace.textDocuments.find(
                                        (document) => canonical(document.uri) === canonical(uri)
                                    );
                                    const content =
                                        open?.getText() ??
                                        reader.decode(await this.resources.read(uri, 8 * 1024 * 1024));
                                    if (generation === this.generation) {
                                        const parsed = new IniDocument(uri, content);
                                        this.snapshots.set(uri.toString(), parsed);
                                        {
                                            for (const name of parsed.getSection('#include')?.properties.values() ??
                                                []) {
                                                const child = includedUri(uri, name);
                                                if (child && !queued.has(child.toString())) {
                                                    queued.add(child.toString());
                                                    reads.push(child);
                                                }
                                            }
                                        }
                                    }
                                } catch (error) {
                                    readErrors.set(uri.toString(), String(error));
                                }
                            })
                        );
                        offset += batch.length;
                    }
                    if (context.configured && reads.length > 2000) {
                        context.complete = false;
                        context.issues.push(
                            localize(
                                'workbench.indexLimit',
                                'Only the first {0} INI files were indexed. Narrow the project resource roots.',
                                2000
                            )
                        );
                    }
                    if (generation !== this.generation) {
                        return;
                    }
                    const included = new Set<string>();
                    for (const file of files) {
                        const document = this.snapshots.get(file.uri.toString());
                        const children: string[] = [];
                        for (const name of document?.getSection('#include')?.properties.values() ?? []) {
                            const child = includedUri(file.uri, name);
                            if (child) {
                                included.add(child.toString());
                                children.push(child.toString());
                            }
                        }
                        this.dependencies.set(file.uri.toString(), compatibility === 'vanilla' ? [] : children);
                    }
                    let rank = 0;
                    const visited = new Set<string>();
                    const visit = (uri: vscode.Uri, category: string, depth = 0) => {
                        const key = uri.toString();
                        if (visited.has(key) || depth > 64 || !known.has(canonical(uri))) {
                            if (depth > 64) {
                                context.complete = false;
                                context.issues.push(uri.toString());
                            }
                            return;
                        }
                        if (!this.snapshots.has(key)) {
                            context.complete = false;
                            context.issues.push(
                                uri.toString() + (readErrors.has(key) ? ': ' + readErrors.get(key) : '')
                            );
                            return;
                        }
                        visited.add(key);
                        this.order.set(key, rank++);
                        this.categories.set(key, category);
                        for (const name of compatibility === 'vanilla'
                            ? []
                            : (this.snapshots.get(key)?.getSection('#include')?.properties.values() ?? [])) {
                            const child = includedUri(uri, name);
                            if (child) {
                                visit(child, category, depth + 1);
                            } else {
                                context.complete = false;
                                context.issues.push(uri.toString() + ' → ' + name);
                            }
                        }
                    };
                    if (context.configured) {
                        for (const [category, paths] of entries) {
                            for (const entry of paths.filter((value) => typeof value === 'string' && value.trim())) {
                                const root = this.resources.projectRoot(origin);
                                const candidate = includedUri(vscode.Uri.joinPath(root, '__entry__.ini'), entry);
                                context.entries.push(category + ': ' + entry);
                                if (candidate) {
                                    visit(candidate, category.toLowerCase());
                                } else {
                                    context.complete = false;
                                    context.issues.push(entry);
                                }
                            }
                        }
                        this.activeDocuments.set(key, new Set(visited));
                    } else {
                        const candidates = files.filter(
                            (file) => compatibility === 'vanilla' || !included.has(file.uri.toString())
                        );
                        for (const category of ['rules', 'art', 'sound', 'ai', 'eva', 'ui', 'theme']) {
                            const matching = candidates.filter(
                                (file) => this.fileTypes.getFileType(file.uri).toLowerCase() === category
                            );
                            const standard = files.find((file) =>
                                new RegExp('^' + category + '(md|es)?\\.ini$', 'i').test(file.name)
                            );
                            const reaches = (uri: string, target: string, seen = new Set<string>()): boolean => {
                                if (uri === target) {
                                    return true;
                                }
                                if (seen.has(uri)) {
                                    return false;
                                }
                                seen.add(uri);
                                return (this.dependencies.get(uri) ?? []).some((child) => reaches(child, target, seen));
                            };
                            const entry = standard
                                ? (matching.find((file) => reaches(file.uri.toString(), standard.uri.toString())) ??
                                  standard)
                                : matching.length === 1
                                  ? matching[0]
                                  : undefined;
                            if (entry) {
                                context.entries.push(category + ': ' + entry.name);
                                visit(entry.uri, category);
                            }
                        }
                        this.activeDocuments.set(key, new Set(visited));
                    }
                    context.documents = visited.size;
                    const complete = context.complete,
                        issues = [...context.issues];
                    for (const file of files) {
                        visit(file.uri, this.fileTypes.getFileType(file.uri).toLowerCase());
                    }
                    context.complete = complete;
                    context.issues = issues;
                    this.contexts.set(key, context);
                })
                .catch((error) => {
                    if (this.loaded.get(key) === pending) {
                        this.loaded.delete(key);
                    }
                    throw error;
                });
            this.loaded.set(key, pending);
        }
        await pending;
        if (generation !== this.generation) {
            await this.load(origin);
        }
    }

    public documents(origin: vscode.Uri): IniDocument[] {
        const result = new Map<string, IniDocument>();
        const active = this.activeDocuments.get(this.resources.projectRoot(origin).toString());
        const standalone = /\.(ini|map|mpr|yrm)$/i.test(origin.path) && active && !active.has(origin.toString());
        const local = new Set<string>();
        if (standalone) {
            const pending = [origin.toString()];
            while (pending.length && local.size < 2000) {
                const uri = pending.pop()!;
                if (!local.has(uri)) {
                    local.add(uri);
                    pending.push(...(this.dependencies.get(uri) ?? []));
                }
            }
        }
        // A standalone file owns its category. Other active categories remain available
        // for explicit rules/art/sound references without merging same-category keys.
        const ownCategory = this.category(origin);
        const included = (uri: vscode.Uri) =>
            !active ||
            (standalone
                ? local.has(uri.toString()) || (active.has(uri.toString()) && this.category(uri) !== ownCategory)
                : active.has(uri.toString()));
        for (const [key, document] of this.snapshots) {
            if (this.resources.contains(origin, document.uri) && included(document.uri)) {
                result.set(key, document);
            }
        }
        for (const document of this.manager.documents.values()) {
            if (
                this.resources.contains(origin, document.uri) &&
                included(document.uri) &&
                (!this.snapshots.size || this.snapshots.has(document.uri.toString()))
            ) {
                result.set(document.uri.toString(), document);
            }
        }
        for (const text of vscode.workspace.textDocuments) {
            if (
                !/\.(ini|map|mpr|yrm)$/i.test(text.uri.path) ||
                !this.resources.contains(origin, text.uri) ||
                !included(text.uri)
            ) {
                continue;
            }
            const key = text.uri.toString();
            result.set(key, this.parse(text));
        }
        return [...result.values()];
    }

    public parse(text: vscode.TextDocument): IniDocument {
        const key = text.uri.toString();
        let cached = this.parsed.get(key);
        if (!cached || cached.version !== text.version) {
            cached = { version: text.version, document: new IniDocument(text.uri, text.getText()) };
            this.parsed.set(key, cached);
        }
        return cached.document;
    }

    /** Rebuild only changed documents, rather than scanning every INI on every cursor move. */
    public incoming(origin: vscode.Uri, name: string, limit = 200): { uri: vscode.Uri; line: number; key: string }[] {
        const result: { uri: vscode.Uri; line: number; key: string }[] = [];
        for (const document of this.documents(origin)) {
            const key = document.uri.toString();
            let cached = this.incomingQueries.get(key);
            if (!cached || cached.document !== document) {
                cached = { document, references: new Map() };
                document.lines.forEach((text, line) => {
                    const property = parsePropertyLine(text);
                    for (const value of new Set(property?.elements.map((item) => item.value.toLowerCase()) ?? [])) {
                        if (!value) {
                            continue;
                        }
                        const references = cached!.references.get(value) ?? [];
                        references.push({ line, key: property!.key });
                        cached!.references.set(value, references);
                    }
                });
                this.incomingQueries.set(key, cached);
            }
            for (const item of cached.references.get(name.toLowerCase()) ?? []) {
                result.push({ uri: document.uri, ...item });
                if (result.length >= limit) {
                    return result;
                }
            }
        }
        return result;
    }

    private queryScope(origin: vscode.Uri): string {
        const root = this.resources.projectRoot(origin).toString(),
            active = this.activeDocuments.get(root);
        return active && /\.(ini|map|mpr|yrm)$/i.test(origin.path) && !active.has(origin.toString())
            ? origin.toString()
            : root;
    }

    private indexedSources(origin: vscode.Uri): Map<string, SectionSource[]> {
        const documents = this.documents(origin),
            root = this.queryScope(origin);
        // Include discovery can reclassify an already indexed document without
        // changing its text. Queries created by hover/annotations must follow it.
        const signature = documents.flatMap((document) => [
            document.uri.toString(),
            document.content,
            this.category(document.uri),
        ]);
        let query = this.queries.get(root);
        if (
            !query ||
            signature.length !== query.signature.length ||
            signature.some((item, index) => item !== query!.signature[index])
        ) {
            query = { signature, sources: new Map() };
            for (const document of documents) {
                const fileCategory = this.category(document.uri);
                for (const section of document.sections) {
                    const key = section.name.toLowerCase(),
                        values = query.sources.get(key) ?? [];
                    values.push({ document, section, category: fileCategory });
                    query.sources.set(key, values);
                }
            }
            this.queries.set(root, query);
        }
        return query.sources;
    }

    private selectSources(
        index: Map<string, SectionSource[]>,
        origin: vscode.Uri,
        name: string,
        category?: string,
        configured = this.context(origin).configured,
        order = this.order
    ): SectionSource[] {
        const sources = [...(index.get(name.toLowerCase()) ?? [])].filter(
            (source) => !category || source.category === category.toLowerCase()
        );
        return sources.sort(
            (a, b) =>
                (order.get(b.document.uri.toString()) ?? -1) - (order.get(a.document.uri.toString()) ?? -1) ||
                a.document.uri.toString().localeCompare(b.document.uri.toString())
        );
    }

    public sources(origin: vscode.Uri, name: string, category?: string): SectionSource[] {
        return this.selectSources(this.indexedSources(origin), origin, name, category);
    }

    /** Freeze the source lookup once for a catalogue or analysis operation. */
    public snapshot(origin: vscode.Uri): {
        sources: (name: string, category?: string) => SectionSource[];
        names: string[];
        context: ProjectResolutionContext;
        isCurrent: () => boolean;
    } {
        const index = this.indexedSources(origin);
        const order = new Map(this.order),
            context = this.context(origin),
            generation = this.generation;
        const documents = new Map(
            this.documents(origin).map((document) => [document.uri.toString(), document.content])
        );
        return {
            names: [...index.keys()],
            context,
            sources: (name, category) =>
                this.selectSources(index, origin, name, category, context.configured, order).map((source) =>
                    context.compatibility === 'vanilla'
                        ? { ...source, section: { ...source.section, parentNames: [] } }
                        : source
                ),
            isCurrent: () => {
                if (generation !== this.generation) {
                    return false;
                }
                const current = this.documents(origin);
                return (
                    current.length === documents.size &&
                    current.every((document) => documents.get(document.uri.toString()) === document.content)
                );
            },
        };
    }

    public effective(
        origin: vscode.Uri,
        name: string,
        category?: string,
        visited = new Set<string>()
    ): Map<string, EffectiveProperty> {
        return new Map(
            [...this.explain(origin, name, category, visited)].map(([key, result]) => [key, result.effective])
        );
    }

    /** Includes overridden declarations and the complete inheritance path. */
    public explain(
        origin: vscode.Uri,
        name: string,
        category?: string,
        visited = new Set<string>()
    ): Map<string, PropertyResolution> {
        const snapshot = this.snapshot(origin);
        return resolveProperties(
            name,
            (target) => snapshot.sources(target, category),
            parsePropertyLine,
            [...visited].map((value) => value.slice(value.indexOf(':') + 1))
        );
    }

    /** Resolve the scoped registry and typed-reference index once per document snapshot. */
    public type(origin: vscode.Uri, name: string, category = this.category(origin)): string {
        const sources = this.indexedSources(origin),
            scope = this.queryScope(origin);
        let cached = this.typeIndexes.get(scope);
        if (!cached || cached.sources !== sources) {
            const snapshot = this.snapshot(origin),
                types = new Map<string, string>();
            const registries: Record<string, string> = {
                UnitTypes: 'UnitType',
                VehicleTypes: 'UnitType',
                InfantryTypes: 'InfantryType',
                AircraftTypes: 'AircraftType',
                BuildingTypes: 'BuildingType',
                SuperWeaponTypes: 'SuperWeaponType',
                Warheads: 'WarheadType',
                Animations: 'AnimType',
                VoxelAnims: 'VoxelAnimType',
                Particles: 'ParticleType',
                ParticleSystems: 'ParticleSystemType',
            };
            for (const registry of this.schema.getRegistryNames()) {
                registries[registry] ??= this.schema.getTypeForRegistry(registry) ?? 'Unknown';
            }
            const registered = new Map<string, string>();
            for (const [registry, type] of Object.entries(registries)) {
                for (const value of registryValues(
                    registry,
                    (target) => snapshot.sources(target, 'rules'),
                    parsePropertyLine,
                    snapshot.context.compatibility !== 'vanilla'
                )) {
                    registered.set(value.toLowerCase(), type);
                }
            }
            for (const [name, type] of registered) {
                types.set('registered:' + name, type);
            }
            for (const [section, definitions] of sources) {
                for (const definition of definitions) {
                    types.set(
                        definition.category + ':' + section,
                        definition.category === 'sound'
                            ? 'Sound'
                            : (registered.get(section) ??
                                  (section === 'audiovisual'
                                      ? 'AudioVisual'
                                      : this.schema.isSchemaType(definition.section.name)
                                        ? definition.section.name
                                        : 'Unknown'))
                    );
                }
            }
            const keyTypes = new Map<string, Map<string, string>>();
            for (let pass = 0; pass < 8; pass++) {
                let changed = false;
                for (const [section, definitions] of sources) {
                    for (const definition of definitions) {
                        const id = definition.category + ':' + section;
                        if (types.get(id) === 'Unknown' && snapshot.context.compatibility !== 'vanilla') {
                            for (const parent of definition.section.parentNames) {
                                const inherited =
                                    types.get(definition.category + ':' + parent.toLowerCase()) ??
                                    (this.schema.isSchemaType(parent) ? parent : 'Unknown');
                                if (inherited !== 'Unknown') {
                                    types.set(id, inherited);
                                    changed = true;
                                    break;
                                }
                            }
                        }
                        const type = types.get(id)!;
                        if (!keyTypes.has(type)) {
                            keyTypes.set(
                                type,
                                new Map(
                                    [...this.schema.getAllKeysForType(type)].map(([key]) => [
                                        key.toLowerCase(),
                                        this.propertyType(type, key) ?? '',
                                    ])
                                )
                            );
                        }
                        for (const [key, value] of definition.section.properties) {
                            const expected = keyTypes.get(type)!.get(key.toLowerCase());
                            if (!expected || !this.schema.isComplexType(expected)) {
                                continue;
                            }
                            const targetCategory = expected === 'AnimType' ? 'art' : definition.category;
                            for (const element of parsePropertyLine('x=' + value)?.elements ?? []) {
                                const target = targetCategory + ':' + element.value.toLowerCase();
                                if (types.get(target) === 'Unknown') {
                                    types.set(target, expected);
                                    changed = true;
                                }
                            }
                        }
                    }
                }
                if (!changed) {
                    break;
                }
            }
            cached = { sources, types };
            this.typeIndexes.set(scope, cached);
        }
        return (
            cached.types.get(category.toLowerCase() + ':' + name.toLowerCase()) ??
            cached.types.get('registered:' + name.toLowerCase()) ??
            (this.schema.isSchemaType(name) ? name : 'Unknown')
        );
    }

    public propertyType(owner: string, key: string): string | undefined {
        const property = [...this.schema.getAllKeysForType(owner)].find(
            ([name]) => name.toLowerCase() === key.toLowerCase()
        )?.[1];
        let type = property?.type;
        const visited = new Set<string>();
        while (type && this.schema.getListDefinition(type) && !visited.has(type)) {
            visited.add(type);
            type = this.schema.getListDefinition(type)!.type;
        }
        return type;
    }

    public category(uri: vscode.Uri): string {
        return this.categories.get(uri.toString()) ?? this.fileTypes.getFileType(uri).toLowerCase();
    }

    public context(origin: vscode.Uri): ProjectResolutionContext {
        const active = this.activeDocuments.get(this.resources.projectRoot(origin).toString());
        if (/\.(ini|map|mpr|yrm)$/i.test(origin.path) && active && !active.has(origin.toString())) {
            const compatibility = this.contexts.get(this.resources.projectRoot(origin).toString())?.compatibility;
            const issues: string[] = [],
                seen = new Set<string>();
            const inspect = (uri: string) => {
                if (seen.has(uri)) {
                    return;
                }
                seen.add(uri);
                const document = vscode.workspace.textDocuments.find((text) => text.uri.toString() === uri);
                const parsed = document ? this.parse(document) : this.snapshots.get(uri);
                if (!parsed) {
                    issues.push(uri);
                    return;
                }
                if (compatibility !== 'vanilla') {
                    const children = this.dependencies.get(uri) ?? [];
                    if ((parsed.getSection('#include')?.properties.size ?? 0) > children.length) {
                        issues.push(uri + ': #include');
                    }
                    children.forEach(inspect);
                }
            };
            inspect(origin.toString());
            return {
                mode: 'standalone',
                compatibility,
                configured: false,
                complete: !issues.length,
                documents: this.documents(origin).length,
                entries: [origin.toString()],
                issues,
            };
        }
        return (
            this.contexts.get(this.resources.projectRoot(origin).toString()) ?? {
                configured: false,
                complete: false,
                documents: 0,
                entries: [],
                issues: [],
            }
        );
    }
}
