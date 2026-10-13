const assert = require('node:assert/strict');
const { chromium } = require('playwright');

module.exports = async function verifyFiles(port, output) {
    const browser = await chromium.connectOverCDP('http://127.0.0.1:' + port);
    try {
        let target;
        for (let attempt = 0; attempt < 120 && !target; attempt++) {
            for (const page of browser.contexts().flatMap(context => context.pages())) {
                for (const frame of page.frames()) { if (await frame.locator('#files .file-row').count()) { target = frame; break; } }
            }
            if (!target) { await new Promise(resolve => setTimeout(resolve, 150)); }
        }
        assert.ok(target, 'Native file browser loads its scripts and host snapshot');
        const undo = async frame => { await frame.locator('.toolbar button[data-label=more]').click(); await frame.locator('.context-menu button[data-label=undo]:not([disabled])').click(); };
        const left = target.locator('[data-pane="0"]'), right = target.locator('[data-pane="1"]');
        await left.locator('.file-row').filter({ hasText: 'hello.ini' }).click();
        await target.page().keyboard.press('Control+c');
        await target.locator('.toolbar button[data-label=paste]:not([disabled])').waitFor();
        await right.locator('.file-scroll').click(); await target.page().keyboard.press('Control+v');
        await right.locator('.file-row').filter({ hasText: 'hello.ini' }).waitFor();
        await undo(target);
        await right.locator('.file-row').filter({ hasText: 'hello.ini' }).waitFor({ state: 'detached' });
        // Actual HTML drag events must reach another native Webview, not just a mocked host.
        await left.locator('.file-row').filter({ hasText: 'hello.ini' }).click();
        await left.locator('.file-row').filter({ hasText: 'sample.llf' }).click({ modifiers: ['Control'] });
        await left.locator('.file-row').filter({ hasText: 'hello.ini' }).dragTo(right.locator('.file-scroll'));
        await right.locator('.file-row').filter({ hasText: 'sample.llf' }).waitFor();
        await right.locator('.file-row').filter({ hasText: 'hello.ini' }).waitFor();
        await undo(target);
        await right.locator('.file-row').filter({ hasText: 'hello.ini' }).waitFor({ state: 'detached' });
        // Open the same target in a separate VS Code editor group.
        await right.locator('.file-scroll').click();
        await target.locator('[data-label=openBeside]').click();
        let beside;
        for (let attempt = 0; attempt < 100 && !beside; attempt++) {
            for (const frame of target.page().frames()) {
                if (frame !== target && await frame.locator('#files .file-scroll').count()) { beside = frame; break; }
            }
            if (!beside) { await new Promise(resolve => setTimeout(resolve, 100)); }
        }
        assert.ok(beside, 'A separate editor group hosts the target');
        const destination = beside.locator('[data-pane="0"] .file-scroll');
        const source = left.locator('.file-row').filter({ hasText: 'hello.ini' });
        await source.click();
        await left.locator('.file-row').filter({ hasText: 'sample.llf' }).click({ modifiers: ['Control'] });
        const from = await source.locator('.file-label').boundingBox(), to = await destination.boundingBox();
        const page = target.page();
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Input.setInterceptDrags', { enabled: true });
        const intercepted = new Promise(resolve => cdp.once('Input.dragIntercepted', resolve));
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + 10, y: from.y + 8 });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x + 10, y: from.y + 8, button: 'left', buttons: 1, clickCount: 1 });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + 35, y: from.y + 8, button: 'left', buttons: 1 });
        const drag = await Promise.race([intercepted, new Promise((_, reject) => setTimeout(() => reject(new Error('No browser drag data')), 5000))]);
        assert.ok(drag.data.items.some(item => item.mimeType === 'application/x-ra2-resources'), 'Native drag carries host-owned resource tokens');
        for (const type of ['dragEnter', 'dragOver', 'drop']) {
            await cdp.send('Input.dispatchDragEvent', { type, x: to.x + 50, y: to.y + 100, data: drag.data, modifiers: 8 });
        }
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x + 50, y: to.y + 100, button: 'left', buttons: 0, clickCount: 1 });
        // Release Chromium's intercepted native gesture so the source Webview accepts subsequent clicks.
        await cdp.send('Input.dispatchDragEvent', { type: 'dragCancel', x: from.x + 10, y: from.y + 8, data: drag.data });
        await cdp.send('Input.setInterceptDrags', { enabled: false });
        await cdp.detach();
        await page.screenshot({ path: output.replace('.png', '-drag.png') });
        await beside.locator('.file-row').filter({ hasText: 'sample.llf' }).waitFor();
        await beside.locator('.file-row').filter({ hasText: 'hello.ini' }).waitFor();
        await left.locator('.file-row').filter({ hasText: 'hello.ini' }).waitFor({ state: 'detached' });
        // Confirm the shared bottom viewer loads the actual archived LLF.
        await beside.locator('.file-row').filter({ hasText: 'sample.llf' }).click();
        let strings;
        for (let attempt = 0; attempt < 120 && !strings; attempt++) {
            for (const frame of page.frames()) {
                if (await frame.locator('#app .string-table').count()) { strings = frame; break; }
            }
            if (!strings) { await new Promise(resolve => setTimeout(resolve, 100)); }
        }
        assert.ok(strings, 'Archive LLF opens in the shared bottom inspector');
        assert.ok((await strings.locator('.string-detail pre').first().textContent()).includes('第一行 #正文\n最后一行'));
        await beside.locator('.file-row').filter({ hasText: 'strings.csf' }).click();
        await strings.locator('.identity h1').filter({ hasText: 'strings.csf' }).waitFor();
        assert.equal(await strings.locator('.string-detail pre').first().textContent(), 'CSF中文');
        await strings.locator('nav.toolbar > button').nth(1).click();
        await beside.locator('.file-row').filter({ hasText: 'sample.llf' }).click();
        await page.waitForTimeout(250);
        assert.equal(await strings.locator('.identity h1').textContent(), 'strings.csf', 'Pinned inspector ignores browser selections');
        await strings.locator('nav.toolbar > button').nth(1).click();
        await undo(beside);
        await beside.locator('.file-row').filter({ hasText: 'hello.ini' }).waitFor({ state: 'detached' });
        await left.locator('.file-row').filter({ hasText: 'hello.ini' }).waitFor();
        await page.locator('.tab').filter({ hasText: /ra2-mix-browser-/ }).first().click();
        await left.locator('.file-row').filter({ hasText: 'alias.dll' }).locator('.file-label').dblclick();
        await left.locator('.file-row').filter({ hasText: 'inner.mix' }).waitFor();
        await left.locator('.file-row').filter({ hasText: 'inner.mix' }).locator('.file-label').dblclick();
        await left.locator('.file-row').filter({ hasText: 'notes.ini' }).waitFor();
        assert.ok((await left.locator('.crumbs').textContent()).includes('alias.dll'));
        await target.page().screenshot({ path: output });
    } finally { await browser.close(); }
};
