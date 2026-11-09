import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const asset = process.env.BASELINE_ASSET
  ? pathToFileURL(path.resolve(process.env.BASELINE_ASSET))
  : new URL('../skills/claude-design/scripts/editor/assets/index-CLSAsUf1.js', import.meta.url);
const fixtureUrl = new URL('./fixtures/capture-mask.html', import.meta.url);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const white = [255, 255, 255, 255];
const blue = [22, 116, 200, 255];
const black = [0, 0, 0, 255];
const mask = '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><path fill="black" fill-rule="evenodd" d="M8 8h32v32H8z M16 16v16h16V16z"/></svg>';
const paint = mask.replace('fill="black"', 'fill="rgb(22,116,200)"');
const half = '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="24" height="48" fill="black"/></svg>';
const policy = "default-src 'none'; img-src 'self' data:; connect-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-eval'";

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

function failureFixture(url) {
  return `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;background:white}#fixture{display:flex;width:96px;height:48px;background:white}
.cell,.cell::before{display:block;width:48px;height:48px;flex:none}
.mask,.pseudo::before{background:rgb(22,116,200);mask:url("${url}") center/contain no-repeat}
.pseudo::before{content:""}
</style><div id="fixture"><i class="cell mask" data-case="failed-element"></i><i class="cell pseudo" data-case="failed-pseudo"></i></div>`;
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  await new Promise((resolve, reject) => server.close(error => {
    if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
    else resolve();
  }));
}

async function runFixture(browser, runtime, origin, pathname) {
  const browserContext = await browser.newContext({
    viewport: { width: 900, height: 96 }, deviceScaleFactor: 1, serviceWorkers: 'block',
  });
  try {
    const unexpectedRequests = [];
    const pageErrors = [];
    await browserContext.route('**/*', route => {
      const requestUrl = new URL(route.request().url());
      if (requestUrl.origin === origin && requestUrl.protocol === 'http:') return route.continue();
      unexpectedRequests.push(requestUrl.href);
      return route.abort('blockedbyclient');
    });
    await browserContext.addInitScript(() => {
      window.capturePolicyViolations = [];
      document.addEventListener('securitypolicyviolation', event => {
        window.capturePolicyViolations.push({ directive: event.effectiveDirective, blocked: event.blockedURI });
      });
    });
    const page = await browserContext.newPage();
    page.on('pageerror', error => pageErrors.push(error.message));
    const response = await page.goto(origin + pathname);
    const responsePolicy = response.headers()['content-security-policy'] ?? null;
    await page.evaluate(() => document.fonts.ready);
    const pristine = await page.locator('#fixture').evaluate(element => element.outerHTML);
    const screen = await page.locator('#fixture').screenshot();
    const result = await page.evaluate(async ({ runtime, screen, checkDeclarations, maskData }) => {
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
      const cases = [...document.querySelectorAll('#fixture > [data-case]')].map(element => element.dataset.case);
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
        const cells = {};
        for (const [index, name] of cases.entries()) {
          cells[name] = {
            digest: await digest(drawing.getImageData(index * 48, 0, 48, 48).data),
            ...Object.fromEntries([['corner', 2], ['edge', 10], ['center', 24], ['right', 38]]
              .map(([label, offset]) => [label, [...drawing.getImageData(index * 48 + offset, 24, 1, 1).data]])),
          };
        }
        return { size: [image.width, image.height], digest: await digest(drawing.getImageData(0, 0, image.width, image.height).data), cells };
      }
      let declarations = null;
      if (checkDeclarations) {
        const clone = document.createElement('div');
        clone.style.cssText = 'mask-image:url("/mask.svg"),linear-gradient(black,transparent);mask-size:24px 24px,contain;mask-position:2px 3px,center;background-image:url("/paint.svg");--note:"url(/paint.svg)"';
        clone.style.setProperty('mask-image', clone.style.maskImage, 'important');
        const local = document.createElement('span');
        local.style.maskImage = 'url("#local-mask")';
        const absoluteLocal = document.createElement('span');
        absoluteLocal.style.maskImage = `url("${document.URL}#local-mask")`;
        const fragment = document.createElement('span');
        fragment.style.maskImage = 'url("/sprite.svg#cutout")';
        clone.append(local, absoluteLocal, fragment);
        const css = ['[data-note="url(/mask.svg)"]::before{mask-image:url("/mask.svg"),linear-gradient(black,transparent)!important;mask-size:24px 24px,contain;mask-position:2px 3px,center;content:"url(/mask.svg)";--note:"url(/mask.svg)"}'];
        const fetched = [];
        const warnings = [];
        await runtimeExports.inlineCaptureImages(clone, async url => {
          fetched.push(url);
          return maskData;
        }, runtimeExports.collectCssImageUrls, runtimeExports.replaceCssImageUrls, css, warnings);
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(css[0]);
        const rule = sheet.cssRules[0];
        function properties(style) {
          return {
            images: style.maskImage, size: style.maskSize, position: style.maskPosition,
            priority: style.getPropertyPriority('mask-image'), note: style.getPropertyValue('--note'),
          };
        }
        declarations = {
          inline: properties(clone.style), pseudo: properties(rule.style),
          content: rule.style.content, selector: rule.selectorText,
          background: clone.style.backgroundImage, local: local.style.maskImage,
          absoluteLocal: absoluteLocal.style.maskImage, fragment: fragment.style.maskImage,
          fetched, warnings,
        };
      }
      const parsed = new DOMParser().parseFromString(markup.m, 'application/xml');
      const embeddedStyle = document.createElement('div').style;
      embeddedStyle.cssText = parsed.querySelector('[data-case="element-standard"]')?.getAttribute('style') ?? '';
      return {
        pngWarnings: png.w, markupWarnings: markup.warn, embeddedMask: embeddedStyle.maskImage,
        screen: await sample(screen), exported: await sample(png.u), declarations,
        xmlError: parsed.querySelector('parsererror')?.textContent ?? null,
      };
    }, {
      runtime, screen: 'data:image/png;base64,' + screen.toString('base64'),
      checkDeclarations: pathname === '/', maskData: 'data:image/svg+xml;base64,' + Buffer.from(mask).toString('base64'),
    });
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
    const violations = await page.evaluate(() => window.capturePolicyViolations);
    const unchanged = await page.locator('#fixture').evaluate(element => element.outerHTML) === pristine;
    assert.equal(unchanged, true, 'capture must not mutate source DOM');
    assert.deepEqual(pageErrors, [], 'capture must not throw page errors');
    assert.deepEqual(unexpectedRequests, [], 'browser must not attempt requests outside the fixture origin');
    assert.equal(result.xmlError, null, 'capture markup must remain valid XML');
    return { ...result, violations, responsePolicy };
  } finally {
    await browserContext.close();
  }
}

