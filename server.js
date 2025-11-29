// server.js
const express = require('express');
const {
    encodeMessage,
    decodeMessage,
    listOfObjects
} = require('./galacticbuf');
const {
    registerUser,
    loginUser,
    changePassword,
    authMiddleware,
    registerDnaSample,
    loginWithDna
} = require('./auth');
const {
    ONE_HOUR_MS,
    createOrder,
    getOrdersForWindow,
    findAndFillOrder,
    placeOrderV2,
    getV2OrderBook,
    getMyActiveV2Orders,
    modifyOrderV2,
    cancelOrderV2
} = require('./orders');
const { getTrades, recordTrade } = require('./trades');

const app = express();

// Health check: simple 200 OK, no GalacticBuf required here.
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// Raw body parser for GalacticBuf
app.use(
    express.raw({
        type: 'application/x-galacticbuf',
        limit: '100mb'
    })
);

// Middleware to decode GalacticBuf requests into req.galactic
function galacticBufParser(req, res, next) {
    const contentType = req.headers['content-type'] || '';

    if (
        !contentType.startsWith('application/x-galacticbuf') ||
        !req.body ||
        req.body.length === 0
    ) {
        return next();
    }

    try {
        const obj = decodeMessage(req.body);
        req.galactic = obj;
        return next();
    } catch (err) {
        console.error('Failed to decode GalacticBuf:', err.message);
        return res.status(400).send('Invalid GalacticBuf message');
    }
}

app.use(galacticBufParser);

// Helper to send GalacticBuf responses (v2 by default)
function sendGalactic(res, obj, status = 200) {
    const buf = encodeMessage(obj);
    res.status(status);
    res.set('Content-Type', 'application/x-galacticbuf');
    res.send(buf);
}

// -------------------- AUTH ENDPOINTS --------------------

// POST /register
app.post('/register', (req, res) => {
    const body = req.galactic || {};
    const username = body.username;
    const password = body.password;

    const result = registerUser(username, password);
    if (!result.ok) {
        return res.status(result.status).send(result.message);
    }

    return res.status(204).end();
});

// POST /login
app.post('/login', (req, res) => {
    const body = req.galactic || {};
    const username = body.username;
    const password = body.password;

    const result = loginUser(username, password);
    if (!result.ok) {
        return res.status(result.status).send(result.message);
    }

    return sendGalactic(res, { token: result.token }, 200);
});

// PUT /user/password
app.put('/user/password', (req, res) => {
    const body = req.galactic || {};
    const username = body.username;
    const oldPassword = body.old_password;
    const newPassword = body.new_password;

    const result = changePassword(username, oldPassword, newPassword);
    if (!result.ok) {
        return res.status(result.status).send(result.message);
    }

    return res.status(204).end();
});

// DNA LOGIN:

app.post('/dna-submit', (req, res) => {
    const body = req.galactic || {};
    const username = body.username;
    const password = body.password;
    const dnaSample = body.dna_sample;

    const result = registerDnaSample(username, password, dnaSample);
    if (!result.ok) {
        return res.status(result.status).send(result.message);
    }

    return res.status(204).end();
});

app.post('/dna-login', (req, res) => {
    const body = req.galactic || {};
    const username = body.username;
    const dnaSample = body.dna_sample;

    const result = loginWithDna(username, dnaSample);
    if (!result.ok) {
        return res.status(result.status).send(result.message);
    }

    return sendGalactic(res, { token: result.token }, 200);
});

// -------------------- LEGACY V1 ORDERS --------------------

// GET /orders (public, V1-style sell orders)
app.get('/orders', (req, res) => {
    const qs = req.query || {};
    const deliveryStartStr = qs.delivery_start;
    const deliveryEndStr = qs.delivery_end;

    if (deliveryStartStr === undefined || deliveryEndStr === undefined) {
        return res.status(400).send('delivery_start and delivery_end are required');
    }

    const deliveryStart = Number(deliveryStartStr);
    const deliveryEnd = Number(deliveryEndStr);

    if (!Number.isFinite(deliveryStart) || !Number.isFinite(deliveryEnd)) {
        return res.status(400).send('delivery_start and delivery_end must be numbers');
    }

    const list = getOrdersForWindow(deliveryStart, deliveryEnd);

    const orderObjects = list.map((o) => ({
        order_id: o.orderId,
        price: o.price,
        quantity: o.quantity,
        delivery_start: o.deliveryStart,
        delivery_end: o.deliveryEnd
    }));

    return sendGalactic(
        res,
        {
            orders: listOfObjects(orderObjects)
        },
        200
    );
});

