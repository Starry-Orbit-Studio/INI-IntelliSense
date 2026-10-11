const assert = require('node:assert/strict');
const { mkdir } = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');
const { voxelCamera } = require('../out/media/voxel-camera');
const { voxelTransform, transformPoint } = require('../out/media/voxel-math');

module.exports = async function verifyHover(
    port,
    output,
    showHover,
    owner = 'ALIFV',
    kind = 'voxel',
    expectedSnow,
    media
) {
    const browser = await chromium.connectOverCDP('http://127.0.0.1:' + port);
    try {
        const page = browser
            .contexts()
            .flatMap((context) => context.pages())
            .find((page) => page.url().includes('workbench'));
        assert.ok(page, 'VS Code workbench page is available');
        // Automatic panel reveal changes editor geometry and dismisses an already
        // open hover. Wait for the first reveal before asking VS Code to show it.
        if (process.env.RA2_WORKBENCH_VERIFY_PANEL) {
            await page.waitForFunction(
                () => {
                    const panel = document.querySelector('.part.panel');
                    return panel && panel.getBoundingClientRect().height > 20;
                },
                undefined,
                { timeout: 20000 }
            );
            let ready = false;
            for (let attempt = 0; attempt < 120 && !ready; attempt++) {
                for (const frame of browser
                    .contexts()
                    .flatMap((context) => context.pages())
                    .flatMap((page) => page.frames())) {
                    if (
                        (await frame.locator('#app[data-inspection] .identity h1').count()) &&
                        (await frame.locator('#app[data-inspection] .identity h1').textContent()) === owner &&
                        (await frame.locator(kind === 'voxel' ? '.voxel-canvas' : '.sprite-canvas').count())
                    ) {
                        ready = true;
                        break;
                    }
                }
                if (!ready) {
                    await new Promise((resolve) => setTimeout(resolve, 100));
                }
            }
            assert.ok(ready, 'automatic panel has finished rendering before hover');
        }
        for (let attempt = 0; attempt < 30; attempt++) {
            await showHover?.();
            if (await page.locator('.monaco-hover img[src^="data:image/png;base64,"]').count()) {
                break;
            }
            await page.waitForTimeout(150);
        }
        try {
            await page.locator('.monaco-hover img[src^="data:image/png;base64,"]').first().waitFor({ timeout: 10000 });
        } catch (error) {
            await mkdir(path.dirname(output), { recursive: true });
            await page.screenshot({ path: output.replace(/\.png$/, '-failed.png') });
            console.error('Native hover state:', await page.locator('.monaco-hover').allTextContents());
            throw error;
        }
        await page.waitForFunction(() => {
            const image = document.querySelector('.monaco-hover img[src^="data:image/png;base64,"]');
            return image?.complete && image.naturalWidth > 0;
        });
        const hoverImage = page.locator('.monaco-hover img[src^="data:image/png;base64,"]').first();
        const hoverBytes = Buffer.from((await hoverImage.getAttribute('src')).split(',')[1], 'base64');
        if (hoverBytes.includes(Buffer.from('acTL'))) {
            const frames = new Set();
            for (let index = 0; index < 8; index++) {
                frames.add((await hoverImage.screenshot()).toString('base64'));
                await new Promise((resolve) => setTimeout(resolve, 75));
            }
            assert.ok(frames.size > 1, 'native VS Code hover visibly plays the animation');
        }
        await mkdir(path.dirname(output), { recursive: true });
        await page.screenshot({ path: output });
        if (process.env.RA2_WORKBENCH_VERIFY_PANEL) {
            await page.keyboard.press('Escape');
            await page.waitForFunction(
                () => {
                    const panel = document.querySelector('.part.panel');
                    return panel && panel.getBoundingClientRect().height > 20;
                },
                { timeout: 20000 }
            );
            let preview;
            for (let attempt = 0; attempt < 120 && !preview; attempt++) {
                for (const frame of browser
                    .contexts()
                    .flatMap((context) => context.pages())
                    .flatMap((page) => page.frames())) {
                    if (
                        (await frame.locator('#app[data-inspection] .identity h1').count()) &&
                        (await frame.locator('#app[data-inspection] .identity h1').textContent()) === owner
                    ) {
                        preview = frame;
                        break;
                    }
                }
                if (!preview) {
                    await new Promise((resolve) => setTimeout(resolve, 100));
                }
            }
            assert.ok(preview, 'the automatically revealed panel must render the inspector');
            assert.equal(await preview.locator('#app .identity h1').textContent(), owner);
            await preview.locator(kind === 'voxel' ? '.voxel-canvas' : '.sprite-canvas').waitFor();
            await preview.waitForFunction((kind) => {
                const canvas = document.querySelector(kind === 'voxel' ? '.voxel-canvas' : '.sprite-canvas');
                if (kind !== 'voxel') {
                    const pixels = canvas?.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
                    return pixels?.some((value, index) => index % 4 === 3 && value > 0);
                }
                const gl = canvas?.getContext('webgl2');
                if (!gl) {
                    return false;
                }
                const pixels = new Uint8Array(canvas.width * canvas.height * 4);
                gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
                return pixels.some((value, index) => index % 4 === 3 && value > 0);
            }, kind);
            assert.ok(
                await page.evaluate(() => !!document.activeElement?.closest('.monaco-editor')),
                'automatic reveal must retain text editor focus'
            );
            if (owner === 'ALIFV' || owner === 'ALTNK') {
                assert.equal(
                    await preview.locator('.cameo-strip .cameo-card canvas').count(),
                    2,
                    'both icons are expanded'
                );
                assert.equal(await preview.getByRole('button', { name: '导出音频', exact: true }).count(), 0);
            }
            if (owner === 'MirageAnimAE') {
                assert.equal(
                    await preview.getByLabel('所属色', { exact: true }).count(),
                    0,
                    'ordinary animations keep palette colors and do not expose remap controls'
                );
            }
            if (owner === 'NASAM' && expectedSnow) {
                const before = await preview.locator('#app').getAttribute('data-inspection');
                const climate = preview.locator('select').filter({ has: preview.locator('option[value="sno"]') });
                await climate.selectOption('sno');
                await preview.waitForFunction((id) => document.getElementById('app').dataset.inspection !== id, before);
                assert.ok(
                    (await preview.locator('.palette-picker summary').first().textContent()).includes('unitsno.pal'),
                    'snow palette follows climate'
                );
                const png = await expectedSnow();
                await page.locator('.monaco-editor textarea').first().focus();
                for (let attempt = 0; attempt < 20; attempt++) {
                    await showHover();
                    const src = await page
                        .locator('.monaco-hover img[src^="data:image/png;base64,"]')
                        .first()
                        .getAttribute('src')
                        .catch(() => '');
                    if (src === 'data:image/png;base64,' + png) {
                        break;
                    }
                    await new Promise((resolve) => setTimeout(resolve, 100));
                }
                assert.equal(
                    await page.locator('.monaco-hover img[src^="data:image/png;base64,"]').first().getAttribute('src'),
                    'data:image/png;base64,' + png,
                    'hover and inspector share snow scene and palette'
                );
                await page.screenshot({ path: path.join(path.dirname(output), 'vscode-snow-hover.png') });
                await page.keyboard.press('Escape');
            }
            if (owner === 'GAWEAP') {
                const state = preview.locator('select').filter({ has: preview.locator('option[value="production"]') });
                await state.selectOption('production');
                await preview.getByLabel('受损', { exact: true }).check();
                assert.ok(
                    (await preview.locator('.scene-layer').count()) > 3,
                    'factory scene includes attached animations'
                );
                assert.equal(
                    await preview.locator('.viewport .firing-points').count(),
                    1,
                    'damage point editor is in the viewport'
                );
            }
            if (owner === 'ALBFRT') {
                await preview
                    .locator('select')
                    .filter({ has: preview.locator('option[value="perspective"]') })
                    .selectOption('game');
                await preview.getByRole('button', { name: '重置视角', exact: true }).last().click();
                const points = preview.locator('.firing-points');
                await points.locator('summary').click();
                await points.locator('input[type="checkbox"]').check();
                await points.locator('select').selectOption('AlternateFLH0');
                const values = points.locator('.controls input[type="number"]');
                const before = await values.evaluateAll((fields) => fields.map((field) => Number(field.value)));
                const scale = Number(await points.locator(':scope > .field input[type="number"]').inputValue());
                await points.locator('summary').click();
                const min = [Infinity, Infinity, Infinity],
                    max = [-Infinity, -Infinity, -Infinity];
                for (const part of media.model.parts) {
                    const matrix = voxelTransform(part, 0, 0);
                    for (let corner = 0; corner < 8; corner++) {
                        transformPoint(
                            matrix,
                            part.size.map((size, axis) => (corner & (1 << axis) ? size : 0))
                        ).forEach((value, axis) => {
                            min[axis] = Math.min(min[axis], value);
                            max[axis] = Math.max(max[axis], value);
                        });
                    }
                }
                const bounds = await preview.locator('.voxel-overlay').evaluate((canvas) => ({
                    width: canvas.width,
                    height: canvas.height,
                    rect: JSON.parse(JSON.stringify(canvas.getBoundingClientRect())),
                }));
                const view = voxelCamera(
                    { mode: 'game', yaw: -45, pitch: 30, zoom: 1, fit: false },
                    min.map((value, axis) => (value + max[axis]) / 2),
                    max.map((value, axis) => value - min[axis]),
                    bounds.width,
                    bounds.height
                );
                const point = view.project(before.map((value) => value / scale));
                await page.screenshot({ path: path.join(path.dirname(output), 'vscode-flh-before.png') });
                const absolute = await preview.locator('.voxel-overlay').boundingBox();
                const x = absolute.x + (point[0] * absolute.width) / bounds.width,
                    y = absolute.y + (point[1] * absolute.height) / bounds.height;
                await page.mouse.move(x, y);
                await page.mouse.down();
                await page.mouse.move(x + 12, y + 7, { steps: 5 });
                const moved = await values.evaluateAll((fields) => fields.map((field) => Number(field.value)));
                // Cancellation verifies native pointer interaction without editing the user's mod.
                await preview.locator('.voxel-overlay').dispatchEvent('pointercancel', { pointerId: 1 });
                await page.mouse.up();
                assert.notDeepEqual(moved, before, 'real battle fortress FLH marker must drag in the native panel');
                assert.deepEqual(
                    await values.evaluateAll((fields) => fields.map((field) => Number(field.value))),
                    before,
                    'cancelled drag restores the original FLH'
                );
            }
            await page.screenshot({ path: path.join(path.dirname(output), 'vscode-panel.png') });
            await page.locator('.monaco-editor textarea').first().focus();
            await page.keyboard.press('Control+j');
            await page.waitForFunction(
                () => document.querySelector('.part.panel')?.getBoundingClientRect().height < 20
            );
            await page.keyboard.press('ArrowDown');
            await new Promise((resolve) => setTimeout(resolve, 600));
            assert.ok(
                await page.evaluate(() => document.querySelector('.part.panel')?.getBoundingClientRect().height < 20),
                'closing the panel must suppress repeated automatic reveal'
            );
        }
    } finally {
        await browser.close();
    }
};
