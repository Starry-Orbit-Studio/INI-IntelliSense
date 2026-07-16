// src/diagnostics/error-codes.ts
/**
 * 定义所有诊断错误的唯一错误码。
 * 这种方法有助于对错误进行分类，并为将来的快速修复等功能提供稳定的标识符。
 * - STYLE (1xx): 代码风格问题
 * - TYPE (2xx):  键值类型不匹配问题
 * - LOGIC (3xx): 逻辑有效性问题 (如引用不存在)
 */
export enum ErrorCode {
    // Style Errors (1xx)
    STYLE_LEADING_WHITESPACE = 'S001',
    STYLE_SPACE_BEFORE_EQUALS = 'S002',
    STYLE_SPACE_AFTER_EQUALS = 'S003',
    STYLE_INCORRECT_SPACES_BEFORE_COMMENT = 'S004',
    STYLE_MISSING_SPACE_AFTER_COMMENT = 'S005',

    // Type Errors (2xx)
    TYPE_INVALID_INTEGER = 'T001',
    TYPE_INVALID_FLOAT = 'T002',
    TYPE_NUMBER_OUT_OF_RANGE = 'T003',
    TYPE_VALUE_NOT_IN_LIST = 'T004',
    TYPE_INVALID_PREFIX = 'T005',
    TYPE_INVALID_SUFFIX = 'T006',
    TYPE_LIST_INVALID_LENGTH = 'T007',

    // Logic Errors (3xx)
    LOGIC_UNDEFINED_SECTION_REFERENCE = 'L001',
    LOGIC_UNREGISTERED_SECTION = 'L002',
    LOGIC_EMPTY_VALUE = 'L003',
    LOGIC_DUPLICATE_REGISTRY_KEY = 'L004',
}