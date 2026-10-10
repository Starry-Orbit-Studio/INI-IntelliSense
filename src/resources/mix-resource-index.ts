import { BinaryReader } from '../media/binary-reader';
import { decryptMixHeader } from '../mix/core/encrypted-header';
import { MixArchive } from '../mix/core/archive';
import { MixGame } from '../mix/core/types';
import { decodeLocalText } from '../mix/core/local-encoding';

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
    resolveName: (game: MixGame, id: number) => Promise<string | undefined>
): Promise<{ entries: Map<number, MixResourceEntry>; game: MixGame }> {
    const prefix = new BinaryReader(await read(0, Math.min(size, 92)));
    prefix.require(0, 6);
    const flags = prefix.u32(0);
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
    if (body + bodySize > size) {
        throw new Error('Truncated MIX container.');
    }
    const entries = new Map<number, MixResourceEntry>();
    for (let i = 0; i < count; i++) {
        const at = cursor + i * 12,
            offset = header.u32(at + 4),
            length = header.u32(at + 8);
        if (offset + length <= bodySize) {
            const id = header.u32(at);
            entries.set(id, { id, offset: body + offset, size: length });
        }
    }
    const local = entries.get(0x366e051f);
    if (local && local.size >= 52 && local.size <= 4 * 1024 * 1024) {
        const data = await read(local.offset, local.size),
            db = new BinaryReader(data);
        if (db.ascii(0, 21) === 'XCC by Olaf van der Sp') {
            const gameId = db.u32(44);
            game = [5, 6].includes(gameId) ? MixGame.Ra2 : [0, 1].includes(gameId) ? MixGame.TdRa : MixGame.Ts;
            let offset = 52;
            for (let i = 0; i < Math.min(db.u32(48), 100000) && offset < data.length; i++) {
                const end = data.indexOf(0, offset);
                if (end < 0) {
                    break;
                }
                const name = decodeLocalText(data.subarray(offset, end));
                const entry = entries.get(MixArchive.calculateId(name, game));
                if (entry) {
                    entry.name = name;
                }
                offset = end + 1;
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
    return { entries, game };
}
