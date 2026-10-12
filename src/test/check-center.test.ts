import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { mkdtemp, writeFile, readFile, rm } from 'fs/promises';
import { DescriptionManager, MultilineIniParser } from '../description-manager';
import { SchemaManager } from '../schema-manager';
import { INIManager } from '../parser';
import { FileTypeManager } from '../file-type-manager';
import { ProjectResources } from '../resources/project-resources';
import { ProjectIni } from '../context/project-ini';
import { DiagnosticManager } from '../diagnostics/engine';
import { indexLogic, logicSlice } from '../context/logic-graph';
import { rulePolicy } from '../diagnostics/rule-catalog';
import { IniSemanticTokensProvider } from '../semantic-tokens-provider';
import { IniDocument } from '../parser';
import { registryValues } from '../context/property-resolution';
import { commandOrigin } from '../context/command-origin';

suite('Check center and contextual logic integration', () => {
    let directory: string,
        project: ProjectIni,
        schema: SchemaManager,
        manager: INIManager,
        diagnostics: DiagnosticManager;
    let context: vscode.ExtensionContext, previous: Record<string, unknown>;
    const settings = vscode.workspace.getConfiguration('ra2-ini-intellisense');
    const keys = [
        'project.entryPoints',
        'project.compatibility',
        'diagnostics.enabled',
        'diagnostics.severity',
        'diagnostics.leadingWhitespace',
    ];
    suiteSetup(async () => {
        directory = await mkdtemp(path.join(os.tmpdir(), 'ra2-check-center-'));
        context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
        previous = Object.fromEntries(keys.map((key) => [key, settings.inspect(key)?.globalValue]));
        await Promise.all([
            writeFile(
                path.join(directory, 'rules.ini'),
                '[#include]\n0=patch.ini\n[VehicleTypes]\n0=Tank\n[Tank]\nCost=1\nPrimary=Gun\n[Gun]\nWarhead=Hit\n[Hit]\n'
            ),
            writeFile(path.join(directory, 'patch.ini'), '[Tank]\nCost=2\n'),
            writeFile(
                path.join(directory, 'backup.ini'),
                '[VehicleTypes]\n0=Tank\n[Tank]\nCost=99\nPrimary=LocalGun\n[LocalGun]\nWarhead=LocalHit\n[LocalHit]\n'
            ),
            writeFile(path.join(directory, 'art.ini'), '[Tank]\nVoxel=yes\n'),
        ]);
        schema = new SchemaManager();
        const dictionary =
            '[Registries]\nVehicleTypes=UnitType\n[Sections]\nUnitType\nWeaponType\nWarheadType\nUnitType=VehicleTypes\n[UnitType]\nCost=int\nStrength=float\nTurret=bool\nPrimary=WeaponType\n[WeaponType]\nWarhead=WarheadType\n[WarheadType]\n';
        await writeFile(path.join(directory, 'schema.ini'), dictionary);
        schema.loadSchema(dictionary, path.join(directory, 'schema.ini'));
        manager = new INIManager();
        manager.setSchemaManager(schema);
        const fileTypes = {
            getFileType: (uri: vscode.Uri) => (path.basename(uri.path).startsWith('art') ? 'art' : 'rules'),
        } as unknown as FileTypeManager;
        const resources = {
            projectRoot: () => vscode.Uri.file(directory),
            contains: (_: vscode.Uri, uri: vscode.Uri) =>
                uri.fsPath.toLowerCase().startsWith((directory + path.sep).toLowerCase()),
            listDocuments: async () =>
                ['rules.ini', 'patch.ini', 'backup.ini', 'art.ini'].map((name) => ({
                    name,
                    uri: vscode.Uri.file(path.join(directory, name)),
                })),
            read: async (uri: vscode.Uri) => new Uint8Array(await readFile(uri.fsPath)),
        } as unknown as ProjectResources;
        project = new ProjectIni(resources, manager, schema, fileTypes);
        diagnostics = new DiagnosticManager(context, schema, manager);
        diagnostics.project = project;
        await settings.update(
            'project.entryPoints',
            { rules: ['rules.ini'], art: ['art.ini'] },
            vscode.ConfigurationTarget.Global
        );
        await settings.update('project.compatibility', 'compatible', vscode.ConfigurationTarget.Global);
    });
    suiteTeardown(async () => {
        diagnostics.dispose();
        context.subscriptions.forEach((item) => item.dispose());
        for (const key of keys) {
            await settings.update(key, previous[key], vscode.ConfigurationTarget.Global);
        }
        await rm(directory, { recursive: true, force: true });
    });
    test('active include overrides and standalone same-name sections never contaminate each other', async () => {
        const rules = vscode.Uri.file(path.join(directory, 'rules.ini')),
            backup = vscode.Uri.file(path.join(directory, 'backup.ini'));
        await project.load(rules);
        assert.strictEqual(project.effective(rules, 'Tank', 'rules').get('cost')?.value, '2');
        assert.strictEqual(project.effective(backup, 'Tank', 'rules').get('cost')?.value, '99');
        assert.strictEqual(project.context(backup).mode, 'standalone');
        assert.strictEqual(project.sources(backup, 'Tank', 'art').length, 1);
        assert.strictEqual(project.effective(rules, 'Tank', 'rules').get('cost')?.value, '2');
    });
    test('typed graph excludes arbitrary matching text and preserves exact edge sources', async () => {
        const origin = vscode.Uri.file(path.join(directory, 'rules.ini'));
        const cancellation = new vscode.CancellationTokenSource();
        try {
            const graph = await indexLogic(project, schema, origin, cancellation.token);
            const slice = logicSlice(graph, 'rules:tank', 'downstream', 2);
            assert.ok(slice.edges.some((edge) => edge.key === 'Primary' && edge.to === 'rules:gun'));
            assert.ok(slice.edges.some((edge) => edge.key === 'Warhead' && edge.to === 'rules:hit'));
            assert.ok(!graph.nodes.some((node) => node.name === 'LocalGun'));
            const edge = graph.edges.find((edge) => edge.key === 'Primary')!;
            assert.strictEqual(graph.locations.get(edge.id)?.range.start.line, 6);
            assert.ok(!slice.truncated);
        } finally {
            cancellation.dispose();
        }
    });
    test('strict scalar validation and disabling clear published results immediately', async () => {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(directory, 'backup.ini')));
        const editor = await vscode.window.showTextDocument(document);
        const edit = new vscode.WorkspaceEdit();
        edit.insert(document.uri, new vscode.Position(5, 0), 'Strength=1abc\nTurret=maybe\nStrength=50%\n');
        await vscode.workspace.applyEdit(edit);
        await settings.update('diagnostics.enabled', true, vscode.ConfigurationTarget.Global);
        await settings.update('diagnostics.severity', {}, vscode.ConfigurationTarget.Global);
        const values = await diagnostics.validate(document);
        assert.strictEqual(values.filter((value) => value.code === 'T002').length, 1);
        assert.ok(values.some((value) => value.code === 'T008'));
        await settings.update('diagnostics.enabled', false, vscode.ConfigurationTarget.Global);
        await diagnostics.validate(document);
        assert.strictEqual(diagnostics.results().flatMap((result) => result.diagnostics).length, 0);
        await vscode.commands.executeCommand('workbench.action.files.revert');
        await settings.update('diagnostics.enabled', true, vscode.ConfigurationTarget.Global);
    });
    test('explicit rule severity takes precedence over deprecated style switches', async () => {
        await settings.update('diagnostics.leadingWhitespace', false, vscode.ConfigurationTarget.Global);
        await settings.update('diagnostics.severity', { S001: 'Error' }, vscode.ConfigurationTarget.Global);
        assert.strictEqual(
            rulePolicy(vscode.Uri.file(path.join(directory, 'rules.ini'))).get('S001'),
            vscode.DiagnosticSeverity.Error
        );
    });
    test('standard description inheritance, case folding and language fallback work with real lookup', async () => {
        const parsed = new MultilineIniParser().parse('[UnitType]:[TechnoType]\nSpeed="""Move speed"""\n');
        assert.strictEqual(parsed.get('unittype')?.base, 'technotype');
        const file = path.join(directory, 'description.ini');
        await writeFile(file, '[TechnoType]\nPrimary="""Weapon documentation"""\n[UnitType]:[TechnoType]\n');
        const descriptions = new DescriptionManager();
        descriptions.setLanguage('zh-cn');
        descriptions.loadFromFile(file, 'en-US');
        assert.strictEqual(descriptions.getDescription('UNITTYPE', 'primary'), 'Weapon documentation');
    });
    test('vanilla mode disables extension includes and inheritance while keeping typed editing', async () => {
        const origin = vscode.Uri.file(path.join(directory, 'rules.ini'));
        await settings.update('project.compatibility', 'vanilla', vscode.ConfigurationTarget.Global);
        project.invalidate();
        try {
            await project.load(origin);
            assert.strictEqual(project.effective(origin, 'Tank', 'rules').get('cost')?.value, '1');
            assert.strictEqual(project.type(origin, 'Tank', 'rules'), 'UnitType');
            assert.ok(!project.documents(origin).some((document) => document.uri.path.endsWith('/patch.ini')));
        } finally {
            await settings.update('project.compatibility', 'compatible', vscode.ConfigurationTarget.Global);
            project.invalidate();
        }
    });
    test('quoted delimiters preserve values and semantic tokens never overlap', async () => {
        const text = '[Tank]\nName="one;two,three",next ; comment\nText="""start;value\ninside;value\nend"""\n';
        const document = await vscode.workspace.openTextDocument({ language: 'ra2-ini', content: text });
        const model = new IniDocument(document.uri, text);
        assert.strictEqual(model.getSection('tank')?.properties.get('Name'), '"one;two,three",next');
        const cancellation = new vscode.CancellationTokenSource();
        try {
            const tokens = (
                await new IniSemanticTokensProvider().provideDocumentSemanticTokens(document, cancellation.token)
            ).data;
            let line = 0,
                start = 0,
                lastLine = -1,
                lastEnd = 0;
            for (let offset = 0; offset < tokens.length; offset += 5) {
                line += tokens[offset];
                start = tokens[offset] ? tokens[offset + 1] : start + tokens[offset + 1];
                assert.ok(line !== lastLine || start >= lastEnd, 'overlapping token span');
                lastLine = line;
                lastEnd = start + tokens[offset + 2];
            }
        } finally {
            cancellation.dispose();
        }
    });
    test('registry append entries preserve all declarations alongside effective numeric keys', () => {
        const document = new IniDocument(
            vscode.Uri.file(path.join(directory, 'append.ini')),
            '[VehicleTypes]\n0=Old\n+=First\n+=Second\n0=Final\n'
        );
        const sources = [{ document, section: document.getSection('VehicleTypes')!, category: 'rules' }];
        const values = registryValues(
            'VehicleTypes',
            () => sources,
            (line) => {
                const equals = line.indexOf('=');
                return equals < 0 ? undefined : { key: line.slice(0, equals), value: line.slice(equals + 1) };
            }
        );
        assert.deepStrictEqual(values, ['Final', 'First', 'Second']);
    });
    test('title context is never passed through as an invalid URI', () => {
        const uri = commandOrigin({ viewId: 'ra2-project-workbench' });
        assert.ok(uri === undefined || uri instanceof vscode.Uri);
    });
});
