import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { MixArchive } from '../mix/core/archive';
import { MixWorkspaceManager } from '../mix/fs/mix-workspace-manager';
import { GlobalMixDb } from '../mix/core/global-mix-db';
import { TextContentService } from '../services/text-content-service';
import { ProjectResources } from '../resources/project-resources';
import { DecoderService } from '../media/decoder-service';
import { MediaService } from '../media/media-service';
import { InspectionService } from '../context/inspection-service';
import { INIManager } from '../parser';
import { SchemaManager } from '../schema-manager';
import { FileTypeManager } from '../file-type-manager';
import { shpFixture, voxelFixture, hvaFixture, idxFixture } from './media-fixtures';
import { encodeWav } from '../media/audio';
import { mixKey, swapWords } from '../mix/core/encrypted-header';
import { normalTransform, voxelTransform, transformPoint } from '../media/voxel-math';
import { readVoxel } from '../media/voxel';
import { MixGame } from '../mix/core/types';
import { MixUriCodec } from '../mix/fs/mix-uri-codec';
import { ThumbnailStore } from '../context/thumbnail-store';
import { inflateSync } from 'zlib';

suite('Project-scoped media integration', () => {
    let directory: string,
        other: string,
        resources: ProjectResources,
        decoder: DecoderService,
        service: InspectionService;
    let rules: vscode.TextDocument, art: vscode.TextDocument, token: vscode.CancellationTokenSource;
    suiteSetup(async function () {
        this.timeout(30000);
        const extension = vscode.extensions.getExtension('Astralette.ra2-ini-intellisense')!;
        await extension.activate();
        directory = await mkdtemp(path.join(os.tmpdir(), 'ra2-workbench-'));
        other = await mkdtemp(path.join(os.tmpdir(), 'ra2-other-project-'));
        const source =
            '[VehicleTypes]\n0=Tank\n[InfantryTypes]\n0=Soldier\n[Animations]\n0=ExpOne\n1=ExpTwo\n[Tank]\nImage=TankArt\nTurret=yes\nVoiceMove=GuardianGIMove\nAnimList=ExpOne,ExpTwo,ExpOne\n[Soldier]\nImage=SoldierArt\nPreviewArt=preview.pcx\n[AudioVisual]\nVoxelLightSource=0.2,-0.9,-0.3\nUseFixedVoxelLighting=yes\n';
        await Promise.all([
            writeFile(path.join(directory, 'rules.ini'), source),
            writeFile(
                path.join(directory, 'art.ini'),
                '[TankArt]\nVoxel=yes\nImage=body\nPrimaryFireFLH=100,0,80\nCameo=icon\n[SoldierArt]\nImage=infantry\nSequence=SoldierSequence\n[SoldierSequence]\nReady=0,1,0,2 ; preserved\n[ExpOne]\nImage=exp1\n[ExpTwo]\nImage=exp2\n'
            ),
            writeFile(path.join(directory, 'sound.ini'), '[GuardianGIMove]\nSounds=$sample loose\nVolume=0.6\n'),
            writeFile(path.join(directory, 'body.vxl'), voxelFixture()),
            writeFile(path.join(directory, 'body.hva'), hvaFixture()),
            writeFile(path.join(directory, 'bodytur.vxl'), voxelFixture()),
            writeFile(path.join(directory, 'bodybarl.vxl'), voxelFixture()),
            writeFile(path.join(directory, 'infantry.shp'), shpFixture()),
            writeFile(path.join(directory, 'icon.shp'), shpFixture()),
            writeFile(path.join(directory, 'exp1.shp'), shpFixture()),
            writeFile(path.join(directory, 'exp2.shp'), shpFixture()),
            writeFile(path.join(directory, 'audio.idx'), idxFixture()),
            writeFile(path.join(directory, 'audio.bag'), new Uint8Array([0, 0, 255, 127])),
            writeFile(
                path.join(directory, 'loose.wav'),
                encodeWav({ samples: new Int16Array([0, 10]), channels: 1, rate: 22050 })
            ),
            writeFile(path.join(other, 'rules.ini'), '[VehicleTypes]\n0=Tank\n[Tank]\nImage=WrongProject\n'),
        ]);
        const pcx = new Uint8Array(131);
        pcx[0] = 10;
        pcx[3] = 8;
        pcx[65] = 3;
        new DataView(pcx.buffer).setUint16(66, 1, true);
        pcx.set([10, 20, 30], 128);
        await writeFile(path.join(directory, 'preview.pcx'), pcx);
        const archive = await MixArchive.open(new Uint8Array(10));
        archive.writeFile('/workbench-unknown.shp', shpFixture(), { create: true, overwrite: false });
        const bankIndex = idxFixture();
        bankIndex.fill(0, 12, 28);
        bankIndex.set(Buffer.from('bank-only'), 12);
        archive.writeFile('/audiomd.idx', bankIndex, { create: true, overwrite: false });
        archive.writeFile('/audiomd.bag', new Uint8Array([0, 0, 255, 127]), { create: true, overwrite: false });
        await writeFile(path.join(directory, 'expand.mix'), archive.serialize());
        await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(other, 'rules.ini')));
        rules = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(directory, 'rules.ini')));
        art = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(directory, 'art.ini')));
        const context = { extensionPath: extension.extensionPath } as vscode.ExtensionContext;
        const mix = new MixWorkspaceManager(new GlobalMixDb(context), new TextContentService());
        resources = new ProjectResources(mix);
        decoder = new DecoderService(path.join(extension.extensionPath, 'dist', 'media-worker.js'));
        const media = new MediaService(resources, decoder, extension.extensionUri);
        const schema = new SchemaManager();
        const dictionary =
            '[Registries]\nVehicleTypes=UnitType\nInfantryTypes=InfantryType\nAnimations=AnimType\n[Sections]\nUnitType=VehicleTypes\nInfantryType=InfantryTypes\nAnimType=Animations\n[ObjectType]\nImage=string\n[TechnoType]:[ObjectType]\nVoiceMove=Sound\nAnimList=AnimList\nPreviewArt=PCXFile\n[UnitType]:[TechnoType]\n[InfantryType]:[TechnoType]\n[AnimType]:[ObjectType]\n[Lists]\nAnimList\n[AnimList]\nType=AnimType\n';
        await writeFile(path.join(directory, 'dictionary.ini'), dictionary);
        schema.loadSchema(dictionary, path.join(directory, 'dictionary.ini'));
        assert.ok(schema.isSchemaLoaded());
        const manager = new INIManager();
        service = new InspectionService(resources, media, manager, schema, new FileTypeManager());
        token = new vscode.CancellationTokenSource();
    });
    suiteTeardown(async () => {
        token?.dispose();
        resources?.dispose();
        decoder?.dispose();
        // Each path was created by mkdtemp above and is removed individually.
        for (const folder of [directory, other].filter(Boolean)) {
            assert.strictEqual(path.dirname(path.resolve(folder)), path.resolve(os.tmpdir()));
            assert.ok(/^ra2-(workbench|other-project)-/.test(path.basename(folder)));
            await rm(folder, { recursive: true, force: true });
        }
    });
    test('unit context resolves rules → art → body/HVA, turret, barrel, cameo and Phobos light', async () => {
        const session = (await service.inspect(rules, new vscode.Position(9, 0), token.token))!;
        assert.strictEqual(session.inspection.owner, 'Tank');
        assert.strictEqual(session.inspection.media?.kind, 'voxel');
        if (session.inspection.media?.kind === 'voxel') {
            assert.deepStrictEqual(
                session.inspection.media.model.parts.map((part) => part.role),
                ['body', 'turret', 'barrel']
            );
            assert.ok(session.inspection.media.model.parts[0].animation);
            assert.strictEqual(session.inspection.media.points[0].name, 'PrimaryFireFLH');
            assert.ok(session.inspection.media.fixed);
        }
        assert.ok(session.inspection.cameo);
        assert.ok(session.inspection.lightEdit);
        assert.ok(!session.inspection.properties.some((item) => item.value === 'WrongProject'));
    });
    test('exact second animation list token targets ExpTwo rather than the first member', async () => {
        const line = rules
            .getText()
            .split('\n')
            .findIndex((text) => text.startsWith('AnimList='));
        const second = rules.lineAt(line).text.indexOf('ExpTwo');
        const session = (await service.inspect(rules, new vscode.Position(line, second + 2), token.token))!;
        assert.strictEqual(session.inspection.focus, 'ExpTwo');
        assert.strictEqual(session.inspection.media?.name, 'exp2.shp');
    });
    test('VoiceMove sound event exposes BAG and loose samples and decodes the chosen bank sample', async () => {
        const line = rules
            .getText()
            .split('\n')
            .findIndex((text) => text.startsWith('VoiceMove='));
        const session = (await service.inspect(rules, new vscode.Position(line, 12), token.token))!;
        assert.strictEqual(session.inspection.assets.length, 2);
        assert.strictEqual(session.inspection.media?.kind, 'audio');
        if (session.inspection.media?.kind === 'audio') {
            assert.strictEqual(session.inspection.media.volume, 0.6);
        }
    });
    test('a sequence section follows its sprite owner and retains shared edit metadata', async () => {
        const line = art
            .getText()
            .split('\n')
            .findIndex((text) => text === '[SoldierSequence]');
        const session = (await service.inspect(art, new vscode.Position(line, 0), token.token))!;
        assert.strictEqual(session.inspection.media?.kind, 'sprite');
        if (session.inspection.media?.kind === 'sprite') {
            assert.strictEqual(session.inspection.media.actions[0].action.name, 'Ready');
        }
    });
    test('unknown MIX hashes resolve by filename without dirtying the archive', async () => {
        const found = await resources.find(rules.uri, 'workbench-unknown.shp');
        assert.strictEqual(found.length, 1);
        assert.strictEqual(found[0].uri.scheme, 'ra2mix');
        assert.deepStrictEqual([...(await resources.read(found[0].uri))], [...shpFixture()]);
        assert.deepStrictEqual([...(await resources.readRange(found[0].uri, 32, 2))], [5, 0]);
    });
    test('a custom PCX tag is discovered through the dictionary rather than its name', async () => {
        const line = rules
            .getText()
            .split('\n')
            .findIndex((text) => text.startsWith('PreviewArt='));
        const session = (await service.inspect(rules, new vscode.Position(line, 13), token.token))!;
        assert.strictEqual(session.inspection.media?.kind, 'image');
        if (session.inspection.media?.kind === 'image') {
            assert.strictEqual(session.inspection.media.width, 1);
        }
    });
    test('cancelled worker requests do not prevent a subsequent valid decode', async () => {
        const cancelled = new vscode.CancellationTokenSource();
        cancelled.cancel();
        await assert.rejects(() => decoder.decode('shp', shpFixture(), cancelled.token));
        cancelled.dispose();
        assert.strictEqual((await decoder.decode<{ width: number }>('shp', shpFixture())).width, 2);
    });
    test('cached decodes retain independent ownership when assembled models are mutated', async () => {
        const first = await decoder.decode<ReturnType<typeof readVoxel>>('voxel', voxelFixture());
        first.parts[0].role = 'turret';
        first.parts.push(first.parts[0]);
        const second = await decoder.decode<ReturnType<typeof readVoxel>>('voxel', voxelFixture());
        assert.strictEqual(second.parts.length, 1);
        assert.strictEqual(second.parts[0].role, 'body');
    });
    test('standard audio banks resolve in a MIX even when the filename table only knows hashes', async () => {
        const media = new MediaService(
            resources,
            decoder,
            vscode.extensions.getExtension('Astralette.ra2-ini-intellisense')!.extensionUri
        );
        const samples = await media.samples(rules.uri, 'bank-only');
        assert.strictEqual(samples.length, 1);
        assert.strictEqual(samples[0].candidate.uri.scheme, 'ra2mix');
        const audio = await media.load(
            samples[0].candidate,
            { origin: rules.uri, sample: samples[0].sample },
            token.token
        );
        assert.strictEqual(audio.kind, 'audio');
    });
    test('sound section properties keep the event context while a whitespace sample selects precisely', async () => {
        const sound = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(directory, 'sound.ini')));
        const volume = (await service.inspect(sound, new vscode.Position(2, 9), token.token))!;
        assert.strictEqual(volume.inspection.assets.length, 2);
        const sample = (await service.inspect(sound, new vscode.Position(1, 17), token.token))!;
        assert.strictEqual(sample.inspection.assets.length, 1);
        assert.strictEqual(sample.inspection.media?.name, 'loose.wav');
    });
    test('resource editors recover the rules owner and voxel thumbnails contain bounded visible pixels', async () => {
        const candidate = (await resources.find(rules.uri, 'body.vxl'))[0];
        const session = (await service.inspectResource(candidate, token.token))!;
        assert.strictEqual(session.inspection.owner, 'Tank');
        const media = new MediaService(
            resources,
            decoder,
            vscode.extensions.getExtension('Astralette.ra2-ini-intellisense')!.extensionUri
        );
        const png = Buffer.from((await media.thumbnail(candidate, token.token, rules.uri))!);
        assert.strictEqual(png.readUInt32BE(16), 96);
        assert.strictEqual(png.readUInt32BE(20), 96);
        let at = 8;
        const chunks: Buffer[] = [];
        while (at < png.length) {
            const size = png.readUInt32BE(at);
            if (png.toString('ascii', at + 4, at + 8) === 'IDAT') {
                chunks.push(png.subarray(at + 8, at + 8 + size));
            }
            at += 12 + size;
        }
        const pixels = inflateSync(Buffer.concat(chunks));
        assert.ok(
            pixels.some((value, index) => index % (96 * 4 + 1) > 0 && (index % (96 * 4 + 1)) % 4 === 0 && value > 0)
        );
    });
    test('replacement capabilities distinguish rules art IDs from art filenames and comments', async () => {
        const rulesImage = (await service.inspect(rules, new vscode.Position(8, 10), token.token))!;
        assert.strictEqual(rulesImage.replacement?.category, 'art');
        const artImage = (await service.inspect(art, new vscode.Position(2, 8), token.token))!;
        assert.strictEqual(artImage.replacement?.extension, '.vxl');
        assert.strictEqual(artImage.inspection.media?.kind, 'voxel');
        if (artImage.inspection.media?.kind === 'voxel') {
            assert.strictEqual(artImage.inspection.media.model.parts.length, 3);
            assert.strictEqual(artImage.inspection.media.points.length, 1);
        }
        assert.strictEqual(artImage.replacement?.category, undefined);
        const header = (await service.inspect(rules, new vscode.Position(7, 0), token.token))!;
        assert.strictEqual(header.inspection.canReplace, undefined);
    });
    test('unsaved Image edits are reflected before saving', async () => {
        assert.ok(service.ini.incoming(rules.uri, 'infantry').length);
        const line = art
            .getText()
            .split('\n')
            .findIndex((text) => text === 'Image=infantry');
        const edit = new vscode.WorkspaceEdit();
        edit.replace(art.uri, art.lineAt(line).range, 'Image=exp2');
        await vscode.workspace.applyEdit(edit);
        const session = (await service.inspect(rules, new vscode.Position(12, 0), token.token))!;
        assert.strictEqual(session.inspection.media?.name, 'exp2.shp');
        assert.strictEqual(service.ini.incoming(rules.uri, 'infantry').length, 0);
        assert.ok(
            service.ini
                .incoming(rules.uri, 'exp2')
                .some((item) => item.uri.toString() === art.uri.toString() && item.line === line)
        );
    });
    test('thumbnail cache keys exclude changing edit capabilities', async () => {
        const context = {
            globalStorageUri: vscode.Uri.file(path.join(directory, 'storage')),
        } as vscode.ExtensionContext;
        const thumbnails = new ThumbnailStore(context, decoder);
        const first = (await service.inspect(rules, new vscode.Position(7, 0), token.token))!;
        const second = (await service.inspect(rules, new vscode.Position(8, 10), token.token))!;
        const left = await thumbnails.create(first.inspection.media, token.token);
        const right = await thumbnails.create(second.inspection.media, token.token);
        assert.ok(left);
        assert.strictEqual(left.toString(), right?.toString());
    });
});

