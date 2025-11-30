// auth.js
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PERSISTENT_DIR = process.env.PERSISTENT_DIR;
const AUTH_STATE_FILE = PERSISTENT_DIR
    ? path.join(PERSISTENT_DIR, 'auth-state.json')
    : null;

const users = new Map();
const tokens = new Map();
const usersDna = new Map();
const userCollateral = new Map();

/****************************
 * LOAD / SAVE PERSISTED STATE
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

        // usersDna: previously was raw strings; new format stores objects with sig/len/fingerprint
        usersDna.clear();
        if (data.usersDna && typeof data.usersDna === 'object') {
            for (const [u, arr] of Object.entries(data.usersDna)) {
                if (Array.isArray(arr)) {
                    // each element should be { sig: [numbers], len: number, fingerprint: string }
                    const normalized = [];
                    for (const s of arr) {
                        if (s && Array.isArray(s.sig) && Number.isInteger(s.len)) {
                            normalized.push({
                                sig: s.sig.map(x => Number(x) >>> 0),
                                len: Number(s.len),
                                fingerprint: typeof s.fingerprint === 'string' ? s.fingerprint : null
                            });
                        }
                    }
                    usersDna.set(u, normalized);
                }
            }
        }

        // collateral
        userCollateral.clear();
        if (data.userCollateral && typeof data.userCollateral === 'object') {
            for (const [u, val] of Object.entries(data.userCollateral)) {
                userCollateral.set(u, val);
            }
        }

        // ensure every user has some collateral entry
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
                Array.from(usersDna.entries()).map(([u, arr]) => [u, arr.map(s => ({ sig: s.sig, len: s.len, fingerprint: s.fingerprint }))])
            ),
            userCollateral: Object.fromEntries(userCollateral)
        };
        fs.mkdirSync(PERSISTENT_DIR, { recursive: true });
        fs.writeFileSync(AUTH_STATE_FILE, JSON.stringify(data));
    } catch (err) {
        console.error('Failed to save auth state:', err.message);
    }
}


// Load persisted state on module load
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

    users.set(username, hashPassword(password));
    userCollateral.set(username, null); // default: unlimited
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

function invalidateTokensForUser(username) {
    for (const [token, user] of tokens.entries()) {
        if (user === username) {
            tokens.delete(token);
        }
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
    if (!header.startsWith('Bearer ')) {
        return res.status(401).end();
    }

    const token = header.slice(7).trim();
    const user = tokens.get(token);
    if (!user) {
        return res.status(401).end();
    }

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

function codonAt(dna, idx) {
    const start = idx * 3;
    return dna.substr(start, 3);
}

// banded Levenshtein on codon indices; limit is small (floor(ref_codons/100000))
function isDnaSimilar(sample, reference, limit) {
    const n = sample.length / 3;
    const m = reference.length / 3;
    if (!Number.isInteger(n) || !Number.isInteger(m)) return false;
    if (Math.abs(n - m) > limit) return false;

    if (limit === 0) {
        if (n !== m) return false;
        for (let i = 0; i < n; i++) {
            if (codonAt(sample, i) !== codonAt(reference, i)) return false;
        }
        return true;
    }

    // initialize prev row for i = 0: dp[0][j] = j for j in [0 .. min(m, limit)]
    let prevJmin = 0;
    let prevJmax = Math.min(m, limit);
    let prev = new Array(prevJmax - prevJmin + 1);
    for (let j = prevJmin; j <= prevJmax; j++) {
        prev[j - prevJmin] = j;
    }

    for (let i = 1; i <= n; i++) {
        const jmin = Math.max(0, i - limit);
        const jmax = Math.min(m, i + limit);
        const currLen = jmax - jmin + 1;
        const curr = new Array(currLen);
        let minRow = Infinity;

        for (let j = jmin; j <= jmax; j++) {
            const idx = j - jmin;
            let del = Infinity;
            let ins = Infinity;
            let sub = Infinity;

            // delete: from prev[j] + 1
            if (j >= prevJmin && j <= prevJmax) {
                del = prev[j - prevJmin] + 1;
            }

            // insert: from curr[j-1] +1
            if (j - 1 >= jmin) {
                ins = curr[(j - 1) - jmin] + 1;
            }

            // substitution/match: from prev[j-1] + (0|1)
            if (j - 1 >= prevJmin && j - 1 <= prevJmax) {
                const eq = codonAt(sample, i - 1) === codonAt(reference, j - 1);
                sub = prev[(j - 1) - prevJmin] + (eq ? 0 : 1);
            }

            const best = Math.min(del, ins, sub);
            curr[idx] = best;
            if (best < minRow) minRow = best;
        }

        if (minRow > limit) return false;
        prev = curr;
        prevJmin = jmin;
        prevJmax = jmax;
    }

    if (m < prevJmin || m > prevJmax) return false;
    const finalVal = prev[m - prevJmin];
    return finalVal <= limit;
}

function registerDnaSample(username, password, sample) {
    if (!username || !password || typeof sample !== 'string') {
        return { ok: false, status: 400, message: 'Invalid input' };
    }
    if (!validateDnaSample(sample)) {
        return { ok: false, status: 400, message: 'Invalid DNA sample' };
    }

    const login = loginUser(username, password);
    if (!login.ok) {
        return { ok: false, status: 401, message: 'Invalid credentials' };
    }

    if (!usersDna.has(username)) {
        usersDna.set(username, new Set());
    }
    usersDna.get(username).add(sample);
    saveAuthState();

    return { ok: true };
}

function loginWithDna(username, sample) {
    if (!username || typeof username !== 'string' || !validateDnaSample(sample)) {
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
        const refCodons = ref.length / 3;
        if (!Number.isInteger(refCodons)) continue;
        const limit = Math.floor(refCodons / 100000);
        if (isDnaSimilar(sample, ref, limit)) {
            const token = crypto.randomBytes(32).toString('hex');
            tokens.set(token, username);
            return { ok: true, token };
        }
    }

    return { ok: false, status: 401, message: 'DNA verification failed' };
}

/****************************
 * TOKEN / COLLATERAL HELPERS
 ****************************/
function getUsernameFromToken(token) {
    return tokens.get(token) || null;
}

function getCollateral(username) {
    return userCollateral.has(username) ? userCollateral.get(username) : null;
}

function setCollateral(username, value) {
    if (!users.has(username)) {
        return { ok: false, status: 404, message: 'User not found' };
    }
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
    getCollateral,
    setCollateral
};

//        (\ /)
//       ( . .) ♥
//       c(")(")
