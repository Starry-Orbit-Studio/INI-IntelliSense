/** File-local entries; duplicate labels and original line positions are preserved. */
export interface StringTableEntry {
    label: string;
    value: string;
    extraValue?: string;
    line?: number;
}

export interface StringTable {
    format: 'CSF' | 'LLF';
    language?: number;
    entries: StringTableEntry[];
}

/** LLF uses literal indented lines, including the >- notation emitted by csf2llf. */
export function parseLlf(text: string): StringTable {
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
    const entries: StringTableEntry[] = [];
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (!line.trim() || /^\s*#/.test(line)) {
            continue;
        }
        const match = /^([^\s].*?):(?:[ \t]+(.*)|$)/.exec(line);
        if (!match) {
            continue;
        }
        const entry: StringTableEntry = { label: match[1].trim(), value: match[2] ?? '', line: index };
        if (/^[>|][-+]?\s*$/.test(entry.value)) {
            const parts: string[] = [];
            while (index + 1 < lines.length && /^ {2}/.test(lines[index + 1])) {
                parts.push(lines[++index].slice(2));
            }
            entry.value = parts.join('\n');
        }
        entries.push(entry);
    }
    return { format: 'LLF', entries };
}

/** Parse declared records, never split on marker bytes inside string payloads. */
export function parseCsf(bytes: Uint8Array): StringTable {
    const buffer = bytes;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 0;
    const requireBytes = (length: number) => {
        if (!Number.isSafeInteger(length) || length < 0 || length > buffer.length - offset) {
            throw new Error('Truncated or invalid CSF record.');
        }
    };
    const uint = () => {
        requireBytes(4);
        const value = view.getUint32(offset, true);
        offset += 4;
        return value;
    };
    const ascii = (length: number) => {
        requireBytes(length);
        let value = '';
        for (let at = offset; at < offset + length; at += 8192) {
            value += String.fromCharCode(...buffer.subarray(at, Math.min(at + 8192, offset + length)));
        }
        offset += length;
        return value;
    };
    if (ascii(4) !== ' FSC') {
        throw new Error('Invalid CSF signature.');
    }
    uint(); // Version.
    const labels = uint(),
        strings = uint();
    uint(); // Reserved.
    const language = uint();
    const entries: StringTableEntry[] = [];
    let stringCount = 0;
    if (labels > Math.floor((buffer.length - offset) / 12)) {
        throw new Error('Invalid CSF label count.');
    }
    for (let index = 0; index < labels; index++) {
        if (ascii(4) !== ' LBL') {
            throw new Error('Invalid CSF label record.');
        }
        const pairs = uint(),
            label = ascii(uint());
        if (!pairs) {
            entries.push({ label, value: '' });
        }
        for (let pair = 0; pair < pairs; pair++) {
            const marker = ascii(4);
            if (marker !== ' RTS' && marker !== 'WRTS') {
                throw new Error('Invalid CSF string record.');
            }
            const length = uint() * 2;
            requireBytes(length);
            const decoded = new Uint8Array(length);
            for (let byte = 0; byte < length; byte++) {
                decoded[byte] = buffer[offset + byte] ^ 0xff;
            }
            offset += length;
            entries.push({
                label,
                value: new TextDecoder('utf-16le', { ignoreBOM: true }).decode(decoded),
                extraValue: marker === 'WRTS' ? ascii(uint()) : undefined,
            });
            stringCount++;
        }
    }
    if (stringCount !== strings) {
        throw new Error('CSF string count does not match its header.');
    }
    return { format: 'CSF', language, entries };
}
