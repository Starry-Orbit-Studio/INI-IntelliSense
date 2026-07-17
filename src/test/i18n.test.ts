import * as assert from 'assert';
import { localize } from '../i18n';

suite('i18n localize()', () => {
    test('falls back to the default message when key is missing', () => {
        assert.strictEqual(
            localize('test.nonexistent.key', 'Fallback text'),
            'Fallback text'
        );
    });

    test('does not return the old !key! sentinel for missing keys', () => {
        const result = localize('test.nonexistent.key', 'Fallback text');
        assert.ok(!result.startsWith('!'), `Expected fallback text, got sentinel: ${result}`);
        assert.ok(!result.endsWith('!'), `Expected fallback text, got sentinel: ${result}`);
    });

    test('substitutes single placeholder in fallback', () => {
        assert.strictEqual(
            localize('test.nonexistent.key', 'Hello {0}', 'World'),
            'Hello World'
        );
    });

    test('substitutes multiple placeholders in fallback', () => {
        assert.strictEqual(
            localize('test.nonexistent.key', '{0} and {1}', 'A', 'B'),
            'A and B'
        );
    });

    test('preserves placeholder when argument is undefined', () => {
        assert.strictEqual(
            localize('test.nonexistent.key', 'Hello {0}'),
            'Hello {0}'
        );
    });

    test('handles numeric arguments', () => {
        assert.strictEqual(
            localize('test.nonexistent.key', 'Count: {0}', 42),
            'Count: 42'
        );
    });

    test('existing bundle key returns non-empty string (not sentinel)', () => {
        const result = localize('mainMenu.placeholder', 'Default Menu');
        assert.ok(result.length > 0, 'Should return a non-empty string');
        assert.ok(!result.startsWith('!'), `Should not return sentinel: ${result}`);
    });
});
