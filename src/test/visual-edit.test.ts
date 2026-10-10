import * as assert from 'assert';
import * as vscode from 'vscode';
import { applyVisualEdit } from '../context/visual-edit';
import { EditCapability } from '../context/inspection-service';

suite('Native visual edits', () => {
    test('light direction and fixed-light flag are one native undo operation', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'ra2-ini',
            content: '[Owner]\nVoxelLightSource=0.2,-0.9,-0.3\nUseFixedVoxelLighting=no ; old',
        });
        await vscode.window.showTextDocument(document);
        const capability = target(document, 'light', 'VoxelLightSource', '0.2,-0.9,-0.3');
        capability.linked = { key: 'UseFixedVoxelLighting', original: 'no' };
        await applyVisualEdit(capability, [0.5, 0.5, 1, 1]);
        assert.strictEqual(document.lineAt(2).text, 'UseFixedVoxelLighting=yes ; old');
        await vscode.commands.executeCommand('undo');
        assert.strictEqual(document.lineAt(1).text, 'VoxelLightSource=0.2,-0.9,-0.3');
        assert.strictEqual(document.lineAt(2).text, 'UseFixedVoxelLighting=no ; old');
    });
    const target = (
        document: vscode.TextDocument,
        kind: EditCapability['kind'],
        key: string,
        original?: string
    ): EditCapability => ({ uri: document.uri, section: 'Owner', kind, key, original, version: document.version });
    test('action edit preserves indentation, trailing fields and comments; native undo works', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'ra2-ini',
            content: '[Owner]\n  Walk= 0,6,6,2  ; note\n[Next]\nX=1',
        });
        await vscode.window.showTextDocument(document);
        await applyVisualEdit(target(document, 'sequence', 'Walk', '0,6,6,2'), [1, 5, 8]);
        assert.strictEqual(document.lineAt(1).text, '  Walk= 1,5,8,2  ; note');
        await vscode.commands.executeCommand('undo');
        assert.strictEqual(document.lineAt(1).text, '  Walk= 0,6,6,2  ; note');
    });
    test('inherited FLH writes an override in the owner before the next section', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'ra2-ini',
            content: '[Owner]\nImage=body\n[Next]\nX=1',
        });
        await applyVisualEdit(target(document, 'point', 'PrimaryFireFLH'), [10, -20, 30]);
        assert.ok(document.getText().includes('PrimaryFireFLH=10,-20,30\n[Next]'));
    });
    test('empty values and stale capabilities are handled without overwriting concurrent edits', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'ra2-ini',
            content: '[Owner]\nPrimaryFireFLH=   ; empty',
        });
        const capability = target(document, 'point', 'PrimaryFireFLH', '');
        await applyVisualEdit(capability, [1, 2, 3]);
        assert.strictEqual(document.lineAt(1).text, 'PrimaryFireFLH=   1,2,3; empty');
        await assert.rejects(() => applyVisualEdit(capability, [4, 5, 6]));
        await assert.rejects(() => applyVisualEdit(target(document, 'light', 'VoxelLightSource'), [0, 0, 0]));
    });
});
