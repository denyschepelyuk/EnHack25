// test-v2-matching.js
// Tests GalacticBuf v2 + matching engine via POST /v2/orders

const { encodeMessage, decodeMessage } = require('./galacticbuf');

const BASE_URL = 'http://localhost:8080';

async function sendGalactic(method, path, bodyObj, token) {
    const url = BASE_URL + path;

    const init = {
        method,
        headers: {}
    };

    if (bodyObj) {
        const buf = encodeMessage(bodyObj); // v2
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

function ensure(condition, label, detail) {
    if (!condition) {
        console.log(`${label}:`);
        console.log('  FAILED');
        console.log('  DETAILS:', JSON.stringify(detail, null, 2));
        process.exit(1);
    } else {
        console.log(`${label} - OK`);
    }
}

async function main() {
    const ts = Date.now();
    const seller = `seller-${ts}`;
    const buyer = `buyer-${ts}`;
    const password = 'pw123';

    const deliveryStart = 3600000;
    const deliveryEnd = 7200000;

    // Health
    const healthRes = await fetch(BASE_URL + '/health');
    const healthBody = await healthRes.text();
    ensure(
        healthRes.status === 200,
        'GET /health',
        { status: healthRes.status, body: healthBody }
    );

    // Register seller
    const regSeller = await sendGalactic('POST', '/register', {
        username: seller,
        password
    });
    ensure(regSeller.status === 204, 'POST /register (seller)', regSeller);

    // Register buyer
    const regBuyer = await sendGalactic('POST', '/register', {
        username: buyer,
        password
    });
    ensure(regBuyer.status === 204, 'POST /register (buyer)', regBuyer);

    // Login seller
    const loginSeller = await sendGalactic('POST', '/login', {
        username: seller,
        password
    });
    ensure(
        loginSeller.status === 200 && loginSeller.decoded && loginSeller.decoded.token,
        'POST /login (seller)',
        loginSeller
    );
    const sellerToken = loginSeller.decoded.token;

    // Login buyer
    const loginBuyer = await sendGalactic('POST', '/login', {
        username: buyer,
        password
    });
    ensure(
        loginBuyer.status === 200 && loginBuyer.decoded && loginBuyer.decoded.token,
        'POST /login (buyer)',
        loginBuyer
    );
    const buyerToken = loginBuyer.decoded.token;

    // Seller posts SELL v2 order: 150 credits, 500 MW
    const sellOrderRes = await sendGalactic(
        'POST',
        '/v2/orders',
        {
            side: 'SELL',
            price: 150,
            quantity: 500,
            delivery_start: deliveryStart,
            delivery_end: deliveryEnd
        },
        sellerToken
    );
    ensure(
        sellOrderRes.status === 200 &&
        sellOrderRes.decoded &&
        sellOrderRes.decoded.order_id,
        'POST /v2/orders (SELL)',
        sellOrderRes
    );

    // Buyer posts BUY v2 order: 155 credits, 500 MW
    const buyOrderRes = await sendGalactic(
        'POST',
        '/v2/orders',
        {
            side: 'BUY',
            price: 155,
            quantity: 500,
            delivery_start: deliveryStart,
            delivery_end: deliveryEnd
        },
        buyerToken
    );
    ensure(
        buyOrderRes.status === 200 &&
        buyOrderRes.decoded &&
        buyOrderRes.decoded.order_id &&
        buyOrderRes.decoded.status === 'FILLED' &&
        buyOrderRes.decoded.filled_quantity === 500,
        'POST /v2/orders (BUY, matching)',
        buyOrderRes
    );

    // Check trades exist
    const tradesRes = await fetch(BASE_URL + '/trades');
    const tradesStatus = tradesRes.status;
    const ctype = tradesRes.headers.get('content-type') || '';
    let tradesDecoded;
    if (ctype.startsWith('application/x-galacticbuf')) {
        const ab = await tradesRes.arrayBuffer();
        const buf = Buffer.from(ab);
        tradesDecoded = decodeMessage(buf);
    } else {
        tradesDecoded = await tradesRes.text();
    }

    ensure(
        tradesStatus === 200 &&
        tradesDecoded &&
        Array.isArray(tradesDecoded.trades) &&
        tradesDecoded.trades.length > 0,
        'GET /trades (after matching)',
        { status: tradesStatus, body: tradesDecoded }
    );
}

main().catch((err) => {
    console.error('UNEXPECTED ERROR:', err);
    process.exit(1);
});
