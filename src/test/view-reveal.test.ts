import * as assert from 'assert';
import * as vscode from 'vscode';
import { openContributedView } from '../context/view-reveal';

suite('Asset workbench view opening', () => {
    const view = 'ra2-object-inspector';
    const container = 'ra2-media-workbench';
    function fixture(available: string[]) {
        const calls: { id: string; args: unknown[] }[] = [];
        const commands: Pick<typeof vscode.commands, 'getCommands' | 'executeCommand'> = {
            getCommands: async () => available,
            executeCommand: async <T>(id: string, ...args: unknown[]) => {
                calls.push({ id, args });
                return undefined as T;
            },
        };
        return { commands, calls };
    }

    test('uses the view focus action and preserves editor focus for automatic reveal', async () => {
        const { commands, calls } = fixture([view + '.focus']);
        await openContributedView(commands, view, container, true);
        assert.deepStrictEqual(calls, [{ id: view + '.focus', args: [{ preserveFocus: true }] }]);
    });

    test('uses the view open action when its focus action is missing', async () => {
        const { commands, calls } = fixture([view + '.open']);
        await openContributedView(commands, view, container, false);
        assert.deepStrictEqual(calls, [{ id: view + '.open', args: [] }]);
    });

    test('falls back to the container and restores editor focus after an extension update', async () => {
        const id = 'workbench.view.extension.' + container;
        const { commands, calls } = fixture([id]);
        await openContributedView(commands, view, container, true);
        assert.deepStrictEqual(
            calls.map((call) => call.id),
            [id, 'workbench.action.focusActiveEditorGroup']
        );
    });

    test('reports an incomplete extension update instead of invoking a nonexistent command', async () => {
        const { commands, calls } = fixture([]);
        await assert.rejects(openContributedView(commands, view, container, false), /VS Code/);
        assert.strictEqual(calls.length, 0);
    });
});
