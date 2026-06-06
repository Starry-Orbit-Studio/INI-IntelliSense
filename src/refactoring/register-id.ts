import * as vscode from 'vscode';
import { INIManager } from '../parser';
import { SchemaManager } from '../schema-manager';
import { localize } from '../i18n';

/**
 * 注册 "注册节 ID 到..." 的上下文菜单命令。
 */
export function registerRegisterIdCommand(iniManager: INIManager, schemaManager: SchemaManager) {
    vscode.commands.registerCommand('ra2-ini-intellisense.registerSectionContext', async (contextUri?: vscode.Uri, contextPosition?: vscode.Position) => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {return;}

        const position = contextPosition || editor.selection.active;
        const sectionName = iniManager.getSectionNameAtLine(editor.document.uri, position.line);

        if (!sectionName) {
            vscode.window.showWarningMessage(localize('register.error.noSection', 'Could not find a section at the current cursor position.'));
            return;
        }

        const possibleRegistries = Array.from(schemaManager.getIdListRegistryNames());
        if (possibleRegistries.length === 0) {
            vscode.window.showErrorMessage(localize('register.error.noRegistries', 'No ID list registries found in the schema file.'));
            return;
        }

        const selectedRegistry = await vscode.window.showQuickPick(possibleRegistries, {
            title: localize('register.quickPick.title', 'Select a registry to add "[{0}]" to', sectionName),
        });

        if (!selectedRegistry) {
            return;
        }

        const registryLocation = iniManager.findSectionLocations(selectedRegistry)[0];
        if (!registryLocation) {
            vscode.window.showErrorMessage(localize('codeaction.registerSection.error.registryNotFound', 'Cannot find the registry section "[{0}]" in the workspace.', selectedRegistry));
            return;
        }

        const registryDoc = await vscode.workspace.openTextDocument(registryLocation.uri);
        const registryContent = registryDoc.getText();
        const sectionRange = iniManager.findSectionRange(registryContent, selectedRegistry);
        if (!sectionRange) {return;}

        const lines = registryContent.substring(registryDoc.offsetAt(sectionRange.start), registryDoc.offsetAt(sectionRange.end)).split(/\r?\n/);
        let maxIndex = -1;
        for (const line of lines) {
            const match = line.trim().match(/^(\d+)\s*=/);
            if (match) {
                const index = parseInt(match[1], 10);
                if (index > maxIndex) {
                    maxIndex = index;
                }
            }
        }
        
        const newIndex = maxIndex + 1;
        const textToInsert = `\n${newIndex}=${sectionName}`;
        
        const edit = new vscode.WorkspaceEdit();
        const lastLineOfSection = registryDoc.lineAt(sectionRange.end.line);
        edit.insert(registryLocation.uri, lastLineOfSection.range.end, textToInsert);
        
        await vscode.workspace.applyEdit(edit);
        vscode.window.showInformationMessage(localize('codeaction.registerSection.success', 'Successfully registered "[{0}]" in "[{1}]" with index {2}.', sectionName, selectedRegistry, newIndex));
    });
}
