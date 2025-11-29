
const crypto = require('crypto');

const ONE_HOUR_MS = 3600000;

// V2 orders are completely independent from V1.
const v2orders = [];

// order object structure:
// {
//   orderId,
//   user,
//   side,              // "buy" | "sell"
//   price,
//   quantity,
//   deliveryStart,
//   deliveryEnd,
//   status: "ACTIVE"
// }

function generateOrderId() {
    return crypto.randomBytes(16).toString('hex');
}

function validateV2OrderFields(side, price, quantity, deliveryStart, deliveryEnd) {
    if (side !== 'buy' && side !== 'sell') {
        return { ok: false, message: 'side must be "buy" or "sell"' };
    }

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

function createV2Order(username, fields) {
    const side = fields.side;
    const price = fields.price;
    const quantity = fields.quantity;
    const deliveryStart = fields.delivery_start;
    const deliveryEnd = fields.delivery_end;

    const validation = validateV2OrderFields(
        side,
        price,
        quantity,
        deliveryStart,
        deliveryEnd
    );

    if (!validation.ok) {
        return { ok: false, status: 400, message: validation.message };
    }

    const orderId = generateOrderId();

    const order = {
        orderId,
        user: username,
        side,
        price,
        quantity,
        deliveryStart,
        deliveryEnd,
        status: 'ACTIVE'
    };

    v2orders.push(order);
    return { ok: true, order };
}

module.exports = {
    createV2Order
};
