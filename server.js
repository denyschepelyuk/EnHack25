// server.js
const express = require('express');
const {
    encodeMessage,
    decodeMessage,
    listOfObjects
} = require('./galacticbuf');
const { registerUser, loginUser, changePassword, authMiddleware } = require('./auth');
const { createOrder, getOrdersForWindow, findAndFillOrder } = require('./orders');
const { getTrades, recordTrade } = require('./trades');
const { createV2Order } = require('./orders_v2');
const { registerV2OrderBookRoutes } = require('./routes_v2_orders');

const { registerListMyOrdersV2 } = require('./list_my_orders_v2');
const app = express();

// Health check: simple 200 OK, no GalacticBuf required here.
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// Raw body parser for GalacticBuf
app.use(
    express.raw({
        type: 'application/x-galacticbuf',
        limit: '100kb'
    })
);

// Middleware to decode GalacticBuf requests into req.galactic
function galacticBufParser(req, res, next) {
    const contentType = req.headers['content-type'] || '';

    // Only parse for GalacticBuf content types with a body
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

// Helper to send GalacticBuf responses
function sendGalactic(res, obj, status = 200) {
    const buf = encodeMessage(obj);
    res.status(status);
    res.set('Content-Type', 'application/x-galacticbuf');
    res.send(buf);
}

registerV2OrderBookRoutes(app, sendGalactic);


// -------------------- AUTH ENDPOINTS --------------------

// POST /register
// Request body (GalacticBuf):
//   username (string)
//   password (string)
// Response:
//   204 No Content on success
//   400 on invalid input
//   409 if username exists
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
// Request body (GalacticBuf):
//   username (string)
//   password (string)
// Response (GalacticBuf):
//   token (string)
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
// Request body (GalacticBuf):
//   username (string)
//   old_password (string)
//   new_password (string)
// Response:
//   204 No Content on success
//   400 on invalid input
//   401 on invalid old password or user not found
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

// -------------------- ORDERS ENDPOINTS --------------------

// GET /orders?delivery_start=...&delivery_end=...
// Response (GalacticBuf):
//   orders (list of objects)
// Each order:
//   order_id (string)
//   price (int)
//   quantity (int)
//   delivery_start (int)
//   delivery_end (int)
// No authentication required.
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

    // Encode as list of objects using GalacticBuf helper
    return sendGalactic(
        res,
        {
            orders: listOfObjects(orderObjects)
        },
        200
    );
});

// POST /orders
// Auth required (Bearer token).
// Request body (GalacticBuf):
//   price (int)
//   quantity (int)
//   delivery_start (int)
//   delivery_end (int)
// Response (GalacticBuf):
//   order_id (string)
app.post('/orders', authMiddleware, (req, res) => {
    const body = req.galactic || {};

    const result = createOrder(req.user, body);
    if (!result.ok) {
        return res.status(result.status).send(result.message);
    }

    return sendGalactic(res, { order_id: result.order.orderId }, 200);
});



// POST /trades
// Take an existing sell order.
// Auth required (buyer must be logged in).
// Request (GalacticBuf):
//   order_id (string)
// Response (GalacticBuf):
//   trade_id (string)
app.post('/trades', authMiddleware, (req, res) => {
    const body = req.galactic || {};
    const orderId = body.order_id;

    if (!orderId || typeof orderId !== 'string') {
        return res.status(400).send('order_id is required');
    }

    const result = findAndFillOrder(orderId);
    if (!result.ok) {
        return res.status(result.status).send(result.message);
    }

    const order = result.order;

    const trade = recordTrade({
        buyerId: req.user,
        sellerId: order.user,
        price: order.price,
        quantity: order.quantity,
        timestamp: Date.now()
    });

    return sendGalactic(res, { trade_id: trade.tradeId }, 200);
});

// GET /trades
// No query params, no auth required.
// Response (GalacticBuf):
//   trades (list of objects)
// Each trade:
//   trade_id (string)
//   buyer_id (string)
//   seller_id (string)
//   price (int)
//   quantity (int)
//   timestamp (int)
app.get('/trades', (req, res) => {
    const tradeList = getTrades();

    const tradeObjects = tradeList.map((t) => ({
        trade_id: t.tradeId,
        buyer_id: t.buyerId,
        seller_id: t.sellerId,
        price: t.price,
        quantity: t.quantity,
        timestamp: t.timestamp
    }));

    return sendGalactic(
        res,
        {
            trades: listOfObjects(tradeObjects)
        },
        200
    );
});

app.post('/v2/orders', authMiddleware, (req, res) => {
    const body = req.galactic || {};

    const result = createV2Order(req.user, body);
    if (!result.ok) {
        return res.status(result.status).send(result.message);
    }

    return sendGalactic(res, { order_id: result.order.orderId }, 200);
});

registerListMyOrdersV2(app);

// -------------------- START SERVER --------------------

    const PORT = process.env.PORT || 8080;

    app.listen(PORT, () => {
        console.log(`Galactic Energy Exchange listening on port ${PORT}`);
    });
