import * as vscode from 'vscode';
import { IniDocument, IniSection, INIManager } from '../parser';
import { SchemaManager } from '../schema-manager';
import { FileTypeManager } from '../file-type-manager';
import { ProjectResources } from '../resources/project-resources';
import { parsePropertyLine } from './ini-position';
import { TextContentService } from '../services/text-content-service';
import * as path from 'path';
import { PropertyResolution, resolveProperties } from './property-resolution';
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
    private contexts = new Map<string, ProjectResolutionContext>();
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
        this.incomingQueries.clear();
        this.activeDocuments.clear();
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
                    const reader = new TextContentService();
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
                            (context.configured ? roots : files.map((file) => file.uri)).map((uri) => [
                                uri.toString(),
                                uri,
                            ])
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
                                        if (context.configured) {
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
                                    context.complete = false;
                                    context.issues.push(uri.toString() + ': ' + String(error));
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
                        for (const name of document?.getSection('#include')?.properties.values() ?? []) {
                            const child = includedUri(file.uri, name);
                            if (child) {
                                included.add(child.toString());
                            }
                        }
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
                            context.issues.push(uri.toString());
                            return;
                        }
                        visited.add(key);
                        this.order.set(key, rank++);
                        this.categories.set(key, category);
                        for (const name of this.snapshots.get(key)?.getSection('#include')?.properties.values() ?? []) {
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
                        this.activeDocuments.set(key, visited);
                    } else {
                        for (const file of files.filter((file) => !included.has(file.uri.toString()))) {
                            visit(file.uri, this.fileTypes.getFileType(file.uri).toLowerCase());
                        }
                        for (const file of files) {
                            visit(file.uri, this.fileTypes.getFileType(file.uri).toLowerCase());
                        }
                    }
                    context.documents = visited.size;
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
        const included = (uri: vscode.Uri) => !active || active.has(uri.toString());
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

    private indexedSources(origin: vscode.Uri): Map<string, SectionSource[]> {
        const documents = this.documents(origin),
            root = this.resources.projectRoot(origin).toString();
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
                (configured
                    ? 0
                    : Number(b.document.uri.toString() === origin.toString()) -
                      Number(a.document.uri.toString() === origin.toString())) ||
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
            sources: (name, category) => this.selectSources(index, origin, name, category, context.configured, order),
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

    public type(origin: vscode.Uri, name: string, category?: string, visited = new Set<string>()): string {
        if (visited.has(name.toLowerCase()) || visited.size > 32) {
            return 'Unknown';
        }
        visited.add(name.toLowerCase());
        const builtins: Record<string, string> = {
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
        const declared = [...new Set(['Animations', ...Object.keys(builtins), ...this.schema.getRegistryNames()])].find(
            (registry) =>
                this.sources(origin, registry, 'rules').some((source) =>
                    [...source.section.properties.values()].some((value) => value.toLowerCase() === name.toLowerCase())
                )
        );
        if (declared) {
            return builtins[declared] ?? this.schema.getTypeForRegistry(declared) ?? 'Unknown';
        }
        if (name.toLowerCase() === 'audiovisual') {
            return 'AudioVisual';
        }
        if (this.schema.isSchemaType(name)) {
            return name;
        }
        if (Object.values(builtins).includes(name) || ['ObjectType', 'TechnoType'].includes(name)) {
            return name;
        }
        for (const source of this.sources(origin, name, category)) {
            for (const parent of source.section.parentNames) {
                const inherited = this.type(origin, parent, category, new Set(visited));
                if (inherited !== 'Unknown') {
                    return inherited;
                }
            }
        }
        // Expand list element types before contextual inference.
        if (visited.size === 1) {
            for (const document of this.documents(origin)) {
                for (const section of document.sections) {
                    for (const [key, value] of section.properties) {
                        if (!value.split(',').some((item) => item.trim().toLowerCase() === name.toLowerCase())) {
                            continue;
                        }
                        const ownerType = this.type(
                            origin,
                            section.name,
                            this.fileTypes.getFileType(document.uri),
                            new Set(visited)
                        );
                        const definition = this.propertyType(ownerType, key);
                        if (definition && this.schema.isComplexType(definition)) {
                            return definition;
                        }
                    }
                }
            }
        }
        if (category?.toLowerCase() === 'sound') {
            return 'Sound';
        }
        return 'Unknown';
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
