const {
    encodeMessage,
    decodeMessage,
    VERSION_V1
} = require('./galacticbuf');

const BASE_URL = 'http://localhost:8080';

async function sendGalactic(method, path, bodyObj, token, version) {
    const url = BASE_URL + path;

    const init = { method, headers: {} };

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

function ensure(condition, label, extra) {
    if (!condition) {
        console.error('FAILED:', label);
        if (extra) console.error('DETAILS:', extra);
        process.exit(1);
    }
}

async function main() {
    const startAll = Date.now();

    // ---- 0) Health
    {
        const res = await fetch(BASE_URL + '/health');
        const txt = await res.text();
        ensure(res.status === 200, 'GET /health', { status: res.status, body: txt });
        console.log('Health OK');
    }

    const ts = Date.now();
    const sellerUser = `sim-seller-${ts}`;
    const buyerUser = `sim-buyer-${ts}`;
    const password = 's1mpw';

    let sellerToken;
    let buyerToken;
    let deliveryStart;
    let deliveryEnd;

    const ONE_HOUR_MS = 3600000;
    const baseHour = Math.floor(Date.now() / ONE_HOUR_MS) + 1;
    deliveryStart = baseHour * ONE_HOUR_MS;
    deliveryEnd = deliveryStart + ONE_HOUR_MS;

    // ---- 1) Register users
    {
        const r1 = await sendGalactic('POST', '/register', {
            username: sellerUser,
            password
        });
        ensure(r1.status === 204, 'register seller', { status: r1.status, body: r1.decoded });

        const r2 = await sendGalactic('POST', '/register', {
            username: buyerUser,
            password
        });
        ensure(r2.status === 204, 'register buyer', { status: r2.status, body: r2.decoded });
        console.log('Users registered');
    }

    // ---- 2) Login users
    {
        const r1 = await sendGalactic('POST', '/login', {
            username: sellerUser,
            password
        });
        ensure(r1.status === 200 && r1.decoded && r1.decoded.token, 'login seller', {
            status: r1.status,
            body: r1.decoded
        });
        sellerToken = r1.decoded.token;

        const r2 = await sendGalactic('POST', '/login', {
            username: buyerUser,
            password
        });
        ensure(r2.status === 200 && r2.decoded && r2.decoded.token, 'login buyer', {
            status: r2.status,
            body: r2.decoded
        });
        buyerToken = r2.decoded.token;

        console.log('Users logged in');
    }

    // ---- 3) Set collateral for both (small, but enough)
    {
        const colSeller = await sendGalactic(
            'PUT',
            `/collateral/${sellerUser}`,
            { collateral: 1_000_000 }, // 1M
            'password123' // admin token (server expects Bearer password123)
        );
        ensure(colSeller.status === 204, 'set collateral seller', {
            status: colSeller.status,
            body: colSeller.decoded
        });

        const colBuyer = await sendGalactic(
            'PUT',
            `/collateral/${buyerUser}`,
            { collateral: 1_000_000 },
            'password123'
        );
        ensure(colBuyer.status === 204, 'set collateral buyer', {
            status: colBuyer.status,
            body: colBuyer.decoded
        });

        console.log('Collateral set');
    }

    // ---- 4) Seller posts a SELL order via /v2/orders
    let sellOrderId;
    {
        const r = await sendGalactic(
            'POST',
            '/v2/orders',
            {
                side: 'SELL',
                price: 100,
                quantity: 500,
                delivery_start: deliveryStart,
                delivery_end: deliveryEnd
            },
            sellerToken
        );
        ensure(r.status === 200 && r.decoded && r.decoded.order_id, 'seller v2 order', {
            status: r.status,
            body: r.decoded
        });
        sellOrderId = r.decoded.order_id;
        console.log('Seller order placed:', sellOrderId);
    }

    // ---- 5) Buyer posts BUY order that partially fills (e.g. 300)
    {
        const r = await sendGalactic(
            'POST',
            '/v2/orders',
            {
                side: 'BUY',
                price: 110, // cross 100
                quantity: 300,
                delivery_start: deliveryStart,
                delivery_end: deliveryEnd
            },
            buyerToken
        );
        ensure(
            r.status === 200 &&
                r.decoded &&
                r.decoded.status === 'FILLED' &&
                r.decoded.filled_quantity === 300,
            'buyer v2 order partial fill',
            { status: r.status, body: r.decoded }
        );
        console.log('Buyer partial fill OK');
    }

    // ---- 6) Check /v2/orders: remaining ask 200
    {
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

        ensure(status === 200, 'GET /v2/orders status', {
            status,
            body: decoded
        });
        ensure(decoded && Array.isArray(decoded.asks), 'order book asks array', { body: decoded });

        const ask = decoded.asks.find((o) => o.order_id === sellOrderId);
        ensure(ask && ask.quantity === 200, 'remaining ask 200', {
            asks: decoded.asks,
            expectedOrderId: sellOrderId
        });
        console.log('/v2/orders shows remaining ask 200');
    }

    // ---- 7) Check /v2/my-orders for seller (should show 200)
    {
        const r = await sendGalactic('GET', '/v2/my-orders', null, sellerToken);
        ensure(r.status === 200, 'GET /v2/my-orders seller status', {
            status: r.status,
            body: r.decoded
        });
        ensure(r.decoded && Array.isArray(r.decoded.orders), 'my-orders structure', {
            body: r.decoded
        });

        const order = r.decoded.orders.find((o) => o.order_id === sellOrderId);
        ensure(order && order.quantity === 200, 'my-orders remaining 200', {
            orders: r.decoded.orders
        });
        console.log('Seller /v2/my-orders OK');
    }

    // ---- 8) Check /v2/my-trades for buyer & seller
    {
        const buyerTrades = await sendGalactic(
            'GET',
            `/v2/my-trades?delivery_start=${deliveryStart}&delivery_end=${deliveryEnd}`,
            null,
            buyerToken
        );
        ensure(buyerTrades.status === 200, 'GET /v2/my-trades buyer', {
            status: buyerTrades.status,
            body: buyerTrades.decoded
        });
        ensure(
            buyerTrades.decoded &&
                Array.isArray(buyerTrades.decoded.trades) &&
                buyerTrades.decoded.trades.length >= 1,
            'buyer has at least one trade',
            { trades: buyerTrades.decoded.trades }
        );

        const sellerTrades = await sendGalactic(
            'GET',
            `/v2/my-trades?delivery_start=${deliveryStart}&delivery_end=${deliveryEnd}`,
            null,
            sellerToken
        );
        ensure(sellerTrades.status === 200, 'GET /v2/my-trades seller', {
            status: sellerTrades.status,
            body: sellerTrades.decoded
        });
        ensure(
            sellerTrades.decoded &&
                Array.isArray(sellerTrades.decoded.trades) &&
                sellerTrades.decoded.trades.length >= 1,
            'seller has at least one trade',
            { trades: sellerTrades.decoded.trades }
        );

        console.log('/v2/my-trades OK for both sides');
    }

    // ---- 9) Basic /balance sanity for both users
    {
        const rb = await sendGalactic('GET', '/balance', null, buyerToken);
        const rs = await sendGalactic('GET', '/balance', null, sellerToken);

        ensure(rb.status === 200, 'buyer /balance status', {
            status: rb.status,
            body: rb.decoded
        });
        ensure(rs.status === 200, 'seller /balance status', {
            status: rs.status,
            body: rs.decoded
        });

        console.log('Buyer balance:', rb.decoded);
        console.log('Seller balance:', rs.decoded);
    }

    const endAll = Date.now();
    const elapsedMs = endAll - startAll;
    console.log('Simulation finished in', elapsedMs, 'ms');
    if (elapsedMs > 10_000) {
        console.error('WARNING: Simulation took more than 10 seconds!');
        process.exit(1);
    }

    console.log('Market simulation Tier 0 looks good.');
    process.exit(0);
}

main().catch((err) => {
    console.error('UNEXPECTED ERROR:', err);
    process.exit(1);
});
