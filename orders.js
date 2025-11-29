// orders.js
const crypto = require('crypto');

const ONE_HOUR_MS = 3600000;

// Order structure:
// {
//   orderId,
//   user,
//   side: 'BUY' | 'SELL',
//   price,
//   quantity,          // remaining quantity
//   originalQuantity,  // initial quantity
//   deliveryStart,
//   deliveryEnd,
//   active: boolean,
//   status: 'ACTIVE' | 'FILLED',
//   createdAt: number, // timestamp ms
//   isV2: boolean      // true if created via /v2/orders
// }
const orders = [];

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

// Legacy endpoint /orders: submit SELL orders only, no matching.
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

// For GET /orders: only active SELL orders for given contract (v1 view)
function getOrdersForWindow(deliveryStart, deliveryEnd) {
    const filtered = orders.filter(
        (o) =>
            o.active &&
            o.side === 'SELL' &&
            o.deliveryStart === deliveryStart &&
            o.deliveryEnd === deliveryEnd
    );

    filtered.sort((a, b) => a.price - b.price);
    return filtered;
}

// Used by manual POST /trades (take order)
function findAndFillOrder(orderId) {
    const order = orders.find((o) => o.orderId === orderId);
    if (!order || !order.active) {
        return {
            ok: false,
            status: 404,
            message: 'Order not found or not active'
        };
    }

    const filledQty = order.quantity;

    order.active = false;
    order.status = 'FILLED';
    order.quantity = 0;

    return { ok: true, order, filledQuantity: filledQty };
}

// V2 matching engine: POST /v2/orders
// fields: { side, price, quantity, delivery_start, delivery_end }
// recordTradeFn: function({ buyerId, sellerId, price, quantity, timestamp })
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
    const deliveryStart = fields.delivery_start;
    const deliveryEnd = fields.delivery_end;

    const validation = validateOrderFields(price, quantity, deliveryStart, deliveryEnd);
    if (!validation.ok) {
        return { ok: false, status: 400, message: validation.message };
    }

    const now = Date.now();
    const orderId = generateOrderId();

    const incomingOrder = {
        orderId,
        user: username,
        side,
        price,
        quantity,
        originalQuantity: quantity,
        deliveryStart,
        deliveryEnd,
        active: true,
        status: 'ACTIVE',
        createdAt: now,
        isV2: true
    };

    let remaining = quantity;
    let filledQuantity = 0;

    const oppositeSide = side === 'BUY' ? 'SELL' : 'BUY';

    // Candidate resting orders in the same contract, opposite side, active, V2 only
    let candidates = orders.filter(
        (o) =>
            o.isV2 &&                 // <--- important: only V2 orders
            o.active &&
            o.side === oppositeSide &&
            o.deliveryStart === deliveryStart &&
            o.deliveryEnd === deliveryEnd &&
            o.quantity > 0
    );


    // Sort by price-time priority
    if (side === 'BUY') {
        // Match cheapest sells first, then oldest
        candidates.sort((a, b) => {
            if (a.price !== b.price) return a.price - b.price;
            return a.createdAt - b.createdAt;
        });
    } else {
        // side === 'SELL': match highest bids first, then oldest
        candidates.sort((a, b) => {
            if (a.price !== b.price) return b.price - a.price;
            return a.createdAt - b.createdAt;
        });
    }

    for (const resting of candidates) {
        if (remaining <= 0) break;

        // Price crossing check
        if (side === 'BUY') {
            // buy_price >= sell_price
            if (incomingOrder.price < resting.price) {
                // Because list is sorted by price, no further candidate will match
                break;
            }
        } else {
            // side === 'SELL', sell_price <= buy_price
            if (incomingOrder.price > resting.price) {
                // No further candidate will have better (higher) price
                break;
            }
        }

        const tradeQty = Math.min(remaining, resting.quantity);
        if (tradeQty <= 0) continue;

        const tradePrice = resting.price; // maker (resting) price
        const buyerId = side === 'BUY' ? incomingOrder.user : resting.user;
        const sellerId = side === 'SELL' ? incomingOrder.user : resting.user;

        recordTradeFn({
            buyerId,
            sellerId,
            price: tradePrice,
            quantity: tradeQty,
            timestamp: Date.now()
        });

        // Update resting order
        resting.quantity -= tradeQty;
        if (resting.quantity <= 0) {
            resting.quantity = 0;
            resting.active = false;
            resting.status = 'FILLED';
        }

        // Update incoming order
        remaining -= tradeQty;
        filledQuantity += tradeQty;
    }

    // Final incoming order state
    incomingOrder.quantity = remaining;

    if (remaining <= 0) {
        incomingOrder.quantity = 0;
        incomingOrder.active = false;
        incomingOrder.status = 'FILLED';
    }

    // We keep the order in our internal list (for "My Orders" etc.)
    orders.push(incomingOrder);

    return {
        ok: true,
        order: incomingOrder,
        filledQuantity
    };
}

// ---- V2 order book helpers ----

// Returns { bids, asks } arrays of ACTIVE v2 orders for a contract
function getV2OrderBook(deliveryStart, deliveryEnd) {
    const bids = [];
    const asks = [];

    for (const o of orders) {
        if (
            !o.isV2 ||
            !o.active ||
            o.quantity <= 0 ||
            o.deliveryStart !== deliveryStart ||
            o.deliveryEnd !== deliveryEnd
        ) {
            continue;
        }
        if (o.side === 'BUY') {
            bids.push(o);
        } else if (o.side === 'SELL') {
            asks.push(o);
        }
    }

    // Bids: price descending, then time ascending
    bids.sort((a, b) => {
        if (a.price !== b.price) return b.price - a.price;
        return a.createdAt - b.createdAt;
    });

    // Asks: price ascending, then time ascending
    asks.sort((a, b) => {
        if (a.price !== b.price) return a.price - b.price;
        return a.createdAt - b.createdAt;
    });

    return { bids, asks };
}

// Returns all ACTIVE v2 orders for a user across all contracts
function getMyActiveV2Orders(username) {
    const mine = orders.filter(
        (o) =>
            o.isV2 &&
            o.active &&
            o.quantity > 0 &&
            o.user === username
    );

    // Newest first
    mine.sort((a, b) => b.createdAt - a.createdAt);

    return mine;
}

module.exports = {
    ONE_HOUR_MS,
    createOrder,
    getOrdersForWindow,
    findAndFillOrder,
    placeOrderV2,
    getV2OrderBook,
    getMyActiveV2Orders
};
