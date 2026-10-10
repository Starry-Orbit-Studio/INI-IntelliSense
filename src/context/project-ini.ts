import * as vscode from 'vscode';
import { IniDocument, IniSection, INIManager } from '../parser';
import { SchemaManager } from '../schema-manager';
import { FileTypeManager } from '../file-type-manager';
import { ProjectResources } from '../resources/project-resources';
import { parsePropertyLine } from './ini-position';
import { TextContentService } from '../services/text-content-service';
import * as path from 'path';

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

/** Scoped queries use open document text first, including unsaved MIX documents. */
export class ProjectIni {
    private parsed = new Map<string, { version: number; document: IniDocument }>();
    private snapshots = new Map<string, IniDocument>();
    private categories = new Map<string, string>();
    private order = new Map<string, number>();
    private loaded = new Map<string, Promise<void>>();
    private generation = 0;
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
    }

    public async load(origin: vscode.Uri): Promise<void> {
        const generation = this.generation;
        const key = this.resources.projectRoot(origin).toString();
        let pending = this.loaded.get(key);
        if (!pending) {
            pending = this.resources
                .listDocuments(origin)
                .then(async (files) => {
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
                    for (let offset = 0; offset < Math.min(files.length, 2000); offset += 16) {
                        await Promise.allSettled(
                            files.slice(offset, offset + 16).map(async (file) => {
                                const content = reader.decode(await this.resources.read(file.uri, 8 * 1024 * 1024));
                                if (generation === this.generation) {
                                    this.snapshots.set(file.uri.toString(), new IniDocument(file.uri, content));
                                }
                            })
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
                            return;
                        }
                        visited.add(key);
                        this.order.set(key, rank++);
                        this.categories.set(key, category);
                        for (const name of this.snapshots.get(key)?.getSection('#include')?.properties.values() ?? []) {
                            const child = includedUri(uri, name);
                            if (child) {
                                visit(child, category, depth + 1);
                            }
                        }
                    };
                    for (const file of files.filter((file) => !included.has(file.uri.toString()))) {
                        visit(file.uri, this.fileTypes.getFileType(file.uri).toLowerCase());
                    }
                    for (const file of files) {
                        visit(file.uri, this.fileTypes.getFileType(file.uri).toLowerCase());
                    }
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
        for (const [key, document] of this.snapshots) {
            if (this.resources.contains(origin, document.uri)) {
                result.set(key, document);
            }
        }
        for (const document of this.manager.documents.values()) {
            if (
                this.resources.contains(origin, document.uri) &&
                (!this.snapshots.size || this.snapshots.has(document.uri.toString()))
            ) {
                result.set(document.uri.toString(), document);
            }
        }
        for (const text of vscode.workspace.textDocuments) {
            if (!/\.(ini|map|mpr|yrm)$/i.test(text.uri.path) || !this.resources.contains(origin, text.uri)) {
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

    public sources(origin: vscode.Uri, name: string, category?: string): SectionSource[] {
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
        const sources = [...(query.sources.get(name.toLowerCase()) ?? [])].filter(
            (source) => !category || source.category === category.toLowerCase()
        );
        return sources.sort(
            (a, b) =>
                Number(b.document.uri.toString() === origin.toString()) -
                    Number(a.document.uri.toString() === origin.toString()) ||
                (this.order.get(b.document.uri.toString()) ?? -1) - (this.order.get(a.document.uri.toString()) ?? -1) ||
                a.document.uri.toString().localeCompare(b.document.uri.toString())
        );
    }

    public effective(
        origin: vscode.Uri,
        name: string,
        category?: string,
        visited = new Set<string>()
    ): Map<string, EffectiveProperty> {
        const identity = (category ?? '*') + ':' + name.toLowerCase();
        if (visited.has(identity) || visited.size > 64) {
            return new Map();
        }
        const branch = new Set(visited);
        branch.add(identity);
        const sources = this.sources(origin, name, category);
        const result = new Map<string, EffectiveProperty>();
        for (const source of sources) {
            for (let line = source.section.startLine + 1; line <= source.section.endLine; line++) {
                const property = parsePropertyLine(source.document.lines[line]);
                if (property) {
                    const key = property.key.toLowerCase();
                    if (!result.has(key) || result.get(key)!.uri.toString() === source.document.uri.toString()) {
                        result.set(key, {
                            key: property.key,
                            value: property.value,
                            uri: source.document.uri,
                            line,
                            section: source.section.name,
                            inherited: false,
                        });
                    }
                }
            }
        }
        for (const source of sources) {
            for (const parent of source.section.parentNames) {
                for (const [key, property] of this.effective(origin, parent, category, branch)) {
                    if (!result.has(key)) {
                        result.set(key, { ...property, inherited: true });
                    }
                }
            }
        }
        return result;
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
}
