// test-all.js
// Comprehensive test runner for the Galactic Energy Exchange
// Requires Node 18+ (for global fetch)

const {
    encodeMessage,
    decodeMessage,
    VERSION_V1
} = require('./galacticbuf');

const BASE_URL = 'http://localhost:8080';

// --------------- Helpers ---------------

async function sendGalactic(method, path, bodyObj, token, version) {
    const url = BASE_URL + path;

    const init = {
        method,
        headers: {}
    };

    if (bodyObj) {
        const buf =
            version === VERSION_V1
                ? encodeMessage(bodyObj, VERSION_V1)
                : encodeMessage(bodyObj); // default v2
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

const results = [];

async function runStep(label, fn) {
    let failed = false;
    let detail = null;
    try {
        await fn();
    } catch (err) {
        failed = true;
        if (err && err._ensureFail) {
            detail = err.detail || { message: err.message || 'ensure failed' };
        } else {
            detail = {
                message: 'Unhandled error',
                error: String(err)
            };
        }
    }
    results.push({
        label,
        status: failed ? 'FAILED' : 'OK',
        detail
    });
    if (failed) {
        console.log(`${label}:`);
        console.log('  FAILED');
        console.log('  DETAILS:', JSON.stringify(detail, null, 2));
        process.exit(1);
    } else {
        console.log(`${label} - OK`);
    }
}

function ensure(condition, label, detailObj) {
    if (!condition) {
        throw {
            _ensureFail: true,
            detail: {
                message: label,
                ...(detailObj || {})
            }
        };
    }
}

// --------------- Main Test Flow ---------------

async function main() {
    const ts = Date.now();

    // Users used in different scenarios
    const userAuth = `auth-user-${ts}`;
    const userAuthOldPassword = 'auth-oldpw';
    const userAuthNewPassword = 'auth-newpw';

    const v1Seller = `v1-seller-${ts}`;
    const v1Buyer = `v1-buyer-${ts}`;
    const v1Password = 'v1pw';

    const v2Seller = `v2-seller-${ts}`;
    const v2Buyer = `v2-buyer-${ts}`;
    const v2Password = 'v2pw';

    const ONE_HOUR_MS = 3600000;
    // pick a fresh future contract window so no old orders are in this book
    const baseHour = Math.floor(Date.now() / ONE_HOUR_MS) + 1;
    const deliveryStart = baseHour * ONE_HOUR_MS;
    const deliveryEnd = deliveryStart + ONE_HOUR_MS;

    let authToken1 = null;
    let authToken2 = null;
    let v1SellerToken = null;
    let v1BuyerToken = null;
    let v1OrderId = null;

    let v2SellerToken = null;
    let v2BuyerToken = null;
    let v2SellOrderId = null;

    // 1) Health
    await runStep('GET /health', async () => {
        const res = await fetch(BASE_URL + '/health');
        const text = await res.text();
        ensure(
            res.status === 200,
            'health check status',
            { expected: 200, got: res.status, body: text }
        );
    });

    // 2) Register auth-user (for password change tests)
    await runStep('POST /register (auth-user)', async () => {
        const r = await sendGalactic('POST', '/register', {
            username: userAuth,
            password: userAuthOldPassword
        });
        ensure(
            r.status === 204,
            'register auth-user',
            { expectedStatus: 204, gotStatus: r.status, body: r.decoded }
        );
    });

    // 3) Login auth-user (original password)
    await runStep('POST /login (auth-user, old pwd)', async () => {
        const r = await sendGalactic('POST', '/login', {
            username: userAuth,
            password: userAuthOldPassword
        });
        ensure(
            r.status === 200 && r.decoded && typeof r.decoded.token === 'string',
            'login auth-user old password',
            { expectedStatus: 200, gotStatus: r.status, body: r.decoded }
        );
        authToken1 = r.decoded.token;
    });

    // 4) Create v1 order with authToken1
    await runStep('POST /orders (v1, authToken1)', async () => {
        const r = await sendGalactic(
            'POST',
            '/orders',
            {
                price: 100,
                quantity: 5,
                delivery_start: deliveryStart,
                delivery_end: deliveryEnd
            },
            authToken1
        );
        ensure(
            r.status === 200 && r.decoded && r.decoded.order_id,
            'create v1 order with authToken1',
            { expectedStatus: 200, gotStatus: r.status, body: r.decoded }
        );
    });

    // 5) Change password for auth-user
    await runStep('PUT /user/password (auth-user)', async () => {
        const r = await sendGalactic(
            'PUT',
            '/user/password',
            {
                username: userAuth,
                old_password: userAuthOldPassword,
                new_password: userAuthNewPassword
            }
        );
        ensure(
            r.status === 204,
            'change password status',
            { expectedStatus: 204, gotStatus: r.status, body: r.decoded }
        );
    });

    // 6) Ensure old token no longer valid
    await runStep('POST /orders (v1, old authToken1, expect 401)', async () => {
        const r = await sendGalactic(
            'POST',
            '/orders',
            {
                price: 200,
                quantity: 3,
                delivery_start: deliveryStart,
                delivery_end: deliveryEnd
            },
            authToken1
        );
        ensure(
            r.status === 401,
            'old token should be invalid',
            { expectedStatus: 401, gotStatus: r.status, body: r.decoded }
        );
    });

    // 7) Login auth-user with new password
    await runStep('POST /login (auth-user, new pwd)', async () => {
        const r = await sendGalactic('POST', '/login', {
            username: userAuth,
            password: userAuthNewPassword
        });
        ensure(
            r.status === 200 && r.decoded && typeof r.decoded.token === 'string',
            'login auth-user new password',
            { expectedStatus: 200, gotStatus: r.status, body: r.decoded }
        );
        authToken2 = r.decoded.token;
    });

    // 8) Create v1 order with new token
    await runStep('POST /orders (v1, authToken2)', async () => {
        const r = await sendGalactic(
            'POST',
            '/orders',
            {
                price: 150,
                quantity: 7,
                delivery_start: deliveryStart,
                delivery_end: deliveryEnd
            },
            authToken2
        );
        ensure(
            r.status === 200 && r.decoded && r.decoded.order_id,
            'create v1 order with authToken2',
            { expectedStatus: 200, gotStatus: r.status, body: r.decoded }
        );
    });

    // ---------- V1 Trading: Create, list, take, trades ----------

    // 9) Register v1 seller
    await runStep('POST /register (v1 seller)', async () => {
        const r = await sendGalactic('POST', '/register', {
            username: v1Seller,
            password: v1Password
        });
        ensure(
            r.status === 204,
            'register v1 seller',
            { expectedStatus: 204, gotStatus: r.status, body: r.decoded }
        );
    });

    // 10) Register v1 buyer
    await runStep('POST /register (v1 buyer)', async () => {
        const r = await sendGalactic('POST', '/register', {
            username: v1Buyer,
            password: v1Password
        });
        ensure(
            r.status === 204,
            'register v1 buyer',
            { expectedStatus: 204, gotStatus: r.status, body: r.decoded }
        );
    });

    // 11) Login v1 seller
    await runStep('POST /login (v1 seller)', async () => {
        const r = await sendGalactic('POST', '/login', {
            username: v1Seller,
            password: v1Password
        });
        ensure(
            r.status === 200 && r.decoded && r.decoded.token,
            'login v1 seller',
            { expectedStatus: 200, gotStatus: r.status, body: r.decoded }
        );
        v1SellerToken = r.decoded.token;
    });

    // 12) Login v1 buyer
    await runStep('POST /login (v1 buyer)', async () => {
        const r = await sendGalactic('POST', '/login', {
            username: v1Buyer,
            password: v1Password
        });
        ensure(
            r.status === 200 && r.decoded && r.decoded.token,
            'login v1 buyer',
            { expectedStatus: 200, gotStatus: r.status, body: r.decoded }
        );
        v1BuyerToken = r.decoded.token;
    });

    // 13) v1 seller creates SELL order
    await runStep('POST /orders (v1 seller)', async () => {
        const r = await sendGalactic(
            'POST',
            '/orders',
            {
                price: 123,
                quantity: 10,
                delivery_start: deliveryStart,
                delivery_end: deliveryEnd
            },
            v1SellerToken
        );
        ensure(
            r.status === 200 && r.decoded && r.decoded.order_id,
            'v1 seller create order',
            { expectedStatus: 200, gotStatus: r.status, body: r.decoded }
        );
        v1OrderId = r.decoded.order_id;
    });

    // 14) GET /orders shows that v1 order
    await runStep('GET /orders (v1 list contains seller order)', async () => {
        const url = `/orders?delivery_start=${deliveryStart}&delivery_end=${deliveryEnd}`;
        const res = await fetch(BASE_URL + url);
        const status = res.status;
        const ctype = res.headers.get('content-type') || '';
        let decoded;
        if (ctype.startsWith('application/x-galacticbuf')) {
            const ab = await res.arrayBuffer();
            const buf = Buffer.from(ab);
            decoded = decodeMessage(buf);
        } else {
            decoded = await res.text();
        }

        ensure(
            status === 200,
            'GET /orders status',
            { expectedStatus: 200, gotStatus: status, body: decoded }
        );
        ensure(
            decoded && Array.isArray(decoded.orders),
            'GET /orders response structure',
            { body: decoded }
        );
        const found = decoded.orders.some((o) => o.order_id === v1OrderId);
        ensure(
            found,
            'v1 order should be present in /orders',
            { orderId: v1OrderId, orders: decoded.orders }
        );
    });

    // 15) v1 buyer takes that order via POST /trades
    await runStep('POST /trades (take v1 order)', async () => {
        const r = await sendGalactic(
            'POST',
            '/trades',
            { order_id: v1OrderId },
            v1BuyerToken
        );
        ensure(
            r.status === 200 && r.decoded && r.decoded.trade_id,
            'take v1 order',
            { expectedStatus: 200, gotStatus: r.status, body: r.decoded }
        );
    });

    // 16) GET /orders no longer contains that v1 order
    await runStep('GET /orders (v1 order removed after trade)', async () => {
        const url = `/orders?delivery_start=${deliveryStart}&delivery_end=${deliveryEnd}`;
        const res = await fetch(BASE_URL + url);
        const status = res.status;
        const ctype = res.headers.get('content-type') || '';
        let decoded;
        if (ctype.startsWith('application/x-galacticbuf')) {
            const ab = await res.arrayBuffer();
            const buf = Buffer.from(ab);
            decoded = decodeMessage(buf);
        } else {
            decoded = await res.text();
        }

        ensure(
            status === 200,
            'GET /orders status after trade',
            { expectedStatus: 200, gotStatus: status, body: decoded }
        );
        ensure(
            decoded && Array.isArray(decoded.orders),
            'GET /orders response structure after trade',
            { body: decoded }
        );
        const found = decoded.orders.some((o) => o.order_id === v1OrderId);
        ensure(
            !found,
            'v1 order should NOT be present in /orders after trade',
            { orderId: v1OrderId, orders: decoded.orders }
        );
    });

    // 17) GET /trades has at least one trade
    await runStep('GET /trades (has trades)', async () => {
        const res = await fetch(BASE_URL + '/trades');
        const status = res.status;
        const ctype = res.headers.get('content-type') || '';
        let decoded;
        if (ctype.startsWith('application/x-galacticbuf')) {
            const ab = await res.arrayBuffer();
            const buf = Buffer.from(ab);
            decoded = decodeMessage(buf);
        } else {
            decoded = await res.text();
        }

        ensure(
            status === 200,
            'GET /trades status',
            { expectedStatus: 200, gotStatus: status, body: decoded }
        );
        ensure(
            decoded && Array.isArray(decoded.trades),
            'GET /trades structure',
            { body: decoded }
        );
        ensure(
            decoded.trades.length >= 1,
            'at least one trade expected',
            { trades: decoded.trades }
        );
    });

    // ---------- V2 Matching & Order Book & My Orders ----------

    // 18) Register v2 seller
    await runStep('POST /register (v2 seller)', async () => {
        const r = await sendGalactic('POST', '/register', {
            username: v2Seller,
            password: v2Password
        });
        ensure(
            r.status === 204,
            'register v2 seller',
            { expectedStatus: 204, gotStatus: r.status, body: r.decoded }
        );
    });

    // 19) Register v2 buyer
    await runStep('POST /register (v2 buyer)', async () => {
        const r = await sendGalactic('POST', '/register', {
            username: v2Buyer,
            password: v2Password
        });
        ensure(
            r.status === 204,
            'register v2 buyer',
            { expectedStatus: 204, gotStatus: r.status, body: r.decoded }
        );
    });

    // 20) Login v2 seller
    await runStep('POST /login (v2 seller)', async () => {
        const r = await sendGalactic('POST', '/login', {
            username: v2Seller,
            password: v2Password
        });
        ensure(
            r.status === 200 && r.decoded && r.decoded.token,
            'login v2 seller',
            { expectedStatus: 200, gotStatus: r.status, body: r.decoded }
        );
        v2SellerToken = r.decoded.token;
    });

    // 21) Login v2 buyer
    await runStep('POST /login (v2 buyer)', async () => {
        const r = await sendGalactic('POST', '/login', {
            username: v2Buyer,
            password: v2Password
        });
        ensure(
            r.status === 200 && r.decoded && r.decoded.token,
            'login v2 buyer',
            { expectedStatus: 200, gotStatus: r.status, body: r.decoded }
        );
        v2BuyerToken = r.decoded.token;
    });

    // 22) v2 seller posts SELL order 150 x 500
    await runStep('POST /v2/orders (SELL)', async () => {
        const r = await sendGalactic(
            'POST',
            '/v2/orders',
            {
                side: 'SELL',
                price: 150,
                quantity: 500,
                delivery_start: deliveryStart,
                delivery_end: deliveryEnd
            },
            v2SellerToken
        );
        ensure(
            r.status === 200 && r.decoded && r.decoded.order_id,
            'v2 seller create order',
            { expectedStatus: 200, gotStatus: r.status, body: r.decoded }
        );
        v2SellOrderId = r.decoded.order_id;
    });

    // 23) v2 buyer posts BUY 155 x 300 -> partial fill
    await runStep('POST /v2/orders (BUY, partial match)', async () => {
        const r = await sendGalactic(
            'POST',
            '/v2/orders',
            {
                side: 'BUY',
                price: 155,
                quantity: 300,
                delivery_start: deliveryStart,
                delivery_end: deliveryEnd
            },
            v2BuyerToken
        );
        ensure(
            r.status === 200 &&
            r.decoded &&
            r.decoded.order_id &&
            r.decoded.status === 'FILLED' &&
            r.decoded.filled_quantity === 300,
            'v2 buyer order partial match',
            { expectedStatus: 200, gotStatus: r.status, body: r.decoded }
        );
    });

    // 24) GET /v2/orders shows remaining ask of 200 (we no longer require bids === 0)
    await runStep('GET /v2/orders (order book)', async () => {
        const url = `/v2/orders?delivery_start=${deliveryStart}&delivery_end=${deliveryEnd}`;
        const res = await fetch(BASE_URL + url);
        const status = res.status;
        const ctype = res.headers.get('content-type') || '';
        let decoded;
        if (ctype.startsWith('application/x-galacticbuf')) {
            const ab = await res.arrayBuffer();
            const buf = Buffer.from(ab);
            decoded = decodeMessage(buf);
        } else {
            decoded = await res.text();
        }

        ensure(
            status === 200,
            'GET /v2/orders status',
            { expectedStatus: 200, gotStatus: status, body: decoded }
        );
        ensure(
            decoded &&
            Array.isArray(decoded.bids) &&
            Array.isArray(decoded.asks),
            'GET /v2/orders structure',
            { body: decoded }
        );

        // Focus on the important requirement:
        // there must be an ask with the seller's order_id and quantity 200
        const ask = decoded.asks.find((o) => o.order_id === v2SellOrderId);
        ensure(
            ask && ask.quantity === 200,
            'ask should remain with quantity 200',
            { asks: decoded.asks, expectedOrderId: v2SellOrderId }
        );
    });

    // 25) GET /v2/my-orders (seller)
    await runStep('GET /v2/my-orders (seller)', async () => {
        const r = await sendGalactic(
            'GET',
            '/v2/my-orders',
            null,
            v2SellerToken
        );
        ensure(
            r.status === 200,
            'GET /v2/my-orders seller status',
            { expectedStatus: 200, gotStatus: r.status, body: r.decoded }
        );
        ensure(
            r.decoded && Array.isArray(r.decoded.orders),
            'GET /v2/my-orders seller structure',
            { body: r.decoded }
        );
        const order = r.decoded.orders.find((o) => o.order_id === v2SellOrderId);
        ensure(
            order && order.quantity === 200 && order.side === 'sell',
            'seller my-orders should show remaining 200 sell',
            { orders: r.decoded.orders, expectedOrderId: v2SellOrderId }
        );
    });

    // 26) GET /v2/my-orders (buyer) should be empty
    await runStep('GET /v2/my-orders (buyer, expect empty)', async () => {
        const r = await sendGalactic(
            'GET',
            '/v2/my-orders',
            null,
            v2BuyerToken
        );
        ensure(
            r.status === 200,
            'GET /v2/my-orders buyer status',
            { expectedStatus: 200, gotStatus: r.status, body: r.decoded }
        );
        ensure(
            r.decoded && Array.isArray(r.decoded.orders),
            'GET /v2/my-orders buyer structure',
            { body: r.decoded }
        );
        ensure(
            r.decoded.orders.length === 0,
            'buyer should have no active orders after full fill',
            { orders: r.decoded.orders }
        );
    });

    // ---------- GalacticBuf v1 compatibility check ----------

    // 27) Login v2 seller using GalacticBuf v1 encoding
    await runStep('POST /login (v1-encoded GalacticBuf)', async () => {
        const r = await sendGalactic(
            'POST',
            '/login',
            {
                username: v2Seller,
                password: v2Password
            },
            null,
            VERSION_V1
        );
        ensure(
            r.status === 200 && r.decoded && r.decoded.token,
            'login with v1-encoded message',
            { expectedStatus: 200, gotStatus: r.status, body: r.decoded }
        );
    });

    // If we reach here, all tests passed
    process.exit(0);
}

main().catch((err) => {
    console.error('UNEXPECTED ERROR:', err);
    process.exit(1);
});
