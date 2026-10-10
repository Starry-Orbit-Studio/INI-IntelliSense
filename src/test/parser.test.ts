import * as assert from 'assert';
import * as vscode from 'vscode';
import { IniDocument, INIManager } from '../parser';

suite('IniDocument Parser', () => {
    const sampleUri = vscode.Uri.parse('file:///test/sample.ini');

    test('parses a simple section with key-value pairs', () => {
        const content = '[BuildingTypes]\n0=GAPOWR\n1=GAPILE\n';
        const doc = new IniDocument(sampleUri, content);

        assert.strictEqual(doc.sections.length, 1);
        const sec = doc.getSection('BuildingTypes');
        assert.ok(sec, 'BuildingTypes section should exist');
        assert.strictEqual(sec!.name, 'BuildingTypes');
        assert.strictEqual(sec!.properties.get('0'), 'GAPOWR');
        assert.strictEqual(sec!.properties.get('1'), 'GAPILE');
    });

    test('parses section with parent inheritance', () => {
        const content = '[GAPowe]:[BuildingType]\nName=GAP\n';
        const doc = new IniDocument(sampleUri, content);

        const sec = doc.getSection('GAPowe');
        assert.ok(sec, 'GAPowe section should exist');
        assert.strictEqual(sec!.parentName, 'BuildingType');
        assert.deepStrictEqual(sec!.parentNames, ['BuildingType']);
    });

    test('parses Phobos Inherits parents', () => {
        const content = '[Child]\n$Inherits=Parent1, Parent2 ; section names\n';
        const doc = new IniDocument(sampleUri, content);

        const sec = doc.getSection('Child');
        assert.ok(sec, 'Child section should exist');
        assert.deepStrictEqual(sec!.parentNames, ['Parent1', 'Parent2']);
    });

    test('combines header inheritance and Phobos Inherits parents', () => {
        const content = '[Child]:[HeaderParent]\nInherits=Parent1,Parent2\n';
        const doc = new IniDocument(sampleUri, content);

        const sec = doc.getSection('Child');
        assert.ok(sec, 'Child section should exist');
        assert.strictEqual(sec!.parentName, 'HeaderParent');
        assert.deepStrictEqual(sec!.parentNames, ['HeaderParent', 'Parent1', 'Parent2']);
    });

    test('ignores blank lines and full-line comments', () => {
        const content = '; full line comment\n\n[Rules]\n; another comment\nFoo=Bar\n';
        const doc = new IniDocument(sampleUri, content);

        const sec = doc.getSection('Rules');
        assert.ok(sec);
        assert.strictEqual(sec!.properties.size, 1);
        assert.strictEqual(sec!.properties.get('Foo'), 'Bar');
    });

    test('strips inline comments from values', () => {
        const content = '[S]\nKey=Value ; inline comment\n';
        const doc = new IniDocument(sampleUri, content);
        const sec = doc.getSection('S');
        assert.ok(sec);
        assert.strictEqual(sec!.properties.get('Key'), 'Value');
    });

    test('getSectionAt returns the section spanning a given line', () => {
        const content = '[A]\nK=1\n[B]\nK=2\n';
        const doc = new IniDocument(sampleUri, content);

        assert.strictEqual(doc.getSectionAt(0)?.name, 'A');
        assert.strictEqual(doc.getSectionAt(1)?.name, 'A');
        assert.strictEqual(doc.getSectionAt(2)?.name, 'B');
        assert.strictEqual(doc.getSectionAt(3)?.name, 'B');
    });

    test('sets section boundaries startLine and endLine', () => {
        const content = '[A]\nK=1\n[B]\nK=2';
        const doc = new IniDocument(sampleUri, content);
        const a = doc.getSection('A')!;
        const b = doc.getSection('B')!;
        assert.strictEqual(a.startLine, 0);
        assert.strictEqual(a.endLine, 1, 'A endLine should be the line before B');
        assert.strictEqual(b.startLine, 2);
        assert.strictEqual(b.endLine, 3, 'last section endLine should be last line index');
    });

    test('getAllSections returns all sections in document order', () => {
        const content = '[A]\n[B]\n[C]\n';
        const doc = new IniDocument(sampleUri, content);
        assert.deepStrictEqual(doc.getAllSections().map(s => s.name), ['A', 'B', 'C']);
    });

    test('update re-parses new content', () => {
        const doc = new IniDocument(sampleUri, '[A]\n');
        assert.strictEqual(doc.sections.length, 1);
        doc.update('[A]\n[B]\n');
        assert.strictEqual(doc.sections.length, 2);
    });

    test('keys before any section are dropped', () => {
        const content = 'Orphan=value\n[A]\n';
        const doc = new IniDocument(sampleUri, content);
        assert.strictEqual(doc.sections.length, 1);
        assert.strictEqual(doc.getSection('A')!.properties.size, 0);
    });

    test('duplicate keys in the same section keep the last value', () => {
        const content = '[S]\n0=First\n0=Second\n';
        const doc = new IniDocument(sampleUri, content);
        const sec = doc.getSection('S')!;
        assert.strictEqual(sec.properties.get('0'), 'Second');
        assert.strictEqual(sec.properties.size, 1);
    });

    test('leading whitespace does not break key parsing', () => {
        const content = '[S]\n  Key=Value\n';
        const doc = new IniDocument(sampleUri, content);
        const sec = doc.getSection('S')!;
        assert.strictEqual(sec.properties.get('Key'), 'Value');
    });

    test('resolves Phobos Inherits recursively in depth-first order', () => {
        const manager = new INIManager();
        const content = [
            '[GrandParent]',
            'Armor=Grand',
            '[Parent1]',
            '$Inherits=GrandParent',
            '[Parent2]',
            'Armor=Second',
            '[Child]',
            '$Inherits=Parent1,Parent2'
        ].join('\n');

        manager.documents.set(sampleUri.toString(), new IniDocument(sampleUri, content));
        (manager as any).rebuildAllIndexes();

        const result = manager.findKeyLocationRecursive('Child', 'Armor');
        assert.strictEqual(result.definer, 'GrandParent');
        assert.strictEqual(result.lineText, 'Armor=Grand');
    });

    test('indexes Phobos Inherits as inheritance references only', () => {
        const manager = new INIManager();
        const content = '[Parent]\nKey=Value\n[Child]\n$Inherits=Parent\n';

        manager.documents.set(sampleUri.toString(), new IniDocument(sampleUri, content));
        (manager as any).rebuildAllIndexes();

        assert.strictEqual(manager.inheritanceReferences.get('Parent')?.length, 1);
        assert.strictEqual(manager.valueReferences.get('Parent')?.length ?? 0, 0);
    });
});
