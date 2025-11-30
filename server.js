// server.js
const express = require('express');
const http = require('http'); // Required for WebSocket integration
const WebSocket = require('ws'); // Required for WebSocket implementation
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
    getUsernameFromToken,
    setCollateral,
    getCollateral
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
    snapshotOrders,
    restoreOrders,
    computePotentialBalance
} = require('./orders');
const {
    getTrades,
    recordTrade,
    snapshotTrades,
    restoreTrades,
    getBalance
} = require('./trades');

const app = express();
const server = http.createServer(app); // Wrap express app in HTTP server

// -------------------- WEBSOCKET SERVER --------------------

const wss = new WebSocket.Server({ noServer: true });
const wsClients = new Set();

// Handle Upgrade Request
server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;

    if (pathname === '/v2/stream/trades') {
        wss.handleUpgrade(request, socket, head, (ws) => {
            wsClients.add(ws);
            
            // Cleanup on close
            ws.on('close', () => {
                wsClients.delete(ws);
            });

            // Ignore incoming messages (stream is one-way)
            ws.on('message', () => {});
        });
    } else {
        socket.destroy();
    }
});

/**
 * Broadcasts a trade to all connected WebSocket clients.
 * Filters out V1 trades automatically.
 */
function broadcastV2Trade(trade) {
    if (!trade || !trade.isV2) return;

    // Map to API spec fields
    const msg = {
        trade_id: trade.tradeId,
        buyer_id: trade.buyerId,
        seller_id: trade.sellerId,
        price: trade.price,
        quantity: trade.quantity,
        delivery_start: trade.delivery_start,
        delivery_end: trade.delivery_end,
        timestamp: trade.timestamp
    };

    try {
        const buf = encodeMessage(msg);
        for (const client of wsClients) {
            if (client.readyState === WebSocket.OPEN) {
                client.send(buf);
            }
        }
    } catch (err) {
        console.error('Failed to broadcast trade:', err.message);
    }
}

/**
 * Wrapper for recordTrade that immediately broadcasts 
 * if the trade is V2.
 */
function recordTradeAndBroadcast(tradeData) {
    const trade = recordTrade(tradeData);
    if (trade.isV2) {
        broadcastV2Trade(trade);
    }
    return trade;
}

// -------------------- APP CONFIG --------------------

// Health check
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

// Middleware to decode GalacticBuf requests
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
    const result = registerUser(body.username, body.password);
    if (!result.ok) return res.status(result.status).send(result.message);
    return res.status(204).end();
});

// POST /login
app.post('/login', (req, res) => {
    const body = req.galactic || {};
    const result = loginUser(body.username, body.password);
    if (!result.ok) return res.status(result.status).send(result.message);
    return sendGalactic(res, { token: result.token }, 200);
});

// PUT /user/password
app.put('/user/password', (req, res) => {
    const body = req.galactic || {};
    const result = changePassword(body.username, body.old_password, body.new_password);
    if (!result.ok) return res.status(result.status).send(result.message);
    return res.status(204).end();
});

// DNA LOGIN
app.post('/dna-submit', (req, res) => {
    const body = req.galactic || {};
    const result = registerDnaSample(body.username, body.password, body.dna_sample);
    if (!result.ok) return res.status(result.status).send(result.message);
    return res.status(204).end();
});

app.post('/dna-login', (req, res) => {
    const body = req.galactic || {};
    const result = loginWithDna(body.username, body.dna_sample);
    if (!result.ok) return res.status(result.status).send(result.message);
    return sendGalactic(res, { token: result.token }, 200);
});

// -------------------- LEGACY V1 ORDERS --------------------

app.get('/orders', (req, res) => {
    const qs = req.query || {};
    const deliveryStart = Number(qs.delivery_start);
    const deliveryEnd = Number(qs.delivery_end);

    if (qs.delivery_start === undefined || qs.delivery_end === undefined) {
        return res.status(400).send('delivery_start and delivery_end are required');
    }
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

    return sendGalactic(res, { orders: listOfObjects(orderObjects) }, 200);
});

app.post('/orders', authMiddleware, (req, res) => {
    const body = req.galactic || {};
    const result = createOrder(req.user, body);
    if (!result.ok) return res.status(result.status).send(result.message);
    return sendGalactic(res, { order_id: result.order.orderId }, 200);
});

// -------------------- V2 ORDER BOOK & MY ORDERS --------------------

