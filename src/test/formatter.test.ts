import * as assert from 'assert';
import * as vscode from 'vscode';
import { formatLine } from '../formatting/formatter';

/** Creates a lightweight mock WorkspaceConfiguration from a plain object. */
function mockConfig(values: Record<string, any>): vscode.WorkspaceConfiguration {
    return {
        get: <T>(key: string): T | undefined => values[key] as T | undefined,
        has: (key: string): boolean => key in values,
        update: async (): Promise<void> => undefined,
        inspect: (): unknown => undefined,
    } as unknown as vscode.WorkspaceConfiguration;
}

suite('Formatter', () => {
    const defaultConfig = mockConfig({ spaceAfterComment: true, spacesBeforeComment: 1 });

    test('removes spaces around equals sign', () => {
        assert.strictEqual(formatLine('Foo = Bar', defaultConfig), 'Foo=Bar');
    });

    test('trims leading whitespace', () => {
        assert.strictEqual(formatLine('  Foo=Bar', defaultConfig), 'Foo=Bar');
    });

    test('adds space before and after comment separator', () => {
        assert.strictEqual(formatLine('Foo=Bar;comment', defaultConfig), 'Foo=Bar ; comment');
    });

    test('preserves existing correct spacing in comment', () => {
        assert.strictEqual(formatLine('Foo=Bar ; comment', defaultConfig), 'Foo=Bar ; comment');
    });

    test('formats standalone comment line', () => {
        assert.strictEqual(formatLine(';comment', defaultConfig), '; comment');
    });

    test('leaves section headers untouched', () => {
        assert.strictEqual(formatLine('[BuildingTypes]', defaultConfig), '[BuildingTypes]');
    });

    test('leaves empty lines untouched', () => {
        assert.strictEqual(formatLine('', defaultConfig), '');
    });

    test('handles key with no value', () => {
        assert.strictEqual(formatLine('Foo=', defaultConfig), 'Foo=');
    });

    test('handles value with spaces in value part', () => {
        assert.strictEqual(formatLine('Name=Some Value Here', defaultConfig), 'Name=Some Value Here');
    });

    test('respects spacesBeforeComment setting', () => {
        const cfg = mockConfig({ spaceAfterComment: true, spacesBeforeComment: 3 });
        assert.strictEqual(formatLine('Foo=Bar;comment', cfg), 'Foo=Bar   ; comment');
    });

    test('disables space after comment when configured', () => {
        const cfg = mockConfig({ spaceAfterComment: false, spacesBeforeComment: 1 });
        assert.strictEqual(formatLine('Foo=Bar;comment', cfg), 'Foo=Bar ;comment');
    });

    test('uses null spacesBeforeComment as single space', () => {
        const cfg = mockConfig({ spaceAfterComment: true, spacesBeforeComment: null });
        assert.strictEqual(formatLine('Foo=Bar;comment', cfg), 'Foo=Bar ; comment');
    });

    test('handles inline comment with existing space', () => {
        assert.strictEqual(formatLine('Foo=Bar ; comment', defaultConfig), 'Foo=Bar ; comment');
    });
});
