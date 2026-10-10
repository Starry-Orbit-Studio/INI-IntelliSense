import * as assert from 'assert';
import { compileFileCategoryGlob } from '../file-type-manager';

suite('INI file category glob semantics', () => {
    test('Rules folder names cannot capture art, sound or other INIs', () => {
        const rules = compileFileCategoryGlob('rules*.ini');
        for (const name of ['Rules/artes.ini', 'Rules/soundes.ini', 'Rules/vehicle-definitions.ini']) {
            assert.ok(!rules.test(name), name);
        }
        assert.ok(rules.test('ruleses_AL.ini'));
        assert.ok(compileFileCategoryGlob('art*.ini').test('ARTES.INI'));
    });
    test('single star and question mark stay in one path segment', () => {
        const direct = compileFileCategoryGlob('Rules/art*.ini');
        assert.ok(direct.test('Rules/artes.ini'));
        assert.ok(!direct.test('Rules/art/nested.ini'));
        assert.ok(compileFileCategoryGlob('art?.ini').test('art1.ini'));
        assert.ok(!compileFileCategoryGlob('art?.ini').test('art/.ini'));
    });
    test('double star supports root and nested files; Windows separators are normalized', () => {
        const recursive = compileFileCategoryGlob('**/art*.ini');
        for (const name of ['art.ini', 'Rules/artes.ini', 'Rules/Factions/artes_AL.ini']) {
            assert.ok(recursive.test(name), name);
        }
        assert.ok(compileFileCategoryGlob('Rules\\**\\art*.ini').test('Rules/Factions/artes_AL.ini'));
    });
    test('literal regex characters remain literal', () => {
        const exact = compileFileCategoryGlob('Rules/art(1).ini');
        assert.ok(exact.test('Rules/art(1).ini'));
        assert.ok(!exact.test('Rules/art1.ini'));
    });
});
