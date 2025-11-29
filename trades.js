const crypto = require('crypto');

const trades = []; // { tradeId, buyerId, sellerId, price, quantity, timestamp }

function recordTrade({ buyerId, sellerId, price, quantity, timestamp }) {
    const tradeId = crypto.randomBytes(16).toString('hex');
    const ts = typeof timestamp === 'number' ? timestamp : Date.now();

    const trade = {
        tradeId,
        buyerId,
        sellerId,
        price,
        quantity,
        timestamp: ts
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
    // NEW for bulk operations
    snapshotTrades,
    restoreTrades
};
