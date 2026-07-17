import * as assert from 'assert';
import { ErrorCode } from '../diagnostics/error-codes';

suite('Error Codes', () => {
    test('style error codes are S001-S005', () => {
        assert.strictEqual(ErrorCode.STYLE_LEADING_WHITESPACE, 'S001');
        assert.strictEqual(ErrorCode.STYLE_SPACE_BEFORE_EQUALS, 'S002');
        assert.strictEqual(ErrorCode.STYLE_SPACE_AFTER_EQUALS, 'S003');
        assert.strictEqual(ErrorCode.STYLE_INCORRECT_SPACES_BEFORE_COMMENT, 'S004');
        assert.strictEqual(ErrorCode.STYLE_MISSING_SPACE_AFTER_COMMENT, 'S005');
    });

    test('type error codes are T001-T007', () => {
        assert.strictEqual(ErrorCode.TYPE_INVALID_INTEGER, 'T001');
        assert.strictEqual(ErrorCode.TYPE_INVALID_FLOAT, 'T002');
        assert.strictEqual(ErrorCode.TYPE_NUMBER_OUT_OF_RANGE, 'T003');
        assert.strictEqual(ErrorCode.TYPE_VALUE_NOT_IN_LIST, 'T004');
        assert.strictEqual(ErrorCode.TYPE_INVALID_PREFIX, 'T005');
        assert.strictEqual(ErrorCode.TYPE_INVALID_SUFFIX, 'T006');
        assert.strictEqual(ErrorCode.TYPE_LIST_INVALID_LENGTH, 'T007');
    });

    test('logic error codes are L001-L004', () => {
        assert.strictEqual(ErrorCode.LOGIC_UNDEFINED_SECTION_REFERENCE, 'L001');
        assert.strictEqual(ErrorCode.LOGIC_UNREGISTERED_SECTION, 'L002');
        assert.strictEqual(ErrorCode.LOGIC_EMPTY_VALUE, 'L003');
        assert.strictEqual(ErrorCode.LOGIC_DUPLICATE_REGISTRY_KEY, 'L004');
    });

    test('all error codes are unique', () => {
        const values = Object.values(ErrorCode);
        const unique = new Set(values);
        assert.strictEqual(values.length, unique.size, 'Duplicate error code values detected');
    });

    test('error codes do not use the old README format', () => {
        for (const code of Object.values(ErrorCode)) {
            assert.ok(!code.startsWith('STYLE'), `Code ${code} should not start with STYLE`);
            assert.ok(!code.startsWith('TYPE'), `Code ${code} should not start with TYPE`);
            assert.ok(!code.startsWith('LOGIC'), `Code ${code} should not start with LOGIC`);
        }
    });
});
