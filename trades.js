// trades.js
// In-memory storage and retrieval of completed trades

const crypto = require('crypto');

const trades = []; // { tradeId, buyerId, sellerId, price, quantity, timestamp }

// This will be used by POST /trades (take order) and any future matching logic.
// buyerId and sellerId are usernames (strings).
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

// Returns trades sorted by timestamp descending (newest first)
function getTrades() {
    return [...trades].sort((a, b) => b.timestamp - a.timestamp);
}

module.exports = {
    recordTrade,
    getTrades
};
