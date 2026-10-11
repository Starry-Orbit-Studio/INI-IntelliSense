import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { mkdtemp, writeFile, rm, mkdir } from 'fs/promises';
import { MixArchive } from '../mix/core/archive';
import { MixWorkspaceManager } from '../mix/fs/mix-workspace-manager';
import { GlobalMixDb } from '../mix/core/global-mix-db';
import { TextContentService } from '../services/text-content-service';
import { ProjectResources } from '../resources/project-resources';
import { DecoderService } from '../media/decoder-service';
import { MediaService } from '../media/media-service';
import { InspectionService } from '../context/inspection-service';
import { IniDocument, INIManager } from '../parser';
import { ProjectIni } from '../context/project-ini';
import { SchemaManager } from '../schema-manager';
import { FileTypeManager } from '../file-type-manager';
import { shpFixture, voxelFixture, hvaFixture, idxFixture } from './media-fixtures';
import { encodeWav } from '../media/audio';
import { mixKey, decryptMixHeader } from '../mix/core/encrypted-header';
import { normalTransform, voxelTransform, transformPoint } from '../media/voxel-math';
import { readVoxel } from '../media/voxel';
import { MixGame } from '../mix/core/types';
import { MixUriCodec } from '../mix/fs/mix-uri-codec';
import { ThumbnailStore } from '../context/thumbnail-store';
import { inflateSync } from 'zlib';
import { spriteCandidates } from '../context/sprite-scene';
import { indexMix } from '../resources/mix-resource-index';
import { nativeLight, authoredLight, nativeNormal } from '../media/voxel-light';
import { voxelThumbnail } from '../media/voxel-thumbnail';

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
            ...['anim', 'cameo'].map((name) =>
                writeFile(path.join(directory, name + '.pal'), new Uint8Array(768).fill(32))
            ),
            writeFile(
                path.join(directory, 'rules.ini'),
                source +
                    '[VoxelAnims]\n0=Fragment\n[Fragment]\nImage=body\n[BuildingTypes]\n9=SceneBuilding\n[SceneBuilding]\nDamageSmokeOffset=100,100,275\nDamageParticleSystems=TestSmokeSys\n[TestSmokeSys]\nHoldsWhat=TestSmoke\n[TestSmoke]\nImage=exp1\n'
            ),
            writeFile(
                path.join(directory, 'art.ini'),
                '[TankArt]\nVoxel=yes\nImage=body\nPrimaryFireFLH=100,0,80\nCameo=icon\n[SoldierArt]\nImage=infantry\nSequence=SoldierSequence\n[SoldierSequence]\nReady=0,1,0,2 ; preserved\n[ExpOne]\nImage=exp1\n[ExpTwo]\nImage=exp2\n' +
                    '[TankArt]\nAltCameoPCX=preview.pcx\n[SceneBuilding]\nImage=buildingbody\nNewTheater=no\nFoundation=2x2\nBibShape=bib\nProductionAnim=Production\nProductionAnimDamaged=DamagedProduction\nActiveAnim=InheritedAnim\nDamageFireOffset0=10,20\n[Production]\nImage=exp1\nCustomPalette=red.pal\n[DamagedProduction]\nImage=exp2\nCustomPalette=blue.pal\n[InheritedAnim]\nImage=exp1\n'
            ),
            writeFile(path.join(directory, 'bib.shp'), shpFixture()),
            writeFile(path.join(directory, 'buildingbody.shp'), shpFixture()),
            writeFile(
                path.join(directory, 'red.pal'),
                new Uint8Array(768).map((_, index) => (index % 3 === 0 ? 63 : 0))
            ),
            writeFile(
                path.join(directory, 'blue.pal'),
                new Uint8Array(768).map((_, index) => (index % 3 === 2 ? 63 : 0))
            ),
            writeFile(
                path.join(directory, 'override.pal'),
                new Uint8Array(768).map((_, index) => (index % 3 === 1 ? 63 : 0))
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
            writeFile(path.join(directory, 'gtcnst.shp'), shpFixture()),
            writeFile(path.join(directory, 'gtcnst_a.shp'), shpFixture()),
            writeFile(path.join(directory, 'gtcnstmk.shp'), shpFixture()),
            writeFile(
                path.join(directory, 'art-patch.ini'),
                '[GACNST]\nNewTheater=yes\nFoundation=2x3\nActiveAnim=GACNST_A\nBuildup=GACNSTMK\n[GACNST_A]\nNewTheater=yes\n'
            ),
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
        assert.deepStrictEqual(
            session.inspection.cameos?.map((item) => item.media.kind),
            ['sprite', 'image']
        );
        assert.ok(session.inspection.lightEdit);
        assert.ok(session.inspection.sources.some((item) => item.label === 'TankArt · Voxel'));
        assert.ok(!session.inspection.properties.some((item) => item.value === 'WrongProject'));
    });
    test('voxel animation format follows its registry without requiring art Voxel=yes', async () => {
        const line = rules
            .getText()
            .split('\n')
            .findIndex((text) => text === '[Fragment]');
        const session = (await service.inspect(rules, new vscode.Position(line, 0), token.token))!;
        assert.strictEqual(session.inspection.type, 'VoxelAnimType');
        assert.strictEqual(session.inspection.media?.kind, 'voxel');
    });
    test('building layers preserve damage conditions, BibShape and independent palette overrides', async () => {
        const line = rules
            .getText()
            .split('\n')
            .findIndex((text) => text === '[SceneBuilding]');
        const session = (await service.inspect(rules, new vscode.Position(line, 0), token.token))!;
        const scene = () => (session.inspection.media?.kind === 'sprite' ? session.inspection.media.scene : undefined);
        assert.ok(scene()?.layers.find((layer) => layer.tag === 'BibShape')?.media);
        const production = scene()!.layers.find((layer) => layer.tag === 'ProductionAnim')!;
        const damaged = scene()!.layers.find((layer) => layer.tag === 'ProductionAnimDamaged')!;
        assert.strictEqual(production.state, 'production');
        assert.strictEqual(damaged.state, 'production');
        assert.ok(damaged.damaged);
        assert.deepStrictEqual(production.media?.palette.slice(0, 3), [252, 0, 0]);
        assert.deepStrictEqual(damaged.media?.palette.slice(0, 3), [0, 0, 252]);
        assert.ok(scene()?.layers.find((layer) => layer.tag.startsWith('DamageParticleSystems:'))?.media);
        assert.strictEqual(scene()?.points?.filter((point) => /^DamageFireOffset/.test(point.name)).length, 8);
        const override = session.inspection.paletteOptions.find((option) => option.name === 'override.pal')!;
        await service.select(session, session.inspection.selectedAsset!, token.token, override.id, production.id);
        assert.deepStrictEqual(
            scene()!
                .layers.find((layer) => layer.id === production.id)!
                .media?.palette.slice(0, 3),
            [0, 252, 0]
        );
        assert.deepStrictEqual(
            scene()!
                .layers.find((layer) => layer.id === damaged.id)!
                .media?.palette.slice(0, 3),
            [0, 0, 252]
        );
        await service.select(session, session.inspection.selectedAsset!, token.token, override.id);
        assert.deepStrictEqual(
            scene()!
                .layers.find((layer) => layer.tag === 'ActiveAnim')!
                .media?.palette.slice(0, 3),
            [0, 252, 0]
        );
        await service.select(session, session.inspection.selectedAsset!, token.token, '', production.id);
        assert.deepStrictEqual(
            scene()!
                .layers.find((layer) => layer.id === production.id)!
                .media?.palette.slice(0, 3),
            [252, 0, 0]
        );
        const artLine = art
            .getText()
            .split('\n')
            .findIndex((text) => text === '[SceneBuilding]');
        const artSession = (await service.inspect(art, new vscode.Position(artLine, 0), token.token))!;
        assert.strictEqual(artSession.inspection.media?.kind, 'sprite');
        if (artSession.inspection.media?.kind === 'sprite') {
            assert.deepStrictEqual(
                artSession.inspection.media.scene?.points?.find((point) => point.name === 'DamageSmokeOffset')?.value,
                [100, 100, 275]
            );
            assert.ok(
                artSession.inspection.media.scene?.layers.some(
                    (layer) => layer.tag.startsWith('DamageParticleSystems:') && layer.media
                )
            );
        }
    });
    test('background include classification replaces queries cached before art indexing finishes', async () => {
        const root = vscode.Uri.file(path.join(directory, 'CachedArt'));
        const entries = [
            ['rules.ini', '[VehicleTypes]\n0=ALTNK\n[ALTNK]\nImage=GTNK\n'],
            ['art.ini', '[#include]\n0=vehicle-definitions.ini\n[GTNK]\nPrimaryFireFLH=150,0,100\n'],
            ['vehicle-definitions.ini', '[GTNK]\nVoxel=yes\n'],
        ].map(([name, content]) => ({ name, content, uri: vscode.Uri.joinPath(root, name) }));
        const manager = new INIManager();
        for (const entry of entries) {
            manager.documents.set(entry.uri.toString(), new IniDocument(entry.uri, entry.content));
        }
        const catalog = {
            projectRoot: () => root,
            contains: () => true,
            listDocuments: async () => entries,
            read: async (uri: vscode.Uri) =>
                Buffer.from(entries.find((entry) => entry.uri.toString() === uri.toString())!.content),
        } as unknown as ProjectResources;
        const ini = new ProjectIni(catalog, manager, new SchemaManager(), new FileTypeManager());
        try {
            // Hover/annotations can query the main index while include discovery is pending.
            assert.strictEqual(ini.effective(entries[0].uri, 'GTNK', 'art').get('voxel'), undefined);
            await ini.load(entries[0].uri);
            assert.strictEqual(ini.category(entries[2].uri), 'art');
            assert.strictEqual(ini.effective(entries[0].uri, 'GTNK', 'art').get('voxel')?.value, 'yes');
            assert.strictEqual(ini.effective(entries[0].uri, 'GTNK', 'art').get('primaryfireflh')?.value, '150,0,100');
        } finally {
            manager.dispose();
        }
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
    test('included art inherits its file category and composes theater body, active animation, buildup and foundation', async () => {
        const rulesText = rules.getText() + '\n[BuildingTypes]\n0=GACNST\n[GACNST]\n';
        const artText = art.getText() + '\n[#include]\n0=art-patch.ini\n[GACNST]\n';
        // Saved content supplies the include graph; open document content supplies unsaved edits.
        await writeFile(art.uri.fsPath, artText);
        await writeFile(rules.uri.fsPath, rulesText);
        const edit = new vscode.WorkspaceEdit();
        edit.insert(art.uri, new vscode.Position(art.lineCount, 0), '\n[#include]\n0=art-patch.ini\n[GACNST]\n');
        edit.insert(rules.uri, new vscode.Position(rules.lineCount, 0), '\n[BuildingTypes]\n0=GACNST\n[GACNST]\n');
        await vscode.workspace.applyEdit(edit);
        service.ini.invalidate();
        resources.invalidate();
        const session = (await service.inspect(rules, new vscode.Position(rules.lineCount - 2, 0), token.token))!;
        assert.strictEqual(session.inspection.type, 'BuildingType');
        assert.strictEqual(session.inspection.media?.kind, 'sprite');
        if (session.inspection.media?.kind === 'sprite') {
            // One-frame files do not invent a shadow frame, even with a building default.
            assert.strictEqual(session.inspection.media.shadow, false);
            assert.strictEqual(session.inspection.media.scene?.foundation.length, 6);
            assert.deepStrictEqual(
                session.inspection.media.scene?.layers.map((layer) => layer.media?.name),
                ['gtcnst.shp', 'gtcnst_a.shp', 'gtcnstmk.shp']
            );
        }
        const snow = await spriteCandidates(
            resources,
            rules.uri,
            'GACNST',
            service.ini.effective(rules.uri, 'GACNST', 'art')
        );
        assert.ok(snow.names.includes('GTCNST.shp'));
    });
    test('building theater fallback preserves direct images and explicit NewTheater=no', async () => {
        const fallback = await spriteCandidates(resources, rules.uri, 'GACNST', new Map(), true);
        assert.deepStrictEqual(fallback.names, ['GACNST.shp', 'GTCNST.shp', 'GGCNST.shp']);
        assert.strictEqual(fallback.candidates[0]?.name, 'gtcnst.shp');
        const properties = new Map([
            [
                'newtheater',
                { key: 'NewTheater', value: 'no', uri: art.uri, line: 0, section: 'GACNST', inherited: false },
            ],
        ]);
        const explicit = await spriteCandidates(resources, rules.uri, 'GACNST', properties, true);
        assert.deepStrictEqual(explicit.names, ['GACNST.shp']);
    });
    test('theater-named SHP sprites can be decoded and thumbnailed without treating their suffix as a format', async () => {
        const uri = vscode.Uri.joinPath(vscode.Uri.file(directory), 'sprite.tem');
        await writeFile(uri.fsPath, shpFixture());
        const extension = vscode.extensions.getExtension('Astralette.ra2-ini-intellisense')!;
        const media = new MediaService(resources, decoder, extension.extensionUri);
        const candidate = { uri, name: 'sprite.tem', source: 'sprite.tem', priority: 0 };
        assert.strictEqual((await media.load(candidate, { origin: rules.uri }, token.token)).kind, 'sprite');
        const thumbnail = await media.thumbnail(candidate, token.token, rules.uri);
        assert.ok(thumbnail && thumbnail.length > 8);
    });
    test('RA2 lighting accepts legacy normal-mode metadata on an otherwise valid VXL', async () => {
        const bytes = voxelFixture();
        bytes[bytes.length - 1] = 2;
        const uri = vscode.Uri.joinPath(vscode.Uri.file(directory), 'legacy.vxl');
        await writeFile(uri.fsPath, bytes);
        const extension = vscode.extensions.getExtension('Astralette.ra2-ini-intellisense')!;
        const media = new MediaService(resources, decoder, extension.extensionUri);
        const decoded = await media.load(
            { uri, name: 'legacy.vxl', source: 'legacy.vxl', priority: 0 },
            { origin: rules.uri },
            token.token
        );
        assert.strictEqual(decoded.kind, 'voxel');
        if (decoded.kind === 'voxel') {
            assert.strictEqual(decoded.model.parts[0].normalsMode, 2);
            assert.ok(decoded.normals.length >= 3 * 244);
        }
    });
    test('split Rules/Resources projects load nested includes and a root patch through the same catalog', async () => {
        const root = path.join(directory, 'SplitLayout');
        await mkdir(path.join(root, 'Rules', 'Factions'), { recursive: true });
        await mkdir(path.join(root, 'Resources', 'Models'), { recursive: true });
        await Promise.all([
            writeFile(
                path.join(root, 'Rules', 'rules.ini'),
                '[#include]\n0=Factions/faction.ini\n1=RootPatch.ini\n[VehicleTypes]\n0=SplitTank\n'
            ),
            writeFile(path.join(root, 'Rules', 'Factions', 'faction.ini'), '[SplitTank]\nImage=WrongArt\n'),
            writeFile(path.join(root, 'RootPatch.ini'), '[SplitTank]\nImage=SplitArt\n'),
            writeFile(path.join(root, 'Rules', 'art.ini'), '[SplitArt]\nVoxel=yes\nImage=split-body\n'),
            writeFile(path.join(root, 'Resources', 'Models', 'split-body.vxl'), voxelFixture()),
        ]);
        resources.invalidate();
        service.ini.invalidate();
        const document = await vscode.workspace.openTextDocument(
            vscode.Uri.file(path.join(root, 'Rules', 'rules.ini'))
        );
        await service.ini.load(document.uri);
        const patch = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, 'RootPatch.ini')));
        const session = (await service.inspect(patch, new vscode.Position(0, 0), token.token))!;
        const owner = await vscode.workspace.openTextDocument(
            vscode.Uri.file(path.join(root, 'Rules', 'Factions', 'faction.ini'))
        );
        const properties = service.ini.effective(document.uri, 'SplitTank', 'rules');
        assert.strictEqual(properties.get('image')?.value, 'SplitArt');
        assert.strictEqual(service.ini.category(vscode.Uri.file(path.join(root, 'RootPatch.ini'))), 'rules');
        assert.strictEqual(resources.projectRoot(owner.uri).fsPath.toLowerCase(), root.toLowerCase());
        const candidate = (await resources.find(document.uri, 'split-body.vxl'))[0];
        assert.ok(candidate);
        assert.strictEqual(resources.projectRoot(candidate.uri).fsPath.toLowerCase(), root.toLowerCase());
        assert.ok(resources.contains(document.uri, owner.uri));
        assert.ok(!resources.contains(document.uri, rules.uri));
        assert.strictEqual(
            session.inspection.media?.kind,
            'voxel',
            JSON.stringify({
                owner: session.inspection.owner,
                type: session.inspection.type,
                warnings: session.inspection.warnings,
                root: resources.projectRoot(patch.uri).fsPath,
                art: [...service.ini.effective(patch.uri, 'SplitArt', 'art')],
            })
        );
        assert.strictEqual(resources.label(document.uri, candidate.uri), 'Resources/Models/split-body.vxl');
    });
});

