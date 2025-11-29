const { listOfObjects } = require('./galacticbuf');
const { getV2OrderBook } = require('./orders_v2');

const ONE_HOUR_MS = 3600000;

function registerV2OrderBookRoutes(app, sendGalactic) {
    // GET /v2/orders
    app.get('/v2/orders', (req, res) => {
        const qs = req.query || {};
        const deliveryStartStr = qs.delivery_start;
        const deliveryEndStr = qs.delivery_end;

        if (deliveryStartStr === undefined || deliveryEndStr === undefined) {
            return res.status(400).send('delivery_start and delivery_end are required');
        }

        const deliveryStart = Number(deliveryStartStr);
        const deliveryEnd = Number(deliveryEndStr);

        if (!Number.isInteger(deliveryStart) || !Number.isInteger(deliveryEnd)) {
            return res.status(400).send('delivery_start and delivery_end must be integers');
        }

        // Must be aligned
        if (
            deliveryStart % ONE_HOUR_MS !== 0 ||
            deliveryEnd % ONE_HOUR_MS !== 0
        ) {
            return res.status(400).send('delivery windows must be aligned to 1-hour boundaries');
        }

        const { bids, asks } = getV2OrderBook(deliveryStart, deliveryEnd);

        return sendGalactic(
            res,
            {
                bids: listOfObjects(
                    bids.map((o) => ({
                        order_id: o.orderId,
                        price: o.price,
                        quantity: o.quantity
                    }))
                ),
                asks: listOfObjects(
                    asks.map((o) => ({
                        order_id: o.orderId,
                        price: o.price,
                        quantity: o.quantity
                    }))
                )
            },
            200
        );
    });
};


module.exports = {registerV2OrderBookRoutes};