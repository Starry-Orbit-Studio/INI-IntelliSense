const assert = require('node:assert/strict');
const { mkdir } = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');

module.exports = async function verifyHover(port, output, showHover, owner = 'ALIFV', kind = 'voxel') {
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
        await showHover?.();
        await page.locator('.monaco-hover img[src^="data:image/png;base64,"]').first().waitFor({ timeout: 10000 });
        await page.waitForFunction(() => {
            const image = document.querySelector('.monaco-hover img[src^="data:image/png;base64,"]');
            return image?.complete && image.naturalWidth > 0;
        });
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