suite('Voxel transforms and encrypted MIX', () => {
    test('game hover thumbnails shade through VPL and honor the default house remap', () => {
        const payload = {
            kind: 'voxel' as const,
            name: 'game.vxl',
            model: readVoxel(voxelFixture()),
            palette: Array.from({ length: 768 }, (_, index) => Math.floor(index / 3)),
            vpl: Array.from({ length: 8192 }, (_, index) => Math.floor(index / 256) * 4),
            normals: [0, 0, 1, 1, 0, 0],
            light: [1, 0, 0],
            fixed: true,
            points: [],
        };
        const lit = voxelThumbnail(payload);
        const dark = voxelThumbnail({ ...payload, light: [-1, 0, 0] });
        assert.notDeepStrictEqual(lit, dark, 'changing game lighting must change the VPL-shaded thumbnail');
        payload.vpl.fill(20);
        const png = Buffer.from(voxelThumbnail(payload));
        const chunks: Buffer[] = [];
        for (let offset = 8; offset < png.length;) {
            const size = png.readUInt32BE(offset);
            if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT') {
                chunks.push(png.subarray(offset + 8, offset + 8 + size));
            }
            offset += 12 + size;
        }
        const scanlines = inflateSync(Buffer.concat(chunks));
        let remapped = false;
        for (let y = 0; y < 96; y++) {
            for (let x = 0; x < 96; x++) {
                const at = y * 385 + 1 + x * 4;
                if (scanlines[at + 3] && scanlines[at] > scanlines[at + 1]) {
                    remapped = true;
                }
            }
        }
        assert.ok(remapped, 'house colors must match the interactive default rather than raw palette remap entries');
    });
    test('legacy RA2 archives resolve CRC names without a game marker', async () => {
        const bytes = new Uint8Array(22);
        const view = new DataView(bytes.buffer);
        view.setUint16(0, 1, true);
        view.setUint32(2, 4, true);
        view.setUint32(6, MixArchive.calculateId('audio.idx', MixGame.Ra2), true);
        view.setUint32(14, 4, true);
        bytes.set([1, 2, 3, 4], 18);
        const archive = await MixArchive.open(bytes);
        const filename = archive.findPathByName('audio.idx');
        assert.ok(filename);
        assert.deepStrictEqual([...archive.readFile(filename)], [1, 2, 3, 4]);
        await assert.rejects(() => MixArchive.open(bytes.subarray(0, 20)), /truncated|不完整/);
    });
    test('a captured original encrypted header decrypts independently of the encoder under test', async () => {
        // Only the public directory prefix is retained; there is no game media in this fixture.
        const bytes = new Uint8Array(348);
        bytes.set(
            Buffer.from(
                '000003007ad285eac52c40068ae8c3962366a5d1f77c4b04d335c190cadabb8c9b25e408654ba327d3db580a30a0d97a6005caa127c839c1f5a28094a6aa4b1ab91156ab881e3061afa04c614d96f580b5753e03a70e68056a9204b1',
                'hex'
            )
        );
        const header = await decryptMixHeader(bytes);
        const view = new DataView(header.bytes.buffer, header.bytes.byteOffset);
        assert.strictEqual(view.getUint16(0, true), 21);
        assert.strictEqual(view.getUint32(2, true), 281888112);
        assert.strictEqual(header.bodyOffset, 348);
    });
    test('lighting uses the reference world axes consistently with authored normals', () => {
        assert.deepStrictEqual(nativeLight([1, 2, 3]), [-3, -1, -2]);
        assert.deepStrictEqual(authoredLight(nativeLight([1, 2, 3])), [1, 2, 3]);
        assert.deepStrictEqual(nativeNormal([1, 2, 3]), [2, 1, 3]);
    });
    test('metadata indexing reads a nested MIX by ranges and preserves filename hashes', async () => {
        const archive = await MixArchive.open(new Uint8Array(10));
        archive.writeFile('/sample.wav', new Uint8Array([4, 3, 2, 1]), { create: true, overwrite: false });
        const bytes = archive.serialize();
        const indexed = await indexMix(
            bytes.length,
            async (offset, length) => bytes.slice(offset, offset + length),
            async () => undefined
        );
        const entry = indexed.entries.get(MixArchive.calculateId('sample.wav', indexed.game))!;
        assert.deepStrictEqual([...bytes.slice(entry.offset, entry.offset + entry.size)], [4, 3, 2, 1]);
    });
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
        const encrypted = cipher.encode(header).subarray(0, 24);
        const bytes = new Uint8Array(112);
        new DataView(bytes.buffer).setUint32(0, 0x20000, true);
        bytes.set(source, 4);
        bytes.set(encrypted, 84);
        bytes.set([1, 2, 3, 4], 108);
        const archive = await MixArchive.open(bytes),
            entry = archive.findPathByName('sample.wav')!;
        const ranges: [number, number][] = [];
        await indexMix(
            bytes.length,
            async (offset, length) => {
                ranges.push([offset, length]);
                return bytes.subarray(offset, offset + length);
            },
            async () => undefined
        );
        assert.ok(
            ranges.every(([offset, length]) => offset + length <= 108),
            'metadata indexing must not read media payload'
        );
        assert.ok(
            ranges.some(([offset, length]) => offset === 84 && length === 24),
            'encrypted directory read must use its exact length'
        );
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
