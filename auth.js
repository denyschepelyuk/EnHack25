// auth.js (ULTRA-FAST VERSION)

// -----------------------------------------
// Imports
// -----------------------------------------
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PERSISTENT_DIR = process.env.PERSISTENT_DIR;
const AUTH_STATE_FILE = PERSISTENT_DIR ? path.join(PERSISTENT_DIR, 'auth-state.json') : null;

const users = new Map();
const tokens = new Map();
const usersDna = new Map();
const userCollateral = new Map();


// -----------------------------------------
// FAST DNA HELPERS
// -----------------------------------------

// Convert codon chars → small number (0–63)
function hashCodon(c1, c2, c3) {
    const map = { A:0, C:1, G:2, T:3 };
    return (map[c1] << 4) | (map[c2] << 2) | map[c3];
}

// Convert raw DNA string → Uint8Array of hashed codons
function dnaToHashedCodons(dna) {
    const n = dna.length / 3;
    const arr = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        const p = i * 3;
        arr[i] = hashCodon(dna[p], dna[p+1], dna[p+2]);
    }
    return arr;
}

// Validate DNA structure quickly
function validateDnaSample(dna) {
    if (!dna || typeof dna !== 'string') return false;
    if (dna.length === 0 || dna.length % 3 !== 0) return false;
    return /^[CGAT]+$/.test(dna);
}


// -----------------------------------------
// ULTRA-FAST DNA SIMILARITY — HAMMING ONLY
// -----------------------------------------
function isDnaSimilarHashed(sampleArr, refArr, limit) {
    const n = sampleArr.length;
    const m = refArr.length;

    // lengths must match — spec allows re-registration for other sampler lengths
    if (n !== m) return false;

    let mismatches = 0;

    // Compare 8 codons per iteration (unrolled loop)
    const blocks = n & ~7;
    for (let i = 0; i < blocks; i += 8) {
        mismatches += (sampleArr[i] !== refArr[i]);
        mismatches += (sampleArr[i+1] !== refArr[i+1]);
        mismatches += (sampleArr[i+2] !== refArr[i+2]);
        mismatches += (sampleArr[i+3] !== refArr[i+3]);
        mismatches += (sampleArr[i+4] !== refArr[i+4]);
        mismatches += (sampleArr[i+5] !== refArr[i+5]);
        mismatches += (sampleArr[i+6] !== refArr[i+6]);
        mismatches += (sampleArr[i+7] !== refArr[i+7]);

        if (mismatches > limit) return false;
    }

    // tail
    for (let i = blocks; i < n; i++) {
        if (sampleArr[i] !== refArr[i]) {
            if (++mismatches > limit) return false;
        }
    }

    return mismatches <= limit;
}


// -----------------------------------------
// State loading / saving
// -----------------------------------------
function loadAuthState() {
    if (!AUTH_STATE_FILE) return;
    try {
        if (!fs.existsSync(AUTH_STATE_FILE)) return;
        const raw = fs.readFileSync(AUTH_STATE_FILE, 'utf8');
        if (!raw) return;
        const data = JSON.parse(raw);

        users.clear();
        if (data.users && typeof data.users === 'object') {
            for (const [u, hash] of Object.entries(data.users)) users.set(u, String(hash));
        }

        usersDna.clear();
        if (data.usersDna && typeof data.usersDna === 'object') {
            for (const [u, arr] of Object.entries(data.usersDna)) {
                if (Array.isArray(arr)) {
                    usersDna.set(u, new Set(arr.map(encoded => {
                        const buf = Buffer.from(encoded, 'base64');
                        return new Uint8Array(buf);
                    })));
                }
            }
        }

        userCollateral.clear();
        if (data.userCollateral && typeof data.userCollateral === 'object') {
            for (const [u, v] of Object.entries(data.userCollateral)) {
                userCollateral.set(u, v);
            }
        }

        for (const u of users.keys()) {
            if (!userCollateral.has(u)) userCollateral.set(u, null);
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
                [...usersDna.entries()].map(([u, set]) => [
                    u,
                    [...set].map(arr => Buffer.from(arr).toString('base64'))
                ])
            ),
            userCollateral: Object.fromEntries(userCollateral)
        };

        fs.mkdirSync(PERSISTENT_DIR, { recursive: true });
        fs.writeFileSync(AUTH_STATE_FILE, JSON.stringify(data));
    } catch (err) {
        console.error('Failed to save auth state:', err.message);
    }
}

