// Built-UI contract tests, not backend authorization tests. All requests are intercepted;
// credentials and reset context exist only in memory, without traces or a mail server.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { chromium } from '@playwright/test';

let browser;
let html;
before(async () => {
    assert.ok(
        !process.env.DEBUG && !process.env.PWDEBUG,
        'Run without browser/protocol debug logging',
    );
    html = await readFile(
        new URL('../../templates/html/users/{id}/reset/reset.html', import.meta.url),
        'utf8',
    );
    browser = await chromium.launch({
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    });
});
after(async () => browser?.close());

for (const scenario of ['password-only', 'passkey', 'start-rejected', 'finish-rejected']) {
    test(`reset page: ${scenario}`, async t => {
        const context = await browser.newContext({ serviceWorkers: 'block' });
        t.after(() => context.close());
        const page = await context.newPage();
        const tpl = {
            user_id: 'reset-user',
            magic_link_id: crypto.randomUUID(),
            csrf_token: crypto.randomUUID(),
            needs_mfa: scenario !== 'password-only',
            password_policy: {
                length_min: 12,
                length_max: 128,
                include_lower_case: 1,
                include_upper_case: 1,
                include_digits: 1,
                include_special: 1,
            },
        };
        let challengeCode;
        let mfaCode;
        let rejected = false;
        const requests = [];
        const documentPath = '/auth/v1/users/reset-user/reset/reset';
        await context.route('**/*', async route => {
            const request = route.request();
            const url = new URL(request.url());
            if (url.origin !== 'http://localhost') return route.abort();
            if (request.method() === 'GET' && url.pathname === documentPath) {
                return route.fulfill({
                    contentType: 'text/html',
                    body: html.replace(
                        /\{%- for tpl in templates -%\}[\s\S]*?\{%- endfor %\}/,
                        `<template id="tpl_password_reset">${JSON.stringify(tpl)}</template>`,
                    ),
                });
            }
            if (
                /^\/auth\/v1\/_app\/immutable\/(entry|chunks|nodes|assets)\/[\w.-]+\.(js|css|woff2)$/.test(
                    url.pathname,
                )
            ) {
                return route.fulfill({
                    path: fileURLToPath(
                        new URL(`../../static/v1/${url.pathname.slice(9)}`, import.meta.url),
                    ),
                });
            }
            if (request.method() === 'GET') return route.fulfill({ status: 404 });
            requests.push(`${request.method()} ${url.pathname}`);
            if (url.pathname === '/auth/v1/users/reset-user/webauthn/auth/start') {
                assert.deepEqual(request.postDataJSON(), { purpose: 'PasswordReset' });
                if (scenario === 'start-rejected' && !rejected) {
                    rejected = true;
                    return route.fulfill({
                        status: 400,
                        json: { message: 'Reset binding rejected' },
                    });
                }
                challengeCode = crypto.randomUUID();
                return route.fulfill({
                    json: {
                        code: challengeCode,
                        exp: 60,
                        rcr: {
                            publicKey: {
                                challenge: btoa(crypto.randomUUID()),
                                rpId: 'localhost',
                                userVerification: 'required',
                            },
                        },
                    },
                });
            }
            if (url.pathname === '/auth/v1/users/webauthn_finish') {
                assert.ok(request.postDataJSON().code === challengeCode);
                if (scenario === 'finish-rejected' && !rejected) {
                    rejected = true;
                    return route.fulfill({
                        status: 403,
                        json: { message: 'Verification rejected' },
                    });
                }
                mfaCode = crypto.randomUUID();
                return route.fulfill({
                    status: 202,
                    json: { code: mfaCode, user_id: tpl.user_id },
                });
            }
            if (url.pathname === '/auth/v1/users/reset-user/reset') {
                const body = request.postDataJSON();
                assert.equal(request.method(), 'PUT');
                assert.ok(body.magic_link_id === tpl.magic_link_id);
                assert.ok(request.headers()['x-pwd-csrf-token'] === tpl.csrf_token);
                assert.ok(body.mfa_code === (tpl.needs_mfa ? mfaCode : undefined));
                assert.ok(typeof body.password === 'string' && body.password.length >= 12);
                return route.fulfill({ status: 202 });
            }
            return route.fulfill({ status: 400, json: { message: 'Unexpected endpoint' } });
        });
        await page.goto(`http://localhost${documentPath}`);
        await page.locator('input[type=password]').first().waitFor();
        const cdp = await context.newCDPSession(page);
        await cdp.send('WebAuthn.enable');
        await cdp.send('WebAuthn.addVirtualAuthenticator', {
            options: {
                protocol: 'ctap2',
                transport: 'internal',
                hasResidentKey: true,
                hasUserVerification: true,
                isUserVerified: true,
                automaticPresenceSimulation: true,
            },
        });
        await page.evaluate(async needsMfa => {
            if (needsMfa) {
                await navigator.credentials.create({
                    publicKey: {
                        challenge: crypto.getRandomValues(new Uint8Array(32)),
                        rp: { name: 'Reset test', id: 'localhost' },
                        user: {
                            id: crypto.getRandomValues(new Uint8Array(16)),
                            name: 'reset-user',
                            displayName: 'Reset user',
                        },
                        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
                        authenticatorSelection: {
                            residentKey: 'required',
                            userVerification: 'required',
                        },
                    },
                });
            }
            const password = `${crypto.randomUUID()}aA1!`;
            for (const input of document.querySelectorAll('input[type=password]')) {
                input.value = password;
                input.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }, tpl.needs_mfa);
        await page.getByRole('button', { name: 'Save', exact: true }).click();
        if (scenario.endsWith('rejected')) {
            await page
                .getByText(
                    scenario === 'start-rejected'
                        ? 'Reset binding rejected'
                        : 'Verification rejected',
                    { exact: true },
                )
                .first()
                .waitFor();
        } else {
            await page.getByRole('link', { name: 'Account', exact: true }).waitFor();
        }
        const expected = [];
        if (tpl.needs_mfa) expected.push('POST /auth/v1/users/reset-user/webauthn/auth/start');
        if (tpl.needs_mfa && scenario !== 'start-rejected')
            expected.push('POST /auth/v1/users/webauthn_finish');
        if (!scenario.endsWith('rejected')) expected.push('PUT /auth/v1/users/reset-user/reset');
        assert.deepEqual(requests, expected);
        if (scenario.endsWith('rejected')) {
            await page.getByRole('button', { name: 'Save', exact: true }).click();
            await page.getByRole('link', { name: 'Account', exact: true }).waitFor();
            assert.deepEqual(requests.slice(expected.length), [
                'POST /auth/v1/users/reset-user/webauthn/auth/start',
                'POST /auth/v1/users/webauthn_finish',
                'PUT /auth/v1/users/reset-user/reset',
            ]);
        }
    });
}
