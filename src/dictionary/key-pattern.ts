/** Numbered dictionary keys retain both the range expression and the suffix. */
export interface KeyPattern { prefix: string; suffix: string; minimum: string; maximum: string }

export function keyPattern(declaration: string): KeyPattern | undefined {
    const match = /^(.*?)\(([^,()]+),([^()]+)\)(.*)$/.exec(declaration);
    return match ? { prefix: match[1], minimum: match[2].trim(), maximum: match[3].trim(), suffix: match[4] } : undefined;
}

export function patternIndex(declaration: string, key: string): number | undefined {
    const pattern = keyPattern(declaration);
    if (!pattern || !key.toLowerCase().startsWith(pattern.prefix.toLowerCase()) || !key.toLowerCase().endsWith(pattern.suffix.toLowerCase())) { return undefined; }
    const part = key.slice(pattern.prefix.length, pattern.suffix ? -pattern.suffix.length : undefined);
    return /^\d+$/.test(part) && Number.isSafeInteger(Number(part)) ? Number(part) : undefined;
}

export function patternBound(value: string, read: (key: string) => string | undefined): number | undefined {
    const text = /^\d+$/.test(value) ? value : read(value);
    return text && /^\d+$/.test(text) && Number.isSafeInteger(Number(text)) ? Number(text) : undefined;
}
