import { catalogGroup } from '../context/catalog-groups';
import { animatedThumbnail } from '../media/animated-thumbnail';
import { voxelTransform, transformPoint } from '../media/voxel-math';
import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import { readFile, writeFile } from 'fs/promises';
import { INIManager } from '../parser';
import { SchemaManager } from '../schema-manager';
import { FileTypeManager } from '../file-type-manager';
import { MixWorkspaceManager } from '../mix/fs/mix-workspace-manager';
import { GlobalMixDb } from '../mix/core/global-mix-db';
import { TextContentService } from '../services/text-content-service';
import { ProjectResources } from '../resources/project-resources';
import { DecoderService } from '../media/decoder-service';
import { MediaService } from '../media/media-service';
import { InspectionService, InspectionSession } from '../context/inspection-service';

suite('Optional real mod acceptance', () => {
    test('real mod sprites, audio and voxel units resolve through the extension entry points', async function () {
        const root = process.env.RA2_WORKBENCH_REAL_PROJECT;
        if (!root) {
            this.skip();
            return;
        }
        this.timeout(240000);
        const dictionary =
            process.env.RA2_WORKBENCH_DICTIONARY ?? 'C:/Projects/RA2ModdingTools/RA2-INI-Dictionary/INIDictionary.ini';
        const configuration = vscode.workspace.getConfiguration('ra2-ini-intellisense');
        const previousDictionary = configuration.inspect<string>('schemaFilePath')?.globalValue;
        if (process.env.RA2_WORKBENCH_VERIFY_PANEL) {
            await configuration.update('schemaFilePath', dictionary, vscode.ConfigurationTarget.Global);
        }
        const extension = vscode.extensions.getExtension('Astralette.ra2-ini-intellisense')!;
        await extension.activate();
        if (process.env.RA2_WORKBENCH_VERIFY_PANEL) {
            const commands = await vscode.commands.getCommands(true);
            assert.ok(commands.includes('ra2-ini-intellisense.inspect'));
            assert.ok(
                commands.includes('ra2-object-inspector.focus'),
                'VS Code registers the contributed inspector view'
            );
            if (process.env.RA2_WORKBENCH_TEST_VSIX) {
                assert.notStrictEqual(
                    path.resolve(extension.extensionPath),
                    path.resolve(__dirname, '..', '..'),
                    'acceptance test must load the installed VSIX, not the development extension'
                );
            }
        }
        const subscriptions: vscode.Disposable[] = [];
        const context = {
            subscriptions,
            extensionPath: extension.extensionPath,
            globalStorageUri: vscode.Uri.file(path.join(extension.extensionPath, 'out', 'real-media-thumbnails')),
        } as vscode.ExtensionContext;
        const resources = new ProjectResources(
            new MixWorkspaceManager(new GlobalMixDb(context), new TextContentService())
        );
        const decoder = new DecoderService(path.join(extension.extensionPath, 'dist', 'media-worker.js'));
        const schema = new SchemaManager();
        schema.loadSchema(await readFile(dictionary, 'utf8'), dictionary);
        const media = new MediaService(resources, decoder, extension.extensionUri);
        const service = new InspectionService(resources, media, new INIManager(), schema, new FileTypeManager());
        const token = new vscode.CancellationTokenSource();
        const report: unknown[] = [];
        try {
            const origin = vscode.Uri.file(path.join(root, 'Rules', 'ruleses_AL.ini'));
            await service.ini.load(origin);
            if (process.env.RA2_WORKBENCH_VERIFY_CATALOG) {
                const started = Date.now();
                const catalog = await service.catalog(origin, token.token);
                const tank = [...catalog.objects!.values()].find(
                    (object) => object.name === 'ALTNK' && object.category === 'rules'
                );
                assert.strictEqual(tank?.type, 'UnitType');
                assert.strictEqual(catalogGroup(tank!), 'vehicles');
                const ambient = [...catalog.objects!.values()].find(
                    (object) => object.name === '_Amb_UrbanMurmur1' && object.category === 'sound'
                );
                assert.ok(ambient, 'ES environment sound remains searchable');
                assert.strictEqual(catalogGroup(ambient), 'sounds');
                assert.ok(
                    catalog.inspection.objects!.some(
                        (object) => object.name === 'ALTANY' && object.group === 'infantry'
                    )
                );
                assert.ok(
                    !catalog.inspection.objects!.some(
                        (object) =>
                            object.category === 'art' && ['vehicles', 'infantry', 'buildings'].includes(object.group!)
                    )
                );

                assert.ok(catalog.isCurrent?.());
                report.push({
                    groups: Object.fromEntries(
                        [...new Set(catalog.inspection.objects!.map((object) => object.group))].map((group) => [
                            group,
                            catalog.inspection.objects!.filter((object) => object.group === group).length,
                        ])
                    ),
                    objectCatalog: catalog.objects!.size,
                    elapsedMs: Date.now() - started,
                    serializedBytes: Buffer.byteLength(JSON.stringify(catalog.inspection)),
                    tankImage: tank.properties.get('image')?.effective.value,
                });
                if (process.env.RA2_WORKBENCH_PLATFORM_UI_PORT) {
                    await vscode.commands.executeCommand('ra2-ini-intellisense.browseObjects', origin);
                    const verify: (
                        port: number,
                        output: string,
                        command: (name: string) => Promise<unknown>
                    ) => Promise<void> = require('../../scripts/verify-vscode-platform.cjs');
                    await verify(
                        Number(process.env.RA2_WORKBENCH_PLATFORM_UI_PORT),
                        path.join(extension.extensionPath, 'out', 'webview-qa', 'vscode-platform.png'),
                        (name) =>
                            Promise.resolve(
                                vscode.commands.executeCommand(
                                    name,
                                    ...(name === 'ra2-ini-intellisense.previewMap'
                                        ? [vscode.Uri.file(path.join(root, 'Custom Maps', 'ring.map'))]
                                        : [])
                                )
                            )
                    );
                    report.push({ nativeCatalogBatchPreview: true });
                }
            }
            for (const file of ['artes.ini', 'artes_AL.ini', 'artes_Regular.ini', 'artes_Explosion.ini']) {
                assert.strictEqual(service.ini.category(vscode.Uri.file(path.join(root, 'Rules', file))), 'art', file);
            }
            assert.strictEqual(service.ini.category(vscode.Uri.file(path.join(root, 'Rules', 'soundes.ini'))), 'sound');
            assert.strictEqual(service.ini.effective(origin, 'GTNK', 'art').get('voxel')?.value, 'yes');
            const effect = await vscode.workspace.openTextDocument(
                vscode.Uri.file(path.join(root, 'Rules', 'ruleses_Attacheffect.ini'))
            );
            const effectLine = effect
                .getText()
                .split(/\r?\n/)
                .findIndex((line) => /^Animation=auhuany-330\s*$/.test(line));
            assert.ok(effectLine >= 0);
            assert.ok(
                service.isReference(effect, effectLine),
                'unknown Animation tag is classified from the target registry'
            );
            const effectPosition = new vscode.Position(effectLine, 13);
            const effectSession = (await service.inspect(effect, effectPosition, token.token))!;
            assert.strictEqual(effectSession.inspection.focus, 'auhuany-330');
            assert.strictEqual(effectSession.inspection.media?.name.toLowerCase(), 'auhuany-330.shp');
            assert.strictEqual(effectSession.options.paletteName, 'auhuany_ae.pal');
            assert.strictEqual(effectSession.options.remap, false);
            if (effectSession.inspection.media?.kind === 'sprite') {
                assert.ok(effectSession.inspection.media.scene?.layers.every((layer) => !layer.remap));
            }
            let effectHover = '';
            for (let attempt = 0; attempt < 40; attempt++) {
                const results = await vscode.commands.executeCommand<vscode.Hover[]>(
                    'vscode.executeHoverProvider',
                    effect.uri,
                    effectPosition
                );
                effectHover = (results ?? [])
                    .flatMap((hover) => hover.contents)
                    .map((content) =>
                        typeof content === 'object' && 'value' in content ? content.value : String(content)
                    )
                    .join('\n');
                if (effectHover.includes('data:image/png;base64,')) {
                    break;
                }
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
            assert.ok(
                effectHover.includes('data:image/png;base64,'),
                'actual unknown Animation tag hover contains a rendered image: ' + effectHover
            );
            assert.ok(
                effectHover
                    .replace(/\\/g, '')
                    .replace(/&nbsp;/g, ' ')
                    .includes('auhuany-330 · AnimType'),
                effectHover.slice(0, 180)
            );
            if (process.env.RA2_WORKBENCH_UI_OWNER === 'MirageAnimAE') {
                const editor = await vscode.window.showTextDocument(effect);
                editor.selection = new vscode.Selection(effectPosition, effectPosition);
                editor.revealRange(
                    new vscode.Range(effectPosition, effectPosition),
                    vscode.TextEditorRevealType.InCenter
                );
                const verifyHover = require('../../scripts/verify-vscode-hover.cjs');
                await verifyHover(
                    Number(process.env.RA2_WORKBENCH_UI_PORT),
                    path.join(extension.extensionPath, 'out', 'webview-qa', 'vscode-unknown-animation.png'),
                    async () => {
                        await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
                        editor.selection = new vscode.Selection(effectPosition, effectPosition);
                        await vscode.commands.executeCommand('editor.action.showHover');
                    },
                    'MirageAnimAE',
                    'sprite'
                );
            }
            report.push({
                name: 'MirageAnimAE:Animation',
                focus: effectSession.inspection.focus,
                palette: effectSession.options.paletteName,
                warnings: effectSession.inspection.warnings,
            });
            for (const [file, name, kind] of [
                ['ruleses.ini', 'GACNST', 'sprite'],
                ['artes_Explosion.ini', 'P_EXPA_120B', 'sprite'],
                ['soundes.ini', 'TanyaPrimeSelect', 'audio'],
                ['ruleses.ini', 'GasCloud1', 'sprite'],
                ['ruleses_AL.ini', 'ALIFV', 'voxel'],
                ['ruleses_AL.ini', 'ALTNK', 'voxel'],
                ['ruleses_AL.ini', 'ALV22B', 'voxel'],
                ['ruleses_AL.ini', 'ALBFRT', 'voxel'],
                ['ruleses_AL.ini', 'AAPRTC', 'sprite'],
                ['ruleses_AL.ini', 'ALMINDebris', 'voxel'],
                ['ruleses.ini', 'GAWEAP', 'sprite'],
                ['ruleses.ini', 'NASAM', 'sprite'],
                ['ruleses.ini', 'GTGCAN', 'sprite'],
                ['ruleses_AL.ini', 'ALMARV', 'voxel'],
                ['ruleses_SO.ini', 'SOMRBST1', 'voxel'],
                ['ruleses_AL.ini', 'AACSPH', 'sprite'],
            ]) {
                const document: vscode.TextDocument = await vscode.workspace.openTextDocument(
                    vscode.Uri.file(path.join(root, 'Rules', file))
                );
                const line = document
                    .getText()
                    .split(/\r?\n/)
                    .findIndex((text) => text.startsWith('[' + name + ']'));
                assert.ok(line >= 0, name + ' section exists');
                const start = Date.now();
                const session: InspectionSession = (await service.inspect(
                    document,
                    new vscode.Position(line, 0),
                    token.token
                ))!;
                report.push({
                    name,
                    type: session.inspection.type,
                    milliseconds: Date.now() - start,
                    assets: session.inspection.assets,
                    warnings: session.inspection.warnings,
                    sprite:
                        session.inspection.media?.kind === 'sprite'
                            ? {
                                  width: session.inspection.media.file.width,
                                  height: session.inspection.media.file.height,
                                  frames: session.inspection.media.file.frames.length,
                                  shadow: session.inspection.media.shadow,
                              }
                            : undefined,
                    scene:
                        session.inspection.media?.kind === 'sprite' ? session.inspection.media.scene?.trace : undefined,
                    index: name === 'GACNST' ? await resources.describeIndex(document.uri) : undefined,
                });
                assert.strictEqual(
                    session.inspection.media?.kind,
                    kind,
                    name + ': ' + session.inspection.warnings.join('; ')
                );
                if (name === 'GasCloud1') {
                    assert.strictEqual(session.inspection.type, 'ParticleType');
                    assert.strictEqual(session.options.paletteName, 'anim.pal');
                    assert.strictEqual(session.options.remap, false);
                }
                if (name === 'GACNST' && session.inspection.media?.kind === 'sprite') {
                    assert.strictEqual(session.inspection.media.scene?.foundation.length, 16);
                    assert.ok(
                        session.inspection.media.scene.layers.some((layer) => layer.tag === 'Buildup' && layer.media)
                    );
                }
                if (name === 'ALIFV' || name === 'ALTNK') {
                    assert.deepStrictEqual(
                        session.inspection.cameos?.map((item) => item.tag),
                        ['Cameo', 'AltCameo']
                    );
                }
                if (name === 'ALV22B' && session.inspection.media?.kind === 'voxel') {
                    const limbs = session.inspection.media.model.parts.filter((part) => part.role === 'body');
                    assert.strictEqual(limbs.length, 3);
                    assert.ok(limbs.every((part) => part.animation?.length === 5));
                    const propellers = limbs.slice(1).map((part) =>
                        transformPoint(
                            voxelTransform(part, 0, 0),
                            part.size.map((value) => value / 2)
                        )
                    );
                    assert.ok(
                        propellers[0][1] > 50 && propellers[1][1] < -50,
                        'HVA places the two rotors on opposite wings'
                    );
                    assert.ok(
                        propellers.every((point) => point[2] > 40),
                        'HVA places rotors above the wing'
                    );
                }
                if (name === 'ALBFRT' && session.inspection.media?.kind === 'voxel') {
                    assert.strictEqual(
                        session.inspection.media.points.filter((point) => /^AlternateFLH/.test(point.name)).length,
                        5
                    );
                }
                if (name === 'ALIFV' && session.inspection.media?.kind === 'voxel') {
                    assert.ok(session.inspection.media.points.some((point) => point.name === 'Weapon17FLH.Burst2'));
                }
                if (name === 'AAPRTC' && session.inspection.media?.kind === 'sprite') {
                    for (const tag of ['SuperAnim', 'SuperAnimTwo', 'SuperAnimThree', 'SuperAnimFour']) {
                        assert.ok(
                            session.inspection.media.scene?.layers.some((layer) => layer.tag === tag && layer.media),
                            tag
                        );
                    }
                }
                if (name === 'GAWEAP' && session.inspection.media?.kind === 'sprite') {
                    assert.ok(
                        session.inspection.media.scene?.layers.some((layer) => layer.tag === 'DoorAnim' && layer.media)
                    );
                    assert.ok(
                        !session.inspection.media.scene?.layers.some((layer) =>
                            layer.tag.startsWith('DamageParticleSystems:')
                        )
                    );
                }
                if ((name === 'NASAM' || name === 'GTGCAN') && session.inspection.media?.kind === 'sprite') {
                    const turret = session.inspection.media.scene?.layers.find((layer) => layer.tag === 'TurretAnim');
                    assert.strictEqual(turret?.voxel?.kind, 'voxel', session.inspection.media.scene?.trace.join('; '));
                    assert.ok(turret.voxel.model.parts.some((part) => part.voxels.length > 0));
                }
                if (name === 'P_EXPA_120B') {
                    assert.strictEqual(session.inspection.type, 'AnimType');
                    assert.ok(
                        session.inspection.media?.kind === 'sprite' &&
                            session.inspection.media.scene?.layers.some(
                                (layer) => layer.tag === 'ConcurrentAnim' && layer.media
                            )
                    );
                }
                if (name === 'TanyaPrimeSelect') {
                    assert.ok(session.inspection.assets.length >= 5);
                    for (const asset of session.inspection.assets) {
                        await service.select(session, asset.id, token.token);
                        assert.strictEqual(session.inspection.media?.kind, 'audio');
                    }
                }
                if (kind === 'voxel' || name === process.env.RA2_WORKBENCH_UI_OWNER) {
                    // Give background thumbnail generation a bounded opportunity to finish.
                    let contents = '';
                    for (let i = 0; i < 40; i++) {
                        const result = await vscode.commands.executeCommand<vscode.Hover[]>(
                            'vscode.executeHoverProvider',
                            document.uri,
                            new vscode.Position(line, 2)
                        );
                        contents = (result ?? [])
                            .flatMap((hover) => hover.contents)
                            .map((content) =>
                                typeof content === 'object' && 'value' in content ? content.value : String(content)
                            )
                            .join('\n');
                        if (contents.includes('data:image/png;base64,')) {
                            break;
                        }
                        await new Promise((resolve) => setTimeout(resolve, 100));
                    }
                    assert.ok(contents.includes('data:image/png;base64,'), name + ': ' + contents);
                    assert.ok(
                        !contents.includes('找不到资源') && !contents.includes('Resource not found'),
                        name + ': ' + contents
                    );
                    report.push({ name, actualExtensionHover: true });
                }
                if (name === (process.env.RA2_WORKBENCH_UI_OWNER ?? 'ALIFV') && process.env.RA2_WORKBENCH_UI_PORT) {
                    const editor = await vscode.window.showTextDocument(document);
                    const cursor = new vscode.Position(line, 4);
                    editor.selection = new vscode.Selection(cursor, cursor);
                    editor.revealRange(new vscode.Range(cursor, cursor), vscode.TextEditorRevealType.InCenter);
                    const verifyHover: (
                        port: number,
                        output: string,
                        showHover: () => Promise<void>,
                        owner: string,
                        kind: string,
                        expectedSnow?: () => Promise<string>,
                        media?: InspectionSession['inspection']['media']
                    ) => Promise<void> = require('../../scripts/verify-vscode-hover.cjs');
                    await verifyHover(
                        Number(process.env.RA2_WORKBENCH_UI_PORT),
                        path.join(extension.extensionPath, 'out', 'webview-qa', 'vscode-hover.png'),
                        async () => {
                            const hovered = await vscode.window.showTextDocument(document, {
                                viewColumn: editor.viewColumn,
                                preserveFocus: false,
                            });
                            hovered.selection = new vscode.Selection(line, 1, line, 1);
                            hovered.revealRange(new vscode.Range(line, 0, line, 1));
                            await vscode.commands.executeCommand('editor.action.showHover');
                        },
                        name,
                        kind,
                        name === 'NASAM'
                            ? async () => {
                                  const snow = (await service.inspect(
                                      document,
                                      new vscode.Position(line, 0),
                                      token.token,
                                      'sno'
                                  ))!;
                                  assert.strictEqual(snow.inspection.media?.kind, 'sprite');
                                  if (snow.inspection.media?.kind !== 'sprite') {
                                      throw new Error('Expected snow building.');
                                  }
                                  return Buffer.from(animatedThumbnail(snow.inspection.media)).toString('base64');
                              }
                            : undefined,
                        session.inspection.media
                    );
                    report.push({ actualHoverImage: true });
                }
                if (name === 'ALTNK') {
                    const voxel = service.ini.effective(document.uri, 'GTNK', 'art').get('voxel');
                    assert.strictEqual(voxel?.value.toLowerCase(), 'yes');
                    assert.ok(voxel?.uri.path.toLowerCase().endsWith('/rules/artes.ini'));
                    assert.ok(session.inspection.sources.some((item) => item.label === 'GTNK · Voxel'));
                    for (const key of ['Image', 'Name', 'Primary']) {
                        const propertyLine = document
                            .getText()
                            .split(/\r?\n/)
                            .findIndex(
                                (text, index) => index > line && index < line + 30 && text.startsWith(key + '=')
                            );
                        assert.ok(propertyLine > line);
                        const content = document.lineAt(propertyLine).text;
                        const contextual = (await service.inspect(
                            document,
                            new vscode.Position(propertyLine, content.indexOf('=') + 2),
                            token.token
                        ))!;
                        report.push({
                            name: name + ':' + key,
                            type: contextual.inspection.type,
                            focus: contextual.inspection.focus,
                            assets: contextual.inspection.assets,
                            warnings: contextual.inspection.warnings,
                        });
                        assert.strictEqual(
                            contextual.inspection.media?.kind,
                            'voxel',
                            key + ': ' + contextual.inspection.warnings.join('; ')
                        );
                    }
                }
            }
        } finally {
            await writeFile(
                path.join(extension.extensionPath, 'out', 'real-media-acceptance.json'),
                JSON.stringify(report, null, 2)
            );
            subscriptions.forEach((item) => item.dispose());
            token.dispose();
            service.dispose();
            decoder.dispose();
            resources.dispose();
            if (process.env.RA2_WORKBENCH_VERIFY_PANEL) {
                await configuration.update('schemaFilePath', previousDictionary, vscode.ConfigurationTarget.Global);
            }
        }
    });
});