loadAuthState();


// -----------------------------------------
// Auth base functions
// -----------------------------------------
function hashPassword(password) {
    return crypto.createHash('sha256').update(password, 'utf8').digest('hex');
}

function registerUser(username, password) {
    if (!username || !password) return { ok: false, status: 400, message: 'Invalid input' };
    if (users.has(username)) return { ok: false, status: 409, message: 'Username already exists' };
    users.set(username, hashPassword(password));
    userCollateral.set(username, null);
    saveAuthState();
    return { ok: true };
}

function loginUser(username, password) {
    if (!username || !password) return { ok: false, status: 401, message: 'Invalid credentials' };
    const storedHash = users.get(username);
    if (!storedHash) return { ok: false, status: 401, message: 'Invalid credentials' };
    if (hashPassword(password) !== storedHash) return { ok: false, status: 401, message: 'Invalid credentials' };
    const token = crypto.randomBytes(32).toString('hex');
    tokens.set(token, username);
    return { ok: true, token };
}

function invalidateTokensForUser(username) {
    for (const [token, user] of tokens.entries()) {
        if (user === username) tokens.delete(token);
    }
}

function changePassword(username, oldPassword, newPassword) {
    if (!username || !oldPassword || !newPassword) return { ok: false, status: 400, message: 'Invalid input' };
    const storedHash = users.get(username);
    if (!storedHash) return { ok: false, status: 401, message: 'Invalid credentials' };
    if (hashPassword(oldPassword) !== storedHash) return { ok: false, status: 401, message: 'Invalid credentials' };
    users.set(username, hashPassword(newPassword));
    invalidateTokensForUser(username);
    saveAuthState();
    return { ok: true };
}

function authMiddleware(req, res, next) {
    const header = req.headers['authorization'] || '';
    if (!header.startsWith('Bearer ')) return res.status(401).end();
    const token = header.slice(7).trim();
    const user = tokens.get(token);
    if (!user) return res.status(401).end();
    req.user = user;
    next();
}


// -----------------------------------------
// DNA Registration and Login
// -----------------------------------------
function registerDnaSample(username, password, sample) {
    if (!username || !password || typeof sample !== 'string')
        return { ok: false, status: 400, message: 'Invalid input' };

    if (!validateDnaSample(sample))
        return { ok: false, status: 400, message: 'Invalid DNA sample' };

    const login = loginUser(username, password);
    if (!login.ok)
        return { ok: false, status: 401, message: 'Invalid credentials' };

    const hashed = dnaToHashedCodons(sample);

    if (!usersDna.has(username)) usersDna.set(username, new Set());
    usersDna.get(username).add(hashed);

    saveAuthState();
    return { ok: true };
}

function loginWithDna(username, sample) {
    if (!username || typeof username !== 'string' || !validateDnaSample(sample)) {
        return { ok: false, status: 400, message: 'Invalid input' };
    }
    if (!users.has(username)) return { ok: false, status: 401, message: 'Authentication failed' };

    const stored = usersDna.get(username);
    if (!stored || stored.size === 0) return { ok: false, status: 401, message: 'Authentication failed' };

    const sampleArr = dnaToHashedCodons(sample);

    for (const refArr of stored) {
        const refCodons = refArr.length;

        // mismatch tolerance (your original rule)
        const limit = Math.floor(refCodons / 100000);

        if (isDnaSimilarHashed(sampleArr, refArr, limit)) {
            const token = crypto.randomBytes(32).toString('hex');
            tokens.set(token, username);
            return { ok: true, token };
        }
    }

    return { ok: false, status: 401, message: 'DNA verification failed' };
}


// -----------------------------------------
// Collateral
// -----------------------------------------
function getUsernameFromToken(token) {
    return tokens.get(token) || null;
}

function getCollateral(username) {
    return userCollateral.has(username) ? userCollateral.get(username) : null;
}

function setCollateral(username, value) {
    if (!users.has(username)) return { ok: false, status: 404, message: 'User not found' };
    userCollateral.set(username, value);
    saveAuthState();
    return { ok: true };
}


module.exports = {
    registerUser,
    loginUser,
    changePassword,
    authMiddleware,
    registerDnaSample,
    loginWithDna,
    getUsernameFromToken,
    getCollateral,
    setCollateral
};


//       (\ /)
//      ( . .) ♥
//      c(")(")

