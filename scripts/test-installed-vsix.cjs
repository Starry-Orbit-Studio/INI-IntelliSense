const assert = require('node:assert/strict');
const { mkdirSync, writeFileSync, existsSync, readdirSync } = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// A separate driver prevents --extensionDevelopmentPath from shadowing the VSIX.
const root = path.resolve(__dirname, '..');
const vsix = path.resolve(process.argv[2] || 'ra2-ini-intellisense-0.0.6.vsix');
assert.ok(existsSync(vsix), 'Pass the production VSIX to test');
const code = process.env.RA2_WORKBENCH_TEST_CODE;
assert.ok(code && existsSync(code), 'Set RA2_WORKBENCH_TEST_CODE to the Code.exe being tested');
const profile = process.env.RA2_WORKBENCH_TEST_USER_DATA || path.join(root, 'out', 'vsix-profile');
const extensions = path.join(root, 'out', 'vsix-extensions');
const installationRoot = path.dirname(code);
const cli = [
    installationRoot,
    ...readdirSync(installationRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(installationRoot, entry.name)),
]
    .map((directory) => path.join(directory, 'resources', 'app', 'out', 'cli.js'))
    .find(existsSync);
assert.ok(cli, 'The VS Code installation must contain its CLI entry point');
// test-cli installs to its default directory even with custom launch arguments.
// Install explicitly into the same isolated directory used by the test host.
const installation = spawnSync(
    code,
    [cli, '--user-data-dir=' + profile, '--extensions-dir=' + extensions, '--install-extension', vsix, '--force'],
    { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
);
if (installation.error) {
    throw installation.error;
}
assert.equal(installation.status, 0, 'VSIX installation must succeed before acceptance tests');
const driver = path.join(root, 'out', 'installed-vsix-driver');
mkdirSync(driver, { recursive: true });
writeFileSync(
    path.join(driver, 'package.json'),
    JSON.stringify({
        name: 'ra2-vsix-test-driver',
        publisher: 'local',
        version: '1.0.0',
        engines: { vscode: '^1.96.0' },
        main: './index.cjs',
        activationEvents: [],
    })
);
writeFileSync(path.join(driver, 'index.cjs'), 'exports.activate = () => {};\n');
const result = spawnSync(process.execPath, [path.join(root, 'node_modules/@vscode/test-cli/out/bin.mjs')], {
    cwd: root,
    stdio: 'inherit',
    env: {
        ...process.env,
        RA2_WORKBENCH_TEST_DRIVER: driver,
        RA2_WORKBENCH_TEST_VSIX: vsix,
        RA2_WORKBENCH_TEST_USER_DATA: profile,
        RA2_WORKBENCH_TEST_EXTENSIONS: extensions,
        RA2_WORKBENCH_TEST_PATTERN: process.env.RA2_WORKBENCH_TEST_PATTERN || 'out/test/**/*.test.js',
    },
});
if (result.error) {
    throw result.error;
}
process.exitCode = result.status ?? 1;
