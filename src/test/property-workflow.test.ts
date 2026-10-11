import * as assert from 'assert';
import * as vscode from 'vscode';
import { IniDocument } from '../parser';
import { resolveProperties } from '../context/property-resolution';
import { parsePropertyLine } from '../context/ini-position';
import { applyPropertyChanges, preparePropertyChanges, PropertyEditTarget } from '../context/property-edit';

suite('Property provenance and transactions', () => {
    const target = (document: vscode.TextDocument, key: string): PropertyEditTarget => ({
        uri: document.uri,
        version: document.version,
        section: 'Owner',
        sectionLine: 0,
        key,
    });
    test('duplicate declarations, file precedence, inheritance and cycles share one winner', () => {
        const high = new IniDocument(
            vscode.Uri.file('C:/fixture/patch.ini'),
            '[Owner]:[Parent]\nCost=2\nCost=3\n[Owner]\nCost=4\n[Parent]:[Owner]\nStrength=100'
        );
        const low = new IniDocument(vscode.Uri.file('C:/fixture/base.ini'), '[Owner]\nCost=1');
        const resolve = resolveProperties(
            'Owner',
            (name) =>
                [high, low].flatMap((document) =>
                    document.sections
                        .filter((section) => section.name.toLowerCase() === name.toLowerCase())
                        .map((section) => ({ document, section, category: 'rules' }))
                ),
            parsePropertyLine
        );
        assert.strictEqual(resolve.get('cost')?.effective.value, '4');
        assert.deepStrictEqual(
            resolve.get('cost')?.declarations.map((declaration) => declaration.value),
            ['4', '3', '2', '1']
        );
        assert.deepStrictEqual(resolve.get('strength')?.effective.via, ['Owner', 'Parent']);
    });
    test('diamond graphs visit each section once', () => {
        const document = new IniDocument(
            vscode.Uri.file('C:/fixture/diamond.ini'),
            Array.from(
                { length: 30 },
                (_, i) => `[Node${i}]${i < 28 ? `:[Node${i + 1}],[Node${i + 2}]` : ''}\nKey${i}=${i}`
            ).join('\n')
        );
        let visits = 0;
        resolveProperties(
            'Node0',
            (name) => {
                visits++;
                return document.sections
                    .filter((section) => section.name === name)
                    .map((section) => ({ document, section, category: 'rules' }));
            },
            parsePropertyLine
        );
        assert.ok(visits <= 30);
    });
    test('one transaction preserves comments and whitespace, inserts overrides and supports native undo', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'ra2-ini',
            content: '[Owner]\r\n  Cost=  10  ; price\r\n[Next]\r\nCost=99',
        });
        await vscode.window.showTextDocument(document);
        const before = document.getText();
        await applyPropertyChanges([
            { target: target(document, 'Cost'), value: '20' },
            { target: target(document, 'Strength'), value: '300' },
        ]);
        assert.ok(document.getText().includes('  Cost=  20  ; price\r\nStrength=300\r\n[Next]'));
        await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
        await vscode.commands.executeCommand('undo');
        assert.strictEqual(document.getText(), before);
    });
    test('removing a property removes duplicates but preserves standalone comments', async () => {
        const document = await vscode.workspace.openTextDocument({
            content: '[Owner]\nCost=1 ; keep\ncost=2\n[Next]\nCost=9',
        });
        await applyPropertyChanges([{ target: target(document, 'Cost'), value: null }]);
        assert.strictEqual(document.getText(), '[Owner]\n; keep\n[Next]\nCost=9');
    });
    test('stale or invalid targets reject the whole group before writing any file', async () => {
        const a = await vscode.workspace.openTextDocument({ content: '[Owner]\nCost=1' });
        const b = await vscode.workspace.openTextDocument({ content: '[Owner]\nCost=2' });
        const stale = target(b, 'Cost');
        await applyPropertyChanges([{ target: target(b, 'Cost'), value: '3' }]);
        await assert.rejects(() =>
            applyPropertyChanges([
                { target: target(a, 'Cost'), value: '9' },
                { target: stale, value: '9' },
            ])
        );
        assert.strictEqual(a.getText(), '[Owner]\nCost=1');
        for (const value of ['NaN', '1.5', '-1', '101', '1\nInjected=yes']) {
            await assert.rejects(() =>
                preparePropertyChanges([
                    { target: { ...target(a, 'Cost'), valueType: 'int', minimum: 0, maximum: 100 }, value },
                ])
            );
        }
        await assert.rejects(() => applyPropertyChanges([{ target: target(a, 'Cost'), value: '2' }], () => false));
        assert.strictEqual(a.getText(), '[Owner]\nCost=1');
    });
});
