import { DictionarySource } from './source-model';
import { DictionaryDetail, DictionaryKind, DictionaryProperty, DictionaryType } from './protocol';

export interface DictionaryFile { path: string; source: DictionarySource }
const meta = new Set(['#include', 'description', 'registries', 'sections', 'globals', 'numberlimits', 'limits', 'lists']);

/** The editor sees effective values and declarations, rather than flattening source documents. */
export class DictionaryCatalog {
    public readonly types = new Map<string, DictionaryType>();
    private readonly properties = new Map<string, Map<string, DictionaryProperty>>();
    private readonly fields = new Map<string, Record<string, string>>();
    public readonly issues: { path: string; line: number; message: string }[] = [];
    constructor(public readonly files: DictionaryFile[], public readonly root: string) {
        const kinds = new Map<string, DictionaryKind>();
        for (const file of files) {
            for (const [category, kind] of [['Sections', 'object'], ['NumberLimits', 'number'], ['Limits', 'limit'], ['Lists', 'list']] as const) {
                for (const entry of file.source.inSection(category)) { kinds.set(entry.key.toLowerCase(), kind); }
            }
            this.issues.push(...file.source.issues.map(issue => ({ ...issue, path: file.path })));
        }
        for (const [id, kind] of kinds) {
            const declaration = files.flatMap(file => file.source.entries).find(entry => entry.key.toLowerCase() === id && ['sections', 'numberlimits', 'limits', 'lists'].includes(entry.section.toLowerCase()));
            this.types.set(id, { name: declaration?.key ?? id, kind, count: 0 });
        }
        for (const file of files) {
            for (const section of file.source.sections) {
                const id = section.name.toLowerCase();
                if (meta.has(id) && id !== 'registries') { continue; }
                const previous = this.types.get(id);
                this.types.set(id, { name: section.name, base: section.base ?? previous?.base, kind: id === 'registries' ? 'registry' : kinds.get(id) ?? 'object', count: 0 });
            }
            for (const entry of file.source.entries) {
                const id = entry.section.toLowerCase(), type = this.types.get(id);
                if (!type || entry.value === undefined) { continue; }
                const fields = this.fields.get(id) ?? {};
                fields[entry.key] = entry.value;
                this.fields.set(id, fields);
                if (type.kind === 'object' || type.kind === 'registry') {
                    const parts = entry.value.split(',').map(item => item.trim());
                    const properties = this.properties.get(id) ?? new Map();
                    properties.set(entry.key.toLowerCase(), { key: entry.key, type: parts[0] || 'string', defaultValue: parts[1] || undefined, fileType: parts[2] || undefined,
                        owner: type.name, path: file.path, line: entry.line, inherited: false, local: file.path === root });
                    this.properties.set(id, properties);
                }
            }
        }
        for (const type of this.types.values()) { type.count = this.detail(type.name).properties.length; }
    }
    public problems(): { path: string; line: number; message: string; args: string[] }[] {
        const result: ReturnType<DictionaryCatalog['problems']> = [];
        const known = (name: string) => ['int', 'float', 'double', 'string', 'bool'].includes(name) || this.types.has(name.toLowerCase());
        for (const type of this.types.values()) {
            const declaration = this.files.flatMap(file => file.source.sections.map(section => ({ file, section }))).filter(item => item.section.name.toLowerCase() === type.name.toLowerCase()).at(-1);
            const issue = (message: string, ...args: string[]) => result.push({ path: declaration?.file.path ?? this.root, line: declaration?.section.line ?? 0, message, args });
            if (type.base && !known(type.base)) { issue('unknownParent', type.name, type.base); }
            let parent = type.base; const visited = new Set([type.name.toLowerCase()]);
            while (parent) {
                if (visited.has(parent.toLowerCase())) { issue('typeCycle', type.name); break; }
                visited.add(parent.toLowerCase()); parent = this.types.get(parent.toLowerCase())?.base;
            }
            if (type.kind === 'object' || type.kind === 'registry') {
                for (const property of this.properties.get(type.name.toLowerCase())?.values() ?? []) {
                    if (!known(property.type)) { result.push({ path: property.path, line: property.line, message: 'unknownType', args: [property.key, property.type] }); }
                }
            }
            const fields = this.fields.get(type.name.toLowerCase()) ?? {};
            if (type.kind === 'list' && (!fields.Type || !known(fields.Type))) { issue('unknownType', type.name, fields.Type ?? ''); }
            if (type.kind === 'number' || (type.kind === 'list' && fields.Range)) {
                const range = fields.Range?.split(',').map(item => item.trim());
                if (!range || range.length !== 2 || !range.every(value => /^[+-]?\d+$/.test(value)) || Number(range[0]) > Number(range[1])) { issue('range', type.name); }
            }
        }
        return result;
    }
    public validDefault(value: string, type: string): boolean {
        if (!value) { return true; }
        if (type === 'int') { return /^[+-]?\d+$/.test(value); }
        if (type === 'float' || type === 'double') { return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?%?$/i.test(value) && Number.isFinite(Number(value.replace(/%$/, ''))); }
        if (type === 'bool') { return /^(yes|no|true|false|0|1)$/i.test(value); }
        const detail = this.detail(type), fields = Object.fromEntries(Object.entries(detail.fields).map(([key, value]) => [key.toLowerCase(), value]));
        if (detail.kind === 'number') {
            const range = fields.range?.split(',').map(Number);
            return /^[+-]?\d+$/.test(value) && !!range && range.length === 2 && Number(value) >= range[0] && Number(value) <= range[1];
        }
        if (detail.kind === 'limit') {
            const sensitive = /^(yes|true|1)$/i.test(fields.casesensitive ?? '');
            const normalize = (value: string) => sensitive ? value : value.toLowerCase();
            const normalized = normalize(value);
            const entries = (key: string) => (fields[key] ?? '').split(',').map(value => normalize(value.trim())).filter(Boolean);
            const choices = entries('limitin'), prefixes = entries('startwith'), suffixes = entries('endwith');
            return (!choices.length || choices.includes(normalized)) && (!prefixes.length || prefixes.some(prefix => normalized.startsWith(prefix))) && (!suffixes.length || suffixes.some(suffix => normalized.endsWith(suffix)));
        }
        return true;
    }
    public detail(name: string, visited = new Set<string>()): DictionaryDetail {
        const id = name.toLowerCase(), type = this.types.get(id);
        const detail: DictionaryDetail = { name: type?.name ?? name, kind: type?.kind ?? 'object', base: type?.base,
            fields: this.fields.get(id) ?? {}, properties: [] };
        if (visited.has(id)) { return detail; }
        visited.add(id);
        const inherited = type?.base ? this.detail(type.base, visited).properties.map(property => ({ ...property, inherited: true, local: false })) : [];
        const properties = new Map(inherited.map(property => [property.key.toLowerCase(), property]));
        for (const [key, property] of this.properties.get(id) ?? []) { properties.set(key, property); }
        detail.properties = [...properties.values()];
        return detail;
    }
}