test('bundled CSS mask capture uses only synthetic loopback resources', { timeout: 90000 }, async context => {
  const playwright = await loadPlaywright();
  const [bytes, fixture] = await Promise.all([readFile(asset), readFile(fixtureUrl)]);
  const runtime = extractRuntime(bytes);
  const blockedRequests = [];
  const requests = [];
  const blockedServer = createServer((request, response) => {
    blockedRequests.push(request.url);
    response.writeHead(200, { 'Content-Type': 'image/svg+xml' }).end(mask);
  });
  let blockedOrigin;
  const server = createServer((request, response) => {
    requests.push(request.url);
    if (request.url === '/favicon.ico') return response.writeHead(204).end();
    const resources = { '/mask.svg': mask, '/half.svg': half, '/paint.svg': paint };
    if (Object.hasOwn(resources, request.url)) {
      return response.writeHead(200, { 'Content-Type': 'image/svg+xml' }).end(resources[request.url]);
    }
    if (request.url === '/') {
      return response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(fixture);
    }
    if (request.url === '/missing') {
      return response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(failureFixture('/missing-mask.svg'));
    }
    if (request.url === '/csp') {
      return response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': policy,
      }).end(failureFixture(blockedOrigin + '/blocked-mask.svg'));
    }
    response.writeHead(404, { 'Content-Type': 'text/plain' }).end('synthetic missing resource');
  });
  let browser;
  try {
    blockedOrigin = await listen(blockedServer);
    const origin = await listen(server);
    browser = await playwright.chromium.launch({
      headless: true,
      ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    });
    console.log(`Chromium ${browser.version()}; asset SHA-256 ${sha256(bytes)}; fixture SHA-256 ${sha256(fixture)}; baseline override ${Boolean(process.env.BASELINE_ASSET)}`);
    await context.test('standard/webkit elements, pseudos, multilayer and controls match screen RGBA', async checks => {
      const result = await runFixture(browser, runtime, origin, '/');
      const names = Object.keys(result.screen.cells);
      console.log(`Mask RGBA mismatches: ${names.filter(name => result.screen.cells[name].digest !== result.exported.cells[name].digest).join(', ') || 'none'}`);
      await checks.test('screen contains the intended shapes, not accidental solid blocks', () => {
        assert.equal(names.length, 14);
        assert.deepEqual(result.screen.size, [672, 48]);
        for (const name of names.filter(name => !name.startsWith('intentional-') && name !== 'local-svg-mask')) {
          const cell = result.screen.cells[name];
          assert.deepEqual(cell.corner, white, name);
          assert.deepEqual(cell.center, white, name);
          assert.deepEqual(cell.edge, blue, name);
          assert.deepEqual(cell.right, name.startsWith('multilayer-') ? white : blue, name);
        }
        assert.deepEqual(result.screen.cells['local-svg-mask'].corner, white);
        assert.deepEqual(result.screen.cells['local-svg-mask'].center, blue);
        for (const point of ['corner', 'edge', 'center', 'right']) {
          assert.deepEqual(result.screen.cells['intentional-solid'][point], blue);
          assert.deepEqual(result.screen.cells['intentional-black'][point], black);
        }
      });
      for (const name of names) {
        await checks.test(`${name}: complete cell RGBA equals screen`, () => {
          assert.deepEqual(result.exported.cells[name], result.screen.cells[name]);
        });
      }
      await checks.test('entire PNG equals screen, without warnings or policy violations', () => {
        assert.deepEqual(result.exported, result.screen);
        assert.deepEqual(result.pngWarnings, []);
        assert.deepEqual(result.markupWarnings, []);
        assert.deepEqual(result.violations, []);
        assert.match(result.embeddedMask, /^url\("data:image\/svg\+xml;base64,/);
      });
      await checks.test('embedding preserves declarations, fragments and non-resource strings', () => {
        const declarations = result.declarations;
        assert.deepEqual(declarations.warnings, []);
        for (const style of [declarations.inline, declarations.pseudo]) {
          assert.match(style.images, /data:image\/svg\+xml;base64,/);
          assert.match(style.images, /linear-gradient/);
          assert.equal(style.priority, 'important');
          assert.equal(style.size, '24px 24px, contain');
          assert.equal(style.position, '2px 3px, center center');
        }
        assert.equal(declarations.inline.note, '"url(/paint.svg)"');
        assert.equal(declarations.pseudo.note, '"url(/mask.svg)"');
        assert.equal(declarations.content, '"url(/mask.svg)"');
        assert.equal(declarations.selector, '[data-note="url(/mask.svg)"]::before');
        assert.match(declarations.background, /^url\("data:image\/svg\+xml;base64,/);
        assert.equal(declarations.local, 'url("#local-mask")');
        assert.equal(declarations.absoluteLocal, 'url("#local-mask")');
        assert.equal(declarations.fragment, 'url("data:image/svg+xml;base64,' + Buffer.from(mask).toString('base64') + '#cutout")');
        assert.ok(declarations.fetched.some(url => url.endsWith('/sprite.svg')));
        assert.ok(declarations.fetched.every(url => !url.includes('#')), 'fragments must not be fetched');
      });
    });
    await context.test('404 mask warns once per capture instead of silently claiming fidelity', async () => {
      const result = await runFixture(browser, runtime, origin, '/missing');
      for (const warnings of [result.pngWarnings, result.markupWarnings]) {
        assert.equal(warnings.length, 1, 'shared missing mask must produce a deduplicated warning');
        assert.match(warnings[0], /image could not be embedded.*\/missing-mask\.svg/);
      }
      for (const cell of Object.values(result.screen.cells)) assert.deepEqual(cell.center, white);
      assert.notEqual(result.exported.digest, result.screen.digest, 'missing resource PNG is not faithful');
      assert.ok(requests.includes('/missing-mask.svg'), 'synthetic server must receive the failing request');
    });
    await context.test('CSP blocks cross-origin mask fetch without relaxing policy or leaking network', async () => {
      const result = await runFixture(browser, runtime, origin, '/csp');
      assert.equal(result.responsePolicy, policy);
      for (const warnings of [result.pngWarnings, result.markupWarnings]) {
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /image could not be embedded/);
        assert.ok(warnings[0].includes(blockedOrigin + '/blocked-mask.svg'));
      }
      for (const directive of ['img-src', 'connect-src']) {
        assert.ok(result.violations.some(event => event.directive === directive && event.blocked === blockedOrigin + '/blocked-mask.svg'), `${directive} must enforce the original policy`);
      }
      assert.deepEqual(blockedRequests, [], 'CSP-blocked loopback origin must receive no requests');
    });
  } finally {
    try {
      await browser?.close();
    } finally {
      await Promise.all([close(server), close(blockedServer)]);
    }
  }
});
