import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'fs/promises';
import { DictionarySource, editedText } from '../dictionary/source-model';
import { DictionaryCatalog } from '../dictionary/catalog';
import { DictionaryEditor } from '../dictionary/editor';
import { DictionaryState } from '../dictionary/protocol';
import { SchemaManager } from '../schema-manager';
import { DescriptionManager } from '../description-manager';
import { ProjectIni } from '../context/project-ini';
import { ProjectResources } from '../resources/project-resources';
import { keyPattern, patternIndex } from '../dictionary/key-pattern';
import { execFile } from 'child_process';

suite('Lossless dictionary authoring', () => {
    test('dictionary contribution retains the default SHP/VXL/audio custom editors', async () => {
        const manifest = JSON.parse(await readFile(path.resolve(__dirname, '../../package.json'), 'utf8'));
        const editors = manifest.contributes.customEditors as { viewType: string; priority: string; selector: { filenamePattern: string }[] }[];
        const media = editors.find(editor => editor.viewType === 'ra2-resource-preview.viewer')!;
        assert.strictEqual(media.priority, 'default');
        for (const format of ['*.shp', '*.vxl', '*.wav', '*.pcx', '*.pal']) { assert.ok(media.selector.some(selector => selector.filenamePattern === format)); }
        assert.strictEqual(editors.find(editor => editor.viewType === 'ra2-ini-intellisense.dictionary')?.priority, 'option');
    });
    test('minimal edits preserve comments, BOM, mixed newlines and repeated sections', () => {
        const text = '\uFEFF; header\r\n[UnitType]\r\nCost = int,1,rules  ; keep\r\nUnknown ???\n[UnitType]\nStrength=int\n';
        const source = new DictionarySource(text);
        assert.strictEqual(source.find('unittype', 'strength')?.line, 5);
        const output = editedText(text, [source.set('UnitType', 'Cost', 'float,1,rules')]);
        assert.strictEqual(output, text.replace('int,1,rules', 'float,1,rules'));
        const appended = editedText(output, [new DictionarySource(output).set('UnitType', 'Turret', 'bool')]);
        assert.ok(appended.includes('Unknown ???\n[UnitType]\nStrength=int\nTurret=bool\r\n'));
        assert.strictEqual(new DictionarySource(appended).find('UnitType', 'Cost')?.value, 'float,1,rules');
    });
    test('multiline descriptions preserve delimiters and trailing comments', () => {
        const text = '[UnitType]\r\nCost="""First\r\n[not a section]\r\n; content\r\nLast""" ; keep\r\n';
        const source = new DictionarySource(text);
        assert.strictEqual(source.sections.length, 1);
        assert.strictEqual(source.find('UnitType', 'Cost')?.value, 'First\n[not a section]\n; content\nLast');
        assert.strictEqual(editedText(text, [source.set('UnitType', 'Cost', 'New\n**text**', true)]), '[UnitType]\r\nCost="""New\r\n**text**""" ; keep\r\n');
        assert.throws(() => source.set('UnitType', 'Cost', 'unsafe"""', true));
        assert.throws(() => source.set('UnitType]\n[Other', 'Cost', 'int'));
    });
    test('numbered declarations retain suffixes and match exact numeric keys', () => {
        assert.deepStrictEqual(keyPattern('Weapon(1,WeaponCount)FLH'), { prefix: 'Weapon', minimum: '1', maximum: 'WeaponCount', suffix: 'FLH' });
        assert.strictEqual(patternIndex('Weapon(1,WeaponCount)FLH', 'weapon12flh'), 12);
        assert.strictEqual(patternIndex('Weapon(1,WeaponCount)FLH', 'WeaponFLH'), undefined);
        assert.strictEqual(patternIndex('Weapon(1,WeaponCount)FLH', 'Weapon1'), undefined);
    });
    test('effective catalog keeps provenance, inherited values and unknown raw constructs', () => {
        const inherited = new DictionarySource('[Sections]\nTechnoType\nUnitType\n[TechnoType]\nCost=int\n[UnitType]:[TechnoType]\nStrength=int\n');
        const root = new DictionarySource('[UnitType]\nCost=float\nWeapon(1,WeaponCount)FLH=CoordStruct\n');
        const catalog = new DictionaryCatalog([{ path: 'base', source: inherited }, { path: 'root', source: root }], 'root');
        const detail = catalog.detail('UnitType');
        assert.strictEqual(detail.base, 'TechnoType');
        assert.strictEqual(detail.properties.find(item => item.key === 'Cost')?.path, 'root');
        assert.strictEqual(detail.properties.find(item => item.key === 'Cost')?.type, 'float');
        assert.strictEqual(detail.properties.find(item => item.key === 'Strength')?.path, 'base');
        assert.ok(detail.properties.some(item => item.key === 'Weapon(1,WeaponCount)FLH'));
        assert.ok(catalog.problems().some(issue => issue.message === 'unknownType'));
    });
    test('schema shares numbered definitions across completion, references and validation', async () => {
        const directory = await mkdtemp(path.join(os.tmpdir(), 'ra2-dict-pattern-'));
        try {
            const content = '[Sections]\nTechnoType\nUnitType\n[TechnoType]\nCost=int\n[UnitType]:[TechnoType]\nWeaponCount=int,2\nWeapon(1,WeaponCount)=WeaponType\nWeapon(1,WeaponCount)FLH=CoordStruct\n[UnitType]\ncost=float\n';
            await writeFile(path.join(directory, 'dictionary.ini'), content);
            const schema = new SchemaManager(); schema.loadSchema(content, path.join(directory, 'dictionary.ini'));
            assert.strictEqual(schema.getProperty('UnitType', 'Weapon2FLH')?.type, 'CoordStruct');
            assert.strictEqual(schema.getProperty('UnitType', 'Weapon2')?.declaration, 'Weapon(1,WeaponCount)');
            assert.strictEqual(schema.getProperty('UnitType', 'Cost')?.type, 'float');
            const keys = schema.expandedKeys('UnitType', key => key === 'WeaponCount' ? '3' : undefined);
            assert.ok(keys.has('Weapon3FLH')); assert.ok(keys.has('Weapon3')); assert.ok(!keys.has('Weapon4'));
            assert.ok(schema.isAssignable('UnitType', 'TechnoType')); assert.ok(!schema.isAssignable('TechnoType', 'UnitType'));
            assert.strictEqual(schema.getProperty('UnitType', 'Weapon2FLH')?.sourcePath, path.join(directory, 'dictionary.ini'));
            assert.ok(schema.isDictionaryDocument(vscode.Uri.file(path.join(directory, 'dictionary.ini'))));
            assert.ok(!schema.isDictionaryDocument(vscode.Uri.file(path.join(directory, 'rules.ini'))));
        } finally { await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
    });

    test('native dictionary edits retain disk contents, native undo and stale-edit protection', async () => {
        const directory = await mkdtemp(path.join(os.tmpdir(), 'ra2-dict-editor-'));
        let provider: DictionaryEditor | undefined;
        const received = new vscode.EventEmitter<unknown>(), disposed = new vscode.EventEmitter<void>();
        const messages: { type: string; state?: DictionaryState; error?: string }[] = [];
        try {
            const file = path.join(directory, 'dictionary.ini'), text = '; keep\n[Sections]\nUnitType\n[UnitType]\nCost = int,1,rules ; keep\n';
            await writeFile(file, text);
            const root = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
            const context = { extensionUri: vscode.Uri.file(path.resolve(__dirname, '../..')), globalStorageUri: vscode.Uri.file(path.join(directory, 'storage')) } as vscode.ExtensionContext;
            provider = new DictionaryEditor(context, new SchemaManager(), new DescriptionManager(), {} as ProjectIni, {} as ProjectResources, false);
            const panel = { webview: { options: {}, html: '', cspSource: 'https://test', asWebviewUri: (uri: vscode.Uri) => uri,
                postMessage: async (message: { type: string; state?: DictionaryState }) => { messages.push(message); return true; }, onDidReceiveMessage: received.event }, onDidDispose: disposed.event } as unknown as vscode.WebviewPanel;
            await provider.resolveCustomTextEditor(root, panel);
            const wait = async (type: string, after = 0) => {
                for (let count = 0; count < 100; count++) {
                    const message = messages.slice(after).find(item => item.type === type);
                    if (message) { return message; } await new Promise(resolve => setTimeout(resolve, 20));
                }
                throw new Error('No ' + type + ': ' + JSON.stringify(messages));
            };
            received.fire({ type: 'ready' }); const initial = (await wait('state')).state!;
            const before = messages.length;
            received.fire({ type: 'apply', revision: initial.revision, draft: { section: 'UnitType', kind: 'object', key: 'Cost', valueType: 'float', defaultValue: '1', fileType: 'rules' } });
            await wait('applied', before);
            assert.strictEqual(root.getText(), text.replace('int,1,rules ', 'float,1,rules '));
            assert.strictEqual(await readFile(file, 'utf8'), text, 'Applying must not silently save');
            assert.ok(root.isDirty);
            const staleBefore = messages.length;
            received.fire({ type: 'apply', revision: initial.revision, draft: { section: 'UnitType', kind: 'object', key: 'Cost', valueType: 'int' } });
            await wait('failure', staleBefore);
            assert.ok(root.getText().includes('float,1,rules'));
            await vscode.window.showTextDocument(root);
            await vscode.commands.executeCommand('undo');
            assert.strictEqual(root.getText(), text);
            await mkdir(path.join(directory, 'descriptions'));
            const afterUndo = messages.length;
            received.fire({ type: 'refresh' }); await wait('state', afterUndo);
            const current = messages.filter(message => message.type === 'state').at(-1)!.state!;
            const beforeDescription = messages.length;
            received.fire({ type: 'apply', revision: current.revision, draft: { section: 'UnitType', kind: 'object', key: 'Cost', valueType: 'int', defaultValue: '1', fileType: 'rules', descriptions: { 'zh-CN': '单位的 **费用**。\n保留换行。' } } });
            await wait('applied', beforeDescription); await wait('state', beforeDescription);
            const description = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(directory, 'descriptions', 'local-zh-CN.ini')));
            assert.strictEqual(new DictionarySource(description.getText()).find('UnitType', 'Cost')?.value, '单位的 **费用**。\n保留换行。');
            const beforeSave = messages.length;
            received.fire({ type: 'save' }); await wait('state', beforeSave);
            assert.ok((await readFile(file, 'utf8')).includes('[Description]'));
            assert.ok((await readFile(description.uri.fsPath, 'utf8')).includes('**费用**'));
            assert.ok(!root.isDirty && !description.isDirty);
        } finally {
            disposed.fire(); provider?.dispose(); received.dispose(); disposed.dispose();
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
            await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        }
    });
    test('defaults respect named constraints and description inheritance is language-local', () => {
        const source = new DictionarySource('[NumberLimits]\nHealth\n[Health]\nRange=1,100\n[Limits]\nChoice\n[Choice]\nLimitIn=Red,Blue\nCaseSensitive=no\n');
        const catalog = new DictionaryCatalog([{ path: 'root', source }], 'root');
        assert.ok(catalog.validDefault('50', 'Health')); assert.ok(!catalog.validDefault('101', 'Health'));
        assert.ok(catalog.validDefault('red', 'Choice')); assert.ok(!catalog.validDefault('green', 'Choice'));
        assert.ok(!catalog.validDefault('1abc', 'float'));
        const descriptions = new DictionarySource('[Base]\nCost="""Inherited **description**"""\n[UnitType]:[Base]\n');
        assert.strictEqual(descriptions.description('UnitType', 'Cost', () => undefined), 'Inherited **description**');
        assert.strictEqual(descriptions.description('UnitType', 'Missing', name => name === 'Base' ? 'UnitType' : undefined), undefined);
    });

    test('optional native dictionary UI opens through the contributed command', async function () {
        const port = process.env.RA2_DICTIONARY_UI_PORT;
        if (!port) { this.skip(); return; }
        this.timeout(90000);
        const directory = await mkdtemp(path.join(os.tmpdir(), 'ra2-dict-native-'));
        const configuration = vscode.workspace.getConfiguration('ra2-ini-intellisense'), previous = configuration.inspect('schemaFilePath')?.globalValue;
        try {
            const dictionary = process.env.RA2_WORKBENCH_DICTIONARY ?? path.join(directory, 'INIDictionary.ini');
            if (!process.env.RA2_WORKBENCH_DICTIONARY) { await writeFile(dictionary, '[Sections]\nUnitType\n[Lists]\nCoordStruct\n[CoordStruct]\nType=int\nRange=3,3\n[UnitType]\nWeaponCount=int\nWeapon(1,WeaponCount)FLH=CoordStruct,,art\n'); }
            await configuration.update('schemaFilePath', dictionary, vscode.ConfigurationTarget.Global);
            await vscode.extensions.getExtension('Astralette.ra2-ini-intellisense')!.activate();
            await vscode.commands.executeCommand('ra2-ini-intellisense.editDictionary', vscode.Uri.file(dictionary));
            await new Promise<void>((resolve, reject) => execFile('node', [path.resolve(__dirname, '../../scripts/verify-vscode-dictionary.cjs'), port,
                path.resolve(__dirname, '../webview-qa/vscode-dictionary.png')], { timeout: 60000 }, (error, stdout, stderr) => {
                console.log(stdout, stderr); if (error) { reject(error); } else { resolve(); }
            }));
        } finally {
            await configuration.update('schemaFilePath', previous, vscode.ConfigurationTarget.Global);
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
            await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        }
    });
});
