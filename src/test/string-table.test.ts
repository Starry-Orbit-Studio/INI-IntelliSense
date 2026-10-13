import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import { parseCsf, parseLlf } from '../strings/string-table';

function csf(pairs: { label: string; value: string; extra?: string }[]): Buffer {
    const uint = (value: number) => {
        const bytes = Buffer.alloc(4);
        bytes.writeUInt32LE(value);
        return bytes;
    };
    const chunks: Uint8Array[] = [
        Buffer.from(' FSC'),
        uint(3),
        uint(pairs.length),
        uint(pairs.length),
        uint(0),
        uint(0),
    ];
    for (const pair of pairs) {
        const value = Buffer.from(pair.value, 'utf16le').map((byte) => byte ^ 0xff);
        chunks.push(
            Buffer.from(' LBL'),
            uint(1),
            uint(pair.label.length),
            Buffer.from(pair.label),
            Buffer.from(pair.extra === undefined ? ' RTS' : 'WRTS'),
            uint(value.length / 2),
            value
        );
        if (pair.extra !== undefined) {
            chunks.push(uint(pair.extra.length), Buffer.from(pair.extra));
        }
    }
    return Buffer.concat(chunks);
}

suite('String table documents', () => {
    test('LLF converter blocks preserve line breaks, hashes, Unicode and the following entry', () => {
        const table = parseLlf(
            '\uFEFF# note\r\nUI:First: >-\r\n  首行 #正文\r\n  \r\n  最后一行\r\nUI:Next: value # literal\r\nEmpty: \r\n'
        );
        assert.deepStrictEqual(table.entries, [
            { label: 'UI:First', value: '首行 #正文\n\n最后一行', line: 1 },
            { label: 'UI:Next', value: 'value # literal', line: 5 },
            { label: 'Empty', value: '', line: 6 },
        ]);
    });
    test('CSF preserves UTF-16, extra text and duplicate labels without mutating source bytes', () => {
        const bytes = csf([
            { label: 'Name:A', value: '中文 😀\nnext', extra: 'WaveName' },
            { label: 'Name:A', value: 'second' },
        ]);
        const original = Buffer.from(bytes),
            table = parseCsf(bytes);
        assert.strictEqual(table.entries.length, 2);
        assert.strictEqual(table.entries[0].value, '中文 😀\nnext');
        assert.strictEqual(table.entries[0].extraValue, 'WaveName');
        assert.strictEqual(table.entries[1].value, 'second');
        assert.deepStrictEqual(bytes, original);
    });
    test('CSF validates truncated records and impossible lengths', () => {
        const bytes = csf([{ label: 'A', value: 'Hello' }]);
        for (let end = 0; end < bytes.length; end++) {
            assert.throws(() => parseCsf(bytes.subarray(0, end)));
        }
        const invalid = Buffer.from(bytes);
        invalid.writeUInt32LE(0xffffffff, 8);
        assert.throws(() => parseCsf(invalid));
        const shifted = Buffer.concat([Buffer.from('padding'), bytes]);
        assert.strictEqual(parseCsf(shifted.subarray(7)).entries[0].value, 'Hello');
    });
    test('optional real ES string tables parse without changing their files', async function () {
        const project = process.env.RA2_WORKBENCH_REAL_PROJECT;
        if (!project) {
            this.skip();
            return;
        }
        const files: string[] = [];
        for (const directory of [project, path.join(project, 'Rules'), path.join(project, 'Resources', 'UI')]) {
            for (const name of await fs.readdir(directory)) {
                if (/\.(csf|llf)$/i.test(name)) {
                    files.push(path.join(directory, name));
                }
            }
        }
        assert.ok(files.length >= 2, 'Real string tables were discovered');
        for (const file of files) {
            const name = path.basename(file),
                before = await fs.stat(file),
                bytes = await fs.readFile(file);
            const table = /\.csf$/i.test(name) ? parseCsf(bytes) : parseLlf(bytes.toString('utf8'));
            assert.ok(table.entries.length, name);
            assert.strictEqual((await fs.stat(file)).mtimeMs, before.mtimeMs);
        }
    });
});
