// orders.js
const crypto = require('crypto');
const { getBalance } = require('./trades');
const { getCollateral } = require('./auth');

const ONE_HOUR_MS = 3600000;

// global order list
const orders = [];

/***********************************************************
 * BASIC UTILITIES
 ***********************************************************/
function generateOrderId() {
    return crypto.randomBytes(16).toString('hex');
}

function validateOrderFields(price, quantity, deliveryStart, deliveryEnd) {
    if (!Number.isInteger(quantity) || quantity <= 0) {
        return { ok: false, message: 'Quantity must be a positive integer' };
    }

    if (!Number.isInteger(price)) {
        return { ok: false, message: 'Price must be an integer' };
    }

    if (!Number.isInteger(deliveryStart) || !Number.isInteger(deliveryEnd)) {
        return { ok: false, message: 'Delivery times must be integers' };
    }

    if (deliveryStart % ONE_HOUR_MS !== 0 || deliveryEnd % ONE_HOUR_MS !== 0) {
        return { ok: false, message: 'Delivery times must be aligned to 1-hour boundaries' };
    }

    if (deliveryEnd <= deliveryStart) {
        return { ok: false, message: 'delivery_end must be greater than delivery_start' };
    }

    if (deliveryEnd - deliveryStart !== ONE_HOUR_MS) {
        return { ok: false, message: 'Delivery period must be exactly 1 hour' };
    }

    return { ok: true };
}


/***********************************************************
 * POTENTIAL BALANCE — REQUIRED FOR COLLATERAL
 ***********************************************************/
function computePotentialBalance(username) {
    let pot = getBalance(username); // current balance from trades.js

    for (const o of orders) {
        if (!o.isV2 || !o.active || o.quantity <= 0) continue;
        if (o.user !== username) continue;

        const value = o.price * o.quantity;

        if (value > 0) {
            if (o.side === 'BUY') pot -= value;   // buys reduce balance
            else pot += value;                    // sells receive money
        } else {
            // negative price orders produce opposite effect
            if (o.side === 'BUY') pot -= value;
            else pot += value;
        }
    }

    return pot;
}

function violatesCollateral(username) {
    const col = getCollateral(username); // null = unlimited
    if (col === null) return false;

    const pot = computePotentialBalance(username);
    return pot < -col;
}


/***********************************************************
 * V1: createOrder, getOrdersForWindow, findAndFillOrder
 ***********************************************************/
function createOrder(username, fields) {
    const price = fields.price;
    const quantity = fields.quantity;
    const deliveryStart = fields.delivery_start;
    const deliveryEnd = fields.delivery_end;

    const validation = validateOrderFields(price, quantity, deliveryStart, deliveryEnd);
    if (!validation.ok) {
        return { ok: false, status: 400, message: validation.message };
    }

    const orderId = generateOrderId();
    const now = Date.now();
    const order = {
        orderId,
        user: username,
        side: 'SELL',
        price,
        quantity,
        originalQuantity: quantity,
        deliveryStart,
        deliveryEnd,
        active: true,
        status: 'ACTIVE',
        createdAt: now,
        isV2: false
    };

    orders.push(order);
    return { ok: true, order };
}

function getOrdersForWindow(start, end) {
    const list = orders.filter(
        (o) =>
            o.active &&
            o.side === 'SELL' &&
            o.deliveryStart === start &&
            o.deliveryEnd === end
    );
    list.sort((a, b) => a.price - b.price);
    return list;
}

function findAndFillOrder(orderId) {
    const o = orders.find((x) => x.orderId === orderId);
    if (!o || !o.active) {
        return { ok: false, status: 404, message: 'Order not found or inactive' };
    }

    const filledQty = o.quantity;
    o.quantity = 0;
    o.active = false;
    o.status = 'FILLED';

    return { ok: true, order: o, filledQuantity: filledQty };
}


/***********************************************************
 * V2: MATCHING ENGINE
 ***********************************************************/
