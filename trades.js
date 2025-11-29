// trades.js
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PERSISTENT_DIR = process.env.PERSISTENT_DIR;
const TRADES_STATE_FILE = PERSISTENT_DIR
    ? path.join(PERSISTENT_DIR, 'trades-state.json')
    : null;

const trades = [];          // stored trades
const balances = new Map(); // username -> integer balance

/****************************
 * PERSISTENCE HELPERS
 ****************************/
function loadTradesState() {
    if (!TRADES_STATE_FILE) return;
    try {
        if (!fs.existsSync(TRADES_STATE_FILE)) return;
        const raw = fs.readFileSync(TRADES_STATE_FILE, 'utf8');
        if (!raw) return;
        const data = JSON.parse(raw);

        trades.length = 0;
        if (Array.isArray(data.trades)) {
            for (const t of data.trades) {
                trades.push(Object.assign({}, t));
            }
        }

        balances.clear();
        if (data.balances && typeof data.balances === 'object') {
            for (const [u, b] of Object.entries(data.balances)) {
                balances.set(u, Number(b));
            }
        }
    } catch (err) {
        console.error('Failed to load trades state:', err.message);
    }
}

function saveTradesState() {
    if (!TRADES_STATE_FILE) return;
    try {
        const data = {
            trades,
            balances: Object.fromEntries(balances)
        };
        fs.mkdirSync(PERSISTENT_DIR, { recursive: true });
        fs.writeFileSync(TRADES_STATE_FILE, JSON.stringify(data));
    } catch (err) {
        console.error('Failed to save trades state:', err.message);
    }
}

// Load persisted trades/balances on module load
loadTradesState();


/****************************
 * BALANCE APPLY
 ****************************/
function applyTradeToBalances({ buyerId, sellerId, price, quantity }) {
    const amount = price * quantity;

    // buyer pays
    const b = balances.get(buyerId) || 0;
    balances.set(buyerId, b - amount);

    // seller receives
    const s = balances.get(sellerId) || 0;
    balances.set(sellerId, s + amount);
}


/****************************
 * RECORD TRADE
 ****************************/
function recordTrade({
    buyerId,
    sellerId,
    buyerUsername,
    sellerUsername,
    price,
    quantity,
    delivery_start,
    delivery_end,
    timestamp,isV2
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
        delivery_end,
        isV2: !!isV2
    };

    trades.push(trade);
    applyTradeToBalances({ buyerId, sellerId, price, quantity });

    saveTradesState();

    return trade;
}


/****************************
 * QUERIES
 ****************************/
function getTrades() {
    return [...trades].sort((a, b) => b.timestamp - a.timestamp);
}

function getBalance(username) {
    return balances.get(username) || 0;
}

function setBalance(username, value) {
    balances.set(username, value);
    saveTradesState();
}


/****************************
 * SNAPSHOT / RESTORE (for bulk ops)
 ****************************/
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

    balances.clear();
    for (const [u, b] of snapshot.balances.entries()) {
        balances.set(u, b);
    }

    // Ensure persistence matches restored state
    saveTradesState();
}


module.exports = {
    recordTrade,
    getTrades,
    getBalance,
    setBalance,
    snapshotTrades,
    restoreTrades
};
