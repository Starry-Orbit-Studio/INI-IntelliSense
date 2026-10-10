import { defineConfig } from '@vscode/test-cli';
import { pathToFileURL } from 'node:url';

export default defineConfig({
    files: process.env.RA2_WORKBENCH_TEST_PATTERN ?? 'out/test/**/*.test.js',
    version: process.env.VSCODE_TEST_VERSION ?? 'stable',
    launchArgs: [
        '--disable-workspace-trust',
        ...(process.env.RA2_WORKBENCH_UI_PORT
            ? ['--remote-debugging-port=' + Number(process.env.RA2_WORKBENCH_UI_PORT)]
            : []),
        ...(process.env.RA2_WORKBENCH_WORKSPACE
            ? ['--folder-uri=' + pathToFileURL(process.env.RA2_WORKBENCH_WORKSPACE).href]
            : []),
    ],
});
