import * as assert from 'assert';
import { inflateSync } from 'zlib';
import type { SpriteLayer, SpriteScene, MediaPayload } from '../context/workbench-protocol';
import { spriteBounds, spriteRaster } from '../media/sprite-raster';
import { layerFrame, layerVisible, layerBounds } from '../media/scene-layout';
import { readShp } from '../media/shp';
import { sceneThumbnail } from '../media/scene-thumbnail';

/** Frames move inside one authored canvas; the union must remain fixed. */
function sprite(): Extract<MediaPayload, { kind: 'sprite' }> {
    const bytes = new Uint8Array(8 + 4 * 24 + 4),
        view = new DataView(bytes.buffer);
    view.setUint16(2, 12, true);
    view.setUint16(4, 10, true);
    view.setUint16(6, 4, true);
    for (let frame = 0; frame < 4; frame++) {
        const at = 8 + frame * 24;
        view.setUint16(at, frame % 2 ? 7 : 3, true);
        view.setUint16(at + 2, 4, true);
        view.setUint16(at + 4, 1, true);
        view.setUint16(at + 6, 1, true);
        view.setUint32(at + 20, 104 + frame, true);
        bytes[104 + frame] = frame < 2 ? 16 : 1;
    }
    return {
        kind: 'sprite',
        name: 'body.shp',
        bytes: Buffer.from(bytes).toString('base64'),
        file: readShp(bytes),
        palette: new Array(768).fill(80),
        actions: [],
        shadow: true,
    };
}

function layer(tag: string, media = sprite()): SpriteLayer {
    return { id: tag, name: tag, tag, source: '', state: 'normal', z: 0, offset: [0, 0], start: 0, end: -1, media };
}

suite('Shared building and hover preview', () => {
    test('all sprite frames use one cropped canvas, preserving relative placement and remap', () => {
        const media = sprite(),
            bytes = Buffer.from(media.bytes, 'base64');
        assert.deepStrictEqual(spriteBounds(media.file), { x: 3, y: 4, width: 5, height: 1 });
        const first = spriteRaster(bytes, media.file, media.palette, 0, true);
        const second = spriteRaster(bytes, media.file, media.palette, 1, true);
        assert.strictEqual(first.width, second.width);
        assert.strictEqual(first.height, second.height);
        assert.deepStrictEqual([...first.pixels.slice(0, 4)], [220, 55, 55, 255]);
        assert.deepStrictEqual([...second.pixels.slice(16, 20)], [220, 55, 55, 255]);
        const rawPalette = spriteRaster(bytes, media.file, media.palette, 0, false, undefined, false);
        assert.deepStrictEqual([...rawPalette.pixels.slice(0, 4)], [80, 80, 80, 255]);
        assert.strictEqual(first.pixels[19], 0);
        assert.deepStrictEqual(layerBounds(layer('body')), { x: -3, y: -1, width: 5, height: 1 });
    });
    test('body and Bib remain static in completed/damaged states; construction excludes both', () => {
        const body = layer('body'),
            bib = layer('BibShape'),
            buildup = { ...layer('Buildup'), state: 'construction' as const };
        const scene: SpriteScene = { kind: 'building', foundation: [], trace: [], layers: [body, bib, buildup] };
        for (const frame of [0, 1, 10, 501]) {
            for (const part of [body, bib]) {
                assert.strictEqual(layerFrame(part, 'building', frame, false), 0);
                assert.strictEqual(layerFrame(part, 'building', frame, true), 1);
            }
        }
        assert.strictEqual(layerVisible(body, scene, 'construction'), false);
        assert.strictEqual(layerVisible(bib, scene, 'construction'), false);
        assert.strictEqual(layerVisible(buildup, scene, 'construction'), true);
    });
    test('hover composes Bib below the same default remapped body, without helper grid', () => {
        const media = sprite(),
            body = layer('body', media),
            bib = { ...layer('BibShape', media), z: 10000, offset: [-6, 0] };
        media.scene = { kind: 'building', foundation: [[0, 0]], trace: [], layers: [body, bib] };
        const png = Buffer.from(sceneThumbnail(media));
        assert.strictEqual(png.readUInt32BE(16), 11);
        assert.strictEqual(png.readUInt32BE(20), 1);
        const chunks: Buffer[] = [];
        for (let offset = 8; offset < png.length;) {
            const size = png.readUInt32BE(offset);
            if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT') {
                chunks.push(png.subarray(offset + 8, offset + 8 + size));
            }
            offset += size + 12;
        }
        const pixels = inflateSync(Buffer.concat(chunks));
        assert.deepStrictEqual([...pixels.subarray(1, 5)], [220, 55, 55, 255]);
        assert.deepStrictEqual([...pixels.subarray(25, 29)], [220, 55, 55, 255]);
    });
});
