import { MixGame } from './types';
import { decodeLocalText } from './local-encoding';

export const LOCAL_MIX_DATABASE_ID = 0x366e051f;
export const LEGACY_LOCAL_MIX_DATABASE_ID = 0x54c2d545;
const signature = Uint8Array.from('XCC by Olaf van der Spek\x1a\x04\x17\x27\x10\x19\x80\x00', (character) =>
    character.charCodeAt(0)
);

/** XCC local filename database, shared by the full editor and range-only resource reader. */
export function readLocalMixDatabase(
    bytes: Uint8Array
): { game: MixGame; names: string[]; entries: { name: string; encodedName: Uint8Array }[] } | undefined {
    if (bytes.length < 52 || signature.some((byte, index) => bytes[index] !== byte)) {
        return undefined;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const gameId = view.getUint32(44, true),
        count = view.getUint32(48, true);
    if (
        view.getUint32(32, true) !== bytes.length ||
        view.getUint32(36, true) !== 0 ||
        view.getUint32(40, true) !== 0 ||
        count > bytes.length - 52
    ) {
        return undefined;
    }
    const game = [5, 6].includes(gameId) ? MixGame.Ra2 : [0, 1].includes(gameId) ? MixGame.TdRa : MixGame.Ts;
    let cursor = 52;
    const names: string[] = [],
        entries: { name: string; encodedName: Uint8Array }[] = [];
    for (let index = 0; index < count; index++) {
        const end = bytes.indexOf(0, cursor);
        if (end < 0) {
            return undefined;
        }
        const encodedName = bytes.subarray(cursor, end),
            name = decodeLocalText(encodedName);
        cursor = end + 1;
        // A database is display metadata, never permission to escape the archive root.
        if (
            !name ||
            name
                .replace(/\\/g, '/')
                .split('/')
                .some((part) => part === '..' || part === '.') ||
            /^[\\/]|^[a-z]:/i.test(name)
        ) {
            continue;
        }
        names.push(name);
        entries.push({ name, encodedName });
    }
    return { game, names, entries };
}

export function writeLocalMixDatabase(game: MixGame, names: readonly (string | Uint8Array)[]): Uint8Array {
    const encodedNames = names.map((name) => (typeof name === 'string' ? new TextEncoder().encode(name) : name));
    const encoded = new Uint8Array(encodedNames.reduce((size, name) => size + name.length + 1, 0));
    let offset = 0;
    for (const name of encodedNames) {
        encoded.set(name, offset);
        offset += name.length + 1;
    }
    const bytes = new Uint8Array(52 + encoded.length),
        view = new DataView(bytes.buffer);
    bytes.set(signature);
    view.setUint32(32, bytes.length, true);
    view.setUint32(44, game === MixGame.Ra2 ? 5 : game === MixGame.Ts ? 2 : 1, true);
    view.setUint32(48, names.length, true);
    bytes.set(encoded, 52);
    return bytes;
}
