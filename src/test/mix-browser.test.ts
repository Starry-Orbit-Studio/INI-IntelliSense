import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { createHash } from 'crypto';
import { MixArchive } from '../mix/core/archive';
import { MixWorkspaceManager } from '../mix/fs/mix-workspace-manager';
import { MixUriCodec } from '../mix/fs/mix-uri-codec';
import { SafeFileStore } from '../mix/fs/safe-file-store';
import { GlobalMixDb } from '../mix/core/global-mix-db';
import { TextContentService } from '../services/text-content-service';
import { BrowserLocations } from '../mix/browser/locations';
import { BrowserTransfers } from '../mix/browser/transfers';
import { MixDetectorService } from '../services/mix-detector-service';
import { CompareService } from '../compare/compare-service';
import { CompareSource } from '../compare/types';
import { MixGame } from '../mix/core/types';
import { writeLocalMixDatabase, LOCAL_MIX_DATABASE_ID } from '../mix/core/local-mix-database';

const bytes = (text: string) => new TextEncoder().encode(text);
const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
async function archive(entries: Record<string, string | Uint8Array>): Promise<Uint8Array> {
    const pack = await MixArchive.create();
    for (const [name, content] of Object.entries(entries)) {
        pack.writeFile(name, typeof content === 'string' ? bytes(content) : content, {
            create: true,
            overwrite: false,
        });
    }
    return pack.serialize();
}

