import * as assert from 'assert';
import { inflateSync } from 'zlib';
import { readShp, decodeShpFrame, parseSequenceAction, validateSequence } from '../media/shp';
import { readVoxel, readHva, attachHva } from '../media/voxel';
import { readBagIndex, decodeBagSample, decodeIma, decodeWav, encodeWav } from '../media/audio';
import { encodePng } from '../media/png';
import { ByteCache } from '../media/byte-cache';
import { createPcxPreview } from '../preview/pcx-preview';
import { parsePropertyLine, valueAtCharacter } from '../context/ini-position';
import { shpFixture, voxelFixture, hvaFixture, idxFixture } from './media-fixtures';

suite('Media format and reference regression', () => {
    test('duplicate list items retain exact independent spans', () => {
        const line = 'AnimList= One, Two, One ; comment';
        const parsed = parsePropertyLine(line)!;
        assert.strictEqual(valueAtCharacter(parsed, 11)?.value, 'One');
        assert.strictEqual(valueAtCharacter(parsed, 16)?.value, 'Two');
        assert.strictEqual(valueAtCharacter(parsed, 20)?.index, 2);
        assert.strictEqual(valueAtCharacter(parsed, 13), undefined);
        assert.strictEqual(valueAtCharacter(parsed, 26), undefined);
    });
    for (const format of [0, 1, 2, 3]) {
        test('SHP scanline format ' + format, () => {
            const bytes = shpFixture(format);
            assert.deepStrictEqual(
                [...decodeShpFrame(bytes, readShp(bytes), 0)],
                format === 3 ? [1, 0, 2, 3] : [1, 2, 3, 4]
            );
        });
    }
    test('SHP rejects truncated runs, header offsets and oversized canvases', () => {
        const bytes = shpFixture();
        const view = new DataView(bytes.buffer);
        assert.throws(() => decodeShpFrame(bytes.slice(0, -1), readShp(bytes), 0));
        view.setUint32(28, 8, true);
        assert.throws(() => readShp(bytes));
        view.setUint16(2, 65535, true);
        assert.throws(() => readShp(bytes));
    });
    test('empty SHP frames remain transparent', () => {
        const bytes = shpFixture();
        new DataView(bytes.buffer).setUint32(28, 0, true);
        assert.deepStrictEqual([...decodeShpFrame(bytes, readShp(bytes), 0)], [0, 0, 0, 0]);
    });
    test('SHP permits transparent tail padding while rejecting literals after an overflowing run', () => {
        const bytes = new Uint8Array(41);
        bytes.set(shpFixture(3).subarray(0, 32));
        bytes.set([5, 0, 1, 0, 4, 4, 0, 2, 3], 32);
        assert.deepStrictEqual([...decodeShpFrame(bytes, readShp(bytes), 0)], [1, 0, 2, 3]);
        const invalid = new Uint8Array(42);
        invalid.set(bytes.subarray(0, 32));
        invalid.set([6, 0, 1, 0, 4, 2, 4, 0, 2, 3], 32);
        assert.throws(() => decodeShpFrame(invalid, readShp(invalid), 0));
    });
    test('empty frames tolerate unused format metadata; populated unsupported frames remain invalid', () => {
        const bytes = shpFixture();
        bytes[16] = 4;
        assert.throws(() => readShp(bytes));
        const view = new DataView(bytes.buffer);
        view.setUint16(12, 0, true);
        view.setUint16(14, 0, true);
        view.setUint32(28, 0, true);
        assert.deepStrictEqual([...decodeShpFrame(bytes, readShp(bytes), 0)], [0, 0, 0, 0]);
    });
    test('action directions and extra sequence fields are preserved', () => {
        const action = parseSequenceAction('Walk', '10,6,6, 2')!;
        assert.deepStrictEqual(action.extra, ['2']);
        assert.ok(validateSequence(action, 58, 8));
        assert.ok(!validateSequence(action, 57, 8));
        assert.strictEqual(parseSequenceAction('Walk', '0,-1,6'), undefined);
    });
    test('VXL spans and case-insensitive HVA limb association', () => {
        const model = readVoxel(voxelFixture());
        attachHva(model, readHva(hvaFixture()));
        assert.deepStrictEqual(model.parts[0].voxels, [0, 0, 0, 10, 1]);
        assert.strictEqual(model.parts[0].animation?.[0][3], 12);
    });
    test('VXL and HVA reject invalid offsets and nonfinite matrices', () => {
        const bytes = voxelFixture();
        new DataView(bytes.buffer).setUint32(843 + 8, 999999, true);
        assert.throws(() => readVoxel(bytes));
        const hva = hvaFixture();
        new DataView(hva.buffer).setFloat32(40, NaN, true);
        assert.throws(() => readHva(hva));
        assert.throws(() => readHva(hva.slice(0, -1)));
    });
    test('BAG flags 6 and 12 decode PCM and IMA respectively', () => {
        const pcm = decodeBagSample(new Uint8Array([0, 0, 255, 127]), readBagIndex(idxFixture())[0]);
        assert.deepStrictEqual([...pcm.samples], [0, 32767]);
        const ima = decodeBagSample(new Uint8Array([0, 0, 0, 0, 0x11]), readBagIndex(idxFixture(12, 5))[0]);
        assert.deepStrictEqual([...ima.samples], [0, 1, 2]);
        assert.throws(() => readBagIndex(idxFixture().slice(0, -1)));
    });
    test('stereo IMA block channels interleave independently', () => {
        const block = new Uint8Array([1, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        const samples = decodeIma(block, 2, block.length);
        assert.deepStrictEqual([...samples.slice(0, 6)], [1, 2, 1, 2, 1, 2]);
        block[2] = 89;
        assert.throws(() => decodeIma(block, 2, block.length));
    });
    test('PCM WAV roundtrip and corrupt chunk rejection', () => {
        const wav = encodeWav({ samples: new Int16Array([-32768, 0, 32767]), channels: 1, rate: 22050 });
        assert.deepStrictEqual([...decodeWav(wav).samples], [-32768, 0, 32767]);
        new DataView(wav.buffer).setUint32(40, 100000, true);
        assert.throws(() => decodeWav(wav));
    });
    test('RGB PCX uses three planes per row', () => {
        const bytes = new Uint8Array(134),
            view = new DataView(bytes.buffer);
        bytes[0] = 10;
        bytes[3] = 8;
        bytes[65] = 3;
        view.setUint16(10, 1, true);
        view.setUint16(66, 1, true);
        bytes.set([10, 20, 30, 40, 50, 60], 128);
        assert.deepStrictEqual([...createPcxPreview(bytes, '').pixels], [10, 20, 30, 255, 40, 50, 60, 255]);
        assert.throws(() => createPcxPreview(bytes.slice(0, -1), ''));
    });
    test('PNG export stores lossless scanlines and valid signature', () => {
        const bytes = encodePng(1, 1, new Uint8Array([1, 2, 3, 255]));
        assert.deepStrictEqual([...bytes.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
            length = view.getUint32(33, false);
        assert.deepStrictEqual([...inflateSync(bytes.subarray(41, 41 + length))], [0, 1, 2, 3, 255]);
    });
    test('byte LRU evicts oldest entries while retaining active references', () => {
        const cache = new ByteCache<Uint8Array>(4);
        const held = new Uint8Array(2);
        cache.set('a', held, 2);
        cache.set('b', held, 2);
        cache.get('a');
        cache.set('c', held, 2);
        assert.strictEqual(cache.get('b'), undefined);
        assert.strictEqual(cache.get('a'), held);
        assert.strictEqual(cache.byteLength, 4);
    });
});
