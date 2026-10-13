import { BinaryReader } from '../media/binary-reader';
import { decryptMixHeader } from '../mix/core/encrypted-header';
import { MixArchive } from '../mix/core/archive';
import { MixGame } from '../mix/core/types';
import { LOCAL_MIX_DATABASE_ID, LEGACY_LOCAL_MIX_DATABASE_ID, readLocalMixDatabase } from '../mix/core/local-mix-database';

export interface MixResourceEntry {
    id: number;
    offset: number;
    size: number;
    name?: string;
}

/** Read archive metadata without retaining its payload; nested archives share the same range reader. */
export async function indexMix(
    size: number,
    read: (offset: number, length: number) => Promise<Uint8Array>,
    resolveName: (game: MixGame, id: number) => Promise<string | undefined>,
    strict = false
): Promise<{ entries: Map<number, MixResourceEntry>; game: MixGame; databaseId?: number }> {
    const prefix = new BinaryReader(await read(0, Math.min(size, 92)));
    prefix.require(0, 6);
    const flags = prefix.u32(0);
    if (strict && (flags & 0xffff) === 0 && flags & ~0x30000) { throw new Error('Invalid MIX flags.'); }
    let header: BinaryReader,
        body: number,
        cursor: number,
        game = MixGame.Ts;
    if ((flags & 0xffff) === 0 && flags & 0x20000) {
        // The first block reveals the count, allowing an exact directory read without loading media.
        const decrypted = await decryptMixHeader(prefix.bytes, read);
        header = new BinaryReader(decrypted.bytes);
        cursor = 6;
        body = decrypted.bodyOffset;
    } else {
        const modern = (flags & 0xffff) === 0;
        cursor = modern ? 10 : 6;
        const count = prefix.u16(modern ? 4 : 0);
        body = cursor + count * 12;
        header = new BinaryReader(await read(0, body));
        if (!modern) {
            game = MixGame.TdRa;
        }
    }
    const count = header.u16(cursor - 6),
        bodySize = header.u32(cursor - 4);
    header.require(cursor, count * 12);
    if (body + bodySize > size || strict && body + bodySize + ((flags & 0xffff) === 0 && flags & 0x10000 ? 20 : 0) !== size) {
        throw new Error('Truncated MIX container.');
    }
    const entries = new Map<number, MixResourceEntry>();
    for (let i = 0; i < count; i++) {
        const at = cursor + i * 12,
            offset = header.u32(at + 4),
            length = header.u32(at + 8);
        if (strict && (offset + length > bodySize || entries.has(header.u32(at)))) { throw new Error('Invalid or duplicate MIX entry.'); }
        if (offset + length <= bodySize) {
            const id = header.u32(at);
            entries.set(id, { id, offset: body + offset, size: length });
        }
    }
    let databaseId: number | undefined;
    const local = entries.get(LOCAL_MIX_DATABASE_ID) ?? entries.get(LEGACY_LOCAL_MIX_DATABASE_ID);
    if (local && local.size >= 52 && local.size <= 4 * 1024 * 1024) {
        const database = readLocalMixDatabase(await read(local.offset, local.size));
        if (database) {
            databaseId = local.id;
            game = database.game;
            for (const name of database.entries) {
                const entry = entries.get(MixArchive.calculateIdBytes(name.encodedName, game));
                if (entry) { entry.name = name.name; }
            }
        }
    }
    for (const entry of entries.values()) {
        entry.name ??= await resolveName(game, entry.id);
        if (!entry.name && game === MixGame.TdRa) {
            entry.name = await resolveName(MixGame.Ts, entry.id);
        }
    }
    // Stock archives frequently omit local filenames; the global database is not complete for containers.
    for (const name of [
        'local.mix',
        'localmd.mix',
        'conquer.mix',
        'conqmd.mix',
        'generic.mix',
        'genermd.mix',
        'cache.mix',
        'cachemd.mix',
        'cameo.mix',
        'cameomd.mix',
        'audio.mix',
        'audiomd.mix',
        'tem.mix',
        'temperat.mix',
        'snow.mix',
        'urban.mix',
        'urbann.mix',
        'desert.mix',
        'lunar.mix',
        'isotemp.mix',
        'isotem.mix',
        'isosnow.mix',
        'isourb.mix',
        'isoubn.mix',
        'isodes.mix',
        'isolun.mix',
    ]) {
        const entry =
            entries.get(MixArchive.calculateId(name, game)) ?? entries.get(MixArchive.calculateId(name, MixGame.Ts));
        if (entry) {
            entry.name = name;
        }
    }
    if (game === MixGame.TdRa && [...entries.values()].some(entry => entry.name && MixArchive.calculateId(entry.name, MixGame.Ts) === entry.id && MixArchive.calculateId(entry.name, MixGame.TdRa) !== entry.id)) { game = MixGame.Ts; }
    return { entries, game, databaseId };
}
