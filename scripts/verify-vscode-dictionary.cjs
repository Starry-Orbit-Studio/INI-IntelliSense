const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const fs = require('node:fs');

module.exports = async function verifyDictionary(port, output) {
    const browser = await chromium.connectOverCDP('http://127.0.0.1:' + port);
    try {
        let frame;
        for (let attempt = 0; attempt < 100 && !frame; attempt++) {
            for (const page of browser.contexts().flatMap(context => context.pages())) {
                for (const candidate of page.frames()) {
                    if (await candidate.locator('.dictionary-type-list button').count()) { frame = candidate; break; }
                }
            }
            if (!frame) { await new Promise(resolve => setTimeout(resolve, 150)); }
        }
        assert.ok(frame, 'Native custom dictionary editor renders');
        const search = frame.locator('input[type=search]');
        await search.fill('FLH');
        assert.ok(await frame.locator('.dictionary-type-list button').count());
        const vehicle = frame.locator('.dictionary-type-list button').filter({ hasText: /^VehicleType$/ });
        await vehicle.click();
        await frame.locator('.dictionary-tag-list button').first().waitFor();
        assert.ok((await frame.locator('.dictionary-tag-list').textContent()).includes('FLH'));
        await frame.locator('.dictionary-tag-list button').first().click();
        await frame.locator('.dictionary-description textarea').waitFor();
        assert.equal(await frame.locator('button[data-action=apply]').isDisabled(), true);
        assert.equal(await frame.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
        fs.mkdirSync(require('node:path').dirname(output), { recursive: true });
        await frame.page().screenshot({ path: output });
        return { types: await frame.locator('.dictionary-type-list button').count(), tags: await frame.locator('.dictionary-tag-list button').count() };
    } finally { await browser.close(); }
};

if (require.main === module) {
    module.exports(Number(process.argv[2]), process.argv[3]).then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error); process.exit(1); });
}