// POST /orders (legacy submit sell order, no matching)
app.post('/orders', authMiddleware, (req, res) => {
    const body = req.galactic || {};

    const result = createOrder(req.user, body);
    if (!result.ok) {
        return res.status(result.status).send(result.message);
    }

    return sendGalactic(res, { order_id: result.order.orderId }, 200);
});

// -------------------- V2 ORDER BOOK & MY ORDERS --------------------

// GET /v2/orders
// Public v2 order book for a given contract
// Query: delivery_start, delivery_end
// Response: { bids: [...], asks: [...] }
app.get('/v2/orders', (req, res) => {
    const qs = req.query || {};
    const deliveryStartStr = qs.delivery_start;
    const deliveryEndStr = qs.delivery_end;

    if (deliveryStartStr === undefined || deliveryEndStr === undefined) {
        return res.status(400).send('delivery_start and delivery_end are required');
    }

    const deliveryStart = Number(deliveryStartStr);
    const deliveryEnd = Number(deliveryEndStr);

    if (!Number.isFinite(deliveryStart) || !Number.isFinite(deliveryEnd)) {
        return res.status(400).send('delivery_start and delivery_end must be numbers');
    }

    // Validate 1h aligned contract as in submit
    if (
        deliveryStart % ONE_HOUR_MS !== 0 ||
        deliveryEnd % ONE_HOUR_MS !== 0 ||
        deliveryEnd <= deliveryStart ||
        deliveryEnd - deliveryStart !== ONE_HOUR_MS
    ) {
        return res.status(400).send('Invalid delivery window');
    }

    const { bids, asks } = getV2OrderBook(deliveryStart, deliveryEnd);

    const bidObjects = bids.map((o) => ({
        order_id: o.orderId,
        price: o.price,
        quantity: o.quantity
    }));

    const askObjects = asks.map((o) => ({
        order_id: o.orderId,
        price: o.price,
        quantity: o.quantity
    }));

    return sendGalactic(
        res,
        {
            bids: listOfObjects(bidObjects),
            asks: listOfObjects(askObjects)
        },
        200
    );
});

// GET /v2/my-orders
// Auth required.
// Response: { orders: [...] } newest first
app.get('/v2/my-orders', authMiddleware, (req, res) => {
    const myOrders = getMyActiveV2Orders(req.user);

    const orderObjects = myOrders.map((o) => ({
        order_id: o.orderId,
        side: o.side.toLowerCase(),      // "buy" / "sell"
        price: o.price,
        quantity: o.quantity,
        delivery_start: o.deliveryStart,
        delivery_end: o.deliveryEnd,
        timestamp: o.createdAt
    }));

    return sendGalactic(
        res,
        {
            orders: listOfObjects(orderObjects)
        },
        200
    );
});

// -------------------- V2 ORDERS (MATCHING ENGINE) --------------------

// POST /v2/orders
// Auth required.
// Request: { side, price, quantity, delivery_start, delivery_end }
// Response: { order_id, status, filled_quantity }
app.post('/v2/orders', authMiddleware, (req, res) => {
    const body = req.galactic || {};

    const result = placeOrderV2(req.user, body, recordTrade);
    if (!result.ok) {
        return res.status(result.status).send(result.message);
    }

    const order = result.order;

    return sendGalactic(
        res,
        {
            order_id: order.orderId,
            status: order.status,
            filled_quantity: result.filledQuantity
        },
        200
    );
});

// PUT /v2/orders/:orderId
// Auth required.
// Request: { price, quantity }
// Response: { order_id, status, filled_quantity }
app.put('/v2/orders/:orderId', authMiddleware, (req, res) => {
    const orderId = req.params.orderId;
    const body = req.galactic || {};

    const result = modifyOrderV2(req.user, orderId, body, recordTrade);
    if (!result.ok) {
        return res.status(result.status).send(result.message || '');
    }

    const order = result.order;

    return sendGalactic(
        res,
        {
            order_id: order.orderId,
            status: order.status,
            filled_quantity: result.filledQuantity
        },
        200
    );
});

// DELETE /v2/orders/:orderId
// Auth required.
// Response: 204 on success
app.delete('/v2/orders/:orderId', authMiddleware, (req, res) => {
    const orderId = req.params.orderId;

    const result = cancelOrderV2(req.user, orderId);
    if (!result.ok) {
        return res.status(result.status).send(result.message || '');
    }

    return res.status(204).end();
});

// -------------------- TRADES ENDPOINTS --------------------

// POST /trades (manual take order, legacy)
app.post('/trades', authMiddleware, (req, res) => {
    const body = req.galactic || {};
    const orderId = body.order_id;

    if (!orderId || typeof orderId !== 'string') {
        return res.status(400).send('order_id is required');
    }

    const result = findAndFillOrder(orderId