app.get('/v2/orders', (req, res) => {
    const qs = req.query || {};
    const deliveryStart = Number(qs.delivery_start);
    const deliveryEnd = Number(qs.delivery_end);

    if (qs.delivery_start === undefined || qs.delivery_end === undefined) {
        return res.status(400).send('delivery_start and delivery_end are required');
    }
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
    const bidObjects = bids.map((o) => ({ order_id: o.orderId, price: o.price, quantity: o.quantity }));
    const askObjects = asks.map((o) => ({ order_id: o.orderId, price: o.price, quantity: o.quantity }));

    return sendGalactic(res, { bids: listOfObjects(bidObjects), asks: listOfObjects(askObjects) }, 200);
});

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
    return sendGalactic(res, { orders: listOfObjects(orderObjects) }, 200);
});

// -------------------- V2 MATCHING ENGINE --------------------

// POST /v2/orders
app.post('/v2/orders', authMiddleware, (req, res) => {
    const body = req.galactic || {};

    // Use recordTradeAndBroadcast to allow immediate streaming
    const result = placeOrderV2(req.user, body, recordTradeAndBroadcast);
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

    // Use recordTradeAndBroadcast to allow immediate streaming
    const result = modifyOrderV2(req.user, orderId, body, recordTradeAndBroadcast);
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
app.post('/v2/bulk-operations', (req, res) => {
    const body = req.galactic || {};

    if (!body.contracts || !Array.isArray(body.contracts)) {
        return res.status(400).send('contracts array is required');
    }

    const ordersSnap = snapshotOrders();
    const tradesSnap = snapshotTrades();
    const results = [];
    
    // Buffer trades during bulk operation to prevent broadcasting phantom trades on rollback
    const bulkTradesBuffer = [];
    const bulkRecordFn = (tradeData) => {
        const t = recordTrade(tradeData);
        if (t.isV2) {
            bulkTradesBuffer.push(t);
        }
        return t;
    };

    function rollback(status, msg) {
        restoreOrders(ordersSnap);
        restoreTrades(tradesSnap);
        return res.status(status).send(msg);
    }

    for (const contract of body.contracts) {
        if (!contract || typeof contract !== 'object') return rollback(400, 'Invalid contract entry');

        const ds = contract.delivery_start;
        const de = contract.delivery_end;

        if (!Number.isInteger(ds) || !Number.isInteger(de)) return rollback(400, 'delivery_start and delivery_end must be integers');
        if (ds % ONE_HOUR_MS !== 0 || de % ONE_HOUR_MS !== 0 || de <= ds || de - ds !== ONE_HOUR_MS) {
            return rollback(400, 'Invalid delivery window');
        }

        const now = Date.now();
        if (de <= now) return rollback(451, 'Delivery window is in the past');
        const THIRTY_DAYS_MS = 30 * 24 * ONE_HOUR_MS;
        if (ds > now + THIRTY_DAYS_MS) return rollback(425, 'Delivery window is too far in the future');

        if (!Array.isArray(contract.operations)) return rollback(400, 'operations must be an array');

        for (const op of contract.operations) {
            if (!op || typeof op !== 'object' || !op.type) return rollback(400, 'Invalid operation object');

            const username = getUsernameFromToken(op.participant_token);
            if (!username) return rollback(401, 'Invalid participant token');

            if (op.type === 'create') {
                const { side, price, quantity, execution_type } = op;
                if (!side || !Number.isInteger(price) || !Number.isInteger(quantity)) return rollback(400, 'Invalid create operation fields');

                const result = placeOrderV2(username, {
                    side, price, quantity, delivery_start: ds, delivery_end: de, execution_type
                }, bulkRecordFn); // Use buffered recorder

                if (!result.ok) return rollback(result.status || 400, result.message);
                results.push({ type: 'create', order_id: result.order.orderId, status: result.order.status });

            } else if (op.type === 'modify') {
                const { order_id, price, quantity } = op;
                if (!order_id || !Number.isInteger(price) || !Number.isInteger(quantity)) return rollback(400, 'Invalid modify operation fields');

                const result = modifyOrderV2(username, order_id, { price, quantity }, bulkRecordFn); // Use buffered recorder
                if (!result.ok) return rollback(result.status || 400, result.message);
                results.push({ type: 'modify', order_id });

            } else if (op.type === 'cancel') {
                const { order_id } = op;
                if (!order_id) return rollback(400, 'Invalid cancel operation fields');
                const result = cancelOrderV2(username, order_id);
                if (!result.ok) return rollback(result.status || 400, result.message);
                results.push({ type: 'cancel', order_id });
            } else {
                return rollback(400, 'Unknown operation type: ' + op.type);
            }
        }
    }

    // Success: Commit trades to broadcast stream
    bulkTradesBuffer.forEach(broadcastV2Trade);

    return sendGalactic(res, { results: listOfObjects(results) }, 200);
});

// -------------------- TRADES ENDPOINTS --------------------

// POST /trades (manual take order - Legacy)
app.post('/trades', authMiddleware, (req, res) => {
    const body = req.galactic || {};
    const orderId = body.order_id;
    if (!orderId || typeof orderId !== 'string') return res.status(400).send('order_id is required');

    const result = findAndFillOrder(orderId);
    if (!result.ok) return res.status(result.status).send(result.message);

    const order = result.order;
    const qty = result.filledQuantity;

    // Direct call to recordTrade (Legacy isV2=false).
    // broadcastV2Trade handles filtering, but since we call recordTrade directly here,
    // we rely on it creating { isV2: false }, which will be ignored if we ever piped it.
    // However, we don't need to change this logic as we don't want V1 trades on the stream.
    const trade = recordTrade({
        buyerId: req.user,
        sellerId: order.user,
        buyerUsername: req.user,
        sellerUsername: order.user,
        price: order.price,
        quantity: qty,
        delivery_start: order.deliveryStart,
        delivery_end: order.deliveryEnd,
        timestamp: Date.now(),
        isV2: false
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
    return sendGalactic(res, { trades: listOfObjects(tradeObjects) }, 200);
});

// GET /v2/trades
app.get('/v2/trades', (req, res) => {
    const qs = req.query || {};
    const deliveryStart = Number(qs.delivery_start);
    const deliveryEnd = Number(qs.delivery_end);

    if (qs.delivery_start === undefined || qs.delivery_end === undefined) {
        return res.status(400).send('delivery_start and delivery_end are required');
    }
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

    const allTrades = getTrades();
    const v2Trades = allTrades.filter(t => 
        t.isV2 === true &&
        t.delivery_start === deliveryStart &&
        t.delivery_end === deliveryEnd
    );

    const tradeObjects = v2Trades.map(t => ({
        trade_id: t.tradeId,
        buyer_id: t.buyerId,
        seller_id: t.sellerId,
        price: t.price,
        quantity: t.quantity,
        delivery_start: t.delivery_start,
        delivery_end: t.delivery_end,
        timestamp: t.timestamp
    }));

    return sendGalactic(res, { trades: listOfObjects(tradeObjects) }, 200);
});

app.put('/collateral/:username', (req, res) => {
    const header = req.headers['authorization'] || '';
    if (header !== 'Bearer password123') return res.status(401).end();

    const username = req.params.username;
    const body = req.galactic || {};
    const c = body.collateral;

    if (!Number.isInteger(c)) return res.status(400).send('collateral must be integer');

    const result = setCollateral(username, c);
    if (!result.ok) return res.status(result.status).send(result.message);

    return res.status(204).end();
});

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
    const delivery_start = Number(qs.delivery_start);
    const delivery_end = Number(qs.delivery_end);

    if (qs.delivery_start === undefined || qs.delivery_end === undefined) return res.status(400).send('delivery_start and delivery_end are required');
    if (!Number.isInteger(delivery_start) || !Number.isInteger(delivery_end)) return res.status(400).send('delivery_start and delivery_end must be integers');
    if (delivery_start % ONE_HOUR_MS !== 0 || delivery_end % ONE_HOUR_MS !== 0 || delivery_end <= delivery_start || delivery_end - delivery_start !== ONE_HOUR_MS) {
        return res.status(400).send('Invalid delivery window');
    }

    const username = req.user;
    const allTrades = getTrades();
    const myTrades = allTrades
        .filter(t =>
            t.delivery_start === delivery_start &&
            t.delivery_end === delivery_end &&
            (t.buyerId === username || t.sellerId === username)
        )
        .map(t => {
            const isBuyer = t.buyerId === username;
            return {
                trade_id: t.tradeId,
                side: isBuyer ? 'buy' : 'sell',
                price: t.price,
                quantity: t.quantity,
                counterparty: isBuyer ? t.sellerId : t.buyerId,
                delivery_start: t.delivery_start,
                delivery_end: t.delivery_end,
                timestamp: t.timestamp
            };
        }).sort((a, b) => b.timestamp - a.timestamp);

    return sendGalactic(res, { trades: listOfObjects(myTrades) }, 200);
});

// -------------------- START SERVER --------------------

const PORT = process.env.PORT || 8080;

// Replaced app.listen with server.listen to support WebSocket upgrades
server.listen(PORT, () => {
    console.log(`Galactic Energy Exchange listening on port ${PORT}`);
});