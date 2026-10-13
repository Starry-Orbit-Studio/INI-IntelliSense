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
const { animatedThumbnail } = require('../out/media/animated-thumbnail');

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
    focus: media?.name ?? '',
    properties: [
        { key: 'Image', value: 'body', inherited: false, source: { id: 'src', label: 'art.ini:3' } },
        { key: 'Strength', value: '100', inherited: true, source: { id: 'base', label: 'rules.ini:2' } },
    ],
    sources: [{ id: 'src', label: 'art.ini:3' }],
    references: [{ id: 'ref', label: 'Weapon → TestUnit' }],
    assets: [
        { id: 'asset-1', name: media?.name ?? '', source: 'expand.mix', priority: 500 },
        { id: 'asset-2', name: media?.name ?? '', source: 'local/', priority: 0 },
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
                    document.querySelector('.sprite-canvas,.voxel-canvas,audio,.catalog-table,.project-layout,.map-sections,.analysis-content,.logic-focus,.string-table'),
                value.id
            );
        };
        const remapBytes = shpFixture(0);
        remapBytes.set([16, 17, 31, 32], 32);
        const ordinary = {
            ...sprite,
            bytes: Buffer.from(remapBytes).toString('base64'),
            file: readShp(remapBytes),
            remap: false,
            actions: [],
        };
        for (const remap of [false, true]) {
            const state = inspection('remap-' + remap, { ...ordinary, remap });
            state.cameos = [{ tag: 'Cameo', media: ordinary }];
            await send(state);
            await page.waitForFunction(
                () =>
                    document.querySelector('.sprite-canvas')?.getContext('2d').getImageData(0, 0, 1, 1).data[3] === 255
            );
            assert.equal(await page.getByLabel(labels.remap, { exact: true }).count(), remap ? 1 : 0);
            if (remap) {
                await page.getByLabel(labels.remap, { exact: true }).fill('#00ff00');
                await page.getByLabel(labels.remap, { exact: true }).dispatchEvent('input');
            }
            const expected = remap ? [0, 255, 0] : [16, 16, 16];
            await page.waitForFunction(
                (rgb) =>
                    [...document.querySelector('.sprite-canvas').getContext('2d').getImageData(0, 0, 1, 1).data]
                        .slice(0, 3)
                        .join() === rgb.join(),
                expected
            );
            await page.waitForFunction(
                () => document.querySelector('.cameo')?.getContext('2d').getImageData(0, 0, 1, 1).data[3] === 255
            );
            assert.deepEqual(
                await page
                    .locator('.cameo')
                    .evaluate((c) => [...c.getContext('2d').getImageData(0, 0, 1, 1).data].slice(0, 3)),
                [16, 16, 16]
            );
            await page.getByRole('button', { name: labels.contact, exact: true }).click();
            await page.waitForFunction(
                (rgb) =>
                    [
                        ...(document.querySelector('.contact-thumbnail')?.getContext('2d').getImageData(0, 0, 1, 1)
                            .data ?? []),
                    ]
                        .slice(0, 3)
                        .join() === rgb.join(),
                expected
            );
            await page.getByRole('button', { name: labels.exportPng, exact: true }).click();
            const exported = await page.evaluate(() => window.messages.filter((m) => m.type === 'export').at(-1));
            assert.deepEqual([...Buffer.from(exported.pixels, 'base64').subarray(0, 3)], expected);
        }
        await send(inspection('sprite', sprite));
        assert.equal(await page.locator('.identity .eyebrow').textContent(), 'VehicleType');
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
        assert.ok(
            await page.locator('.asset-choice').evaluateAll((rows) =>
                rows.every((row) => {
                    const name = row.querySelector('.asset-name').getBoundingClientRect(),
                        role = row.querySelector('.source-role').getBoundingClientRect(),
                        hint = row.querySelector('.hint').getBoundingClientRect(),
                        rect = row.getBoundingClientRect();
                    return hint.top >= name.bottom && name.right <= role.left && hint.bottom <= rect.bottom;
                })
            ),
            'source names, provenance badges and paths must occupy separate rows without overlap'
        );
        const animatedBytes = Buffer.alloc(8 + 2 * 24 + 32);
        animatedBytes.writeUInt16LE(24, 2);
        animatedBytes.writeUInt16LE(24, 4);
        animatedBytes.writeUInt16LE(2, 6);
        for (let i = 0; i < 2; i++) {
            const at = 8 + i * 24;
            animatedBytes.writeUInt16LE(i * 20, at);
            animatedBytes.writeUInt16LE(4, at + 4);
            animatedBytes.writeUInt16LE(4, at + 6);
            animatedBytes.writeUInt32LE(56 + i * 16, at + 20);
            animatedBytes.fill(144, 56 + i * 16, 72 + i * 16);
        }
        const animated = {
            ...sprite,
            bytes: animatedBytes.toString('base64'),
            file: readShp(animatedBytes),
            actions: [],
        };
        const previewPng = animatedThumbnail(animated);
        await page.evaluate(
            (src) => {
                const img = document.createElement('img');
                img.id = 'animated-hover-qa';
                img.src = src;
                img.style.cssText =
                    'position:fixed;z-index:99;left:10px;top:10px;width:240px;height:40px;background:#111;image-rendering:pixelated';
                document.body.append(img);
            },
            'data:image/png;base64,' + Buffer.from(previewPng).toString('base64')
        );
        await page.waitForFunction(() => document.querySelector('#animated-hover-qa').complete);
        const animationShots = new Set();
        for (let i = 0; i < 8; i++) {
            animationShots.add((await page.locator('#animated-hover-qa').screenshot()).toString('base64'));
            await page.waitForTimeout(35);
        }
        assert.ok(animationShots.size > 1, 'Chromium must visibly play the generated hover APNG');
        await page.locator('#animated-hover-qa').evaluate((img) => img.remove());
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
        assert.equal(await page.locator('#comparison .sprite-canvas').count(), 1);
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
            { mode: 'game', yaw: -45, pitch: 30, zoom: 1, fit: false },
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
        const lightingSnapshot = async () =>
            page
                .locator('.voxel-overlay')
                .first()
                .evaluate((overlay) => {
                    const gl = overlay.parentElement.querySelector('canvas:not(.voxel-overlay)').getContext('webgl2');
                    const program = gl.getParameter(gl.CURRENT_PROGRAM);
                    const uniform = (name) => Array.from(gl.getUniform(program, gl.getUniformLocation(program, name)));
                    return {
                        light: uniform('light'),
                        secondary: uniform('eye'),
                        normal: uniform('normalMatrix'),
                        projection: uniform('projection'),
                        orb: Array.from(overlay.getContext('2d').getImageData(overlay.width - 100, 16, 84, 84).data),
                    };
                });
        const lightingBeforeOrbit = await lightingSnapshot();
        const orbitBounds = await page.locator('.voxel-overlay').first().boundingBox();
        await page.mouse.move(orbitBounds.x + orbitBounds.width - 160, orbitBounds.y + orbitBounds.height - 130);
        await page.mouse.down();
        await page.mouse.move(orbitBounds.x + orbitBounds.width - 195, orbitBounds.y + orbitBounds.height - 140, {
            steps: 5,
        });
        await page.mouse.up();
        const lightingAfterOrbit = await lightingSnapshot();
        assert.notDeepEqual(
            lightingBeforeOrbit.projection,
            lightingAfterOrbit.projection,
            'orbit changes the inspection camera'
        );
        assert.notDeepEqual(
            lightingBeforeOrbit.light,
            lightingAfterOrbit.light,
            'world light follows the camera basis'
        );
        const screenLight = (state) =>
            [0, 1].map((axis) => {
                const basis = [state.projection[axis], state.projection[axis + 4], state.projection[axis + 8]];
                return basis.reduce((sum, value, index) => sum + value * state.light[index], 0) / Math.hypot(...basis);
            });
        screenLight(lightingBeforeOrbit).forEach((value, axis) =>
            assert.ok(Math.abs(value - screenLight(lightingAfterOrbit)[axis]) < 0.00001)
        );
        screenLight({ ...lightingBeforeOrbit, light: lightingBeforeOrbit.secondary }).forEach((value, axis) =>
            assert.ok(
                Math.abs(value - screenLight({ ...lightingAfterOrbit, light: lightingAfterOrbit.secondary })[axis]) <
                    0.00001
            )
        );
        for (const field of ['normal', 'orb']) {
            assert.deepEqual(
                lightingBeforeOrbit[field],
                lightingAfterOrbit[field],
                'orbit must keep ' + field + ' fixed in game space'
            );
        }
        assert.deepEqual(
            await page.locator('.light-value').evaluateAll((inputs) => inputs.map((input) => input.value)),
            beforeLight
        );
        // Middle-drag over the orb is still camera pan, never a light edit.
        await page.mouse.move(orb.x, orb.y);
        await page.mouse.down({ button: 'middle' });
        await page.mouse.move(orb.x + 10, orb.y + 8, { steps: 3 });
        await page.mouse.up({ button: 'middle' });
        assert.deepEqual(
            await page.locator('.light-value').evaluateAll((inputs) => inputs.map((input) => input.value)),
            beforeLight
        );
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
        const editable = inspection('property-edit', sprite);
        editable.properties = [
            {
                key: 'Cost',
                value: '100',
                inherited: true,
                source: { id: 'parent', label: 'Parent · rules.ini:2' },
                editId: 'edit-cost',
                editSource: { id: 'owner', label: 'Tank · rules.ini:20' },
                valueType: 'int',
                minimum: 0,
                declarations: [
                    {
                        value: '100',
                        via: ['Tank', 'Parent'],
                        effective: true,
                        source: { id: 'parent', label: 'Parent · rules.ini:2' },
                    },
                ],
            },
        ];
        await send(editable);
        await page.getByRole('button', { name: labels.attributes, exact: true }).click();
        await page.getByRole('button', { name: labels.editProperty, exact: true }).click();
        await page.getByLabel('Cost', { exact: true }).fill('120');
        assert.ok((await page.locator('.edit-preview').textContent()).includes('100 → 120'));
        await page.locator('.property-form button[type=submit]').click();
        assert.ok(
            await page.evaluate(() =>
                window.messages.some(
                    (message) =>
                        message.type === 'property-edit' && message.id === 'edit-cost' && message.value === '120'
                )
            )
        );
        await page.getByRole('button', { name: labels.cancel, exact: true }).click();
        const catalog = inspection('catalog', undefined);
        catalog.objects = Array.from({ length: 250 }, (_, i) => ({
            id: 'object-' + i,
            name: 'UNIT' + i,
            label: 'Guardian ' + i,
            category: 'rules',
            type: 'UnitType',
            source: 'rules.ini:' + (i + 1),
            definitions: 1,
            values: { Cost: String(i) },
        }));
        catalog.objects.push({ id: 'ambient', name: '_Amb_Ocean', label: 'Ocean ambience', category: 'sound', type: 'Sound', group: 'sounds', source: 'sound.ini:10', definitions: 1, values: {} });
        catalog.objectColumns = ['Cost'];
        await send(catalog);
        assert.equal(await page.locator('.catalog-table tbody tr').count(), 100);
        assert.ok(!(await page.locator('.catalog-table tbody').textContent()).includes('_Amb_Ocean'));
        await page.locator('.catalog-toolbar select').selectOption('sounds');
        assert.equal(await page.locator('.catalog-table tbody tr').count(), 1);
        assert.ok((await page.locator('.catalog-table tbody').textContent()).includes('_Amb_Ocean'));
        assert.equal(await page.getByRole('button', { name: 'Cost', exact: true }).isVisible(), false);
        await page.locator('.catalog-toolbar select').selectOption('game');
        await page.getByLabel(labels.searchObjects).fill('Guardian UNIT249');
        await page.waitForFunction(() => document.querySelectorAll('.catalog-table tbody tr').length === 1);
        await page.getByLabel(labels.searchObjects).fill('');
        await page.waitForFunction(() => document.querySelectorAll('.catalog-table tbody tr').length === 100);
        await page.getByRole('checkbox', { name: 'UNIT0', exact: true }).check();
        await page.getByRole('checkbox', { name: 'UNIT1', exact: true }).check();
        await page.getByRole('button', { name: labels.compareObjects, exact: true }).click();
        assert.ok(
            await page.evaluate(() =>
                window.messages.some((message) => message.type === 'compare-objects' && message.ids.length === 2)
            )
        );
        await page.getByRole('button', { name: labels.batchEdit, exact: true }).click();
        await page.getByLabel(labels.propertyKey, { exact: true }).fill('Cost');
        await page.getByLabel(labels.newValue, { exact: true }).fill('20');
        await page.getByRole('button', { name: labels.previewChanges, exact: true }).click();
        const planRequest = await page.evaluate(() =>
            window.messages.filter((message) => message.type === 'batch-plan').at(-1)
        );
        await page.evaluate(
            (request) =>
                window.postMessage(
                    {
                        type: 'batch-preview',
                        inspection: 'catalog',
                        request: request.request,
                        id: 'change-plan',
                        rows: [{ name: 'UNIT0', before: '0', after: '20', source: 'rules.ini' }],
                    },
                    '*'
                ),
            planRequest
        );
        await page.locator('.change-preview button').first().waitFor();
        await page.getByLabel(labels.newValue, { exact: true }).fill('30');
        assert.equal(
            await page.locator('.change-preview button').count(),
            0,
            'changing the input invalidates the old plan'
        );
        await page.screenshot({ path: path.join(root, 'out', 'webview-qa', 'object-browser.png'), fullPage: true });
        const configuration = (id, fields) => ({ id, origin: 'file:///E:/Extreme%20Starry', scope: 'folder', scopes: ['user', 'workspace', 'folder'], destination: 'E:/Extreme Starry/.vscode/settings.json', fields });
        const projectConfig = configuration('project-config', [
            { key: 'project.entryPoints', group: 'loading', control: 'entries', picker: 'ini', value: { rules: ['Rules/ruleses.ini'], art: ['Rules/artes.ini'] }, source: 'folder', configured: true },
            { key: 'media.resourceRoots', group: 'resources', control: 'list', picker: 'directory', value: ['Resources', 'Backup'], source: 'folder', configured: true },
            { key: 'media.hoverEnabled', group: 'editing', control: 'toggle', immediate: true, value: true, source: 'default', configured: false },
        ]);
        const project = inspection('project', undefined);
        project.owner = labels.projectSettings; project.type = '';
        project.project = { root: 'E:/Extreme Starry', files: 37483, archives: [{ source: 'expandmd01.mix', entries: 10 }], counts: { vehicles: 512, sounds: 1485 }, configuration: projectConfig, documents: [{ id: 'rules', label: 'Rules/ruleses.ini' }], errors: [] };
        await send(project);
        await page.locator('.project-layout').waitFor();
        await page.getByRole('button', { name: labels.group_vehicles + ' · 512', exact: true }).click();
        assert.ok(await page.evaluate(() => window.messages.some(message => message.type === 'catalog-scope' && message.value === 'vehicles')));
        await page.locator('[data-project-tab=configuration]').click();
        await page.getByRole('button', { name: labels.configGroup_resources, exact: true }).click();
        await page.getByLabel(labels['setting_media.resourceRoots'] + '  1', { exact: true }).fill('UpdatedResources');
        await page.getByRole('button', { name: new RegExp('^' + labels.configApply) }).click();
        const configRequest = await page.evaluate(() => window.messages.filter(message => message.type === 'configuration-apply').at(-1));
        assert.equal(configRequest.snapshot, 'project-config');
        assert.deepEqual(configRequest.changes[0].value, ['UpdatedResources', 'Backup']);
        await page.evaluate(model => window.postMessage({ type: 'configuration-result', snapshot: 'project-config', ok: true, configuration: model }, '*'), { ...projectConfig, id: 'project-config-saved', fields: projectConfig.fields.map(field => field.key === 'media.resourceRoots' ? { ...field, value: ['UpdatedResources', 'Backup'] } : field) });
        await page.waitForFunction(() => document.querySelector('.configuration-bar')?.textContent.includes('Saved'));
        await page.getByRole('button', { name: labels.configGroup_loading, exact: true }).click();
        await page.getByRole('button', { name: labels.configBrowse, exact: true }).first().click();
        assert.ok(await page.evaluate(() => window.messages.some(message => message.type === 'configuration-pick' && message.key === 'project.entryPoints' && message.parts[0] === 'rules')));
        await page.evaluate(() => window.postMessage({ type: 'configuration-picked', snapshot: 'project-config-saved', key: 'project.entryPoints', parts: ['rules'], values: [] }, '*'));
        await page.setViewportSize({ width: 350, height: 800 });
        assert.ok(await page.evaluate(() => document.body.scrollWidth <= window.innerWidth), 'project settings fit a narrow editor');
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: path.join(root, 'out', 'webview-qa', 'project-narrow.png'), fullPage: true });
        await page.setViewportSize({ width: 720, height: 1000 });
        const map = inspection('map', undefined);
        map.map = {
            version: 1,
            note: labels.embeddedMap,
            sections: [{ id: 'waypoints', name: 'Waypoints', count: 4 }],
            details: [{ key: 'Map.Theater', value: 'SNOW' }],
        };
        await send(map);
        await page.getByRole('button', { name: 'Waypoints · 4', exact: true }).click();
        assert.ok(
            await page.evaluate(() =>
                window.messages.some((message) => message.type === 'source' && message.id === 'waypoints')
            )
        );
        await page.getByRole('button', { name: labels.renderMap, exact: true }).click();
        assert.ok(await page.evaluate(() => window.messages.some((message) => message.type === 'render-map')));
        await send(inspection('sky-test', voxel));
        await page.evaluate(() => {
            const canvas = document.createElement('canvas');
            canvas.width = 128;
            canvas.height = 64;
            const context = canvas.getContext('2d');
            const gradient = context.createLinearGradient(0, 0, 128, 64);
            gradient.addColorStop(0, '#1267df');
            gradient.addColorStop(1, '#de8124');
            context.fillStyle = gradient;
            context.fillRect(0, 0, 128, 64);
            window.postMessage(
                {
                    type: 'background-file',
                    bytes: canvas.toDataURL().split(',')[1],
                    mime: 'image/png',
                    name: 'test-panorama.png',
                },
                '*'
            );
        });
        await page.waitForFunction(() => !document.querySelector('.environment-canvas').hidden);
        await page.locator('[data-background]').selectOption('sky');
        const skyBefore = await page
            .locator('.environment-canvas')
            .first()
            .evaluate((canvas) => canvas.toDataURL());
        const skyBounds = await page.locator('.voxel-overlay').first().boundingBox();
        await page.mouse.move(skyBounds.x + 100, skyBounds.y + 160);
        await page.mouse.down();
        await page.mouse.move(skyBounds.x + 180, skyBounds.y + 170, { steps: 5 });
        await page.mouse.up();
        await page.waitForFunction(
            (before) => document.querySelector('.environment-canvas').toDataURL() !== before,
            skyBefore
        );
        await page.screenshot({ path: path.join(root, 'out', 'webview-qa', 'sky-preview.png'), fullPage: true });
        const checks = inspection('checks', undefined);
        checks.type = ''; checks.assets = []; checks.paletteOptions = [];
        checks.checks = { enabled: true, scope: 'folder', checked: 1, total: 2, complete: false, dictionary: 'dictionary.ini', languages: ['zh-CN', 'en-US'], rules: [{ id: 'S001', name: 'Leading whitespace', group: 'S', severity: 'Warning', effective: 'Error', configured: 'Error' }], issues: [{ id: 'problem', source: 'rules.ini:4', code: 'T008', message: 'Invalid boolean', severity: 0, provider: 'RA2 INI' }], configuration: configuration('check-config', [{ key: 'diagnostics.excludePatterns', group: 'checks', control: 'list', value: [], source: 'default', configured: false }, { key: 'exePath', group: 'validator', control: 'path', picker: 'file', value: 'E:/Tools/INIValidator.exe', source: 'folder', configured: true }]) };
        await send(checks);
        await page.getByRole('button', { name: labels.checkRules, exact: true }).click();
        await page.getByLabel('Leading whitespace', { exact: true }).selectOption('None');
        assert.ok(await page.evaluate(() => window.messages.some(message => message.type === 'rule-level' && message.id === 'S001' && message.value === 'None')));
        await page.screenshot({ path: path.join(root, 'out', 'webview-qa', 'check-rules.png'), fullPage: true });
        await page.getByRole('button', { name: labels.configExternalValidator, exact: true }).click();
        assert.equal(await page.locator('[data-tab=settings]').count(), 0, 'check center has no duplicate project settings tab');
        assert.ok(!(await page.locator('.analysis-content').textContent()).includes('Legacy:'));
        assert.equal(await page.getByLabel(labels.setting_exePath, { exact: true }).inputValue(), 'E:/Tools/INIValidator.exe');
        await page.setViewportSize({ width: 350, height: 800 });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        await page.screenshot({ path: path.join(root, 'out', 'webview-qa', 'check-settings-narrow.png'), fullPage: true });
        const graph = inspection('logic', undefined); graph.type = ''; graph.assets = []; graph.paletteOptions = [];
        graph.logic = { focus: 'rules:tank', direction: 'both', depth: 2, truncated: false, nodes: [{ id: 'rules:tank', name: 'Tank', type: 'UnitType', category: 'rules', missing: false }, { id: 'rules:gun', name: 'Gun', type: 'WeaponType', category: 'rules', missing: false }], edges: [{ id: 'edge', from: 'rules:tank', to: 'rules:gun', key: 'Primary', source: 'rules.ini:4', kind: 'reference', inherited: false }] };
        await send(graph);
        await page.getByRole('button', { name: 'Gun · WeaponType', exact: true }).click();
        assert.ok(await page.evaluate(() => window.messages.some(message => message.type === 'logic-options' && message.value.focus === 'rules:gun')));
        await page.getByRole('button', { name: 'rules.ini:4', exact: true }).click();
        assert.ok(await page.evaluate(() => window.messages.some(message => message.type === 'source' && message.id === 'edge')));
        await page.screenshot({ path: path.join(root, 'out', 'webview-qa', 'logic-narrow.png'), fullPage: true });
        graph.mediaRevision = 2;
        graph.logic.query = 'Gun'; graph.logic.choices = [graph.logic.nodes[1]];
        await send(graph);
        await page.waitForFunction(() => document.querySelector('form input')?.value === 'Gun');
        assert.ok(await page.getByRole('button', { name: 'Gun · WeaponType', exact: true }).count() === 2, 'same-page revisions render search results');

        const strings = inspection('strings', undefined);
        strings.assets = []; strings.paletteOptions = [];
        strings.stringTable = { format: 'LLF', entries: Array.from({ length: 15000 }, (_, index) => ({ label: 'UI:Item' + index, value: index === 42 ? '<script>literal</script>\n中文 #正文' : 'Text ' + index, line: index })) };
        await page.setViewportSize({ width: 1100, height: 500 });
        await send(strings);
        assert.ok(await page.locator('.string-row').count() < 100, 'Large string tables are virtualized');
        await page.getByLabel(labels.stringSearch).fill('中文');
        await page.locator('.string-row').click();
        assert.equal(await page.locator('.string-detail pre').first().textContent(), '<script>literal</script>\n中文 #正文');
        assert.equal(await page.locator('.string-detail script').count(), 0);
        await page.getByRole('button', { name: labels.stringCopyValue, exact: true }).click();
        assert.ok(await page.evaluate(() => window.messages.some(message => message.type === 'string-copy-value' && message.index === 42)));
        await page.getByRole('button', { name: labels.stringOpen, exact: true }).click();
        assert.ok(await page.evaluate(() => window.messages.some(message => message.type === 'string-open' && message.index === 42)));
        await page.screenshot({ path: path.join(root, 'out', 'webview-qa', 'strings.png'), fullPage: true });

        assert.deepEqual(errors, [], 'Webview must not emit browser or CSP errors');
        console.log(
            'Webview regression passed (configuration drafts, apply acknowledgments and entry picker included): worker pixels, source/palette selection, action edits, comparison, PNG, WebGL, light edits, narrow layout, audio pause, asset library.'
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
