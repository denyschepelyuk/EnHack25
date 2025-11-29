const crypto = require('crypto');

const trades = []; // stored trades
const balances = new Map(); // username -> integer balance

function applyTradeToBalances({ buyerId, sellerId, price, quantity }) {
    const amount = price * quantity;

    // buyer pays
    const b = balances.get(buyerId) || 0;
    balances.set(buyerId, b - amount);

    // seller receives
    const s = balances.get(sellerId) || 0;
    balances.set(sellerId, s + amount);
}

function recordTrade({ 
    buyerId, 
    sellerId, 
    buyerUsername, 
    sellerUsername,
    price, 
    quantity,
    delivery_start,
    delivery_end,
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

    applyTradeToBalances({ buyerId, sellerId, price, quantity });

    return trade;
}

function getTrades() {
    return [...trades].sort((a, b) => b.timestamp - a.timestamp);
}

// --- NEW BALANCE HELPERS ---

function getBalance(username) {
    return balances.get(username) || 0;
}

function setBalance(username, value) {
    balances.set(username, value);
}

function snapshotTrades() {
    return {
        trades: JSON.parse(JSON.stringify(trades)),
        balances: new Map(balances)
    };
}

function restoreTrades(snapshot) {
    trades.length = 0;
    for (const t of snapshot.trades) {
        trades.push(Object.assign({}, t));
    }

    // restore balances
    balances.clear();
    for (const [u, b] of snapshot.balances.entries()) {
        balances.set(u, b);
    }
}

module.exports = {
    recordTrade,
    getTrades,
    getBalance,
    setBalance,
    snapshotTrades,
    restoreTrades
};
