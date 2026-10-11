/* Standalone Webview contract tests. Build and compile-tests before running. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const { shpFixture } = require('../out/test/media-fixtures');
const { readShp } = require('../out/media/shp');
const { encodeWav } = require('../out/media/audio');
const { GAME_NORMALS } = require('../out/media/voxel-normals');
const { voxelCamera } = require('../out/media/voxel-camera');

const root = path.resolve(__dirname, '..');
const labels = {};
const translations = JSON.parse(fs.readFileSync(path.join(root, 'i18n/bundle.nls.json'), 'utf8'));
for (const [key, value] of Object.entries(translations)) {
    if (key.startsWith('workbench.')) labels[key.slice(10)] = value;
}
const palette = Array.from({ length: 256 * 3 }, (_, i) => Math.floor(i / 3));
const bytes = shpFixture();
const sprite = {
    kind: 'sprite',
    name: 'sample.shp',
    bytes: Buffer.from(bytes).toString('base64'),
    file: readShp(bytes),
    palette,
    actions: [
        {
            id: 'walk',
            action: { name: 'Walk', start: 0, count: 1, stride: 0, extra: ['2'], raw: '0,1,0,2' },
            users: 2,
            valid: true,
        },
    ],
    shadow: false,
};
const model = { remapStart: 16, remapEnd: 31, parts: [] };
for (const [name, role, size, bounds, color, offset] of [
    ['MAIN', 'body', [20, 12, 5], [-10, -6, 0, 10, 6, 5], 90, [0, 0, 0]],
    ['TURRET', 'turret', [8, 8, 4], [-4, -4, 5, 4, 4, 9], 120, [0, 0, 0]],
    ['BARREL', 'barrel', [12, 2, 2], [0, -1, 7, 12, 1, 9], 20, [0, 0, 0]],
]) {
    const voxels = [];
    for (let z = 0; z < size[2]; z++)
        for (let y = 0; y < size[1]; y++)
            for (let x = 0; x < size[0]; x++) voxels.push(x, y, z, color + ((x + y) % 3), 1);
    model.parts.push({
        name,
        role,
        size,
        bounds,
        color,
        offset,
        scale: 1 / 12,
        matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0],
        normalsMode: 4,
        voxels,
    });
}
const voxel = {
    kind: 'voxel',
    name: 'tank.vxl',
    model,
    palette,
    vpl: Array.from({ length: 8192 }, (_, i) => i % 256),
    normals: GAME_NORMALS.flatMap((n) => [n.x, n.y, n.z]),
    light: [0.4, -0.8, 0.6],
    fixed: false,
    points: [{ id: 'flh', name: 'PrimaryFireFLH', value: [100, 0, 64] }],
};
const inspection = (id, media) => ({
    id,
    owner: 'TestUnit',
    type: 'UnitType',
    focus: media.name,
    properties: [
        { key: 'Image', value: 'body', inherited: false, source: { id: 'src', label: 'art.ini:3' } },
        { key: 'Strength', value: '100', inherited: true, source: { id: 'base', label: 'rules.ini:2' } },
    ],
    sources: [{ id: 'src', label: 'art.ini:3' }],
    references: [{ id: 'ref', label: 'Weapon → TestUnit' }],
    assets: [
        { id: 'asset-1', name: media.name, source: 'expand.mix', priority: 500 },
        { id: 'asset-2', name: media.name, source: 'local/', priority: 0 },
    ],
    paletteOptions: [{ id: 'pal', name: 'unittem.pal', source: 'local/', priority: 0 }],
    selectedAsset: 'asset-2',
    warnings: [],
    media,
    mediaRevision: 1,
    lightEdit: 'light',
});

async function main() {
    const errors = [];
    const server = http.createServer((request, response) => {
        if (request.url === '/') {
            response.setHeader('Content-Type', 'text/html');
            response.end(
                "<!doctype html><html><head><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'nonce-test'; style-src 'self' 'nonce-test'; worker-src blob:; connect-src 'self'; img-src data:; media-src blob:\">" +
                    '<style nonce="test">:root{--vscode-foreground:#dbe3ed;--vscode-sideBar-background:#191e26;--vscode-editor-background:#141921;--vscode-font-size:13px;--vscode-font-family:system-ui;--vscode-input-background:#252d39;--vscode-input-foreground:#dbe3ed;--vscode-button-background:#3467bc;--vscode-button-foreground:white;--vscode-button-secondaryBackground:#2a3444;--vscode-button-secondaryForeground:#dbe3ed;--vscode-descriptionForeground:#9aabc0;--vscode-panel-border:#364155;--vscode-focusBorder:#7cb7ff;--vscode-textLink-foreground:#81baff}</style>' +
                    '<link rel="stylesheet" href="/dist/workbench/main.css"></head><body><main id="app"></main><script nonce="test" src="/dist/workbench/main.js" data-worker="/dist/workbench/worker.js"></script></body></html>'
            );
            return;
        }
        const file = path.resolve(root, '.' + decodeURIComponent(request.url.split('?')[0]));
        if (!file.startsWith(root + path.sep) || !file.includes(path.sep + 'dist' + path.sep)) {
            response.writeHead(404);
            response.end();
            return;
        }
        response.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : 'text/javascript');
        fs.createReadStream(file)
            .on('error', () => {
                response.writeHead(404);
                response.end();
            })
            .pipe(response);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    let browser;
    try {
        browser = await chromium.launch({
            headless: true,
            channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
            args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
        });
        const page = await browser.newPage({ viewport: { width: 720, height: 1000 } });
        await page.addInitScript(() => {
            window.messages = [];
            window.persisted = undefined;
            window.acquireVsCodeApi = () => ({
                postMessage: (message) => window.messages.push(message),
                getState: () => window.persisted,
                setState: (value) => (window.persisted = value),
            });
        });
        page.on('pageerror', (error) => errors.push(error.message));
        page.on('console', (msg) => {
            if (msg.type() === 'error') errors.push(msg.text());
        });
        await page.goto('http://127.0.0.1:' + server.address().port);
        await page.waitForFunction(() => window.messages.some((message) => message.type === 'ready'));
        const send = async (value) => {
            await page.evaluate((state) => window.postMessage(state, '*'), {
                type: 'state',
                labels,
                loading: false,
                pinned: false,
                inspection: value,
            });
            await page.waitForFunction(
                (id) =>
                    document.getElementById('app')?.dataset.inspection === id &&
                    document.querySelector('.sprite-canvas,.voxel-canvas,audio'),
                value.id
            );
        };
        await send(inspection('sprite', sprite));
        await page.waitForFunction(() => {
            const c = document.querySelector('.sprite-canvas');
            return c?.getContext('2d').getImageData(0, 0, 2, 2).data[3] === 255;
        });
        assert.equal(
            await page.locator('.asset-choice[aria-pressed="true"] .hint').textContent(),
            'local/',
            'duplicate names must retain selected source'
        );
        assert.equal(await page.locator('.asset-choice').count(), 2, 'all candidates must be visible');
        await page.getByRole('button', { name: 'Contact sheet', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('.contact-thumbnail')?.width === 2);
        await page
            .getByRole('combobox')
            .filter({ has: page.locator('option[value="-1"]') })
            .selectOption('0');
        await page.getByRole('button', { name: 'Apply to INI', exact: true }).click();
        assert.ok(
            await page.evaluate(() =>
                window.messages.some((m) => m.type === 'edit' && m.id === 'walk' && m.values.join(',') === '0,1,0')
            )
        );
        assert.equal(
            await page.locator('input[type="range"]').getAttribute('max'),
            '0',
            'action timeline uses clip length'
        );
        assert.equal(await page.locator('.direction-grid button').count(), 8);
        await page.getByRole('button', { name: 'Contact sheet', exact: true }).click();
        await page.getByRole('button', { name: 'Contact sheet', exact: true }).click();
        await page.waitForFunction(() => document.querySelectorAll('.contacts .contact-thumbnail').length === 8);
        await page.locator('.contacts button').filter({ hasText: '90°' }).click();
        await page.waitForFunction(() => document.querySelector('.direction-select')?.value === '2');
        await page.getByRole('button', { name: 'Keep for comparison', exact: true }).click();
        assert.equal(await page.locator('#comparison canvas').count(), 1);
        await page.getByRole('button', { name: 'Attributes', exact: true }).click();
        assert.equal(await page.locator('table tr').count(), 2);
        await page.getByRole('button', { name: 'Preview', exact: true }).click();
        await page.getByRole('button', { name: 'Export PNG', exact: true }).click();
        assert.ok(
            await page.evaluate(() => window.messages.some((m) => m.type === 'export' && m.width === 2 && m.pixels))
        );
        await send(inspection('voxel', voxel));
        assert.equal(
            await page.getByRole('button', { name: 'Play / Pause', exact: true }).count(),
            0,
            'static VXL must hide HVA playback'
        );
        await page.waitForFunction(() => {
            const c = document.querySelector('.voxel-canvas');
            const g = c?.getContext('webgl2');
            if (!g) return false;
            const p = new Uint8Array(c.width * c.height * 4);
            g.readPixels(0, 0, c.width, c.height, g.RGBA, g.UNSIGNED_BYTE, p);
            return p.some((v, i) => i % 4 === 3 && v > 0);
        });
        const gameWidth = await page.locator('.voxel-canvas').evaluate((canvas) => {
            const gl = canvas.getContext('webgl2');
            const pixels = new Uint8Array(canvas.width * canvas.height * 4);
            gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
            let left = canvas.width,
                right = 0;
            for (let y = 0; y < canvas.height; y++)
                for (let x = 0; x < canvas.width; x++) {
                    if (pixels[(y * canvas.width + x) * 4 + 3]) {
                        left = Math.min(left, x);
                        right = Math.max(right, x);
                    }
                }
            return right - left + 1;
        });
        assert.ok(
            gameWidth >= 10 && gameWidth <= 40,
            'game view must preserve model pixel scale instead of filling the viewport'
        );
        await page.locator('.firing-points summary').click();
        assert.equal(await page.locator('.viewport .firing-points').count(), 1, 'FLH editor belongs in the viewport');
        await page
            .getByRole('combobox')
            .filter({ has: page.locator('option[value="PrimaryFireFLH"]') })
            .selectOption('PrimaryFireFLH');
        await page.getByLabel(labels.showPoints, { exact: true }).uncheck();
        assert.ok(
            await page.locator('.voxel-overlay').evaluate((canvas) => {
                const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
                return !pixels.some(
                    (value, index) =>
                        index % 4 === 0 && value === 114 && pixels[index + 1] === 185 && pixels[index + 2] === 255
                );
            }),
            'FLH visibility toggle must hide edit axes'
        );
        await page.getByLabel(labels.showPoints, { exact: true }).check();
        await page.locator('.voxel-overlay').first().scrollIntoViewIfNeeded();
        const handle = await page
            .locator('.voxel-overlay')
            .first()
            .evaluate((canvas) => {
                const rgba = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
                const rect = canvas.getBoundingClientRect();
                for (let y = 0; y < canvas.height; y++)
                    for (let x = 0; x < canvas.width; x++) {
                        const i = (y * canvas.width + x) * 4;
                        if (rgba[i] === 114 && rgba[i + 1] === 185 && rgba[i + 2] === 255 && rgba[i + 3] > 200) {
                            return {
                                x: rect.left + (x * rect.width) / canvas.width,
                                y: rect.top + (y * rect.height) / canvas.height,
                            };
                        }
                    }
            });
        assert.ok(handle, 'FLH axis must be visible');
        await page.mouse.move(handle.x, handle.y);
        await page.mouse.down();
        await page.mouse.move(handle.x, handle.y - 16, { steps: 5 });
        await page.mouse.up();
        assert.ok(
            await page.evaluate(() =>
                window.messages.some(
                    (m) =>
                        m.type === 'edit' &&
                        m.id === 'flh' &&
                        m.values.some((value, index) => value !== [100, 0, 64][index]) &&
                        m.values.every(Number.isInteger)
                )
            ),
            'FLH drag must send new integer coordinates'
        );
        const latestPoint = await page.evaluate(
            () => window.messages.filter((m) => m.type === 'edit' && m.id === 'flh').at(-1).values
        );
        const bounds = await page
            .locator('.voxel-overlay')
            .first()
            .evaluate((canvas) => ({
                width: canvas.width,
                height: canvas.height,
                rect: JSON.parse(JSON.stringify(canvas.getBoundingClientRect())),
            }));
        const pointCamera = voxelCamera(
            { mode: 'game', yaw: -45, pitch: 35.264, zoom: 1, fit: false },
            [1, 0, 4.5],
            [22, 12, 9],
            bounds.width,
            bounds.height
        );
        const pointScreen = pointCamera.project(latestPoint.map((value) => value / 8));
        const pointX = bounds.rect.left + (pointScreen[0] * bounds.rect.width) / bounds.width,
            pointY = bounds.rect.top + (pointScreen[1] * bounds.rect.height) / bounds.height;
        await page.mouse.move(pointX, pointY);
        await page.mouse.down();
        await page.mouse.move(pointX + 16, pointY + 10, { steps: 5 });
        await page.mouse.up();
        const draggedPoint = await page.evaluate(
            () => window.messages.filter((m) => m.type === 'edit' && m.id === 'flh').at(-1).values
        );
        assert.ok(
            draggedPoint[0] !== latestPoint[0] && draggedPoint[1] !== latestPoint[1],
            'dragging the marker moves the point in the screen plane, rather than choosing an axis'
        );
        const orb = await page
            .locator('.voxel-overlay')
            .first()
            .evaluate((canvas) => {
                const rect = canvas.getBoundingClientRect();
                return {
                    x: rect.right - (58 * rect.width) / canvas.width,
                    y: rect.top + (58 * rect.height) / canvas.height,
                };
            });
        const beforeLight = await page
            .locator('.light-value')
            .evaluateAll((inputs) => inputs.map((input) => input.value));
        await page.mouse.move(orb.x, orb.y);
        await page.mouse.down();
        await page.mouse.move(orb.x + 18, orb.y - 12, { steps: 5 });
        await page.mouse.up();
        assert.notDeepEqual(
            await page.locator('.light-value').evaluateAll((inputs) => inputs.map((input) => input.value)),
            beforeLight,
            'light orb must synchronize numeric fields'
        );
        await page.getByRole('button', { name: labels.resetLight, exact: true }).click();
        assert.deepEqual(
            await page.locator('.light-value').evaluateAll((inputs) => inputs.map((input) => input.value)),
            voxel.light.map(String),
            'project light must restore numeric controls'
        );
        await page
            .locator('select')
            .filter({ has: page.locator('option[value="normal"]') })
            .selectOption('perspective');
        await page.getByLabel('Fixed voxel lighting', { exact: true }).check();
        await page
            .locator('.controls')
            .filter({ has: page.locator('.light-value') })
            .getByRole('button', { name: 'Apply to INI', exact: true })
            .click();
        assert.ok(
            await page.evaluate(() =>
                window.messages.some(
                    (m) => m.type === 'edit' && m.id === 'light' && m.values.length === 4 && m.values[3] === 1
                )
            )
        );
        fs.mkdirSync(path.join(root, 'out', 'webview-qa'), { recursive: true });
        await page.screenshot({ path: path.join(root, 'out', 'webview-qa', 'voxel.png'), fullPage: true });
        await page.setViewportSize({ width: 340, height: 900 });
        await page.screenshot({ path: path.join(root, 'out', 'webview-qa', 'narrow.png'), fullPage: true });
        const wav = encodeWav({ rate: 22050, channels: 1, samples: new Int16Array(2205) });
        await send(
            inspection('audio', {
                kind: 'audio',
                name: 'sample.wav',
                bytes: Buffer.from(wav).toString('base64'),
                duration: 0.1,
                rate: 22050,
                channels: 1,
                volume: 0.5,
                loop: false,
            })
        );
        assert.equal(
            await page.getByLabel(labels.palette, { exact: true }).count(),
            0,
            'audio must not expose palette'
        );
        assert.equal(
            await page.getByRole('button', { name: labels.exportPng, exact: true }).count(),
            0,
            'audio must not expose PNG export'
        );
        assert.equal(
            await page.getByRole('button', { name: labels.compare, exact: true }).count(),
            0,
            'audio must not expose image comparison'
        );
        assert.equal(await page.getByRole('button', { name: labels.exportAudio, exact: true }).count(), 1);
        await page.waitForFunction(() => document.querySelector('audio')?.readyState >= 1);
        await page.evaluate(async () => {
            await document.querySelector('audio').play();
            window.postMessage({ type: 'visibility', visible: false }, '*');
        });
        await page.waitForFunction(() => document.querySelector('audio')?.paused);
        const library = inspection('library', sprite);
        library.library = [{ id: 'tile', name: 'sample.shp', source: 'expand.mix', priority: 500 }];
        await send(library);
        await page.locator('.library summary').click();
        await page.waitForFunction(() => window.messages.some((m) => m.type === 'thumbnail' && m.id === 'tile'));
        await page.locator('.asset-tile').click();
        assert.ok(await page.evaluate(() => window.messages.some((m) => m.type === 'select' && m.id === 'tile')));
        await page.setViewportSize({ width: 1320, height: 440 });
        const building = structuredClone(sprite);
        building.scene = {
            kind: 'building',
            foundation: [
                [0, 0],
                [1, 0],
                [0, 1],
                [1, 1],
            ],
            trace: ['body → BodyArt → generic.mix', 'Buildup → BodyMK → isotemp.mix'],
            layers: [
                {
                    id: 'body',
                    name: 'BodyArt',
                    tag: 'body',
                    source: 'generic.mix',
                    state: 'normal',
                    offset: [0, 0],
                    z: 0,
                    start: 0,
                    end: -1,
                    media: sprite,
                },
                {
                    id: 'buildup',
                    name: 'BodyMK',
                    tag: 'Buildup',
                    source: 'isotemp.mix',
                    state: 'construction',
                    offset: [0, 0],
                    z: 0,
                    start: 0,
                    end: -1,
                    media: sprite,
                },
                {
                    id: 'bib',
                    name: 'Bib',
                    tag: 'BibShape',
                    source: 'generic.mix',
                    state: 'normal',
                    offset: [-12, 0],
                    z: 10000,
                    start: 0,
                    end: -1,
                    media: { ...sprite, palette: palette.map((_, i) => (i % 3 === 1 ? 224 : 0)) },
                },
                {
                    id: 'production',
                    name: 'Prod',
                    tag: 'ProductionAnim',
                    source: 'generic.mix',
                    state: 'production',
                    offset: [12, 0],
                    z: 0,
                    start: 0,
                    end: -1,
                    media: { ...sprite, palette: palette.map((_, i) => (i % 3 === 0 ? 224 : 0)) },
                },
                {
                    id: 'production-damaged',
                    name: 'ProdDamage',
                    tag: 'ProductionAnimDamaged',
                    source: 'generic.mix',
                    state: 'production',
                    damaged: true,
                    offset: [12, 0],
                    z: 0,
                    start: 0,
                    end: -1,
                    media: { ...sprite, palette: palette.map((_, i) => (i % 3 === 2 ? 224 : 0)) },
                },
                {
                    id: 'turret',
                    name: 'SAM',
                    tag: 'TurretAnim',
                    source: 'generic.mix',
                    state: 'normal',
                    offset: [0, -60],
                    z: -1,
                    start: 0,
                    end: -1,
                    voxel,
                },
            ],
            points: [
                { id: 'damage-0', name: 'DamageFireOffset0', space: 'pixel', value: [45, -40] },
                { id: 'damage-1', name: 'DamageFireOffset1', space: 'pixel', value: [0, 0], absent: true },
            ],
        };
        await send(inspection('building', building));
        await page.getByLabel(labels.foundation, { exact: true }).uncheck();
        const sceneState = page.getByRole('combobox').filter({ has: page.locator('option[value="construction"]') });
        await sceneState.selectOption('production');
        await page.waitForFunction(() => {
            const canvas = document.querySelector('.sprite-canvas');
            return canvas?.getContext('2d').getImageData(161, 119, 1, 1).data[0] === 224;
        });
        await page.getByLabel(labels.damaged, { exact: true }).check();
        await page.waitForFunction(() => {
            const canvas = document.querySelector('.sprite-canvas');
            return canvas?.getContext('2d').getImageData(161, 119, 1, 1).data[2] === 224;
        });
        assert.strictEqual(
            await page.locator('.scene-layer select').count(),
            0,
            'building layers hide palette controls'
        );
        await page.locator('.palette-picker summary').first().click();
        await page.locator('.palette-picker input[type="search"]').first().fill('pal');
        assert.ok((await page.locator('.palette-picker option').count()) > 0, 'palette sources can be searched');
        await page.locator('.palette-picker summary').first().click();
        const damage = await page
            .locator('.sprite-canvas')
            .first()
            .evaluate((canvas) => {
                const rect = canvas.getBoundingClientRect();
                return {
                    x: rect.left + (195 * rect.width) / canvas.width,
                    y: rect.top + (80 * rect.height) / canvas.height,
                };
            });
        await page.mouse.move(damage.x, damage.y);
        await page.mouse.down();
        await page.mouse.move(damage.x + 20, damage.y, { steps: 4 });
        await page.mouse.up();
        assert.ok(
            await page.evaluate(() =>
                window.messages.some((m) => m.type === 'edit' && m.id === 'damage-0' && m.values.join(',') === '65,-40')
            ),
            'damage point drag preserves pixel units'
        );
        await page.getByRole('button', { name: labels.deletePoint, exact: true }).click();
        assert.ok(
            await page.evaluate(() =>
                window.messages.some((m) => m.type === 'edit' && m.id === 'damage-0' && m.values === null)
            )
        );
        await page
            .getByRole('combobox')
            .filter({ has: page.locator('option[value="DamageFireOffset1"]') })
            .selectOption('DamageFireOffset1');
        await page.getByRole('button', { name: labels.addPoint, exact: true }).click();
        assert.ok(
            await page.evaluate(() =>
                window.messages.some((m) => m.type === 'edit' && m.id === 'damage-1' && m.values.length === 2)
            )
        );
        await page.locator('.firing-points summary').click();
        await page
            .getByRole('combobox')
            .filter({ has: page.locator('option[value="construction"]') })
            .selectOption('construction');
        await page.waitForFunction(() => {
            const canvas = document.querySelector('.sprite-canvas');
            return canvas?.getContext('2d').getImageData(150, 120, 1, 1).data[3] > 0;
        });
        assert.ok(
            await page
                .locator('.sprite-canvas')
                .first()
                .evaluate((canvas) => {
                    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
                    for (let at = 0; at < pixels.length; at += 4) {
                        if (pixels[at + 1] === 224 && pixels[at] === 0 && pixels[at + 2] === 0) {
                            return false;
                        }
                    }
                    return true;
                }),
            'construction does not include BibShape'
        );
        await sceneState.selectOption('normal');
        const turretHeading = page.getByLabel(labels.turret, { exact: true });
        await turretHeading.fill('90');
        await turretHeading.dispatchEvent('input');
        await page.waitForFunction(() => {
            const canvas = document.querySelector('.sprite-canvas'),
                ctx = canvas.getContext('2d');
            const pixels = ctx.getImageData(110, 45, 80, 45).data;
            return pixels.some((value, index) => index % 4 === 3 && value === 255);
        });
        const zoomBefore = await page.locator('.viewport-zoom').first().inputValue();
        await page.locator('.sprite-canvas').first().hover();
        await page.mouse.wheel(0, -100);
        assert.ok(
            Number(await page.locator('.viewport-zoom').first().inputValue()) > Number(zoomBefore),
            'sprite wheel zoom syncs the viewport control'
        );
        const panRect = await page.locator('.viewport').first().boundingBox();
        await page.mouse.move(panRect.x + 25, panRect.y + 100);
        await page.mouse.down({ button: 'middle' });
        await page.mouse.move(panRect.x + 55, panRect.y + 105);
        await page.mouse.up({ button: 'middle' });
        assert.ok(
            await page
                .locator('.sprite-canvas')
                .first()
                .evaluate((canvas) => canvas.style.transform.includes('translate(')),
            'middle drag pans sprite canvas'
        );
        await page.screenshot({ path: path.join(root, 'out', 'webview-qa', 'bottom-panel.png'), fullPage: true });
        assert.ok(
            await page
                .locator('.preview-stage')
                .evaluate(
                    (stage) =>
                        stage.getBoundingClientRect().left <
                        document.querySelector('.preview-controls').getBoundingClientRect().left
                ),
            'wide bottom panel must use a horizontal layout'
        );
        assert.deepEqual(errors, [], 'Webview must not emit browser or CSP errors');
        console.log(
            'Webview regression passed: worker pixels, source/palette selection, action edits, comparison, PNG, WebGL, light edits, narrow layout, audio pause, asset library.'
        );
    } finally {
        await browser?.close();
        await new Promise((resolve) => server.close(resolve));
    }
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
