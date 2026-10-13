import { parsePropertyLine } from '../context/ini-position';

export interface DictionaryEntry {
    section: string;
    key: string;
    value?: string;
    line: number;
    start: number;
    end: number;
    valueStart: number;
    valueEnd: number;
    multiline: boolean;
}
export interface DictionarySection { name: string; base?: string; line: number; start: number; headingEnd: number; end: number }
export interface SourceEdit { start: number; end: number; text: string }

/** Lossless offsets: comments, unknown syntax, encoding and line endings stay in the document. */
export class DictionarySource {
    public readonly entries: DictionaryEntry[] = [];
    public readonly sections: DictionarySection[] = [];
    public readonly eol: string;
    public readonly issues: { line: number; message: string }[] = [];
    constructor(public readonly text: string) {
        this.eol = text.includes('\r\n') ? '\r\n' : '\n';
        const chunks = text.split('\n');
        const lines = chunks.map(line => line.replace(/\r$/, ''));
        let offset = 0, section: DictionarySection | undefined;
        for (let line = 0; line < lines.length; line++) {
            const raw = lines[line];
            const start = offset;
            offset += chunks[line].length + (line < lines.length - 1 ? 1 : 0);
            const header = /^\s*\[([^\]:]+)\](?::\[([^\]]+)\])?\s*(?:;.*)?$/.exec(raw.replace(/^\uFEFF/, ''));
            if (header) {
                if (section) { section.end = start; }
                section = { name: header[1].trim(), base: header[2]?.trim(), line, start, headingEnd: start + raw.length, end: text.length };
                this.sections.push(section);
                continue;
            }
            if (!section || /^\s*(?:;|$)/.test(raw)) { continue; }
            const property = parsePropertyLine(raw);
            if (!property) {
                const key = raw.split(';')[0].trim();
                if (key && !key.startsWith('[')) {
                    this.entries.push({ section: section.name, key, line, start, end: offset, valueStart: start + raw.indexOf(key), valueEnd: start + raw.indexOf(key) + key.length, multiline: false });
                }
                continue;
            }
            const entry: DictionaryEntry = { section: section.name, key: property.key, value: property.value, line, start, end: offset,
                valueStart: start + property.valueStart, valueEnd: start + property.valueEnd, multiline: false };
            const quote = raw.indexOf('"""', property.valueStart);
            if (quote >= 0 && raw.slice(property.valueStart, quote).trim() === '') {
                entry.multiline = true;
                entry.valueStart = start + quote;
                let rest = raw.slice(quote + 3), closed = rest.indexOf('"""');
                entry.value = '';
                while (closed < 0 && line < lines.length - 1) {
                    entry.value += rest + '\n';
                    line++;
                    rest = lines[line];
                    const restStart = offset;
                    offset += chunks[line].length + (line < lines.length - 1 ? 1 : 0);
                    closed = rest.indexOf('"""');
                    entry.valueEnd = restStart + (closed < 0 ? rest.length : closed + 3);
                }
                if (closed < 0) { this.issues.push({ line: entry.line, message: 'multiline' }); }
                else {
                    entry.value += rest.slice(0, closed);
                    if (line === entry.line) { entry.valueEnd = start + quote + 3 + closed + 3; }
                }
                entry.end = offset;
            }
            this.entries.push(entry);
        }
    }
    public inSection(name: string): DictionaryEntry[] {
        return this.entries.filter(entry => entry.section.toLowerCase() === name.toLowerCase());
    }
    public find(section: string, key: string): DictionaryEntry | undefined {
        return this.inSection(section).filter(entry => entry.key.toLowerCase() === key.toLowerCase()).at(-1);
    }
    public description(section: string, key: string, parent: (section: string) => string | undefined): string | undefined {
        const visited = new Set<string>();
        while (section && !visited.has(section.toLowerCase())) {
            visited.add(section.toLowerCase());
            const value = this.find(section, key)?.value;
            if (value !== undefined) { return value; }
            section = this.sections.filter(item => item.name.toLowerCase() === section.toLowerCase()).at(-1)?.base ?? parent(section) ?? '';
        }
        return undefined;
    }
    /** Generate a minimal replacement or append to the final matching section. */
    public set(section: string, key: string, value: string | undefined, description = false): SourceEdit {
        if (!section || /[\r\n\[\]:;]/.test(section) || !key || /[\r\n=;]/.test(key)) { throw new Error('identifier'); }
        if (value !== undefined && (description ? value.includes('"""') : /[\r\n;]/.test(value))) { throw new Error('value'); }
        const entry = this.find(section, key);
        const serialized = description && value !== undefined ? '"""' + value.replace(/\r?\n/g, this.eol) + '"""' : value;
        if (entry && entry.value !== undefined && serialized !== undefined) {
            const original = this.text.slice(entry.valueStart, entry.valueEnd);
            const leading = /^\s*/.exec(original)?.[0] ?? '', trailing = /\s*$/.exec(original)?.[0] ?? '';
            return { start: entry.valueStart, end: entry.valueEnd, text: entry.multiline ? serialized : leading + serialized + trailing };
        }
        if (entry && serialized === undefined) { return { start: entry.start, end: entry.end, text: '' }; }
        const block = this.sections.filter(item => item.name.toLowerCase() === section.toLowerCase()).at(-1);
        const at = block?.end ?? this.text.length;
        const prefix = at > 0 && !/[\r\n]$/.test(this.text.slice(0, at)) ? this.eol : '';
        return { start: at, end: at, text: prefix + (block ? '' : this.eol + '[' + section + ']' + this.eol) + key + (serialized === undefined ? '' : '=' + serialized) + this.eol };
    }
}

export function editedText(text: string, edits: SourceEdit[]): string {
    let boundary = text.length;
    for (const edit of [...edits].sort((a, b) => b.start - a.start || b.end - a.end)) {
        if (edit.end > boundary || edit.start > edit.end || edit.start < 0) { throw new Error('overlap'); }
        text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
        boundary = edit.start;
    }
    return text;
}
