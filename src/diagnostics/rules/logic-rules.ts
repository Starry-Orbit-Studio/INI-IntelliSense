import * as vscode from 'vscode';
import { IniDiagnostic } from '../diagnostic';
import { ErrorCode } from '../error-codes';
import { RuleContext, ValidationRule } from '../rules';
import { localize } from '../../i18n';

const checkUnregisteredSection: ValidationRule = (context: RuleContext): IniDiagnostic[] => {
    // 暂不启用此检查，因为判定逻辑复杂且容易误报。
    // 将通过上下文菜单提供一个更主动、可控的注册方式。
    return [];
    /*
    const { line, lineNumber, schemaManager, iniManager } = context;
    const sectionMatch = line.text.match(/^\s*\[([^\]:]+)/);

    if (sectionMatch) {
        const sectionName = sectionMatch[1].trim();
        const typeName = iniManager.getTypeForSection(sectionName);
        
        // 仅当此节是一个复杂的对象类型时才检查注册
        if (schemaManager.isComplexType(typeName)) {
            // 检查此节是否已在任何注册表中注册
            const registry = iniManager.findRegistryForSection(sectionName);
            if (!registry) {
                const range = new vscode.Range(lineNumber, line.text.indexOf(sectionName), lineNumber, line.text.indexOf(sectionName) + sectionName.length);
                return [new IniDiagnostic(
                    range,
                    localize('diag.logic.unregisteredSection', 'Section "[{0}]" appears to be of type "{1}" but is not registered in any ID list (e.g., [{2}]).', sectionName, typeName, schemaManager.getRegistryForType(typeName) || '...Types'),
                    vscode.DiagnosticSeverity.Warning,
                    ErrorCode.LOGIC_UNREGISTERED_SECTION
                )];
            }
        }
    }

    return [];
    */
};

const checkEmptyValue: ValidationRule = (context: RuleContext): IniDiagnostic[] => {
    const { line, codePart } = context;

    const kvMatch = codePart.match(/^\s*([^;=\s][^=]*?)\s*=(.*)/);
    if (kvMatch) {
        const key = kvMatch[1].trim();
        const value = kvMatch[2].trim();

        if (value === '') {
            return [new IniDiagnostic(
                line.range,
                localize('checks.emptyValueReview', "The key '{0}' has an empty value. This may intentionally clear an inherited value; review the effective result.", key),
                vscode.DiagnosticSeverity.Warning,
                ErrorCode.LOGIC_EMPTY_VALUE
            )];
        }
    }
    
    return [];
};

const checkDuplicateRegistryKey: ValidationRule = (context: RuleContext): IniDiagnostic[] => {
    const { codePart, currentSection, schemaManager, seenRegistryKeys, lineNumber } = context;

    if (!currentSection.name) { return []; }

    // 检查该节是否是一个“ID列表注册表”（如 BuildingTypes）
    if (!schemaManager.getIdListRegistryNames().has(currentSection.name)) {
        return [];
    }

    // 匹配 Key=Value 结构
    const kvMatch = codePart.match(/^\s*([^;=\s][^=]*?)\s*=/);
    if (kvMatch) {
        const key = kvMatch[1].trim();

        // Ares 的 "+" 键允许重复，不做检查
        if (key === '+') {
            return [];
        }

        // 检查重复
        if (seenRegistryKeys.has(key)) {
            const keyIndex = codePart.indexOf(key);
            const range = new vscode.Range(lineNumber, keyIndex, lineNumber, keyIndex + key.length);
            
            return [new IniDiagnostic(
                range,
                localize('checks.registryOverrideReview', "Registry key '{0}' replaces an earlier entry in this section. Review the effective registration.", key),
                vscode.DiagnosticSeverity.Error,
                ErrorCode.LOGIC_DUPLICATE_REGISTRY_KEY
            )];
        }

        // 6. 记录该键
        seenRegistryKeys.add(key);
    }

    return [];
};

const checkRegistryDefinition: ValidationRule = (context: RuleContext): IniDiagnostic[] => {
    const { project, schemaManager, currentSection, document, lineNumber } = context;
    const registry = currentSection.name;
    if (!project || !registry || !schemaManager.getIdListRegistryNames().has(registry) || !project.context(document.uri).complete) { return []; }
    const property = /^\s*([^=;]+)\s*=\s*([^;]+)/.exec(context.codePart);
    if (!property) { return []; }
    const key = property[1].trim(), value = property[2].trim();
    if (!value || /^(none|<none>)$/i.test(value)) { return []; }
    const effective = project.effective(document.uri, registry, project.category(document.uri));
    const winner = effective.get(key.toLowerCase());
    if (key !== '+' && (winner?.uri.toString() !== document.uri.toString() || winner.line !== lineNumber)) { return []; }
    const previous = [...effective.values()].filter(item => item.value.toLowerCase() === value.toLowerCase() && item.key !== key && item.key !== '+');
    const result: IniDiagnostic[] = [];
    if (key !== '+' && previous.length) {
        const item = new IniDiagnostic(context.line.range, localize('checks.duplicateRegisteredValue', '[{0}] is registered more than once in [{1}]. Review whether the duplicate is intentional.', value, registry), vscode.DiagnosticSeverity.Information, ErrorCode.LOGIC_DUPLICATE_REGISTRY_VALUE);
        item.relatedInformation = previous.slice(0, 8).map(entry => new vscode.DiagnosticRelatedInformation(new vscode.Location(entry.uri, new vscode.Position(entry.line, 0)), localize('checks.otherRegistration', 'Other registration')));
        result.push(item);
    }
    const checkExist = schemaManager.getProperty(registry, 'CheckExist')?.type;
    const expected = schemaManager.getTypeForRegistry(registry)!;
    if (!/^(no|false|0)$/i.test(checkExist ?? '') && !project.sources(document.uri, value, expected === 'AnimType' || expected === 'VoxelAnimType' ? 'art' : 'rules').length) {
        result.push(new IniDiagnostic(context.line.range, localize('checks.registeredMissing', '[{0}] is registered in [{1}], but has no definition in the current loading context.', value, registry), vscode.DiagnosticSeverity.Warning, ErrorCode.LOGIC_MISSING_REGISTERED_SECTION));
    }
    return result;
};

export const logicRules: ValidationRule[] = [
    checkUnregisteredSection,
    checkEmptyValue,
    checkDuplicateRegistryKey,
    checkRegistryDefinition,
];
