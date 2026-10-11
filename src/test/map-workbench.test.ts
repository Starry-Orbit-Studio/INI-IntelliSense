import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import { spawn } from 'child_process';
import { access } from 'fs/promises';
import { inspectMap } from '../context/map-inspection';
import { renderMap, MapRendererOptions } from '../context/map-renderer';
import { encodePng } from '../media/png';

suite('Map inspection and renderer protocol', () => {
    test('maps without embedded pictures still expose editable source sections and metadata', async () => {
        const document = await vscode.workspace.openTextDocument({
            content: '[Map]\nTheater=SNOW\nSize=0,0,80,80\n[Waypoints]\n0=10010',
        });
        const session = inspectMap(document, new vscode.Position(0, 0));
        assert.strictEqual(session.inspection.map?.preview, undefined);
        assert.ok(
            session.inspection.map?.details.some((value) => value.key === 'Map.Theater' && value.value === 'SNOW')
        );
        const waypoint = session.inspection.map!.sections.find((section) => section.name === 'Waypoints')!;
        assert.strictEqual(session.links.get(waypoint.id)?.range.start.line, 3);
    });
    const options: MapRendererOptions = {
        executable: process.execPath,
        mixDirectory: path.dirname(process.execPath),
        modDirectories: ['C:/mod/Rules'],
        rulesFiles: ['ruleses.ini'],
        artFiles: ['artes.ini'],
        extraMixes: [],
    };
    test('worker uses an unsaved snapshot, preserves resource options and removes owned temporary files', async () => {
        const png = Buffer.from(encodePng(1, 1, new Uint8Array([255, 0, 0, 255]))).toString('base64');
        let temporary = '';
        const launch = ((file: string, args: string[], launchOptions: object) => {
            assert.deepStrictEqual(args, ['--worker']);
            assert.strictEqual(file, options.executable);
            assert.strictEqual((launchOptions as { shell: boolean }).shell, false);
            const script = `const fs=require('fs'); console.log(JSON.stringify({type:'ready'}));
                process.stdin.once('data', data => { const r=JSON.parse(data).Request;
                if(!fs.readFileSync(r.MapPath,'utf8').includes('Unsaved=true') || r.CustomRulesIniFiles[0]!=='ruleses.ini') process.exit(4);
                console.log(JSON.stringify({type:'progress',message:r.MapPath}));
                fs.writeFileSync(r.OutputPngPath,Buffer.from('${png}','base64'));
                console.log(JSON.stringify({type:'complete',ok:true})); });`;
            return spawn(process.execPath, ['-e', script], {
                env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
                windowsHide: true,
            });
        }) as typeof spawn;
        const cancellation = new vscode.CancellationTokenSource();
        try {
            const result = await renderMap(
                '[Map]\nUnsaved=true',
                options,
                cancellation.token,
                (message) => {
                    temporary = message;
                },
                launch
            );
            assert.deepStrictEqual(Buffer.from(result).toString('base64'), png);
            assert.ok(temporary);
            await assert.rejects(() => access(temporary));
        } finally {
            cancellation.dispose();
        }
    });
    test('cancellation kills the owned worker and rejects without waiting for its completion', async () => {
        const cancellation = new vscode.CancellationTokenSource();
        let child: ReturnType<typeof spawn> | undefined;
        const launch = (() => {
            child = spawn(
                process.execPath,
                ['-e', "console.log(JSON.stringify({type:'ready'})); setInterval(()=>{},1000)"],
                { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true }
            );
            setTimeout(() => cancellation.cancel(), 100);
            return child;
        }) as typeof spawn;
        try {
            await assert.rejects(
                () => renderMap('[Map]', options, cancellation.token, () => undefined, launch),
                vscode.CancellationError
            );
            assert.strictEqual(child?.killed, true);
        } finally {
            cancellation.dispose();
            child?.kill();
        }
    });
});
