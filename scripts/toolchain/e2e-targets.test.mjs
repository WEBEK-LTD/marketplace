// Where the smoke run points (`packages/e2e/urls.ts`).
//
// The module resolves its targets once, at load, from the environment, so each case re-imports it with a fresh
// cache key. Node strips the types; nothing is built for this.
//
// The property worth protecting is the refusal: a malformed deployment URL must fail the run, not fall back to
// localhost. A suite that quietly visited local servers after a typo would report a green deployment nobody
// deployed, which is the one outcome worse than a red one.
//
// **0108 kept that refusal rather than relaxing it** (owner decision DR-7). There is one deployment now, serving the
// marketplace at `/` and the console at `/admin`, and the tempting way to say so would have been to let a target
// carry a path. A path-bearing target is still refused — the case is still here — and the console is expressed as
// the web origin plus `ADMIN_PATH_PREFIX` instead. `E2E_ADMIN_URL` no longer exists: a second target would have to
// name a second deployment, and there is not one.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const MODULE = new URL('../../packages/e2e/urls.ts', import.meta.url);

let loads = 0;

/** The module as it resolves under exactly this environment. */
async function load(env) {
  const saved = { E2E_WEB_URL: process.env['E2E_WEB_URL'], E2E_ADMIN_URL: process.env['E2E_ADMIN_URL'] };
  for (const name of ['E2E_WEB_URL', 'E2E_ADMIN_URL']) {
    if (env[name] === undefined) delete process.env[name];
    else process.env[name] = env[name];
  }
  try {
    loads += 1;
    return await import(`${MODULE.href}?case=${loads}`);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('with nothing set, the target is the local server the config starts', async () => {
  const urls = await load({});
  assert.equal(urls.WEB_URL, 'http://127.0.0.1:3100');
  assert.equal(urls.WEB_IS_LOCAL, true);
  assert.equal(urls.HAS_DEPLOYED_TARGET, false);
  assert.equal(urls.WEB_PORT, 3100);
});

test('the console is the web origin plus the mount point, on every target', async () => {
  // The whole of the 0108 topology, stated once: one origin, two surfaces, and the console's address derived
  // rather than configured. A separate target for it is not merely unset — it cannot exist.
  const local = await load({});
  assert.equal(local.ADMIN_PATH_PREFIX, '/admin');
  assert.equal(local.ADMIN_URL, 'http://127.0.0.1:3100/admin');

  const deployed = await load({ E2E_WEB_URL: 'https://web-site.netlify.app' });
  assert.equal(deployed.WEB_URL, 'https://web-site.netlify.app');
  assert.equal(deployed.ADMIN_URL, 'https://web-site.netlify.app/admin');
  assert.equal(deployed.WEB_IS_LOCAL, false);
  assert.equal(deployed.HAS_DEPLOYED_TARGET, true);
});

test('there is no separate admin target, and setting one changes nothing', async () => {
  // `E2E_ADMIN_URL` is not read any more. A value left over in somebody's shell must not silently redirect the
  // console half of the run at a deployment that no longer exists — it must be ignored outright.
  const urls = await load({ E2E_ADMIN_URL: 'https://admin-site.netlify.app' });
  assert.equal(urls.WEB_URL, 'http://127.0.0.1:3100');
  assert.equal(urls.ADMIN_URL, 'http://127.0.0.1:3100/admin');
  assert.equal(urls.WEB_IS_LOCAL, true);
  assert.equal(urls.ADMIN_PORT, undefined);
  assert.equal(urls.ADMIN_IS_LOCAL, undefined);
});

test('one deployed target means nothing is started locally', async () => {
  const urls = await load({ E2E_WEB_URL: 'https://web-site.netlify.app' });
  assert.equal(urls.WEB_IS_LOCAL, false);
});

test('a trailing slash and an empty value are not configuration mistakes', async () => {
  // A trailing slash is how a browser's address bar writes an origin; it is normalised, not refused.
  const slash = await load({ E2E_WEB_URL: 'https://web-site.netlify.app/' });
  assert.equal(slash.WEB_URL, 'https://web-site.netlify.app');

  // An empty or whitespace value is an unset variable in every shell that has ever exported one.
  for (const value of ['', '   ']) {
    const blank = await load({ E2E_WEB_URL: value });
    assert.equal(blank.WEB_URL, 'http://127.0.0.1:3100');
    assert.equal(blank.WEB_IS_LOCAL, true);
  }
});

test('a port and plain http are accepted, for a target that is not on Netlify', async () => {
  const urls = await load({ E2E_WEB_URL: 'http://staging.internal:8080' });
  assert.equal(urls.WEB_URL, 'http://staging.internal:8080');
  assert.equal(urls.WEB_IS_LOCAL, false);
});

test('a malformed target fails the run rather than falling back to localhost', async () => {
  const refused = [
    'not a url',
    'web-site.netlify.app',
    'ftp://web-site.netlify.app',
    'file:///tmp/x',
    'https://user:pass@web-site.netlify.app',
    'https://web-site.netlify.app/staging',
    'https://web-site.netlify.app/?x=1',
    'https://web-site.netlify.app/#top',
  ];
  for (const value of refused) {
    await assert.rejects(() => load({ E2E_WEB_URL: value }), /E2E_WEB_URL/, value);
  }
});

test('the refusal names the variable that is wrong', async () => {
  await assert.rejects(() => load({ E2E_WEB_URL: 'nope' }), /E2E_WEB_URL/);
  // And it says what was wrong with it, not merely that something was.
  await assert.rejects(
    () => load({ E2E_WEB_URL: 'https://web-site.netlify.app/staging' }),
    /must be an origin with no path \(found \/staging\)/,
  );
});
