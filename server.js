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
    loginWithDna,
    getUsernameFromToken     // <-- REQUIRED for bulk operations
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
    cancelOrderV2,
    snapshotOrders,          // <-- required
    restoreOrders            // <-- required
} = require('./orders');
const {
    getTrades,
    recordTrade,
    snapshotTrades,          // <-- required
    restoreTrades            // <-- required
} = require('./trades');

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

// POST /orders (legacy submit sell order)
app.post('/orders', authMiddleware, (req, res) => {
    const body = req.galactic || {};

    const result = createOrder(req.user, body);
    if (!result.ok) {
        return res.status(result.status).send(result.message);
    }

    return sendGalactic(res, { order_id: result.order.orderId }, 200);
});

// -------------------- V2 ORDER BOOK & MY ORDERS --------------------

// GET /v2/orders (public order book)
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
app.get('/v2/my-orders', authMiddleware, (req, res) => {
    const myOrders = getMyActiveV2Orders(req.user);

    const orderObjects = myOrders.map((o) => ({
        order_id: o.orderId,
        side: o.side.toLowerCase(),
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

// -------------------- V2 MATCHING ENGINE --------------------

// POST /v2/orders
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
app.delete('/v2/orders/:orderId', authMiddleware, (req, res) => {
    const orderId = req.params.orderId;

    const result = cancelOrderV2(req.user, orderId);
    if (!result.ok) {
        return res.status(result.status).send(result.message || '');
    }

    return res.status(204).end();
});

// -------------------- V2 BULK OPERATIONS --------------------
// POST /v2/bulk-operations
app.post('/v2/bulk-operations', (req, res) => {
    const body = req.galactic || {};

    if (!body.contracts || !Array.isArray(body.contracts)) {
        return res.status(400).send('contracts array is required');
    }

    const ordersSnap = snapshotOrders();
    const tradesSnap = snapshotTrades();

    const results = [];

    function rollback(status, msg) {
        restoreOrders(ordersSnap);
        restoreTrades(tradesSnap);
        return res.status(status).send(msg);
    }

    for (const contract of body.contracts) {
        if (!contract || typeof contract !== 'object')
            return rollback(400, 'Invalid contract entry');

        const ds = contract.delivery_start;
        const de = contract.delivery_end;

        if (!Number.isInteger(ds) || !Number.isInteger(de))
            return rollback(400, 'delivery_start and delivery_end must be integers');

        if (
            ds % ONE_HOUR_MS !== 0 ||
            de % ONE_HOUR_MS !== 0 ||
            de <= ds ||
            de - ds !== ONE_HOUR_MS
        ) {
            return rollback(400, 'Invalid delivery window');
        }

        const now = Date.now();

        if (de <= now)
            return rollback(451, 'Delivery window is in the past');

        const THIRTY_DAYS_MS = 30 * 24 * ONE_HOUR_MS;
        if (ds > now + THIRTY_DAYS_MS)
            return rollback(425, 'Delivery window is too far in the future');

        if (!Array.isArray(contract.operations))
            return rollback(400, 'operations must be an array');

        for (const op of contract.operations) {
            if (!op || typeof op !== 'object' || !op.type)
                return rollback(400, 'Invalid operation object');

            const username = getUsernameFromToken(op.participant_token);
            if (!username)
                return rollback(401, 'Invalid participant token');

            if (op.type === 'create') {
                const { side, price, quantity, execution_type } = op;

                if (!side || !Number.isInteger(price) || !Number.isInteger(quantity))
                    return rollback(400, 'Invalid create operation fields');

                const result = placeOrderV2(username, {
                    side,
                    price,
                    quantity,
                    delivery_start: ds,
                    delivery_end: de,
                    execution_type
                }, recordTrade);

                if (!result.ok)
                    return rollback(result.status || 400, result.message);

                results.push({
                    type: 'create',
                    order_id: result.order.orderId,
                    status: result.order.status
                });

            } else if (op.type === 'modify') {
                const { order_id, price, quantity } = op;

                if (!order_id || !Number.isInteger(price) || !Number.isInteger(quantity))
                    return rollback(400, 'Invalid modify operation fields');

                const result = modifyOrderV2(username, order_id, { price, quantity }, recordTrade);
                if (!result.ok)
                    return rollback(result.status || 400, result.message);

                results.push({
                    type: 'modify',
                    order_id
                });

            } else if (op.type === 'cancel') {
                const { order_id } = op;

                if (!order_id)
                    return rollback(400, 'Invalid cancel operation fields');

                const result = cancelOrderV2(username, order_id);
                if (!result.ok)
                    return rollback(result.status || 400, result.message);

                results.push({
                    type: 'cancel',
                    order_id
                });

            } else {
                return rollback(400, 'Unknown operation type: ' + op.type);
            }
        }
    }

    return sendGalactic(
        res,
        {
            results: listOfObjects(results)
        },
        200
    );
});

// -------------------- TRADES ENDPOINTS --------------------

// POST /trades (manual take order)
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
    const qty = result.filledQuantity;

    const trade = recordTrade({
        buyerId: req.user,
        sellerId: order.user,
        price: order.price,
        quantity: qty,
        timestamp: Date.now()
    });

    return sendGalactic(res, { trade_id: trade.tradeId }, 200);
});

// GET /trades
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

const { setCollateral } = require('./auth');

app.put('/collateral/:username', (req, res) => {
    const header = req.headers['authorization'] || '';
    if (header !== 'Bearer password123') {
        return res.status(401).end();
    }

    const username = req.params.username;
    const body = req.galactic || {};
    const c = body.collateral;

    if (!Number.isInteger(c)) {
        return res.status(400).send('collateral must be integer');
    }

    const result = setCollateral(username, c);
    if (!result.ok) return res.status(result.status).send(result.message);

    return res.status(204).end();
});


const { getBalance } = require('./trades');
const { getCollateral } = require('./auth');
const { computePotentialBalance } = require('./orders');

app.get('/balance', authMiddleware, (req, res) => {
    const user = req.user;

    const balance = getBalance(user);
    const potential = computePotentialBalance(user);
    const collateral = getCollateral(user);

    return sendGalactic(
        res,
        {
            balance,
            potential_balance: potential,
            collateral: collateral === null ? -1 : collateral
        },
        200
    );
});


app.get('/v2/my-trades', authMiddleware, (req, res) => {
    const qs = req.query || {};
    const deliveryStartStr = qs.delivery_start;
    const deliveryEndStr = qs.delivery_end;

    // Required params
    if (deliveryStartStr === undefined || deliveryEndStr === undefined) {
        return res.status(400).send('delivery_start and delivery_end are required');
    }

    const delivery_start = Number(deliveryStartStr);
    const delivery_end = Number(deliveryEndStr);

    // Must be integers
    if (!Number.isInteger(delivery_start) || !Number.isInteger(delivery_end)) {
        return res.status(400).send('delivery_start and delivery_end must be integers');
    }

    const userId = req.user.id;        // from authMiddleware
    const username = req.user.username;

    // Pull all trades (already sorted newest first)
    const allTrades = getTrades();

    // Filter only user’s trades for this delivery window
    const myTrades = allTrades
        .filter(t =>
            t.delivery_start === delivery_start &&
            t.delivery_end === delivery_end &&
            (t.buyerId === userId || t.sellerId === userId)
        )
        .map(t => {
            const isBuyer = t.buyerId === userId;
            return {
                trade_id: t.tradeId,
                side: isBuyer ? 'buy' : 'sell',
                price: t.price,
                quantity: t.quantity,
                counterparty: isBuyer ? t.sellerUsername : t.buyerUsername,
                delivery_start: t.delivery_start,
                delivery_end: t.delivery_end,
                timestamp: t.timestamp
            };
        });

    return sendGalactic(
        res,
        {
            trades: listOfObjects(myTrades)
        },
        200
    );
});

// -------------------- START SERVER --------------------

const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
    console.log(`Galactic Energy Exchange listening on port ${PORT}`);
});
