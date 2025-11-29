// auth.js
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/**
 * PERSISTENCE SETUP
 */
const PERSISTENT_DIR = process.env.PERSISTENT_DIR;
const AUTH_STATE_FILE = PERSISTENT_DIR
    ? path.join(PERSISTENT_DIR, 'auth-state.json')
    : null;

/**
 * USERS, TOKENS, DNA
 */
const users = new Map();       // username -> passwordHash
const tokens = new Map();      // token -> username
const usersDna = new Map();    // username -> Set<dna>
const userCollateral = new Map(); // username -> integer (max negative balance allowed, null = unlimited)

/****************************
 * PERSISTENCE HELPERS
 ****************************/
function loadAuthState() {
    if (!AUTH_STATE_FILE) return;
    try {
        if (!fs.existsSync(AUTH_STATE_FILE)) return;
        const raw = fs.readFileSync(AUTH_STATE_FILE, 'utf8');
        if (!raw) return;
        const data = JSON.parse(raw);

        // users
        users.clear();
        if (data.users && typeof data.users === 'object') {
            for (const [u, hash] of Object.entries(data.users)) {
                users.set(u, String(hash));
            }
        }

        // DNA samples
        usersDna.clear();
        if (data.usersDna && typeof data.usersDna === 'object') {
            for (const [u, arr] of Object.entries(data.usersDna)) {
                if (Array.isArray(arr)) {
                    usersDna.set(u, new Set(arr));
                }
            }
        }

        // collateral
        userCollateral.clear();
        if (data.userCollateral && typeof data.userCollateral === 'object') {
            for (const [u, val] of Object.entries(data.userCollateral)) {
                // val may be null or number
                userCollateral.set(u, val);
            }
        }

        // ensure every known user has collateral entry
        for (const u of users.keys()) {
            if (!userCollateral.has(u)) {
                userCollateral.set(u, null);
            }
        }
    } catch (err) {
        console.error('Failed to load auth state:', err.message);
    }
}

function saveAuthState() {
    if (!AUTH_STATE_FILE) return;
    try {
        const data = {
            users: Object.fromEntries(users),
            usersDna: Object.fromEntries(
                Array.from(usersDna.entries()).map(([u, set]) => [u, Array.from(set)])
            ),
            userCollateral: Object.fromEntries(userCollateral)
        };
        fs.mkdirSync(PERSISTENT_DIR, { recursive: true });
        fs.writeFileSync(AUTH_STATE_FILE, JSON.stringify(data));
    } catch (err) {
        console.error('Failed to save auth state:', err.message);
    }
}

// Load existing state on startup
loadAuthState();

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

    saveAuthState();

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

    saveAuthState();

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

// Your new banded Levenshtein implementation
function isDnaSimilar(sample, reference, limit) {
    // sample and reference are strings of CGAT with length divisible by 3
    // limit is integer number of allowed codon differences
    const sampleCodons = splitToCodons(sample);
    const refCodons = splitToCodons(reference);

    const n = sampleCodons.length;
    const m = refCodons.length;

    // Quick impossible-length check
    if (Math.abs(n - m) > limit) return false;

    // If limit is zero, require exact equality
    if (limit === 0) {
        if (n !== m) return false;
        for (let i = 0; i < n; i++) if (sampleCodons[i] !== refCodons[i]) return false;
        return true;
    }

    let prev = {}; // dp for i-1
    for (let j = 0; j <= m; j++) {
        if (j <= limit) prev[j] = j;
    }

    for (let i = 1; i <= n; i++) {
        const curr = {};
        const jmin = Math.max(0, i - limit);
        const jmax = Math.min(m, i + limit);

        // dp[i][0] = i if within band
        if (0 >= jmin && 0 <= jmax) curr[0] = i;

        for (let j = jmin; j <= jmax; j++) {
            if (j === 0 && curr[0] !== undefined) continue;

            let deleteCost = Infinity;
            let insertCost = Infinity;
            let subCost = Infinity;

            if (prev[j] !== undefined) deleteCost = prev[j] + 1;
            if (curr[j - 1] !== undefined) insertCost = curr[j - 1] + 1;
            if (prev[j - 1] !== undefined) {
                const eq = sampleCodons[i - 1] === refCodons[j - 1];
                subCost = prev[j - 1] + (eq ? 0 : 1);
            }

            const best = Math.min(deleteCost, insertCost, subCost);
            if (best !== Infinity) {
                curr[j] = best;
            }
        }

        let minInRow = Infinity;
        for (const v of Object.values(curr)) if (v < minInRow) minInRow = v;
        if (minInRow === Infinity || minInRow > limit) return false;

        prev = curr;
    }

    const finalVal = prev[m];
    if (finalVal === undefined) return false;
    return finalVal <= limit;
}


function registerDnaSample(username, password, sample) {
    if (!username || !password || typeof sample !== 'string') {
        return { ok: false, status: 400, message: 'Invalid input' };
    }

    if (!validateDnaSample(sample)) {
        return { ok: false, status: 400, message: 'Invalid DNA sample' };
    }

    // now authenticate (401 for bad credentials)
    const login = loginUser(username, password);
    if (!login.ok) return { ok: false, status: 401, message: 'Invalid credentials' };

    if (!usersDna.has(username)) usersDna.set(username, new Set());
    usersDna.get(username).add(sample);

    saveAuthState();

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
    saveAuthState();
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

    // NEW (required for collateral & persistence)
    getCollateral,
    setCollateral
};