function placeOrderV2(username, fields, recordTradeFn) {
    const rawSide = fields.side;
    if (!rawSide || typeof rawSide !== 'string') {
        return { ok: false, status: 400, message: 'side is required (BUY or SELL)' };
    }
    const side = rawSide.toUpperCase();
    if (side !== 'BUY' && side !== 'SELL') {
        return { ok: false, status: 400, message: 'side must be BUY or SELL' };
    }

    const price = fields.price;
    const quantity = fields.quantity;
    const ds = fields.delivery_start;
    const de = fields.delivery_end;

    const v = validateOrderFields(price, quantity, ds, de);
    if (!v.ok) {
        return { ok: false, status: 400, message: v.message };
    }

    // --- COLLATERAL CHECK BEFORE ACCEPTING ORDER ---
    const tmp = {
        isV2: true,
        active: true,
        user: username,
        side,
        price,
        quantity,
        deliveryStart: ds,
        deliveryEnd: de
    };
    orders.push(tmp);
    const violates = violatesCollateral(username);
    orders.pop();

    if (violates) {
        return { ok: false, status: 402, message: 'Insufficient collateral' };
    }

    const now = Date.now();
    const incoming = {
        orderId: generateOrderId(),
        user: username,
        side,
        price,
        quantity,
        originalQuantity: quantity,
        deliveryStart: ds,
        deliveryEnd: de,
        active: true,
        status: 'ACTIVE',
        createdAt: now,
        isV2: true
    };

    let remaining = quantity;
    let filled = 0;

    const oppSide = side === 'BUY' ? 'SELL' : 'BUY';

    let candidates = orders.filter(
        (o) =>
            o.isV2 &&
            o.active &&
            o.side === oppSide &&
            o.deliveryStart === ds &&
            o.deliveryEnd === de &&
            o.quantity > 0
    );

    if (side === 'BUY') {
        candidates.sort((a, b) => a.price - b.price || a.createdAt - b.createdAt);
    } else {
        candidates.sort((a, b) => b.price - a.price || a.createdAt - b.createdAt);
    }

    for (const rest of candidates) {
        if (remaining <= 0) break;

        if (side === 'BUY' && incoming.price < rest.price) break;
        if (side === 'SELL' && incoming.price > rest.price) break;

        const tq = Math.min(remaining, rest.quantity);
        if (tq <= 0) continue;

        const tradePrice = rest.price;
        const buyer = side === 'BUY' ? incoming.user : rest.user;
        const seller = side === 'SELL' ? incoming.user : rest.user;

        recordTradeFn({
            buyerId: buyer,
            sellerId: seller,
            price: tradePrice,
            quantity: tq,
            timestamp: Date.now()
        });

        rest.quantity -= tq;
        if (rest.quantity <= 0) {
            rest.quantity = 0;
            rest.active = false;
            rest.status = 'FILLED';
        }

        remaining -= tq;
        filled += tq;
    }

    incoming.quantity = remaining;

    if (remaining <= 0) {
        incoming.active = false;
        incoming.status = 'FILLED';
    } else {
        orders.push(incoming);
    }

    return { ok: true, order: incoming, filledQuantity: filled };
}


/***********************************************************
 * V2 ORDER BOOK
 ***********************************************************/
function getV2OrderBook(ds, de) {
    const bids = [];
    const asks = [];

    for (const o of orders) {
        if (!o.isV2 || !o.active || o.quantity <= 0) continue;
        if (o.deliveryStart !== ds || o.deliveryEnd !== de) continue;

        if (o.side === 'BUY') bids.push(o);
        else if (o.side === 'SELL') asks.push(o);
    }

    bids.sort((a, b) => b.price - a.price || a.createdAt - b.createdAt);
    asks.sort((a, b) => a.price - b.price || a.createdAt - b.createdAt);

    return { bids, asks };
}

function getMyActiveV2Orders(username) {
    const mine = orders.filter(
        (o) => o.isV2 && o.active && o.quantity > 0 && o.user === username
    );
    mine.sort((a, b) => b.createdAt - a.createdAt);
    return mine;
}


/***********************************************************
 * V2 MODIFY
 ***********************************************************/
function findActiveV2Order(orderId) {
    const o = orders.find((x) => x.orderId === orderId && x.isV2);
    if (!o) return null;
    if (!o.active || o.quantity <= 0 || o.status !== 'ACTIVE') return null;
    return o;
}

