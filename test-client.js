// test-client.js
// Simple local test client for the Galactic Energy Exchange server
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
    if (contentType.startsWith('application/x-galacticbuf')) {
        const arrayBuf = await res.arrayBuffer();
        const nodeBuf = Buffer.from(arrayBuf);
        decoded = decodeMessage(nodeBuf);
    } else {
        // For error messages or plain text
        decoded = await res.text();
    }

    return { status, decoded };
}

async function main() {
    console.log('--- HEALTH CHECK ---');
    const healthRes = await fetch(BASE_URL + '/health');
    console.log('GET /health ->', healthRes.status, await healthRes.text());

    // ----------------- REGISTER -----------------
    console.log('\n--- REGISTER ---');
    const username = 'alice';
    const password = 'password123';

    const reg = await sendGalactic('POST', '/register', {
        username,
        password
    });

    console.log('POST /register -> status', reg.status, 'body:', reg.decoded);

    // If you run this multiple times, you might get 409 (already exists), that’s OK.

    // ----------------- LOGIN -----------------
    console.log('\n--- LOGIN ---');
    const login = await sendGalactic('POST', '/login', {
        username,
        password
    });

    console.log('POST /login -> status', login.status, 'body:', login.decoded);

    if (login.status !== 200 || !login.decoded || !login.decoded.token) {
        console.error('Login failed, cannot continue');
        return;
    }

    const token = login.decoded.token;
    console.log('Received token:', token);

    // ----------------- CREATE ORDER -----------------
    console.log('\n--- CREATE ORDER ---');

    // Use a fixed 1-hour window: [3600000, 7200000]
    const deliveryStart = 3600000; // 1h in ms
    const deliveryEnd = 7200000;   // 2h in ms

    const createOrderRes = await sendGalactic(
        'POST',
        '/orders',
        {
            price: 100,               // credits per unit
            quantity: 5,              // MW
            delivery_start: deliveryStart,
            delivery_end: deliveryEnd
        },
        token
    );

    console.log(
        'POST /orders -> status',
        createOrderRes.status,
        'body:',
        createOrderRes.decoded
    );

    if (createOrderRes.status !== 200) {
        console.error('Order creation failed, cannot list orders');
        return;
    }

    const orderId = createOrderRes.decoded.order_id;
    console.log('Created order with ID:', orderId);

    // ----------------- LIST ORDERS -----------------
    console.log('\n--- LIST ORDERS ---');

    const listUrl = `/orders?delivery_start=${deliveryStart}&delivery_end=${deliveryEnd}`;
    const listResRaw = await fetch(BASE_URL + listUrl);

    const listStatus = listResRaw.status;
    const listContentType = listResRaw.headers.get('content-type') || '';

    let listDecoded;
    if (listContentType.startsWith('application/x-galacticbuf')) {
        const ab = await listResRaw.arrayBuffer();
        const buf = Buffer.from(ab);
        listDecoded = decodeMessage(buf);
    } else {
        listDecoded = await listResRaw.text();
    }

    console.log('GET /orders -> status', listStatus, 'body:', listDecoded);
}

main().catch((err) => {
    console.error('Test client error:', err);
    process.exit(1);
});
