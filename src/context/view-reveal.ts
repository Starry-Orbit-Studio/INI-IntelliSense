import * as vscode from 'vscode';
import { localize } from '../i18n';

/** Open a contributed view even while its generated focus action is unavailable. */
export async function openContributedView(
    commands: Pick<typeof vscode.commands, 'getCommands' | 'executeCommand'>,
    viewId: string,
    containerId: string,
    preserveFocus: boolean
): Promise<void> {
    const available = new Set(await commands.getCommands(true));
    const focus = viewId + '.focus';
    if (available.has(focus)) {
        await commands.executeCommand(focus, { preserveFocus });
        return;
    }
    // Extension updates can leave generated view actions unregistered until reload.
    const open = [viewId + '.open', 'workbench.view.extension.' + containerId].find((id) => available.has(id));
    if (!open) {
        throw new Error(
            localize(
                'workbench.viewNotRegistered',
                'VS Code has not registered the asset workbench after the extension update. Reload the window to finish loading it.'
            )
        );
    }
    await commands.executeCommand(open);
    if (preserveFocus) {
        await commands.executeCommand('workbench.action.focusActiveEditorGroup');
    }
}
