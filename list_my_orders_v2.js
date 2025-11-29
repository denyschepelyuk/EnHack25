const { authMiddleware } = require('./auth');
const { v2orders } = require('./orders_v2');

function registerListMyOrdersV2(app) {
    app.get('/v2/my-orders', authMiddleware, (req, res) => {
        const username = req.user;

        if (!username) {
            return res.status(401).json({ message: 'Unauthorized' });
        }

        const mine = v2orders
            .filter(o => o.user === username && o.status === 'ACTIVE')
            .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));


        const orders = mine.map(o => ({
            order_id: o.orderId,
            side: o.side,
            price: o.price,
            quantity: o.quantity,
            delivery_start: o.deliveryStart,
            delivery_end: o.deliveryEnd,
            timestamp: o.timestamp
        }));

        return res.status(200).json({ orders });
    });
}

module.exports = {
    registerListMyOrdersV2
};
