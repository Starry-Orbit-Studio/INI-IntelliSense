import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { ConfigurationService, validConfiguration, configurationLayer } from '../context/configuration-service';
import { ConfigurationChange } from '../context/configuration-model';

suite('Scoped project configuration', () => {
    const settings = vscode.workspace.getConfiguration('ra2-ini-intellisense');
    const keys = ['media.resourceRoots', 'project.entryPoints', 'schemaFilePath', 'indexing.excludePatterns'];
    let previous: Map<string, unknown>, directory: string, origin: vscode.Uri, service: ConfigurationService;
    suiteSetup(async () => {
        directory = await mkdtemp(path.join(os.tmpdir(), 'ra2-project-config-'));
        origin = vscode.Uri.file(directory);
        previous = new Map(keys.map((key) => [key, settings.inspect(key)?.globalValue]));
        service = new ConfigurationService(vscode.Uri.file(path.resolve(__dirname, '../..')));
    });
    teardown(async () => {
        for (const [key, value] of previous) {
            await settings.update(key, value, vscode.ConfigurationTarget.Global);
        }
    });
    suiteTeardown(async () => {
        await rm(directory, { recursive: true, force: true });
    });
    test('page ownership excludes duplicate checks and historical switches', () => {
        const project = service.describe(origin, ['loading', 'resources', 'dictionary', 'editing', 'maps'], 'user');
        const checks = service.describe(origin, ['checks', 'validator'], 'user');
        assert.ok(project.fields.some((field) => field.key === 'project.entryPoints'));
        assert.ok(!project.fields.some((field) => field.key.startsWith('diagnostics.')));
        assert.ok(!checks.fields.some((field) => field.key === 'project.entryPoints'));
        assert.ok(
            ![...project.fields, ...checks.fields].some((field) => field.key === 'diagnostics.leadingWhitespace')
        );
        assert.deepStrictEqual(project.scopes, ['user']);
    });
    test('batch applies typed values and resetting removes only the selected override', async () => {
        const model = service.describe(origin, ['loading', 'resources'], 'user');
        await service.apply(model.id, [
            { key: 'media.resourceRoots', value: [directory] },
            { key: 'project.entryPoints', value: { rules: ['Rules/main.ini'], art: ['Art/main.ini'] } },
        ]);
        assert.deepStrictEqual(settings.inspect('media.resourceRoots')?.globalValue, [directory]);
        const next = service.describe(origin, ['resources'], 'user');
        assert.strictEqual(next.fields.find((field) => field.key === 'media.resourceRoots')?.source, 'user');
        await service.apply(next.id, [{ key: 'media.resourceRoots', reset: true }]);
        assert.strictEqual(settings.inspect('media.resourceRoots')?.globalValue, undefined);
        assert.deepStrictEqual(settings.inspect('project.entryPoints')?.globalValue, {
            rules: ['Rules/main.ini'],
            art: ['Art/main.ini'],
        });
    });
    test('external edits reject a stale draft without overwriting either setting', async () => {
        const model = service.describe(origin, ['resources'], 'user');
        await settings.update('media.resourceRoots', ['external'], vscode.ConfigurationTarget.Global);
        await assert.rejects(service.apply(model.id, [{ key: 'media.resourceRoots', value: ['draft'] }]));
        assert.deepStrictEqual(settings.inspect('media.resourceRoots')?.globalValue, ['external']);
    });
    test('all changes validate before the first write', async () => {
        const model = service.describe(origin, ['loading', 'resources'], 'user');
        await assert.rejects(
            service.apply(model.id, [
                { key: 'media.resourceRoots', value: ['valid'] },
                { key: 'project.entryPoints', value: { rules: [23] } },
            ])
        );
        assert.deepStrictEqual(
            settings.inspect('media.resourceRoots')?.globalValue,
            previous.get('media.resourceRoots')
        );
        await assert.rejects(service.apply(model.id, [{ key: 'diagnostics.leadingWhitespace', value: false }]));
    });
    test('a partial write failure restores earlier writes', async () => {
        class FailingService extends ConfigurationService {
            private writes = 0;
            protected override async writeValue(
                configuration: vscode.WorkspaceConfiguration,
                key: string,
                value: unknown,
                scope: vscode.ConfigurationTarget
            ): Promise<void> {
                if (++this.writes === 2) {
                    throw new Error('Simulated second write failure');
                }
                await super.writeValue(configuration, key, value, scope);
            }
        }
        const failing = new FailingService(vscode.Uri.file(path.resolve(__dirname, '../..')));
        const model = failing.describe(origin, ['loading', 'resources'], 'user');
        await assert.rejects(
            failing.apply(model.id, [
                { key: 'media.resourceRoots', value: ['partial'] },
                { key: 'project.entryPoints', value: { rules: ['main.ini'] } },
            ])
        );
        assert.deepStrictEqual(
            settings.inspect('media.resourceRoots')?.globalValue,
            previous.get('media.resourceRoots')
        );
    });
    test('pinned drafts survive repeated background state refreshes', async () => {
        const model = service.describe(origin, ['loading'], 'user');
        service.pin(model.id);
        for (let index = 0; index < 40; index++) {
            service.describe(origin, ['loading'], 'user');
        }
        await service.apply(model.id, [{ key: 'indexing.excludePatterns', value: ['generated/**'] }]);
        assert.deepStrictEqual(settings.inspect('indexing.excludePatterns')?.globalValue, ['generated/**']);
        service.pin();
    });
    test('path checking is read-only and distinguishes files from directories', async () => {
        const file = path.join(directory, 'dictionary.ini');
        await writeFile(file, '[Sections]\n');
        await settings.update('schemaFilePath', directory, vscode.ConfigurationTarget.Global);
        let model = service.describe(origin, ['dictionary'], 'user');
        assert.strictEqual((await service.checkPaths(model.id, origin))[0].state, 'wrongType');
        await settings.update('schemaFilePath', file, vscode.ConfigurationTarget.Global);
        model = service.describe(origin, ['dictionary'], 'user');
        assert.strictEqual((await service.checkPaths(model.id, origin))[0].state, 'ready');
        assert.strictEqual(settings.inspect('schemaFilePath')?.globalValue, file);
    });
    test('personal editing excludes higher workspace overrides while merging inherited object fields', () => {
        const details = {
            defaultValue: { rules: ['rules.ini'], art: ['art.ini'] },
            globalValue: { rules: ['personal.ini'] },
            workspaceValue: { rules: ['project.ini'] },
            workspaceFolderValue: { art: ['folder.ini'] },
        };
        assert.deepStrictEqual(configurationLayer(details, 'user'), { rules: ['personal.ini'], art: ['art.ini'] });
        assert.deepStrictEqual(configurationLayer(details, 'folder'), { rules: ['project.ini'], art: ['folder.ini'] });
        assert.deepStrictEqual(details.defaultValue.rules, ['rules.ini']);
    });
    test('nested validation rejects unsafe keys and invalid array elements', () => {
        assert.ok(!validConfiguration(JSON.parse('{"__proto__":"value"}'), { type: 'object' }));
        assert.ok(!validConfiguration([1], { type: 'array', items: { type: 'string' } }));
        assert.ok(
            !validConfiguration(
                { executable: false },
                { type: 'object', properties: { executable: { type: 'string' } }, additionalProperties: false }
            )
        );
        assert.ok(!validConfiguration({ missing: 'value' }, { type: 'object', additionalProperties: false }));
    });
});
