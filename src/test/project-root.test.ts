import * as assert from 'assert';
import * as vscode from 'vscode';
import { resolveProjectRoot, isWithinRoot } from '../resources/project-root';
import { MixUriCodec } from '../mix/fs/mix-uri-codec';

suite('Mod project root resolution', () => {
    const root = vscode.Uri.file('E:/Example Mod');
    const rules = vscode.Uri.joinPath(root, 'Rules');
    const resources = vscode.Uri.joinPath(root, 'Resources');
    test('opening Rules alone includes its sibling Resources and root archives', () => {
        assert.strictEqual(
            resolveProjectRoot(vscode.Uri.joinPath(rules, 'ruleses.ini'), rules).toString(),
            root.toString()
        );
        assert.strictEqual(resolveProjectRoot(rules, rules).toString(), root.toString());
    });
    test('nested includes and directly opened models resolve the same project', () => {
        for (const uri of [
            vscode.Uri.joinPath(rules, 'Factions', 'ruleses_AL.ini'),
            vscode.Uri.joinPath(resources, 'Models', 'tank.vxl'),
            vscode.Uri.joinPath(resources, 'Audio', 'voice.wav'),
        ]) {
            assert.strictEqual(resolveProjectRoot(uri).toString(), root.toString());
        }
    });
    test('Resources workspace and MIX entries use the physical mod root', () => {
        assert.strictEqual(
            resolveProjectRoot(vscode.Uri.joinPath(resources, 'Models', 'tank.vxl'), resources).toString(),
            root.toString()
        );
        const entry = MixUriCodec.toChildUri(MixUriCodec.toRootUri(vscode.Uri.joinPath(root, 'ra2.mix')), 'tank.vxl');
        assert.strictEqual(resolveProjectRoot(entry, root).toString(), root.toString());
    });
    test('explicit project folder is scoped to its documents and keeps ordinary layouts working', () => {
        const nested = vscode.Uri.joinPath(root, 'Config', 'rules.ini');
        assert.strictEqual(resolveProjectRoot(nested, undefined, root).toString(), root.toString());
        const unrelated = vscode.Uri.file('E:/Other Mod/rules.ini');
        assert.strictEqual(
            resolveProjectRoot(unrelated, undefined, root).toString(),
            vscode.Uri.file('E:/Other Mod').toString()
        );
        assert.strictEqual(resolveProjectRoot(nested, root).toString(), root.toString());
    });
    test('Windows case differences do not lose ownership or include neighboring projects', () => {
        assert.ok(isWithinRoot(root, vscode.Uri.file('e:/EXAMPLE MOD/Rules/rules.ini')));
        assert.ok(!isWithinRoot(root, vscode.Uri.file('E:/Example Mod Copy/rules.ini')));
    });
});
