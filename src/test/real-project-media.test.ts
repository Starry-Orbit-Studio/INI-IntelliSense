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
            for (const file of ['artes.ini', 'artes_AL.ini', 'artes_Regular.ini', 'artes_Explosion.ini']) {
                assert.strictEqual(service.ini.category(vscode.Uri.file(path.join(root, 'Rules', file))), 'art', file);
            }
            assert.strictEqual(service.ini.category(vscode.Uri.file(path.join(root, 'Rules', 'soundes.ini'))), 'sound');
            assert.strictEqual(service.ini.effective(origin, 'GTNK', 'art').get('voxel')?.value, 'yes');
            for (const [file, name, kind] of [
                ['ruleses.ini', 'GACNST', 'sprite'],
                ['artes_Explosion.ini', 'P_EXPA_120B', 'sprite'],
                ['soundes.ini', 'TanyaPrimeSelect', 'audio'],
                ['ruleses_AL.ini', 'ALIFV', 'voxel'],
                ['ruleses_AL.ini', 'ALTNK', 'voxel'],
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
                    scene:
                        session.inspection.media?.kind === 'sprite' ? session.inspection.media.scene?.trace : undefined,
                    index: name === 'GACNST' ? await resources.describeIndex(document.uri) : undefined,
                });
                assert.strictEqual(
                    session.inspection.media?.kind,
                    kind,
                    name + ': ' + session.inspection.warnings.join('; ')
                );
                if (name === 'GACNST' && session.inspection.media?.kind === 'sprite') {
                    assert.strictEqual(session.inspection.media.scene?.foundation.length, 16);
                    assert.ok(
                        session.inspection.media.scene.layers.some((layer) => layer.tag === 'Buildup' && layer.media)
                    );
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
                if (kind === 'voxel') {
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
                        owner: string
                    ) => Promise<void> = require('../../scripts/verify-vscode-hover.cjs');
                    await verifyHover(
                        Number(process.env.RA2_WORKBENCH_UI_PORT),
                        path.join(extension.extensionPath, 'out', 'webview-qa', 'vscode-hover.png'),
                        async () => {
                            await vscode.commands.executeCommand('editor.action.showHover');
                        },
                        name
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
            decoder.dispose();
            resources.dispose();
            if (process.env.RA2_WORKBENCH_VERIFY_PANEL) {
                await configuration.update('schemaFilePath', previousDictionary, vscode.ConfigurationTarget.Global);
            }
        }
    });
});
