// orders.js
const crypto = require('crypto');

const ONE_HOUR_MS = 3600000;

// order: { orderId, user, price, quantity, deliveryStart, deliveryEnd, active, status }
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
    const order = {
        orderId,
        user: username,
        price,
        quantity,
        deliveryStart,
        deliveryEnd,
        active: true,
        status: 'ACTIVE'
    };

    orders.push(order);
    return { ok: true, order };
}

function getOrdersForWindow(deliveryStart, deliveryEnd) {
    const filtered = orders.filter(
        (o) =>
            o.active &&
            o.deliveryStart === deliveryStart &&
            o.deliveryEnd === deliveryEnd
    );

    filtered.sort((a, b) => a.price - b.price);
    return filtered;
}

// Used by POST /trades (take order)
function findAndFillOrder(orderId) {
    const order = orders.find((o) => o.orderId === orderId);
    if (!order || !order.active) {
        return {
            ok: false,
            status: 404,
            message: 'Order not found or not active'
        };
    }

    order.active = false;
    order.status = 'FILLED';
    return { ok: true, order };
}

module.exports = {
    createOrder,
    getOrdersForWindow,
    findAndFillOrder
};