suite('MIX folder browser and transactions', () => {
    let directory: string, manager: MixWorkspaceManager, locations: BrowserLocations, transfers: BrowserTransfers;
    const disk = (name: string) => vscode.Uri.file(path.join(directory, name));
    const root = (name: string) => MixUriCodec.toRootUri(disk(name));
    const entry = (name: string, file: string) => MixUriCodec.toChildUri(root(name), file);
    setup(async () => {
        await vscode.extensions.getExtension('Astralette.ra2-ini-intellisense')!.activate();
        directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ra2-mix-browser-'));
        manager = new MixWorkspaceManager(
            { getFileName: async () => undefined } as unknown as GlobalMixDb,
            new TextContentService()
        );
        locations = new BrowserLocations(manager);
        transfers = new BrowserTransfers(locations, manager);
    });
    teardown(async () => {
        await fs.rm(directory, { recursive: true, force: true });
    });

    test('serializes stable signed indexes, UTF-8 local names and unknown IDs', async () => {
        const pack = await MixArchive.open(await archive({ 'hello.ini': 'A', '音频.wav': 'B', '0xABCDEF01': 'C' }));
        const first = pack.serialize(),
            second = pack.serialize();
        assert.deepStrictEqual(first, second);
        const reopened = await MixArchive.open(first);
        assert.strictEqual(new TextDecoder().decode(reopened.readFile('/音频.wav')), 'B');
        assert.strictEqual(reopened.entryId('/0xABCDEF01'), 0xabcdef01);
        const view = new DataView(first.buffer),
            count = view.getUint16(4, true);
        const ids = Array.from({ length: count }, (_, index) => view.getInt32(10 + index * 12, true));
        assert.deepStrictEqual(
            ids,
            [...ids].sort((a, b) => a - b)
        );
    });

    test('checksummed packs retain their checksum after modifications', async () => {
        const original = await archive({ 'rules.ini': 'A' }),
            view = new DataView(original.buffer),
            start = 10 + view.getUint16(4, true) * 12;
        view.setUint32(0, 0x10000, true);
        const checked = Buffer.concat([original, createHash('sha1').update(original.subarray(start)).digest()]);
        const pack = await MixArchive.open(checked);
        pack.writeFile('/rules.ini', bytes('NEW'), { create: false, overwrite: true });
        const result = pack.serialize(),
            resultView = new DataView(result.buffer),
            body = 10 + resultView.getUint16(4, true) * 12;
        assert.strictEqual(resultView.getUint32(0, true), 0x10000);
        assert.deepStrictEqual(
            Buffer.from(result.subarray(-20)),
            createHash('sha1').update(result.subarray(body, -20)).digest()
        );
    });

    test('case-insensitive writes replace one ID and retain names on reopen', async () => {
        const pack = await MixArchive.open(await archive({ 'HELLO.INI': 'A' }));
        pack.writeFile('/hello.ini', bytes('B'), { create: false, overwrite: true });
        const next = await MixArchive.open(pack.serialize());
        assert.strictEqual(next.listDirectory('/').filter((file) => /hello/i.test(file.name)).length, 1);
        assert.strictEqual(new TextDecoder().decode(next.readFile(next.findPathByName('hello.ini')!)), 'B');
    });

    test('overwriting a cached rename target retains the source contents', async () => {
        const pack = await MixArchive.open(await archive({ 'a.ini': 'A', 'b.ini': 'B' }));
        pack.readFile('/b.ini');
        pack.rename('/a.ini', '/b.ini', { overwrite: true });
        const reopened = await MixArchive.open(pack.serialize());
        assert.strictEqual(new TextDecoder().decode(reopened.readFile('/b.ini')), 'A');
    });

    test('legacy headers keep the legacy filename database ID', async () => {
        const buffer = new Uint8Array(19),
            view = new DataView(buffer.buffer),
            id = MixArchive.calculateId('hello.ini', MixGame.TdRa);
        view.setUint16(0, 1, true);
        view.setUint32(2, 1, true);
        view.setUint32(6, id, true);
        view.setUint32(14, 1, true);
        buffer[18] = 65;
        const pack = await MixArchive.open(buffer);
        pack.applyDisplayName(id, 'hello.ini');
        const reopened = await MixArchive.open(pack.serialize());
        assert.strictEqual(reopened.getGame(), MixGame.TdRa);
        assert.strictEqual(new TextDecoder().decode(reopened.readFile('/hello.ini')), 'A');
        assert.strictEqual(reopened.entryId('0x54C2D545'), 0x54c2d545);
    });

    test('legacy GBK local names survive a UTF-8 filename addition', async () => {
        const encodedName = Buffer.from('d2f4c6b52e776176', 'hex'),
            id = MixArchive.calculateIdBytes(encodedName, MixGame.Ra2),
            database = writeLocalMixDatabase(MixGame.Ra2, [encodedName]);
        const buffer = new Uint8Array(35 + database.length),
            view = new DataView(buffer.buffer);
        view.setUint16(4, 2, true);
        view.setUint32(6, 1 + database.length, true);
        view.setUint32(10, id, true);
        view.setUint32(18, 1, true);
        view.setUint32(22, LOCAL_MIX_DATABASE_ID, true);
        view.setUint32(26, 1, true);
        view.setUint32(30, database.length, true);
        buffer[34] = 65;
        buffer.set(database, 35);
        const pack = await MixArchive.open(buffer);
        assert.strictEqual(pack.entryId('/音频.wav'), id);
        pack.writeFile('/new.ini', bytes('B'), { create: true, overwrite: false });
        const reopened = await MixArchive.open(pack.serialize());
        assert.strictEqual(reopened.entryId('/音频.wav'), id);
        assert.strictEqual(new TextDecoder().decode(reopened.readFile('/音频.wav')), 'A');
    });

    test('changing another member does not change an open INI timestamp', async () => {
        await fs.writeFile(disk('outer.mix').fsPath, await archive({ 'hello.ini': 'A' }));
        const uri = entry('outer.mix', 'hello.ini'),
            before = await manager.stat(uri);
        await manager.writeFile(entry('outer.mix', 'other.bin'), bytes('OTHER'), { create: true, overwrite: false });
        assert.strictEqual((await manager.stat(uri)).mtime, before.mtime);
        await manager.writeFile(uri, bytes('B'), { create: false, overwrite: true });
        assert.ok((await manager.stat(uri)).mtime > before.mtime);
    });

    test('backup limits include previous sessions and preserve the latest undo', async () => {
        const file = disk('hello.ini').fsPath;
        await fs.writeFile(file, '0');
        const policy = () => ({ count: 2, maxBytes: 1024 });
        for (let index = 1; index <= 3; index++) {
            await new SafeFileStore(policy).update(file, async () => bytes(String(index)));
        }
        assert.strictEqual((await fs.readdir(directory)).filter((name) => name.includes('.ra2-backup-')).length, 2);
        const store = new SafeFileStore(policy);
        const revision = await store.update(file, async () => bytes('4'));
        await store.undo(file, revision);
        assert.strictEqual(await fs.readFile(file, 'utf8'), '3');
    });

    test('unsafe virtual paths and payloads masquerading as MIX are rejected', async () => {
        assert.throws(() => MixUriCodec.toChildUri(root('test.mix'), '/../outside.ini'));
        assert.throws(() =>
            MixUriCodec.decode(
                vscode.Uri.from({
                    scheme: 'ra2mix',
                    query: encodeURIComponent(
                        JSON.stringify({ container: disk('test.mix').toString(), chain: ['../bad'] })
                    ),
                })
            )
        );
        for (const [name, content] of Object.entries({
            'ordinary.dll': Buffer.from('MZ' + 'x'.repeat(96)),
            'actual.big': Buffer.from('BIGF' + 'x'.repeat(96)),
            'bad.mix': new Uint8Array(20),
        })) {
            await fs.writeFile(disk(name).fsPath, content);
            assert.strictEqual(await locations.isArchive(disk(name)), false, name);
        }
    });

    test('recognizes renamed DLL/BIG and empty MIX, invalidates replaced files', async () => {
        const detector = new MixDetectorService(manager);
        for (const name of ['test.dll', 'test.big', 'test.mix']) {
            await fs.writeFile(disk(name).fsPath, new Uint8Array(10));
            assert.strictEqual(await detector.isMixLike(disk(name)), true);
        }
        await fs.writeFile(disk('test.dll').fsPath, Buffer.from('ordinary dll'));
        assert.strictEqual(await detector.isMixLike(disk('test.dll')), false);
    });

    test('nested chains retain directory prefixes', async () => {
        await fs.writeFile(
            disk('outer.mix').fsPath,
            await archive({ 'folder/inner.mix': await archive({ 'hello.ini': 'A' }) })
        );
        const nested = MixUriCodec.toNestedRootUri(entry('outer.mix', '/folder/inner.mix'));
        assert.deepStrictEqual(MixUriCodec.decode(nested).nestedChain, ['folder/inner.mix']);
        assert.strictEqual((await locations.list(nested)).entries[0].name, 'hello.ini');
        const range = await locations.resourceRange(MixUriCodec.toChildUri(nested, 'hello.ini'));
        assert.ok(range && range.offset > 10 && range.size === 1);
    });

    test('one batch updates two nested containers and the outer archive with one backup', async () => {
        await fs.writeFile(
            disk('outer.mix').fsPath,
            await archive({ 'a.mix': await archive({ 'x.ini': 'A' }), 'b.mix': await archive({ 'y.ini': 'B' }) })
        );
        const a = MixUriCodec.toNestedRootUri(entry('outer.mix', 'a.mix')),
            b = MixUriCodec.toNestedRootUri(entry('outer.mix', 'b.mix'));
        await manager.mutate([
            {
                kind: 'write',
                uri: MixUriCodec.toChildUri(a, 'x.ini'),
                content: bytes('AA'),
                create: false,
                overwrite: true,
            },
            {
                kind: 'write',
                uri: MixUriCodec.toChildUri(b, 'new.ini'),
                content: bytes('BB'),
                create: true,
                overwrite: false,
            },
            {
                kind: 'write',
                uri: entry('outer.mix', 'root.ini'),
                content: bytes('ROOT'),
                create: true,
                overwrite: false,
            },
        ]);
        locations.clear();
        assert.strictEqual(new TextDecoder().decode(await locations.read(MixUriCodec.toChildUri(a, 'x.ini'))), 'AA');
        assert.strictEqual(new TextDecoder().decode(await locations.read(MixUriCodec.toChildUri(b, 'new.ini'))), 'BB');
        assert.strictEqual((await fs.readdir(directory)).filter((name) => name.includes('.ra2-backup-')).length, 1);
    });

    test('failed batch leaves the original and cached files unchanged', async () => {
        await fs.writeFile(disk('outer.mix').fsPath, await archive({ 'hello.ini': 'A' }));
        const original = await fs.readFile(disk('outer.mix').fsPath);
        await manager.readFile(entry('outer.mix', 'hello.ini'));
        await assert.rejects(
            manager.mutate([
                {
                    kind: 'write',
                    uri: entry('outer.mix', 'hello.ini'),
                    content: bytes('NEW'),
                    create: false,
                    overwrite: true,
                },
                { kind: 'delete', uri: entry('outer.mix', 'absent.ini'), recursive: false },
            ])
        );
        assert.deepStrictEqual(await fs.readFile(disk('outer.mix').fsPath), original);
        assert.strictEqual(new TextDecoder().decode(await manager.readFile(entry('outer.mix', 'hello.ini'))), 'A');
        assert.ok(!(await fs.readdir(directory)).some((name) => /lock|tmp|backup/.test(name)));
    });

    test('concurrent edits are serialized and undo refuses external changes', async () => {
        await fs.writeFile(disk('outer.mix').fsPath, await archive({}));
        await Promise.all(
            ['a.ini', 'b.ini'].map((name) =>
                manager.writeFile(entry('outer.mix', name), bytes(name), { create: true, overwrite: false })
            )
        );
        locations.clear();
        assert.strictEqual((await locations.list(root('outer.mix'))).entries.length, 2);
        await fs.writeFile(disk('outer.mix').fsPath, await archive({ 'external.ini': 'OUTSIDE' }));
        await assert.rejects(manager.undo(root('outer.mix')));
        assert.strictEqual(
            new TextDecoder().decode(await locations.read(entry('outer.mix', 'external.ini'))),
            'OUTSIDE'
        );
    });

    test('safe replacement detects an external write during preparation', async () => {
        const file = disk('plain.ini').fsPath;
        await fs.writeFile(file, 'A');
        await assert.rejects(
            new SafeFileStore().update(file, async () => {
                await fs.writeFile(file, 'EXTERNAL');
                return bytes('NEW');
            })
        );
        assert.strictEqual(await fs.readFile(file, 'utf8'), 'EXTERNAL');
    });

    test('directory imports flatten explicitly and detect duplicate names', async () => {
        await fs.mkdir(disk('source/sub').fsPath, { recursive: true });
        await fs.writeFile(disk('source/hello.ini').fsPath, 'A');
        await fs.writeFile(disk('source/sub/hello.ini').fsPath, 'B');
        await fs.writeFile(disk('target.mix').fsPath, await archive({}));
        const plan = await transfers.plan([disk('source')], root('target.mix'));
        assert.deepStrictEqual(plan.conflicts, ['hello.ini']);
        plan.files[0].skip = true;
        await transfers.execute(plan);
        assert.strictEqual(new TextDecoder().decode(await locations.read(entry('target.mix', 'hello.ini'))), 'B');
        await transfers.undo();
        assert.strictEqual((await locations.list(root('target.mix'))).entries.length, 0);
    });

    test('MIX-to-directory extraction retains unknown IDs and directory structure', async () => {
        await fs.writeFile(disk('source.mix').fsPath, await archive({ '0xDEADBEEF': 'RAW', 'folder/hello.ini': 'A' }));
        await fs.mkdir(disk('output').fsPath);
        await transfers.execute(
            await transfers.plan([entry('source.mix', '0xDEADBEEF'), entry('source.mix', 'folder')], disk('output'))
        );
        assert.strictEqual(await fs.readFile(disk('output/0xDEADBEEF').fsPath, 'utf8'), 'RAW');
        assert.strictEqual(await fs.readFile(disk('output/folder/hello.ini').fsPath, 'utf8'), 'A');
    });

    test('unknown ID copies and cross-archive moves undo both sides', async () => {
        await fs.writeFile(disk('source.mix').fsPath, await archive({ '0xDEADBEEF': 'RAW' }));
        await fs.writeFile(disk('target.mix').fsPath, await archive({}));
        await transfers.execute(await transfers.plan([entry('source.mix', '0xDEADBEEF')], root('target.mix'), true));
        assert.strictEqual((await locations.list(root('source.mix'))).entries.length, 0);
        assert.strictEqual(
            (await MixArchive.open(await fs.readFile(disk('target.mix').fsPath))).entryId('/0xDEADBEEF'),
            0xdeadbeef
        );
        await transfers.undo();
        assert.strictEqual((await locations.list(root('source.mix'))).entries.length, 1);
        assert.strictEqual((await locations.list(root('target.mix'))).entries.length, 0);
    });

    test('a move failing during source commit restores the target', async () => {
        await fs.writeFile(disk('source.mix').fsPath, await archive({ 'hello.ini': 'A' }));
        await fs.writeFile(disk('target.mix').fsPath, await archive({}));
        const original = hash(await fs.readFile(disk('target.mix').fsPath)),
            mutate = manager.mutate.bind(manager);
        let calls = 0;
        manager.mutate = async (operations) => {
            if (++calls === 2) {
                throw new Error('Simulated source failure');
            }
            return mutate(operations);
        };
        await assert.rejects(
            transfers.execute(await transfers.plan([entry('source.mix', 'hello.ini')], root('target.mix'), true)),
            /Simulated/
        );
        assert.strictEqual(hash(await fs.readFile(disk('target.mix').fsPath)), original);
        assert.strictEqual(new TextDecoder().decode(await locations.read(entry('source.mix', 'hello.ini'))), 'A');
    });

    test('a changed target is rejected after planning, before writing', async () => {
        await fs.writeFile(disk('source.ini').fsPath, 'A');
        await fs.writeFile(disk('target.mix').fsPath, await archive({}));
        const plan = await transfers.plan([disk('source.ini')], root('target.mix'));
        await manager.writeFile(entry('target.mix', 'source.ini'), bytes('EXTERNAL'), {
            create: true,
            overwrite: false,
        });
        await assert.rejects(transfers.execute(plan));
        assert.strictEqual(
            new TextDecoder().decode(await locations.read(entry('target.mix', 'source.ini'))),
            'EXTERNAL'
        );
    });

    test('copying an entire container leaves its bytes unchanged', async () => {
        const original = await archive({ 'hello.ini': 'A' });
        await fs.writeFile(disk('source.mix').fsPath, original);
        await fs.mkdir(disk('output').fsPath);
        await transfers.execute(await transfers.plan([disk('source.mix')], disk('output')));
        assert.deepStrictEqual(await fs.readFile(disk('output/source.mix').fsPath), Buffer.from(original));
    });

    test('compares directory/MIX contents by bytes and supports cancellation', async () => {
        await fs.mkdir(disk('left').fsPath);
        await fs.writeFile(disk('left/hello.ini').fsPath, 'A');
        await fs.writeFile(disk('left/ignored.ra2-backup-1').fsPath, 'BACKUP');
        await fs.writeFile(disk('right.mix').fsPath, await archive({ 'hello.ini': 'B' }));
        const source = (uri: vscode.Uri, kind: 'directory' | 'mix'): CompareSource => ({
            rootUri: uri,
            openUri: uri,
            kind,
            label: '',
            description: '',
        });
        const compare = new CompareService(new TextContentService()),
            left = source(disk('left'), 'directory'),
            right = source(root('right.mix'), 'mix');
        const result = await compare.compare(left, right);
        assert.strictEqual(result.items.length, 1);
        assert.strictEqual(result.items[0].status, 'different');
        const token = new vscode.CancellationTokenSource();
        token.cancel();
        await assert.rejects(compare.compare(left, right, undefined, token.token));
        token.dispose();
    });

    test('directory/file conflicts remain visible when MIX comparisons match by ID', async () => {
        await fs.mkdir(disk('left/hello.ini').fsPath, { recursive: true });
        await fs.writeFile(disk('right.mix').fsPath, await archive({ 'hello.ini': 'A' }));
        const source = (uri: vscode.Uri, kind: 'directory' | 'mix'): CompareSource => ({ rootUri: uri, openUri: uri, kind, label: '', description: '' });
        const compare = new CompareService(new TextContentService()); compare.reader = locations;
        const result = await compare.compare(source(disk('left'), 'directory'), source(root('right.mix'), 'mix'));
        assert.strictEqual(result.items.length, 1); assert.strictEqual(result.items[0].status, 'type-mismatch');
    });

    test('directory move includes empty subfolders, removes the source and can be undone', async () => {
        await fs.mkdir(disk('source/empty').fsPath, { recursive: true });
        await fs.writeFile(disk('source/hello.ini').fsPath, 'A');
        await fs.mkdir(disk('output').fsPath);
        await transfers.execute(await transfers.plan([disk('source')], disk('output'), true));
        await assert.rejects(fs.stat(disk('source').fsPath));
        assert.ok((await fs.stat(disk('output/source/empty').fsPath)).isDirectory());
        await transfers.undo();
        assert.strictEqual(await fs.readFile(disk('source/hello.ini').fsPath, 'utf8'), 'A');
        await assert.rejects(fs.stat(disk('output/source').fsPath));
    });

    test('keep-both conflict resolution preserves the existing file', async () => {
        await fs.writeFile(disk('hello.ini').fsPath, 'NEW');
        await fs.writeFile(disk('target.mix').fsPath, await archive({ 'hello.ini': 'OLD' }));
        const plan = await transfers.plan([disk('hello.ini')], root('target.mix'));
        await transfers.keepBoth(plan);
        await transfers.execute(plan);
        assert.strictEqual(new TextDecoder().decode(await locations.read(entry('target.mix', 'hello.ini'))), 'OLD');
        assert.strictEqual(new TextDecoder().decode(await locations.read(entry('target.mix', 'hello (2).ini'))), 'NEW');
    });

    test('browser undo cannot undo a later INI save through the filesystem', async () => {
        await fs.writeFile(disk('hello.ini').fsPath, 'A');
        await fs.writeFile(disk('target.mix').fsPath, await archive({}));
        await transfers.execute(await transfers.plan([disk('hello.ini')], root('target.mix')));
        await manager.writeFile(entry('target.mix', 'hello.ini'), bytes('LATER SAVE'), {
            create: false,
            overwrite: true,
        });
        await assert.rejects(transfers.undo());
        assert.strictEqual(
            new TextDecoder().decode(await locations.read(entry('target.mix', 'hello.ini'))),
            'LATER SAVE'
        );
    });

    test('known names and unknown IDs compare as the same resource', async () => {
        const name = 'hello.ini',
            id = (await MixArchive.open(await archive({ [name]: 'A' }))).entryId(name)!;
        await fs.writeFile(disk('left.mix').fsPath, await archive({ [name]: 'A' }));
        await fs.writeFile(disk('right.mix').fsPath, await archive({ ['0x' + id.toString(16).padStart(8, '0')]: 'A' }));
        const source = (uri: vscode.Uri): CompareSource => ({
            rootUri: uri,
            openUri: uri,
            kind: 'mix',
            label: '',
            description: '',
        });
        const compare = new CompareService(new TextContentService());
        compare.reader = locations;
        const result = await compare.compare(source(root('left.mix')), source(root('right.mix')));
        assert.strictEqual(result.items.length, 1);
        assert.strictEqual(result.items[0].status, 'identical');
    });

    test('optional native browser, clipboard and nested INI saves', async function () {
        if (!process.env.RA2_WORKBENCH_VERIFY_FILES || !process.env.RA2_WORKBENCH_UI_PORT) {
            this.skip();
            return;
        }
        this.timeout(150000);
        await fs.writeFile(disk('hello.ini').fsPath, '[Hello]\nValue=1\n');
        await fs.writeFile(disk('sample.llf').fsPath, 'UI:First: >-\n  第一行 #正文\n  最后一行\nUI:Next: 下一条\n');
        await fs.writeFile(
            disk('alias.dll').fsPath,
            await archive({ 'inner.mix': await archive({ 'notes.ini': '[Hello]\nValue=1\n' }) })
        );
        const uint32 = (value: number) => {
            const result = Buffer.alloc(4);
            result.writeUInt32LE(value);
            return result;
        };
        const text = Buffer.from('CSF中文', 'utf16le');
        const stringTable = Buffer.concat([
            Buffer.from(' FSC'),
            uint32(3),
            uint32(1),
            uint32(1),
            uint32(0),
            uint32(0),
            Buffer.from(' LBL'),
            uint32(1),
            uint32(7),
            Buffer.from('UI:TEST'),
            Buffer.from(' RTS'),
            uint32(text.length / 2),
            Buffer.from(text.map((byte) => byte ^ 0xff)),
        ]);
        await fs.writeFile(disk('target.mix').fsPath, await archive({ 'strings.csf': stringTable }));
        const original = await fs.readFile(disk('target.mix').fsPath),
            output = path.resolve(__dirname, '../webview-qa/native-files.png');
        await fs.mkdir(path.dirname(output), { recursive: true });
        await vscode.commands.executeCommand('ra2-ini-intellisense.browseFiles', disk(''), disk('target.mix'));
        await require(path.resolve(__dirname, '../../scripts/verify-vscode-files.cjs'))(
            Number(process.env.RA2_WORKBENCH_UI_PORT),
            output
        );
        assert.deepStrictEqual(await fs.readFile(disk('target.mix').fsPath), original);
        const nested = MixUriCodec.toNestedRootUri(MixUriCodec.toChildUri(root('alias.dll'), 'inner.mix')),
            uri = MixUriCodec.toChildUri(nested, 'notes.ini');
        const document = await vscode.workspace.openTextDocument(uri);
        assert.strictEqual(document.languageId, 'ra2-ini');
        const edit = new vscode.WorkspaceEdit();
        edit.replace(uri, new vscode.Range(1, 0, 1, 7), 'Value=2');
        await vscode.workspace.applyEdit(edit);
        assert.ok(await document.save());
        locations.clear();
        assert.ok(new TextDecoder().decode(await locations.read(uri)).includes('Value=2'));
        await vscode.commands.executeCommand('vscode.open', disk('alias.dll'));
        for (
            let attempt = 0;
            attempt < 60 &&
            !vscode.window.tabGroups.all.some((group) =>
                group.tabs.some(
                    (tab) =>
                        tab.input instanceof vscode.TabInputCustom &&
                        tab.input.uri.toString() === disk('alias.dll').toString()
                )
            );
            attempt++
        ) {
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert.ok(
            vscode.window.tabGroups.all.some((group) =>
                group.tabs.some(
                    (tab) =>
                        tab.input instanceof vscode.TabInputCustom &&
                        tab.input.uri.toString() === disk('alias.dll').toString()
                )
            ),
            'Renamed DLL opens through content detection'
        );
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    test('optional ES archive acceptance is read-only and resolves original local names', async function () {
        const project = process.env.RA2_WORKBENCH_REAL_PROJECT;
        if (!project) {
            this.skip();
            return;
        }
        this.timeout(90000);
        const physical = vscode.Uri.file(path.join(project, 'MixBackup', 'ext08.dll')),
            original = await fs.readFile(physical.fsPath),
            stat = await fs.stat(physical.fsPath);
        const uri = MixUriCodec.toRootUri(physical),
            listing = await locations.list(uri);
        assert.strictEqual(await locations.isArchive(physical), true);
        assert.strictEqual(await locations.isArchive(vscode.Uri.file(path.join(project, 'ddraw.dll'))), false);
        assert.strictEqual(listing.entries.length, 192); // 193 index entries, including the managed XCC filename database.
        assert.ok(listing.entries.some((entry) => entry.name === 'gem05.lun'));
        const gem = listing.entries.find((entry) => entry.name === 'gem05.lun')!;
        assert.ok((await locations.read(gem.uri)).length > 1024);
        const large = MixUriCodec.toRootUri(vscode.Uri.file(path.join(project, 'MixBackup', 'ext02.dll')));
        const largeEntries = await locations.list(large);
        assert.ok(largeEntries.entries.length > 1000);
        const samples = largeEntries.entries.filter((entry) => !entry.directory).slice(0, 3),
            hashes = await Promise.all(samples.map(async (entry) => hash(await locations.read(entry.uri))));
        await fs.copyFile(MixUriCodec.decode(large).containerUri.fsPath, disk('large-copy.mix').fsPath);
        await manager.writeFile(entry('large-copy.mix', 'test-only.ini'), bytes('[Test]\nValue=1\n'), {
            create: true,
            overwrite: false,
        });
        locations.clear();
        for (const [index, sample] of samples.entries()) {
            assert.strictEqual(hash(await locations.read(entry('large-copy.mix', sample.name))), hashes[index]);
        }
        await fs.writeFile(
            path.resolve(__dirname, '../mix-es-report.json'),
            JSON.stringify(
                {
                    archive: physical.fsPath,
                    entries: listing.entries.length,
                    largeEntries: largeEntries.entries.length,
                    unchanged: hash(await fs.readFile(physical.fsPath)) === hash(original),
                },
                null,
                2
            )
        );
        assert.deepStrictEqual(await fs.readFile(physical.fsPath), original);
        assert.strictEqual((await fs.stat(physical.fsPath)).mtimeMs, stat.mtimeMs);
    });
});
