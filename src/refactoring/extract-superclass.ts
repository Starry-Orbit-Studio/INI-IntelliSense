import * as vscode from 'vscode';
import { INIManager } from '../parser';
import { localize } from '../i18n';

/**
 * 注册并实现 "提取超类" 的重构命令。
 */
export function registerExtractSuperclassCommand(iniManager: INIManager) {
    vscode.commands.registerCommand('ra2-ini-intellisense.refactor.extractSuperclass', async (contextUri?: vscode.Uri, contextPosition?: vscode.Position) => {
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor || activeEditor.document.languageId !== 'ra2-ini') {
            vscode.window.showWarningMessage(localize('refactor.error.noIniFile', 'Please open an INI file to use this refactoring command.'));
            return;
        }

        // 尝试从上下文获取当前节，用于预选
        let preselectedSection: string | undefined;
        const currentUri = contextUri || activeEditor.document.uri;
        const currentPosition = contextPosition || activeEditor.selection.active;
        preselectedSection = iniManager.getSectionNameAtLine(currentUri, currentPosition.line) || undefined;
        
        const allSections = Array.from(iniManager.getAllSectionNames());
        
        // 1. 让用户选择要重构的节
        const selectedSections = await vscode.window.showQuickPick(
            allSections.map(s => ({ 
                label: s,
                picked: s === preselectedSection
            })), {
            canPickMany: true,
            title: localize('refactor.extract.selectSections.title', 'Select sections to extract a superclass from'),
            placeHolder: localize('refactor.extract.selectSections.placeholder', 'Choose at least two sections'),
        });

        if (!selectedSections || selectedSections.length < 2) {
            return;
        }
        const selectedSectionNames = selectedSections.map(item => item.label);

        // 2. 查找共同的键值对
        const commonProperties = findCommonProperties(selectedSectionNames, iniManager);

        if (commonProperties.size === 0) {
            vscode.window.showInformationMessage(localize('refactor.extract.noCommonProperties', 'No common properties with identical values found among the selected sections.'));
            return;
        }

        // 3. 让用户选择要提取的属性
        const propertiesToExtract = await vscode.window.showQuickPick(Array.from(commonProperties.keys()), {
            canPickMany: true,
            title: localize('refactor.extract.selectProperties.title', 'Select properties to extract'),
            placeHolder: localize('refactor.extract.selectProperties.placeholder', 'Choose properties to move to the new superclass'),
        });

        if (!propertiesToExtract || propertiesToExtract.length === 0) {
            return;
        }

        // 4. 让用户输入新超类的名称
        const newSuperclassName = await vscode.window.showInputBox({
            prompt: localize('refactor.extract.newClassName.prompt', 'Enter the name for the new superclass'),
            placeHolder: 'e.g., BaseVehicle',
            validateInput: text => {
                return text.match(/^[a-zA-Z0-9_]+$/) ? null : localize('refactor.extract.newClassName.validation', 'Invalid name. Use letters, numbers, and underscores only.');
            }
        });

        if (!newSuperclassName) {
            return;
        }

        // 5. 执行重构
        const edit = new vscode.WorkspaceEdit();

        // 5.1 创建新超类
        let newClassContent = `[${newSuperclassName}]\n`;
        for (const key of propertiesToExtract) {
            newClassContent += `${key}=${commonProperties.get(key)}\n`;
        }
        newClassContent += '\n';
        // 将新类插入到当前文件的顶部
        edit.insert(activeEditor.document.uri, new vscode.Position(0, 0), newClassContent);


        // 5.2 修改子类
        for (const sectionName of selectedSectionNames) {
            const locations = iniManager.findSectionLocations(sectionName);
            for (const location of locations) {
                const doc = await vscode.workspace.openTextDocument(location.uri);
                
                // 修改节定义以添加继承
                const sectionLine = doc.lineAt(location.range.start.line);
                const oldHeader = sectionLine.text;
                // 简单处理，直接替换。更复杂的场景（已存在父类）可以后续扩展。
                const newHeader = `[${sectionName}]:[${newSuperclassName}]`;
                edit.replace(location.uri, sectionLine.range, newHeader);

                // 删除已提取的属性
                const sectionData = iniManager.getSectionData(sectionName);
                if (sectionData) {
                    for (const key of propertiesToExtract) {
                        const keyLocation = iniManager.findKeyLocation(sectionName, key);
                        if (keyLocation && keyLocation.location.uri.toString() === location.uri.toString()) {
                            // 删除整行
                            const lineRange = doc.lineAt(keyLocation.location.range.start.line).rangeIncludingLineBreak;
                            edit.delete(location.uri, lineRange);
                        }
                    }
                }
            }
        }

        await vscode.workspace.applyEdit(edit);
        vscode.window.showInformationMessage(localize('refactor.extract.success', 'Successfully extracted superclass "[{0}]".', newSuperclassName));
    });
}

function findCommonProperties(sections: string[], iniManager: INIManager): Map<string, string> {
    if (sections.length < 2) {
        return new Map();
    }

    const firstSectionData = iniManager.getSectionData(sections[0]);
    if (!firstSectionData) {
        return new Map();
    }

    const common = new Map<string, string>();
    for (const [key, value] of Object.entries(firstSectionData)) {
        if (typeof value === 'string') {
            let isCommon = true;
            for (let i = 1; i < sections.length; i++) {
                const otherSectionData = iniManager.getSectionData(sections[i]);
                if (!otherSectionData || otherSectionData[key] !== value) {
                    isCommon = false;
                    break;
                }
            }
            if (isCommon) {
                common.set(key, value);
            }
        }
    }
    return common;
}
