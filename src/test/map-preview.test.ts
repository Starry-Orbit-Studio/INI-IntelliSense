import * as assert from 'assert';
import { decompressLzo } from '../preview/lzo';
import { createMapPreview } from '../preview/map-preview';
import { catalogGroup, catalogLabel, matchesCatalogScope } from '../context/catalog-groups';

function literal(bytes: number[]): number[] {
    if (bytes.length <= 238) {
        return [bytes.length + 17, ...bytes];
    }
    const length: number[] = [0];
    let remaining = bytes.length - 18;
    while (remaining > 255) {
        length.push(0);
        remaining -= 255;
    }
    return [...length, remaining, ...bytes];
}
const end = [17, 0, 0];
function mapBytes(stream: number[], outputSize: number, size = '3,4,2,1'): Uint8Array {
    const header = Buffer.alloc(4);
    header.writeUInt16LE(stream.length);
    header.writeUInt16LE(outputSize, 2);
    const base64 = Buffer.concat([header, Buffer.from(stream)]).toString('base64');
    return Buffer.from('[Preview]\nSize=' + size + '\n[PreviewPack]\n1=' + base64);
}

suite('Map thumbnail decoding and catalog semantics', () => {
    test('decodes RGB channels and width/height independently of the preview origin', () => {
        const preview = createMapPreview(mapBytes([...literal([255, 0, 0, 0, 0, 255]), ...end], 6), 'test');
        assert.strictEqual(preview.kind, 'rgba-image');
        if (preview.kind !== 'rgba-image') {
            return;
        }
        assert.strictEqual(preview.width, 2);
        assert.deepStrictEqual([...preview.pixels], [255, 0, 0, 255, 0, 0, 255, 255]);
    });
    test('decodes overlapping short matches, trailing literals and M1/M3 instructions', () => {
        const stream = [...literal([65, 66, 67, 68]), 65, 0, 69, 0, 0, 33, 0, 0, ...end];
        assert.strictEqual(Buffer.from(decompressLzo(Uint8Array.from(stream), 13)).toString(), 'ABCDDDDEEEEEE');
    });
    test('decodes long literal extensions and both distant match encodings', () => {
        const raw = Array.from({ length: 17000 }, (_, i) => i % 251);
        const stream = [...literal(raw), 0, 0, 17, 4, 0, ...end];
        const expected = [...raw, ...raw.slice(17000 - 2049, 17000 - 2049 + 3), ...raw.slice(618, 621)];
        assert.deepStrictEqual([...decompressLzo(Uint8Array.from(stream), expected.length)], expected);
    });
    test('rejects incomplete streams, invalid offsets and declared lengths instead of returning zero padding', () => {
        const stream = Uint8Array.from([...literal([1, 2, 3, 4]), ...end]);
        for (let length = 0; length < stream.length; length++) {
            assert.throws(() => decompressLzo(stream.subarray(0, length), 4));
        }
        assert.throws(() => decompressLzo(stream, 5));
        assert.throws(() => decompressLzo(stream, 3));
        assert.throws(() => decompressLzo(Uint8Array.from([64, 255, ...end]), 3));
        const invalid = mapBytes([...literal([1, 2, 3]), ...end], 6);
        assert.strictEqual(createMapPreview(invalid, 'bad').kind, 'text');
    });
    test('default game scope excludes sound events, art counterparts and inherited templates', () => {
        assert.strictEqual(catalogGroup({ category: 'sound', type: 'Sound' }), 'sounds');
        assert.strictEqual(catalogGroup({ category: 'art', type: 'UnitType', registered: false }), 'other');
        assert.strictEqual(catalogGroup({ category: 'rules', type: 'UnitType', registered: false }), 'other');
        assert.strictEqual(catalogGroup({ category: 'rules', type: 'UnitType', registered: true }), 'vehicles');
        assert.ok(!matchesCatalogScope('sounds', 'game'));
        assert.ok(matchesCatalogScope('vehicles', 'game'));
        assert.ok(matchesCatalogScope('sounds', 'all'));
        assert.strictEqual(catalogLabel('\n多功能步兵车\n可搭载步兵'), '多功能步兵车');
        assert.strictEqual(catalogLabel('-\n\n多功能步兵车\n可搭载步兵'), '多功能步兵车');
    });
});
