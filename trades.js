const crypto = require('crypto');

const trades = []; 

function recordTrade({ 
    buyerId, sellerId, buyerUsername, sellerUsername,
    price, quantity,
    delivery_start, delivery_end,
    timestamp
}) {
    const tradeId = crypto.randomBytes(16).toString('hex');
    const ts = typeof timestamp === 'number' ? timestamp : Date.now();

    const trade = {
        tradeId,
        buyerId,
        sellerId,
        buyerUsername,
        sellerUsername,
        price,
        quantity,
        timestamp: ts,
        delivery_start,
        delivery_end
    };

    trades.push(trade);
    return trade;
}

function getTrades() {
    return [...trades].sort((a, b) => b.timestamp - a.timestamp);
}

function snapshotTrades() {
    return JSON.parse(JSON.stringify(trades));
}

function restoreTrades(snapshot) {
    trades.length = 0;
    for (const t of snapshot) {
        trades.push(Object.assign({}, t));
    }
}

module.exports = {
    recordTrade,
    getTrades,
    snapshotTrades,
    restoreTrades
};
