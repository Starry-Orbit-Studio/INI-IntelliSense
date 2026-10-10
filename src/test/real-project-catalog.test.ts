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
import { InspectionService } from '../context/inspection-service';
import { spriteCandidates } from '../context/sprite-scene';
import { ShpFile } from '../media/shp';

suite('Optional real mod catalog survey', () => {
    test('survey all registered technos and decode representative Resources assets', async function () {
        const root = process.env.RA2_WORKBENCH_REAL_PROJECT;
        if (!root) {
            this.skip();
            return;
        }
        this.timeout(240000);
        const extension = vscode.extensions.getExtension('Astralette.ra2-ini-intellisense')!;
        await extension.activate();
        const context = { extensionPath: extension.extensionPath } as vscode.ExtensionContext;
        const mix = new MixWorkspaceManager(new GlobalMixDb(context), new TextContentService());
        const resources = new ProjectResources(mix);
        const decoder = new DecoderService(path.join(extension.extensionPath, 'dist', 'media-worker.js'));
        const schema = new SchemaManager();
        const dictionary =
            process.env.RA2_WORKBENCH_DICTIONARY ?? 'C:/Projects/RA2ModdingTools/RA2-INI-Dictionary/INIDictionary.ini';
        schema.loadSchema(await readFile(dictionary, 'utf8'), dictionary);
        const service = new InspectionService(
            resources,
            new MediaService(resources, decoder, extension.extensionUri),
            new INIManager(),
            schema,
            new FileTypeManager()
        );
        const origin = vscode.Uri.file(path.join(root, 'Rules', 'ruleses.ini'));
        if (process.env.RA2_WORKBENCH_WORKSPACE) {
            assert.strictEqual(
                vscode.workspace.getWorkspaceFolder(origin)?.uri.fsPath.toLowerCase(),
                vscode.Uri.file(process.env.RA2_WORKBENCH_WORKSPACE).fsPath.toLowerCase(),
                'The supplied workspace is actually open'
            );
        }
        const token = new vscode.CancellationTokenSource();
        const results: {
            registry: string;
            name: string;
            art: string;
            files: string[];
            source?: string;
            definition?: string;
            line?: number;
            decoded?: string;
            warnings?: string[];
        }[] = [];
        let binaries: { total: number; decoded: number; failures: { source: string; error: string }[] } | undefined;
        try {
            assert.strictEqual(
                resources.projectRoot(origin).fsPath.toLowerCase(),
                vscode.Uri.file(root).fsPath.toLowerCase()
            );
            await service.ini.load(origin);
            for (const registry of ['InfantryTypes', 'VehicleTypes', 'AircraftTypes', 'BuildingTypes']) {
                for (const name of new Set(
                    [...service.ini.effective(origin, registry, 'rules').values()].map((item) => item.value)
                )) {
                    const rules = service.ini.effective(origin, name, 'rules');
                    const artName = rules.get('image')?.value ?? name;
                    const art = service.ini.effective(origin, artName, 'art');
                    const base = art.get('image')?.value ?? artName;
                    const voxel = /^(yes|true|1)$/i.test(art.get('voxel')?.value ?? '');
                    const resolved = voxel
                        ? { names: [base + '.vxl'], candidates: await resources.find(origin, base + '.vxl') }
                        : await spriteCandidates(resources, origin, base, art, registry === 'BuildingTypes');
                    const definition = service.ini.sources(origin, name, 'rules')[0];
                    results.push({
                        registry,
                        name,
                        art: artName,
                        files: resolved.names,
                        source: resolved.candidates[0]?.source,
                        definition: definition?.document.uri.toString(),
                        line: definition?.section.startLine,
                    });
                }
            }
            console.log(
                'ES catalog:',
                JSON.stringify({
                    count: results.length,
                    resolved: results.filter((item) => item.source).length,
                    missing: results.filter((item) => !item.source).length,
                })
            );
            if (process.env.RA2_WORKBENCH_SURVEY_DECODE) {
                const selected = new Map<string, number>();
                for (const item of results.filter((item) => item.source?.startsWith('Resources/') && item.definition)) {
                    const group = item.registry + ':' + item.source!.split('/')[1];
                    if ((selected.get(group) ?? 0) >= 8) {
                        continue;
                    }
                    selected.set(group, (selected.get(group) ?? 0) + 1);
                    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(item.definition!));
                    const session = await service.inspect(document, new vscode.Position(item.line!, 0), token.token);
                    item.decoded = session?.inspection.media?.kind;
                    item.warnings = session?.inspection.warnings;
                    assert.ok(item.decoded, item.name + ': ' + item.warnings?.join('; '));
                }
                assert.ok(selected.size >= 4, 'Representatives span infantry, vehicles, aircraft and buildings');
            }
            if (process.env.RA2_WORKBENCH_SURVEY_BINARY) {
                const palette = await new MediaService(resources, decoder, extension.extensionUri).palette(origin);
                const files = (await resources.list(origin, ['.shp', '.vxl'])).filter(
                    (item) => item.uri.scheme === 'file' && /\/Resources\//i.test(item.uri.path)
                );
                binaries = { total: files.length, decoded: 0, failures: [] };
                for (const file of files) {
                    try {
                        const bytes = await resources.read(file.uri);
                        if (/\.vxl$/i.test(file.name)) {
                            await decoder.decode('voxel', bytes, token.token);
                        } else {
                            const shp = await decoder.decode<ShpFile>('shp', bytes, token.token);
                            const frame = Math.max(
                                0,
                                shp.frames.findIndex((item) => item.width && item.height)
                            );
                            await decoder.decode('thumbnail', bytes, token.token, undefined, { palette, frame });
                        }
                        binaries.decoded++;
                    } catch (error) {
                        binaries.failures.push({ source: resources.label(origin, file.uri), error: String(error) });
                    }
                }
                console.log('ES binary survey:', JSON.stringify(binaries));
            }
        } finally {
            await writeFile(
                path.join(extension.extensionPath, 'out', 'real-project-catalog.json'),
                JSON.stringify(
                    {
                        index: await resources.describeIndex(origin),
                        count: results.length,
                        resolved: results.filter((item) => item.source).length,
                        binaries,
                        results,
                    },
                    null,
                    2
                )
            );
            token.dispose();
            resources.dispose();
            decoder.dispose();
        }
    });
});