function modifyOrderV2(username, orderId, fields, recordTradeFn) {
    const newPrice = fields.price;
    const newQty = fields.quantity;

    if (newPrice === undefined || newQty === undefined) {
        return { ok: false, status: 400, message: 'Both price and quantity required' };
    }
    if (!Number.isInteger(newPrice)) {
        return { ok: false, status: 400, message: 'Price must be integer' };
    }
    if (!Number.isInteger(newQty) || newQty <= 0) {
        return { ok: false, status: 400, message: 'Quantity must be positive' };
    }

    const o = findActiveV2Order(orderId);
    if (!o) {
        return { ok: false, status: 404, message: 'Order not found or not modifiable' };
    }
    if (o.user !== username) {
        return { ok: false, status: 403, message: 'Cannot modify another user\'s order' };
    }

    // --- COLLATERAL CHECK (simulate change) ---
    const oldPrice = o.price;
    const oldQ = o.quantity;
    const oldT = o.createdAt;

    o.price = newPrice;
    o.quantity = newQty;

    const violates = violatesCollateral(username);

    // revert
    o.price = oldPrice;
    o.quantity = oldQ;
    o.createdAt = oldT;

    if (violates) {
        return { ok: false, status: 402, message: 'Insufficient collateral' };
    }

    // APPLY REAL CHANGE
    const now = Date.now();
    let resetTP = false;

    if (newPrice !== oldPrice) resetTP = true;
    if (newQty > oldQ) resetTP = true;

    o.price = newPrice;
    o.quantity = newQty;

    if (newQty > o.originalQuantity) {
        o.originalQuantity = newQty;
    }

    if (resetTP) {
        o.createdAt = now;
    }

    // RUN MATCHING
    const side = o.side;
    const ds = o.deliveryStart;
    const de = o.deliveryEnd;
    let remaining = o.quantity;
    let filled = 0;

    const oppSide = side === 'BUY' ? 'SELL' : 'BUY';
    let candidates = orders.filter(
        (x) =>
            x.isV2 &&
            x.active &&
            x.side === oppSide &&
            x.deliveryStart === ds &&
            x.deliveryEnd === de &&
            x.quantity > 0
    );

    if (side === 'BUY') {
        candidates.sort((a, b) => a.price - b.price || a.createdAt - b.createdAt);
    } else {
        candidates.sort((a, b) => b.price - a.price || a.createdAt - b.createdAt);
    }

    for (const rest of candidates) {
        if (remaining <= 0) break;

        if (side === 'BUY' && o.price < rest.price) break;
        if (side === 'SELL' && o.price > rest.price) break;

        const tq = Math.min(remaining, rest.quantity);
        if (tq <= 0) continue;

        const tradePrice = rest.price;
        const buyer = side === 'BUY' ? o.user : rest.user;
        const seller = side === 'SELL' ? o.user : rest.user;

        recordTradeFn({
            buyerId: buyer,
            sellerId: seller,
            price: tradePrice,
            quantity: tq,
            timestamp: Date.now()
        });

        rest.quantity -= tq;
        if (rest.quantity <= 0) {
            rest.quantity = 0;
            rest.active = false;
            rest.status = 'FILLED';
        }

        remaining -= tq;
        filled += tq;
    }

    o.quantity = remaining;
    if (remaining <= 0) {
        o.quantity = 0;
        o.active = false;
        o.status = 'FILLED';
    }

    return { ok: true, order: o, filledQuantity: filled };
}


/***********************************************************
 * CANCEL ORDER
 ***********************************************************/
function cancelOrderV2(username, orderId) {
    const o = orders.find((x) => x.orderId === orderId && x.isV2);
    if (!o || o.status === 'CANCELLED') {
        return { ok: false, status: 404, message: 'Order not found or already cancelled' };
    }
    if (o.status === 'FILLED' || !o.active || o.quantity <= 0) {
        return { ok: false, status: 404, message: 'Order not cancellable' };
    }
    if (o.user !== username) {
        return { ok: false, status: 403, message: 'Cannot cancel another user\'s order' };
    }

    o.active = false;
    o.status = 'CANCELLED';
    o.quantity = 0;

    return { ok: true };
}


/***********************************************************
 * SNAPSHOT / RESTORE
 ***********************************************************/
function snapshotOrders() {
    return JSON.parse(JSON.stringify(orders));
}

function restoreOrders(snapshot) {
    orders.length = 0;
    for (const o of snapshot) orders.push(Object.assign({}, o));
}


/***********************************************************
 * EXPORTS
 ***********************************************************/
module.exports = {
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

    // NEW
    computePotentialBalance,
    violatesCollateral
};
