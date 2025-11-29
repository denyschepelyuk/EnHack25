// auth.js
const crypto = require('crypto');

/**
 * USERS, TOKENS, DNA
 */
const users = new Map();       // username -> passwordHash
const tokens = new Map();      // token -> username
const usersDna = new Map();    // username -> Set<dna>
const userCollateral = new Map(); // username -> integer (max negative balance allowed, null = unlimited)


/****************************
 * PASSWORD HASHING
 ****************************/
function hashPassword(password) {
    return crypto.createHash('sha256').update(password, 'utf8').digest('hex');
}


/****************************
 * USER REGISTRATION & LOGIN
 ****************************/
function registerUser(username, password) {
    if (!username || !password) {
        return { ok: false, status: 400, message: 'Invalid input' };
    }
    if (users.has(username)) {
        return { ok: false, status: 409, message: 'Username already exists' };
    }

    const hash = hashPassword(password);
    users.set(username, hash);

    // DEFAULT collateral: unlimited
    userCollateral.set(username, null);

    return { ok: true };
}

function loginUser(username, password) {
    if (!username || !password) {
        return { ok: false, status: 401, message: 'Invalid credentials' };
    }

    const storedHash = users.get(username);
    if (!storedHash) {
        return { ok: false, status: 401, message: 'Invalid credentials' };
    }

    if (hashPassword(password) !== storedHash) {
        return { ok: false, status: 401, message: 'Invalid credentials' };
    }

    const token = crypto.randomBytes(32).toString('hex');
    tokens.set(token, username);
    return { ok: true, token };
}


/****************************
 * PASSWORD CHANGE
 ****************************/
function invalidateTokensForUser(username) {
    for (const [token, user] of tokens.entries()) {
        if (user === username) tokens.delete(token);
    }
}

function changePassword(username, oldPassword, newPassword) {
    if (!username || !oldPassword || !newPassword) {
        return { ok: false, status: 400, message: 'Invalid input' };
    }

    const storedHash = users.get(username);
    if (!storedHash) {
        return { ok: false, status: 401, message: 'Invalid credentials' };
    }

    if (hashPassword(oldPassword) !== storedHash) {
        return { ok: false, status: 401, message: 'Invalid credentials' };
    }

    users.set(username, hashPassword(newPassword));
    invalidateTokensForUser(username);

    return { ok: true };
}


/****************************
 * AUTH MIDDLEWARE
 ****************************/
function authMiddleware(req, res, next) {
    const header = req.headers['authorization'] || '';
    if (!header.startsWith('Bearer ')) return res.status(401).end();

    const token = header.slice(7).trim();
    const user = tokens.get(token);
    if (!user) return res.status(401).end();

    req.user = user;
    next();
}


/****************************
 * DNA LOGIN SUPPORT
 ****************************/
function validateDnaSample(dna) {
    if (!dna || typeof dna !== 'string') return false;
    if (dna.length === 0 || dna.length % 3 !== 0) return false;
    return /^[CGAT]+$/.test(dna);
}

function splitToCodons(dna) {
    const arr = [];
    for (let i = 0; i < dna.length; i += 3) arr.push(dna.substring(i, i+3));
    return arr;
}

function isDnaSimilar(sample, reference, limit) {
    // Implementation unchanged—your original version
    const n = sample.length / 3;
    const m = reference.length / 3;

    if (Math.abs(n - m) > limit) return false;
    if (limit === 0) return sample === reference;

    let prev = new Array(m+1);
    let curr = new Array(m+1);

    for (let j = 0; j <= m; j++) prev[j] = j;

    for (let i = 1; i <= n; i++) {
        const start = Math.max(1, i-limit);
        const end = Math.min(m, i+limit);
        curr[0] = i;

        let minInRow = Infinity;

        for (let j = start; j <= end; j++) {
            const codS = sample.substring((i - 1) * 3, i * 3);
            const codT = reference.substring((j - 1) * 3, j * 3);
            const cost = codS === codT ? 0 : 1;

            let left = j > start ? curr[j - 1] : curr[0];

            curr[j] = Math.min(prev[j] + 1, left + 1, prev[j - 1] + cost);

            if (curr[j] < minInRow) minInRow = curr[j];
        }

        if (minInRow > limit) return false;

        const tmp = prev; prev = curr; curr = tmp;
    }

    return prev[m] <= limit;
}

function registerDnaSample(username, password, sample) {
    const login = loginUser(username, password);
    if (!login.ok) return { ok: false, status: 401, message: 'Invalid credentials' };

    if (!validateDnaSample(sample)) {
        return { ok: false, status: 400, message: 'Invalid DNA sample' };
    }

    if (!usersDna.has(username)) usersDna.set(username, new Set());
    usersDna.get(username).add(sample);

    return { ok: true };
}

function loginWithDna(username, sample) {
    if (!username || !validateDnaSample(sample)) {
        return { ok: false, status: 400, message: 'Invalid input' };
    }

    if (!users.has(username)) {
        return { ok: false, status: 401, message: 'Authentication failed' };
    }

    const stored = usersDna.get(username);
    if (!stored || stored.size === 0) {
        return { ok: false, status: 401, message: 'Authentication failed' };
    }

    for (const ref of stored) {
        const limit = Math.floor((ref.length / 3) / 100000);
        if (isDnaSimilar(sample, ref, limit)) {
            const token = crypto.randomBytes(32).toString('hex');
            tokens.set(token, username);
            return { ok: true, token };
        }
    }

    return { ok: false, status: 401, message: 'DNA verification failed' };
}

function getUsernameFromToken(token) {
    return tokens.get(token) || null;
}


/****************************
 * COLLATERAL MANAGEMENT
 ****************************/
function getCollateral(username) {
    return userCollateral.has(username) ? userCollateral.get(username) : null;
}

function setCollateral(username, value) {
    if (!users.has(username)) return { ok: false, status: 404, message: 'User not found' };
    userCollateral.set(username, value);
    return { ok: true };
}


/****************************
 * EXPORTS
 ****************************/
module.exports = {
    registerUser,
    loginUser,
    changePassword,
    authMiddleware,

    registerDnaSample,
    loginWithDna,

    getUsernameFromToken,

    // NEW (required for collateral)
    getCollateral,
    setCollateral
};
