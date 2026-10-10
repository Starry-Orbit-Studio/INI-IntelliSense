/** Exact source spans shared by references, hover and visual edits. */
export interface ValueSpan {
    value: string;
    start: number;
    end: number;
    index: number;
}

export interface IniPropertyLine {
    key: string;
    keyStart: number;
    keyEnd: number;
    valueStart: number;
    valueEnd: number;
    value: string;
    elements: ValueSpan[];
}

/** Parse the project's INI dialect without losing offsets or duplicate values. */
export function parsePropertyLine(line: string): IniPropertyLine | undefined {
    if (/^\s*[;\[]/.test(line)) {
        return undefined;
    }
    const equals = line.indexOf('=');
    if (equals < 0) {
        return undefined;
    }
    const key = line.slice(0, equals).trim();
    if (!key) {
        return undefined;
    }
    const keyStart = line.indexOf(key);
    const comment = line.indexOf(';', equals + 1);
    const valueEnd = comment < 0 ? line.length : comment;
    const raw = line.slice(equals + 1, valueEnd);
    const elements: ValueSpan[] = [];
    let offset = equals + 1;
    raw.split(',').forEach((part, index) => {
        const value = part.trim();
        const start = offset + (value ? part.indexOf(value) : part.length);
        elements.push({ value, start, end: start + value.length, index });
        offset += part.length + 1;
    });
    return {
        key,
        keyStart,
        keyEnd: keyStart + key.length,
        valueStart: equals + 1,
        valueEnd,
        value: raw.trim(),
        elements,
    };
}

/** Boundaries are half-open: commas and comments are never reference targets. */
export function valueAtCharacter(property: IniPropertyLine, character: number): ValueSpan | undefined {
    return property.elements.find((span) => span.value && character >= span.start && character < span.end);
}

/** Sound sample lists also use whitespace separators, with the same half-open spans. */
export function soundValueAtCharacter(
    line: string,
    property: IniPropertyLine,
    character: number
): ValueSpan | undefined {
    const raw = line.slice(property.valueStart, property.valueEnd);
    let index = 0;
    for (const match of raw.matchAll(/[^\s,]+/g)) {
        const start = property.valueStart + match.index!,
            end = start + match[0].length;
        if (character >= start && character < end) {
            return { value: match[0], start, end, index };
        }
        index++;
    }
    return undefined;
}