suite('Voxel transforms and encrypted MIX', () => {
    test('HVA rotates bounds and turret offsets remain in body coordinates', () => {
        const part = readVoxel(voxelFixture()).parts[0];
        part.bounds = [-2, -1, 0, 2, 1, 1];
        part.size = [4, 2, 1];
        part.animation = [[0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0]];
        part.role = 'turret';
        part.offset = [5, 0, 0];
        const matrix = voxelTransform(part, 0, 0);
        assert.deepStrictEqual(transformPoint(matrix, [0, 0, 0]), [6, -2, 0]);
        assert.deepStrictEqual(normalTransform([2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0]), [
            0.5,
            0,
            0,
            0,
            1 / 3,
            0,
            0,
            0,
            0.25,
        ]);
    });
    test('RSA key transform matches an independent integer arithmetic vector', () => {
        assert.strictEqual(
            Buffer.from(mixKey(Uint8Array.from({ length: 80 }, (_, i) => i))).toString('hex'),
            'fd0b077d5780a7d08d96681dcbe1bea9450e77fcba6632451c94208a0711274b905a205f5aff6bc04d920b8f3d2f29868be2030a36d40c8e'
        );
    });
    test('encrypted index permits read and rejects mutation before dirtying data', async () => {
        const { Blowfish } = await import('egoroof-blowfish');
        const source = Uint8Array.from({ length: 80 }, (_, i) => i);
        const header = new Uint8Array(24),
            view = new DataView(header.buffer);
        view.setUint16(0, 1, true);
        view.setUint32(2, 4, true);
        view.setUint32(6, MixArchive.calculateId('sample.wav', MixGame.Ts), true);
        view.setUint32(14, 4, true);
        const cipher = new Blowfish(mixKey(source), Blowfish.MODE.ECB, Blowfish.PADDING.NULL);
        const encrypted = swapWords(cipher.encode(swapWords(header))).subarray(0, 24);
        const bytes = new Uint8Array(112);
        new DataView(bytes.buffer).setUint32(0, 0x20000, true);
        bytes.set(source, 4);
        bytes.set(encrypted, 84);
        bytes.set([1, 2, 3, 4], 108);
        const archive = await MixArchive.open(bytes),
            entry = archive.findPathByName('sample.wav')!;
        assert.deepStrictEqual([...archive.readFile(entry)], [1, 2, 3, 4]);
        assert.throws(() => archive.writeFile(entry, new Uint8Array(1), { create: false, overwrite: true }));
        assert.throws(() => archive.rename(entry, 'other.wav', { overwrite: false }));
        assert.throws(() => archive.createDirectory('/new'));
        assert.throws(() => archive.delete(entry, { recursive: false }));
        assert.strictEqual(archive.isDirty(), false);
        // Exercise the actual bundled extension filesystem, not only the imported decoder.
        const folder = await mkdtemp(path.join(os.tmpdir(), 'ra2-workbench-encrypted-'));
        try {
            const file = vscode.Uri.file(path.join(folder, 'encrypted.mix'));
            await writeFile(file.fsPath, bytes);
            let uri = MixUriCodec.toRootUri(file);
            for (let depth = 0; depth < 16; depth++) {
                const [name, type] = (await vscode.workspace.fs.readDirectory(uri))[0];
                uri = vscode.Uri.joinPath(uri, name);
                if (type & vscode.FileType.File) {
                    break;
                }
            }
            assert.deepStrictEqual([...(await vscode.workspace.fs.readFile(uri))], [1, 2, 3, 4]);
            assert.strictEqual((await vscode.workspace.fs.stat(uri)).permissions, vscode.FilePermission.Readonly);
            await assert.rejects(async () => vscode.workspace.fs.writeFile(uri, new Uint8Array([9])));
            assert.deepStrictEqual([...(await vscode.workspace.fs.readFile(file))], [...bytes]);
        } finally {
            assert.strictEqual(path.dirname(path.resolve(folder)), path.resolve(os.tmpdir()));
            assert.ok(path.basename(folder).startsWith('ra2-workbench-encrypted-'));
            await rm(folder, { recursive: true, force: true });
        }
    });
});
