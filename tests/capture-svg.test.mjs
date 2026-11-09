import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const asset = process.env.BASELINE_ASSET
  ? pathToFileURL(path.resolve(process.env.BASELINE_ASSET))
  : new URL('../skills/claude-design/scripts/editor/assets/index-CLSAsUf1.js', import.meta.url);
const fixtureUrl = new URL('./fixtures/capture-svg.html', import.meta.url);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const white = [255, 255, 255, 255];
const black = [0, 0, 0, 255];
const blue = [22, 116, 200, 255];
const red = [200, 20, 50, 255];

async function loadPlaywright() {
  if (process.env.PLAYWRIGHT_MODULE) {
    const specifier = process.env.PLAYWRIGHT_MODULE;
    return import(path.isAbsolute(specifier) || specifier.startsWith('.')
      ? pathToFileURL(path.resolve(specifier)).href : specifier);
  }
  for (const name of ['playwright', 'playwright-core']) {
    try {
      return await import(name);
    } catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    }
  }
  throw new Error('Chromium regression requires playwright or playwright-core. Install one or set PLAYWRIGHT_MODULE; set CHROME_PATH if no bundled Chromium is installed. This test does not skip missing dependencies.');
}

function extractRuntime(bytes) {
  const source = bytes.toString();
  function between(start, end) {
    assert.equal(source.split(start).length, 2, `Expected one bundled runtime anchor: ${start}`);
    assert.equal(source.split(end).length, 2, `Expected one bundled runtime anchor: ${end}`);
    const startIndex = source.indexOf(start);
    const endIndex = source.indexOf(end, startIndex);
    assert.ok(endIndex > startIndex, `Runtime end must follow ${start}`);
    return source.slice(startIndex, endIndex);
  }
  return {
    helpers: between('function eH(e){', 'function dH(e){'),
    capture: between('async function _6(e,a){', 'function A6(e){'),
  };
}

