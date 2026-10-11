import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { mkdtemp, writeFile, readFile, stat, rm } from 'fs/promises';
import { spawn } from 'child_process';
import { localize } from '../i18n';

export interface MapRendererOptions {
    executable: string;
    mixDirectory: string;
    modDirectories: string[];
    rulesFiles: string[];
    artFiles: string[];
    extraMixes: string[];
}

/** CNCMaps JSON worker protocol used by ra2rmg-rs; never invokes a shell. */
export async function renderMap(
    text: string,
    options: MapRendererOptions,
    token: vscode.CancellationToken,
    progress: (message: string) => void,
    spawnWorker: typeof spawn = spawn
): Promise<Uint8Array> {
    if (!path.isAbsolute(options.executable) || !path.isAbsolute(options.mixDirectory)) {
        throw new Error(
            localize(
                'workbench.mapRendererConfiguration',
                'Configure an absolute map renderer executable and game MIX directory first.'
            )
        );
    }
    if (token.isCancellationRequested) {
        throw new vscode.CancellationError();
    }
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ra2-map-render-'));
    const map = path.join(directory, 'preview.map'),
        output = path.join(directory, 'preview.png');
    try {
        await writeFile(map, '\uFEFF' + text, 'utf8');
        await new Promise<void>((resolve, reject) => {
            const child = spawnWorker(options.executable, ['--worker'], {
                cwd: path.dirname(options.executable),
                windowsHide: true,
                shell: false,
            });
            let finished = false,
                ready = false,
                buffer = '',
                stderr = '';
            let cancellation: vscode.Disposable | undefined;
            const finish = (error?: Error) => {
                if (finished) {
                    return;
                }
                finished = true;
                clearTimeout(timeout);
                cancellation?.dispose();
                child.stdin.destroy();
                child.kill();
                error ? reject(error) : resolve();
            };
            const timeout = setTimeout(
                () =>
                    finish(
                        new Error(
                            localize('workbench.mapRendererTimeout', 'Map rendering exceeded the two-minute limit.')
                        )
                    ),
                120000
            );
            cancellation = token.onCancellationRequested(() => finish(new vscode.CancellationError()));
            child.on('error', finish);
            child.stdin.on('error', finish);
            child.stderr.setEncoding('utf8');
            child.stderr.on('data', (chunk: string) => {
                stderr = (stderr + chunk).slice(-8192);
            });
            child.on('exit', (code) =>
                finish(
                    new Error(
                        localize(
                            'workbench.mapRendererExited',
                            'Map renderer exited before completion ({0}): {1}',
                            String(code),
                            stderr
                        )
                    )
                )
            );
            child.stdout.setEncoding('utf8');
            child.stdout.on('data', (chunk: string) => {
                if (finished) {
                    return;
                }
                buffer += chunk;
                if (buffer.length > 1024 * 1024) {
                    finish(new Error(localize('workbench.mapRendererProtocol', 'Invalid map renderer response.')));
                    return;
                }
                let end: number;
                while ((end = buffer.indexOf('\n')) >= 0 && !finished) {
                    const line = buffer.slice(0, end).trim();
                    buffer = buffer.slice(end + 1);
                    if (!line) {
                        continue;
                    }
                    try {
                        const event = JSON.parse(line) as Record<string, unknown>;
                        if (!ready && event.type === 'ready') {
                            ready = true;
                            child.stdin.write(
                                JSON.stringify({
                                    Command: 'render',
                                    Request: {
                                        MapPath: map,
                                        MixDir: options.mixDirectory,
                                        ModDirectoryPaths: options.modDirectories,
                                        CustomRulesIniFiles: options.rulesFiles,
                                        CustomArtIniFiles: options.artFiles,
                                        ExtraMixes: options.extraMixes,
                                        OutputPngPath: output,
                                        PreviewImagePath: path.join(directory, 'progress.jpg'),
                                        SavePng: true,
                                        ForceYrEngine: true,
                                        ForceFullMap: true,
                                        IgnoreLighting: false,
                                        PngCompressionLevel: 6,
                                        PreviewWidth: 960,
                                        PreviewHeight: 540,
                                        PreviewMinIntervalMs: 250,
                                        PreviewRowStride: 4,
                                        PreviewJpegQuality: 72,
                                    },
                                }) + '\n'
                            );
                        } else if (ready && (event.type === 'progress' || event.type === 'preview')) {
                            if (typeof event.message === 'string') {
                                progress(event.message.slice(0, 300));
                            }
                        } else if (ready && event.type === 'complete' && event.ok !== false) {
                            finish();
                        } else {
                            finish(
                                new Error(
                                    localize(
                                        'workbench.mapRendererFailed',
                                        'Map rendering failed: {0}',
                                        String(
                                            event.error_details ?? event.details ?? event.message ?? event.type
                                        ).slice(0, 2000)
                                    )
                                )
                            );
                        }
                    } catch (error) {
                        finish(error instanceof Error ? error : new Error(String(error)));
                    }
                }
            });
            if (token.isCancellationRequested) {
                finish(new vscode.CancellationError());
            }
        });
        if (token.isCancellationRequested) {
            throw new vscode.CancellationError();
        }
        const metadata = await stat(output);
        if (metadata.size > 64 * 1024 * 1024) {
            throw new Error(localize('workbench.mapImageLimit', 'Rendered map exceeds the 64 MiB image limit.'));
        }
        const bytes = await readFile(output);
        if (
            bytes.length < 24 ||
            bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
            bytes.readUInt32BE(16) * bytes.readUInt32BE(20) > 64 * 1024 * 1024
        ) {
            throw new Error(localize('workbench.mapImageLimit', 'Rendered map exceeds the 64 MiB image limit.'));
        }
        return bytes;
    } finally {
        // The owned directory comes directly from mkdtemp; never remove a user path.
        if (path.dirname(directory) === os.tmpdir() && path.basename(directory).startsWith('ra2-map-render-')) {
            await rm(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
        }
    }
}
