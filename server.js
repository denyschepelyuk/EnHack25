// server.js
const express = require('express');
const {
    encodeMessage,
    decodeMessage,
    listOfObjects
} = require('./galacticbuf');
const { registerUser, loginUser, authMiddleware } = require('./auth');
const { createOrder, getOrdersForWindow } = require('./orders');

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

// -------------------- START SERVER --------------------

const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
    console.log(`Galactic Energy Exchange listening on port ${PORT}`);
});
