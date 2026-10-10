import * as vscode from 'vscode';
import { IniDocument, IniSection, INIManager } from '../parser';
import { SchemaManager } from '../schema-manager';
import { FileTypeManager } from '../file-type-manager';
import { ProjectResources } from '../resources/project-resources';
import { parsePropertyLine } from './ini-position';

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
    private loaded = new Map<string, Promise<void>>();
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
        this.loaded.clear();
        this.parsed.clear();
        this.queries.clear();
        this.incomingQueries.clear();
    }

    public async load(origin: vscode.Uri): Promise<void> {
        const key = this.resources.projectRoot(origin).toString();
        let pending = this.loaded.get(key);
        if (!pending) {
            pending = this.resources
                .list(origin, ['.ini'])
                .then(async (files) => {
                    for (let offset = 0; offset < Math.min(files.length, 2000); offset += 16) {
                        await Promise.allSettled(
                            files.slice(offset, offset + 16).map((file) => vscode.workspace.openTextDocument(file.uri))
                        );
                    }
                })
                .catch((error) => {
                    this.loaded.delete(key);
                    throw error;
                });
            this.loaded.set(key, pending);
        }
        await pending;
    }

    public documents(origin: vscode.Uri): IniDocument[] {
        const result = new Map<string, IniDocument>();
        for (const document of this.manager.documents.values()) {
            if (this.resources.contains(origin, document.uri)) {
                result.set(document.uri.toString(), document);
            }
        }
        for (const text of vscode.workspace.textDocuments) {
            if (!this.resources.contains(origin, text.uri) || !/\.(ini|map|mpr|yrm)$/i.test(text.uri.path)) {
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
        const signature = documents.flatMap((document) => [document.uri.toString(), document.content]);
        let query = this.queries.get(root);
        if (
            !query ||
            signature.length !== query.signature.length ||
            signature.some((item, index) => item !== query!.signature[index])
        ) {
            query = { signature, sources: new Map() };
            for (const document of documents) {
                const fileCategory = this.fileTypes.getFileType(document.uri).toLowerCase();
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
        const declared = [...new Set([...this.schema.getRegistryNames(), ...Object.keys(builtins)])].find((registry) =>
            this.sources(origin, registry, 'rules').some((source) =>
                [...source.section.properties.values()].some((value) => value.toLowerCase() === name.toLowerCase())
            )
        );
        if (declared) {
            return this.schema.getTypeForRegistry(declared) ?? builtins[declared] ?? 'Unknown';
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
        return this.fileTypes.getFileType(uri).toLowerCase();
    }
}
