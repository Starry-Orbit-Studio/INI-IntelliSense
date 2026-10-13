import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { mkdtemp, writeFile, readFile, rm, readdir } from 'fs/promises';
import { SchemaManager } from '../schema-manager';
import { INIManager } from '../parser';
import { ProjectIni } from '../context/project-ini';
import { ProjectResources } from '../resources/project-resources';
import { FileTypeManager } from '../file-type-manager';
import { DiagnosticManager } from '../diagnostics/engine';

suite('Context-aware INI rules', () => {
    const settings = vscode.workspace.getConfiguration('ra2-ini-intellisense');
    const keys = ['project.entryPoints', 'project.compatibility', 'diagnostics.enabled', 'diagnostics.severity'];
    let previous: Map<string, unknown>, directory: string, project: ProjectIni, diagnostics: DiagnosticManager, manager: INIManager;
    const rootText = '[#include]\n0=patch.ini\n[VehicleTypes]\n0=Tank\n[InfantryTypes]\n0=Soldier\n[Tank]\nWeaponCount=2\nWeapon1=Gun\nWeapon2=Soldier\nWeapon3FLH=1,2,3\nAnimList=Good,,Bad\nArtOnly=yes\n[Gun]\nWarhead=Hit\n[Hit]\n[Soldier]\n';
    suiteSetup(async () => {
        directory = await mkdtemp(path.join(os.tmpdir(), 'ra2-context-rules-'));
        previous = new Map(keys.map(key => [key, settings.inspect(key)?.globalValue]));
        await writeFile(path.join(directory, 'rules.ini'), rootText);
        await writeFile(path.join(directory, 'patch.ini'), '[Base]\nWeaponCount=3\n');
        await writeFile(path.join(directory, 'art.ini'), '[Good]\n[Bad]\n');
        const schemaText = '[Registries]\nVehicleTypes=UnitType\nInfantryTypes=InfantryType\nAnimations=AnimType\n[Sections]\nTechnoType\nUnitType\nInfantryType\nWeaponType\nWarheadType\nAnimType\n[Lists]\nCoordStruct\nAnimList\n[CoordStruct]\nType=int\nRange=3,3\n[AnimList]\nType=AnimType\n[TechnoType]\n[UnitType]:[TechnoType]\nWeaponCount=int\nWeapon(1,WeaponCount)=WeaponType\nWeapon(1,WeaponCount)FLH=CoordStruct\nAnimList=AnimList\nArtOnly=bool,,art\n[InfantryType]:[TechnoType]\n[WeaponType]\nWarhead=WarheadType\n[WarheadType]\n[AnimType]\n[Animations]\nCheckExist=false\n';
        await writeFile(path.join(directory, 'dictionary.ini'), schemaText);
        const schema = new SchemaManager(); schema.loadSchema(schemaText, path.join(directory, 'dictionary.ini'));
        manager = new INIManager(); manager.setSchemaManager(schema);
        const resources = {
            projectRoot: () => vscode.Uri.file(directory),
            contains: (_: vscode.Uri, uri: vscode.Uri) => uri.fsPath.toLowerCase().startsWith((directory + path.sep).toLowerCase()),
            listDocuments: async () => (await readdir(directory)).filter(name => name !== 'dictionary.ini').map(name => ({ name, uri: vscode.Uri.file(path.join(directory, name)) })),
            read: async (uri: vscode.Uri) => new Uint8Array(await readFile(uri.fsPath)),
        } as unknown as ProjectResources;
        project = new ProjectIni(resources, manager, schema, { getFileType: (uri: vscode.Uri) => path.basename(uri.path) === 'art.ini' ? 'art' : 'rules' } as FileTypeManager);
        diagnostics = new DiagnosticManager({ subscriptions: [] } as unknown as vscode.ExtensionContext, schema, manager); diagnostics.project = project;
        await settings.update('project.entryPoints', { rules: ['rules.ini'], art: ['art.ini'] }, vscode.ConfigurationTarget.Global);
        await settings.update('project.compatibility', 'compatible', vscode.ConfigurationTarget.Global);
        await settings.update('diagnostics.enabled', true, vscode.ConfigurationTarget.Global);
        await settings.update('diagnostics.severity', { L005: 'Warning' }, vscode.ConfigurationTarget.Global);
    });
    teardown(async () => {
        for (const document of vscode.workspace.textDocuments) {
            if (document.uri.fsPath.toLowerCase().startsWith((directory + path.sep).toLowerCase()) && document.isDirty) {
                await vscode.window.showTextDocument(document); await vscode.commands.executeCommand('workbench.action.files.revert');
            }
        }
        await writeFile(path.join(directory, 'rules.ini'), rootText); await writeFile(path.join(directory, 'patch.ini'), '[Base]\nWeaponCount=3\n');
        project.invalidate();
        await settings.update('project.compatibility', 'compatible', vscode.ConfigurationTarget.Global);
    });
    suiteTeardown(async () => {
        diagnostics.dispose(); manager.dispose();
        for (const [key, value] of previous) { await settings.update(key, value, vscode.ConfigurationTarget.Global); }
        await rm(directory, { recursive: true, force: true });
    });
    const values = async (text?: string) => {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(directory, 'rules.ini')));
        if (text !== undefined) {
            const edit = new vscode.WorkspaceEdit(); edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text); await vscode.workspace.applyEdit(edit);
            project.documentChanged(document);
        }
        const result = await diagnostics.validate(document);
        return result;
    };
    test('numbered suffixes, reference types and individual empty list members are checked precisely', async () => {
        const result = await values(rootText);
        assert.strictEqual(result.filter(item => item.code === 'L007').length, 1);
        assert.ok(result.find(item => item.code === 'L007')?.message.includes('3'));
        assert.strictEqual(result.filter(item => item.code === 'T009').length, 1);
        assert.strictEqual(result.find(item => item.code === 'T009')?.range.start.line, 9);
        assert.strictEqual(result.filter(item => item.code === 'T010').length, 1);
        assert.ok(result.some(item => item.code === 'L008'));
        assert.ok(!result.some(item => item.code === 'L005' && [9, 10, 11].includes(item.range.start.line)), 'Numbered tags must not be unknown');
        assert.ok(!result.some(item => item.code === 'L001'), 'Art animations must resolve in art');
    });
    test('inherited count controls the effective numbered range', async () => {
        const result = await values(rootText.replace('[Tank]', '[Tank]:[Base]').replace('WeaponCount=2\n', ''));
        assert.ok(!result.some(item => item.code === 'L007'));
        assert.ok(!result.some(item => item.code === 'C003'));
    });
    test('missing includes defer reference errors and report the exact loading problem', async () => {
        const result = await values(rootText.replace('patch.ini', 'missing.ini').replace('Weapon1=Gun', 'Weapon1=Missing'));
        assert.ok(result.some(item => item.code === 'C001' && item.range.start.line === 1));
        assert.ok(!result.some(item => item.code === 'L001' || item.code === 'T009'));
    });
    test('include cycles and parent cycles have useful chains; vanilla mode ignores extension syntax', async () => {
        await writeFile(path.join(directory, 'patch.ini'), '[#include]\n0=rules.ini\n[Parent]:[Tank]\n'); project.invalidate();
        const text = rootText.replace('[Tank]', '[Tank]:[Parent]');
        const result = await values(text);
        assert.ok(result.some(item => item.code === 'C002' && item.message.includes('rules.ini')));
        assert.ok(result.some(item => item.code === 'C004' && item.relatedInformation?.length));
        await settings.update('project.compatibility', 'vanilla', vscode.ConfigurationTarget.Global); project.invalidate();
        const vanilla = await values(); assert.ok(!vanilla.some(item => String(item.code).startsWith('C')));
    });
    test('missing parents and registrations are checked without requiring every definition to be registered', async () => {
        const text = rootText.replace('[Tank]', '[Tank]:[MissingParent]').replace('0=Tank', '0=Tank\n1=Tank\n2=MissingObject') + '\n[Animations]\n0=FilenameOnly\n[UnusedTemplate]\nCost=1\n';
        const result = await values(text);
        assert.ok(result.some(item => item.code === 'C003'));
        assert.ok(result.some(item => item.code === 'L009'));
        assert.strictEqual(result.filter(item => item.code === 'L010').length, 1);
        assert.ok(!result.some(item => item.code === 'L002'));
    });
});
