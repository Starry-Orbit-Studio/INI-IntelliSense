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
        const left = target.locator('[data-pane="0"]'), right = target.locator('[data-pane="1"]');
        await left.locator('.file-row').filter({ hasText: 'hello.ini' }).click();
        await target.page().keyboard.press('Control+c');
        await target.locator('.toolbar button[data-label=paste]:not([disabled])').waitFor();
        await right.locator('.file-scroll').click(); await target.page().keyboard.press('Control+v');
        await right.locator('.file-row').filter({ hasText: 'hello.ini' }).waitFor();
        await target.locator('.toolbar button[data-label=undo]:not([disabled])').click();
        await right.locator('.file-row').filter({ hasText: 'hello.ini' }).waitFor({ state: 'detached' });
        await left.locator('.file-row').filter({ hasText: 'alias.dll' }).dblclick();
        await left.locator('.file-row').filter({ hasText: 'inner.mix' }).waitFor();
        await left.locator('.file-row').filter({ hasText: 'inner.mix' }).dblclick();
        await left.locator('.file-row').filter({ hasText: 'notes.ini' }).waitFor();
        assert.ok((await left.locator('.crumbs').textContent()).includes('alias.dll'));
        await target.page().screenshot({ path: output });
    } finally { await browser.close(); }
};
