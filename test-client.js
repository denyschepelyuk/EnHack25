// test-client.js
// Test client: prints "<endpoint> - OK" or "<endpoint>:\n  FAILED - ..."
// and exits with code 1 if anything failed.
//
// Requires Node 18+ (for global fetch)

const { encodeMessage, decodeMessage } = require('./galacticbuf');

const BASE_URL = 'http://localhost:8080';

async function sendGalactic(method, path, bodyObj, token) {
    const url = BASE_URL + path;

    const init = {
        method,
        headers: {}
    };

    if (bodyObj) {
        const buf = encodeMessage(bodyObj);
        init.body = buf;
        init.headers['Content-Type'] = 'application/x-galacticbuf';
    }

    if (token) {
        init.headers['Authorization'] = `Bearer ${token}`;
    }

    const res = await fetch(url, init);
    const status = res.status;
    const contentType = res.headers.get('content-type') || '';

    let decoded = null;
    if (contentType && contentType.startsWith('application/x-galacticbuf')) {
        const arrayBuf = await res.arrayBuffer();
        const nodeBuf = Buffer.from(arrayBuf);
        decoded = decodeMessage(nodeBuf);
    } else {
        decoded = await res.text();
    }

    return { status, decoded };
}

// --- step tracking ---

const results = [];
let currentStepLabel = null;
let stepFailed = false;
let stepErrorDetail = null;

function ensure(condition, message, detail) {
    if (!condition && !stepFailed) {
        stepFailed = true;
        stepErrorDetail = {
            message,
            ...(detail || {})
        };
    }
}

async function runStep(label, fn) {
    currentStepLabel = label;
    stepFailed = false;
    stepErrorDetail = null;

    try {
        await fn();
    } catch (err) {
        if (!stepFailed) {
            stepFailed = true;
            stepErrorDetail = {
                message: 'Unhandled error',
                error: String(err)
            };
        }
    }

    results.push({
        label,
        status: stepFailed ? 'FAILED' : 'OK',
        detail: stepErrorDetail
    });
}

// --- main test flow ---

async function main() {
    // unique username each run
    const username = 'alice-' + Date.now();
    const originalPassword = 'password123';
    const newPassword = 'password456';

    const deliveryStart = 3600000; // 1h
    const deliveryEnd = 7200000;   // 2h

    // 1) GET /health
    await runStep('GET /health', async () => {
        const res = await fetch(BASE_URL + '/health');
        const text = await res.text();
        ensure(
            res.status === 200,
            'health check status',
            { expected: 200, got: res.status, body: text }
        );
    });

    // 2) POST /register
    await runStep('POST /register', async () => {
        const reg = await sendGalactic('POST', '/register', {
            username,
            password: originalPassword
        });

        ensure(
            reg.status === 204,
            'register status (expected 204 for new user)',
            { expectedStatus: 204, gotStatus: reg.status, body: reg.decoded }
        );
    });

    let token1 = null;
    let token2 = null;

    // 3) POST /login (original password)
    await runStep('POST /login (original password)', async () => {
        const login1 = await sendGalactic('POST', '/login', {
            username,
            password: originalPassword
        });

        ensure(
            login1.status === 200 &&
            login1.decoded &&
            typeof login1.decoded.token === 'string',
            'login (original password)',
            { expectedStatus: 200, gotStatus: login1.status, body: login1.decoded }
        );

        if (!stepFailed) {
            token1 = login1.decoded.token;
        }
    });

    // 4) POST /orders (token1)
    await runStep('POST /orders (token1)', async () => {
        const createOrder1 = await sendGalactic(
            'POST',
            '/orders',
            {
                price: 100,
                quantity: 5,
                delivery_start: deliveryStart,
                delivery_end: deliveryEnd
            },
            token1
        );

        ensure(
            createOrder1.status === 200 &&
            createOrder1.decoded &&
            createOrder1.decoded.order_id,
            'create order with token1',
            { expectedStatus: 200, gotStatus: createOrder1.status, body: createOrder1.decoded }
        );
    });

    // 5) PUT /user/password
    await runStep('PUT /user/password', async () => {
        const changePasswordRes = await sendGalactic(
            'PUT',
            '/user/password',
            {
                username,
                old_password: originalPassword,
                new_password: newPassword
            }
        );

        ensure(
            changePasswordRes.status === 204,
            'change password status',
            { expectedStatus: 204, gotStatus: changePasswordRes.status, body: changePasswordRes.decoded }
        );
    });

    // 6) POST /orders (old token1, expected 401)
    await runStep('POST /orders (old token1, should be 401)', async () => {
        const createOrderOldToken = await sendGalactic(
            'POST',
            '/orders',
            {
                price: 200,
                quantity: 3,
                delivery_start: deliveryStart,
                delivery_end: deliveryEnd
            },
            token1
        );

        ensure(
            createOrderOldToken.status === 401,
            'old token still valid after password change (should be invalid)',
            {
                expectedStatus: 401,
                gotStatus: createOrderOldToken.status,
                body: createOrderOldToken.decoded
            }
        );
    });

    // 7) POST /login (new password)
    await runStep('POST /login (new password)', async () => {
        const login2 = await sendGalactic('POST', '/login', {
            username,
            password: newPassword
        });

        ensure(
            login2.status === 200 &&
            login2.decoded &&
            typeof login2.decoded.token === 'string',
            'login with new password',
            { expectedStatus: 200, gotStatus: login2.status, body: login2.decoded }
        );

        if (!stepFailed) {
            token2 = login2.decoded.token;
        }
    });

    // 8) POST /orders (token2)
    await runStep('POST /orders (token2)', async () => {
        const createOrder2 = await sendGalactic(
            'POST',
            '/orders',
            {
                price: 150,
                quantity: 10,
                delivery_start: deliveryStart,
                delivery_end: deliveryEnd
            },
            token2
        );

        ensure(
            createOrder2.status === 200 &&
            createOrder2.decoded &&
            createOrder2.decoded.order_id,
            'create order with token2',
            { expectedStatus: 200, gotStatus: createOrder2.status, body: createOrder2.decoded }
        );
    });

    // --- summary output ---
    let anyFailed = false;

    for (const r of results) {
        if (r.status === 'OK') {
            console.log(`${r.label} - OK`);
        } else {
            anyFailed = true;
            console.log(`${r.label}:`);
            console.log(`  FAILED - ${r.detail?.message || 'unknown error'}`);
            console.log(
                '  DETAILS:',
                JSON.stringify(r.detail, null, 2)
            );
        }
    }

    if (anyFailed) {
        process.exit(1);
    } else {
        process.exit(0);
    }
}

main().catch((err) => {
    console.error('UNEXPECTED ERROR:', err);
    process.exit(1);
});