test('bundled SVG capture matches actual Chromium screen pixels', { timeout: 60000 }, async context => {
  const playwright = await loadPlaywright();
  const [bytes, fixture] = await Promise.all([readFile(asset), readFile(fixtureUrl)]);
  const runtime = extractRuntime(bytes);
  const server = createServer((request, response) => {
    if (request.url === '/favicon.ico') {
      response.writeHead(204).end();
    } else if (request.url === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(fixture);
    } else if (request.url === '/inactive.css') {
      response.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' })
        .end('.import-inactive { fill: blue; }');
    } else if (request.url === '/media-red.css' || request.url === '/media-blue.css') {
      response.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' })
        .end(`.import-media { fill: ${request.url === '/media-red.css' ? 'red' : 'blue'}; }`);
    } else {
      response.writeHead(404).end();
    }
  });
  let browser;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await playwright.chromium.launch({
      headless: true,
      ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    });
    const browserContext = await browser.newContext({
      viewport: { width: 1600, height: 48 }, deviceScaleFactor: 1, serviceWorkers: 'block',
    });
    const unexpectedRequests = [];
    const pageErrors = [];
    await browserContext.route('**/*', route => {
      if (new URL(route.request().url()).origin === origin) return route.continue();
      unexpectedRequests.push(route.request().url());
      return route.abort();
    });
    const page = await browserContext.newPage();
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.emulateMedia({ media: 'screen' });
    await page.goto(origin);
    const pristine = await page.locator('#fixture').evaluate(element => element.outerHTML);
    const screen = await page.locator('#fixture').screenshot();
    const result = await page.evaluate(async ({ runtime, screen }) => {
      const importRule = document.querySelector('#inactive-import').sheet.cssRules[0];
      const importState = {
        media: importRule.media.mediaText,
        ruleCount: importRule.styleSheet?.cssRules.length ?? 0,
        matches: matchMedia(importRule.media.mediaText).matches,
      };
      const runtimeExports = {};
      function registerGetter(target, key, getter) {
        Object.defineProperty(target, key, { get: getter });
      }
      new Function('runtimeExports', 't', runtime.helpers +
        ';eH(runtimeExports);tH(runtimeExports);nH(runtimeExports);rH(runtimeExports);' +
        'lH(runtimeExports);oH(runtimeExports);sH(runtimeExports);iH(runtimeExports);cH(runtimeExports);')
        (runtimeExports, registerGetter);
      const dependencies = {
        resolveSelectionRoot: runtimeExports.captureSelectionSvg,
        maxCaptureSide: 12000, maxCapturePixels: 120000000,
        collectFontFaceRules: runtimeExports.resolveCaptureFonts,
        warnUnembeddedFonts: runtimeExports.collectUsedFontFaces,
        collectBackgroundUrls: runtimeExports.collectCssImageUrls,
        inlineImages: runtimeExports.inlineCaptureImages,
        replaceBackgroundUrls: runtimeExports.replaceCssImageUrls,
        makeCloneStyled: runtimeExports.captureElementStyle,
        prepareWebGlCapture: runtimeExports.prepareWebGlCanvasCapture,
        settleFrozenAnimations: runtimeExports.captureAnimationStates,
        freezeAnimations: runtimeExports.captureAnimationStyles,
        sanitizeXmlCharacters: runtimeExports.sanitizeXmlCharacters,
      };
      const capture = new Function(`return (${runtime.capture});`)();
      const options = {
        layout: { zoom: 0, dpr: 0 }, format: 'image/png', scale: 1,
        selection: 1, selectionRoot: '#fixture', selectionBackground: '#fff',
      };
      const png = await capture(options, dependencies);
      const markup = await capture({ ...options, markup: true }, dependencies);
      const cases = [...document.querySelectorAll('#fixture > svg')].map(element => element.dataset.case);
      async function digest(pixels) {
        return [...new Uint8Array(await crypto.subtle.digest('SHA-256', pixels))]
          .map(value => value.toString(16).padStart(2, '0')).join('');
      }
      async function sample(url) {
        const image = new Image();
        image.src = url;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const drawing = canvas.getContext('2d');
        drawing.drawImage(image, 0, 0);
        const pixels = drawing.getImageData(0, 0, image.width, image.height).data;
        const icons = {};
        for (const [index, name] of cases.entries()) {
          icons[name] = {
            digest: await digest(drawing.getImageData(index * 48, 0, 48, 48).data),
            ...Object.fromEntries([['center', 24], ['edge', 6], ['left', 12], ['right', 36]]
              .map(([label, offset]) => [label, [...drawing.getImageData(index * 48 + offset, 24, 1, 1).data]])),
          };
        }
        return { size: [image.width, image.height], digest: await digest(pixels), icons };
      }
      const documentClone = new DOMParser().parseFromString(markup.m, 'application/xml');
      const selectors = [
        '#struct-first:first-child', '#struct-nth:nth-child(2)',
        '#path-first > path:first-child', '#path-nth > path:nth-child(2)',
      ];
      return {
        png, markup, importState, screen: await sample(screen), exported: await sample(png.u),
        structure: selectors.map(selector => !!documentClone.querySelector(selector)),
        xmlError: documentClone.querySelector('parsererror')?.textContent ?? null,
      };
    }, { runtime, screen: 'data:image/png;base64,' + screen.toString('base64') });
    const unchanged = await page.locator('#fixture').evaluate(element => element.outerHTML) === pristine;
    const mismatches = Object.keys(result.screen.icons)
      .filter(name => result.screen.icons[name].digest !== result.exported.icons[name].digest);
    if (process.env.SVG_CAPTURE_EVIDENCE) {
      const directory = path.resolve(process.env.SVG_CAPTURE_EVIDENCE);
      await mkdir(directory, { recursive: true });
      await Promise.all([
        writeFile(path.join(directory, 'screen.png'), screen),
        writeFile(path.join(directory, 'export.png'), Buffer.from(result.png.u.split(',')[1], 'base64')),
        writeFile(path.join(directory, 'export.xml'), result.markup.m),
        writeFile(path.join(directory, 'pixels.json'), JSON.stringify({
          chromium: browser.version(), asset: asset.href, assetSha256: sha256(bytes),
          fixtureSha256: sha256(fixture), screen: result.screen, exported: result.exported,
          mismatches, importState: result.importState, structure: result.structure, xmlError: result.xmlError,
          pngWarnings: result.png.w, markupWarnings: result.markup.warn,
          unchanged, pageErrors, unexpectedRequests,
        }, null, 2)),
      ]);
    }
    console.log(`Chromium ${browser.version()}; asset SHA-256 ${sha256(bytes)}; mismatched cases: ${mismatches.join(', ') || 'none'}`);
    await context.test('synthetic screen has the intended paints', () => {
      const icons = result.screen.icons;
      assert.equal(Object.keys(icons).length, 28);
      assert.deepEqual(result.screen.size, [1344, 48]);
      assert.deepEqual(result.importState, { media: 'print', ruleCount: 1, matches: false });
      assert.deepEqual(icons['import-inactive'].center, black);
      assert.deepEqual(icons['layer-order'].center, [255, 0, 0, 255]);
      assert.deepEqual(icons['layer-empty'].center, [255, 0, 0, 255]);
      for (const name of ['media-rule', 'sheet-media', 'import-media']) {
        assert.deepEqual(icons[name].center, [255, 0, 0, 255], name);
      }
      for (const name of ['attribute-outline', 'inline-outline', 'group-outline']) {
        assert.deepEqual(icons[name].center, white, name);
        assert.deepEqual(icons[name].edge, blue, name);
      }
      for (const name of ['symbol-attribute-outline', 'symbol-css-outline', 'media-xlink-outline']) {
        assert.deepEqual(icons[name].center, white, name);
        assert.deepEqual(icons[name].edge, red, name);
      }
      for (const name of ['css-currentcolor', 'inline-currentcolor', 'variable-local', 'variable-chain',
        'variable-group', 'variable-important', 'struct-defs-first', 'struct-defs-nth', 'struct-symbol-first', 'struct-symbol-nth']) {
        assert.deepEqual(icons[name].center, red, name);
      }
      for (const name of ['shared-currentcolor', 'shared-variable']) {
        assert.deepEqual(icons[name].left, blue, name);
        assert.deepEqual(icons[name].right, red, name);
      }
      assert.deepEqual(icons['intentional-solid'].center, black);
      assert.deepEqual(icons.multicolor.left, blue);
      assert.deepEqual(icons.multicolor.right, red);
      assert.notDeepEqual(icons.gradient.left, icons.gradient.right);
      assert.equal(icons.gradient.center[3], 255);
      assert.deepEqual(icons.clip.left, blue);
      assert.deepEqual(icons.clip.right, white);
    });
    for (const name of Object.keys(result.screen.icons)) {
      await context.test(`${name}: export RGBA equals screen`, () => {
        assert.deepEqual(result.exported.icons[name], result.screen.icons[name]);
      });
    }
    await context.test('entire export RGBA equals screen', () => {
      assert.deepEqual(result.exported, result.screen);
    });
    await context.test('definition child positions and XML remain intact', () => {
      assert.equal(result.xmlError, null);
      assert.deepEqual(result.structure, [true, true, true, true]);
      assert.doesNotMatch(result.markup.m, /<(?:defs|symbol)\b[^>]*>\s*<style\b/);
    });
    await context.test('capture is read-only, warning-free and loopback-only', () => {
      assert.equal(unchanged, true, 'capture must not mutate source DOM');
      assert.deepEqual(result.png.w, []);
      assert.deepEqual(result.markup.warn, []);
      assert.deepEqual(pageErrors, []);
      assert.deepEqual(unexpectedRequests, []);
    });
  } finally {
    try {
      await browser?.close();
    } finally {
      await new Promise((resolve, reject) => server.close(error => {
        if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
        else resolve();
      }));
    }
  }
});
