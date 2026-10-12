import * as vscode from 'vscode';
import { IniDiagnostic } from '../diagnostic';
import { ErrorCode } from '../error-codes';
import { RuleContext, ValidationRule } from '../rules';
import { ValueTypeCategory } from '../../schema-manager';
import { localize } from '../../i18n';
import { parsePropertyLine } from '../../context/ini-position';

/**
 * 验证一个值是否符合其 Schema 定义的类型规则，并返回带精确范围的错误。
 * @param value 要验证的字符串值
 * @param valueType 值的预期类型 (来自 Schema)
 * @param context 完整的诊断上下文
 * @param valueStartIndex 完整值字符串在行中的起始位置
 * @returns 一个包含所有验证错误的数组，如果验证成功，则返回空数组
 */
function validateValue(value: string, valueType: string, context: RuleContext, valueStartIndex: number): IniDiagnostic[] {
    const { schemaManager, iniManager, lineNumber } = context;
    if (value === '') { return []; }
    const category = schemaManager.getValueTypeCategory(valueType);
    const fullRange = new vscode.Range(lineNumber, valueStartIndex, lineNumber, valueStartIndex + value.length);

    const createError = (message: string, code: ErrorCode, range: vscode.Range = fullRange): IniDiagnostic[] => {
        return [new IniDiagnostic(range, message, vscode.DiagnosticSeverity.Error, code)];
    };

    switch (category) {
        case ValueTypeCategory.Primitive:
            if (valueType === 'int' && !/^[+-]?\d+$/.test(value)) {return createError(localize('diag.type.invalidInteger', 'Value "{0}" is not a valid integer.', value), ErrorCode.TYPE_INVALID_INTEGER);}
            if ((valueType === 'float' || valueType === 'double') && (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?%?$/i.test(value) || !Number.isFinite(Number(value.replace(/%$/, ''))))) {return createError(localize('diag.type.invalidFloat', 'Value "{0}" is not a valid floating-point number.', value), ErrorCode.TYPE_INVALID_FLOAT);}
            if (valueType === 'bool' && !/^(yes|no|true|false|1|0)$/i.test(value)) { return createError(localize('diag.type.invalidBoolean', 'Value "{0}" is not a valid boolean.', value), ErrorCode.TYPE_INVALID_BOOLEAN); }
            return [];

        case ValueTypeCategory.NumberLimit: {
            const limit = schemaManager.getNumberLimit(valueType);
            if (!limit) {return [];}
            const num = /^[-+]?\d+$/.test(value) ? Number(value) : NaN;
            if (isNaN(num)) {return createError(localize('diag.type.invalidInteger', 'Value "{0}" is not a valid integer.', value), ErrorCode.TYPE_INVALID_INTEGER);}
            if (num < limit.min || num > limit.max) {
                return createError(localize('diag.type.numberOutOfRange', 'Value {0} is outside the allowed range [{1}, {2}] for type "{3}".', value, limit.min, limit.max, valueType), ErrorCode.TYPE_NUMBER_OUT_OF_RANGE);
            }
            return [];
        }

        case ValueTypeCategory.StringLimit: {
            const limit = schemaManager.getStringLimit(valueType);
            if (!limit) {return [];}
            const compareValue = limit.caseSensitive ? value : value.toLowerCase();

            if (limit.limitIn) {
                const allowed = limit.caseSensitive ? limit.limitIn : limit.limitIn.map(v => v.toLowerCase());
                if (!allowed.includes(compareValue)) {return createError(localize('diag.type.valueNotInList', 'Value "{0}" is not one of the allowed values for type "{1}".', value, valueType), ErrorCode.TYPE_VALUE_NOT_IN_LIST);}
            }
            if (limit.startWith) {
                const prefixes = limit.caseSensitive ? limit.startWith : limit.startWith.map(v => v.toLowerCase());
                if (!prefixes.some(p => compareValue.startsWith(p))) {return createError(localize('diag.type.invalidPrefix', 'Value "{0}" does not meet the prefix requirement for type "{1}".', value, valueType), ErrorCode.TYPE_INVALID_PREFIX);}
            }
            if (limit.endWith) {
                const suffixes = limit.caseSensitive ? limit.endWith : limit.endWith.map(v => v.toLowerCase());
                if (!suffixes.some(s => compareValue.endsWith(s))) {return createError(localize('diag.type.invalidSuffix', 'Value "{0}" does not meet the suffix requirement for type "{1}".', value, valueType), ErrorCode.TYPE_INVALID_SUFFIX);}
            }
            return [];
        }

        case ValueTypeCategory.List: {
            const definition = schemaManager.getListDefinition(valueType);
            if (!definition) {return [];}
            
            const items = value ? value.split(',').map(item => item.trim()) : [];

            if (definition.minRange !== undefined && items.length < definition.minRange) {return createError(localize('diag.type.listTooShort', 'Type "{0}" requires at least {1} value(s), but only {2} were provided.', valueType, definition.minRange, items.length), ErrorCode.TYPE_LIST_INVALID_LENGTH);}
            if (definition.maxRange !== undefined && items.length > definition.maxRange) {return createError(localize('diag.type.listTooLong', 'Type "{0}" requires at most {1} value(s), but {2} were provided.', valueType, definition.maxRange, items.length), ErrorCode.TYPE_LIST_INVALID_LENGTH);}
            
            const allErrors: IniDiagnostic[] = [];
            let currentOffsetInValue = 0;
            const originalItems = value ? value.split(',') : [];

            for (let i = 0; i < originalItems.length; i++) {
                const originalItem = originalItems[i];
                const trimmedItem = originalItem.trim();
                
                const itemStartIndexInLine = valueStartIndex + currentOffsetInValue + originalItem.indexOf(trimmedItem);

                const itemErrors = validateValue(trimmedItem, definition.type, context, itemStartIndexInLine);
                if (itemErrors.length > 0) {
                    itemErrors.forEach(err => {
                        err.message = localize('diag.type.listItemInvalid', 'List item "{0}" is invalid: {1}', trimmedItem, err.message);
                        allErrors.push(err);
                    });
                }
                currentOffsetInValue += originalItem.length + 1; // +1 for comma
            }
            return allErrors;
        }

        case ValueTypeCategory.Section:
            if (/^(none|<none>)$/i.test(value) || (context.project && !context.project.context(context.document.uri).complete)) { return []; }
            if (context.project ? !context.project.sources(context.document.uri, value, valueType === 'AnimType' ? 'art' : valueType === 'Sound' ? 'sound' : context.project.category(context.document.uri)).length : iniManager.findSectionLocations(value).length === 0) {
                return createError(localize('diag.logic.undefinedSection', 'Definition for section "[{0}]" not found in the project.', value), ErrorCode.LOGIC_UNDEFINED_SECTION_REFERENCE);
            }
            return [];
            
        default:
            return [];
    }
}

const checkKeyValueTypes: ValidationRule = (context: RuleContext): IniDiagnostic[] => {
    const { codePart, currentSection } = context;

    const kvMatch = codePart.match(/^\s*([^;=\s][^=]*?)\s*=\s*(.*)/);
    if (!kvMatch || !currentSection.keys) {
        return [];
    }
    
    const key = kvMatch[1].trim();
    const valueString = kvMatch[2].trim();
    
    let valueType: string | undefined;
    // currentSection.keys 是 Map<string, PropertyDefinition>
    for (const [k, v] of currentSection.keys.entries()) {
        if (k.toLowerCase() === key.toLowerCase()) {
            // 适配 v 可能是对象的情况
            valueType = v.type;
            break;
        }
    }

    if (valueType) {
        // 计算值在行中的精确起始位置
        const parsed = parsePropertyLine(codePart)!;
        const valueStartIndex = parsed.elements[0]?.start ?? parsed.valueStart;
        return validateValue(valueString, valueType, context, valueStartIndex);
    }
    
    return [];
};


export const typeRules: ValidationRule[] = [
    checkKeyValueTypes
];