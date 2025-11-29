// auth.js
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PERSISTENT_DIR = process.env.PERSISTENT_DIR;
const AUTH_STATE_FILE = PERSISTENT_DIR ? path.join(PERSISTENT_DIR, 'auth-state.json') : null;

const users = new Map();
const tokens = new Map();

// usersDna.get(username) = Map<dnaString, { codons: Uint16Array, len: number, hash: number }>
const usersDna = new Map();

const userCollateral = new Map();

function loadAuthState() {
    if (!AUTH_STATE_FILE) return;
    try {
        if (!fs.existsSync(AUTH_STATE_FILE)) return;
        const raw = fs.readFileSync(AUTH_STATE_FILE, 'utf8');
        if (!raw) return;
        const data = JSON.parse(raw);

        users.clear();
        if (data.users) {
            for (const [u, hash] of Object.entries(data.users)) users.set(u, hash);
        }

        usersDna.clear();
        if (data.usersDna) {
            for (const [u, arr] of Object.entries(data.usersDna)) {
                const map = new Map();
                for (const dna of arr) {
                    const enc = encodeSample(dna);
                    map.set(dna, enc);
                }
                usersDna.set(u, map);
            }
        }

        userCollateral.clear();
        if (data.userCollateral) {
            for (const [u, val] of Object.entries(data.userCollateral)) userCollateral.set(u, val);
        }

        for (const u of users.keys()) {
            if (!userCollateral.has(u)) userCollateral.set(u, null);
        }
    } catch { }
}

function saveAuthState() {
    if (!AUTH_STATE_FILE) return;
    try {
        const data = {
            users: Object.fromEntries(users),
            usersDna: Object.fromEntries(
                Array.from(usersDna.entries())
                    .map(([u, map]) => [u, Array.from(map.keys())])
            ),
            userCollateral: Object.fromEntries(userCollateral)
        };
        fs.mkdirSync(PERSISTENT_DIR, { recursive: true });
        fs.writeFileSync(AUTH_STATE_FILE, JSON.stringify(data));
    } catch { }
}

loadAuthState();

// ========= Password helpers =========
const hashPassword = p => crypto.createHash('sha256').update(p).digest('hex');

function registerUser(username, password) {
    if (!username || !password) return { ok: false, status: 400 };
    if (users.has(username)) return { ok: false, status: 409 };
    users.set(username, hashPassword(password));
    userCollateral.set(username, null);
    saveAuthState();
    return { ok: true };
}

function loginUser(username, password) {
    if (!username || !password) return { ok: false, status: 401 };
    const stored = users.get(username);
    if (!stored) return { ok: false, status: 401 };
    if (hashPassword(password) !== stored) return { ok: false, status: 401 };

    const token = crypto.randomBytes(32).toString('hex');
    tokens.set(token, username);
    return { ok: true, token };
}

function authMiddleware(req, res, next) {
    const h = req.headers['authorization'] || '';
    if (!h.startsWith('Bearer ')) return res.status(401).end();
    const token = h.slice(7).trim();
    const user = tokens.get(token);
    if (!user) return res.status(401).end();
    req.user = user;
    next();
}

// ========= DNA handling =========

function validateDnaSample(dna) {
    if (!dna || typeof dna !== 'string') return false;
    if (dna.length % 3 !== 0) return false;
    return /^[CGAT]+$/.test(dna);
}

const encMap = { C:0, G:1, A:2, T:3 };

function encodeSample(dna) {
    const n = dna.length / 3;
    const arr = new Uint16Array(n);
    let hash = 0;

    for (let i = 0, k = 0; i < dna.length; i += 3, k++) {
        const c0 = encMap[dna[i]];
        const c1 = encMap[dna[i+1]];
        const c2 = encMap[dna[i+2]];
        const code = (c0 << 4) | (c1 << 2) | c2;
        arr[k] = code;
        hash = (hash * 1315423911 + code) >>> 0;
    }

    return { codons: arr, len: n, hash };
}

// ===== fast banded DP on integer codon arrays =====
function similarEncoded(a, b, lenA, lenB, limit) {
    const diff = lenA - lenB;
    if (diff < -limit || diff > limit) return false;

    if (limit === 0) {
        if (lenA !== lenB) return false;
        for (let i = 0; i < lenA; i++) if (a[i] !== b[i]) return false;
        return true;
    }

    let prevJmin = Math.max(0, 0 - limit);
    let prevJmax = Math.min(lenB, limit);
    let prev = new Int32Array(prevJmax - prevJmin + 1);
    for (let j = prevJmin; j <= prevJmax; j++) prev[j - prevJmin] = j;

    for (let i = 1; i <= lenA; i++) {
        const jmin = Math.max(0, i - limit);
        const jmax = Math.min(lenB, i + limit);
        const width = jmax - jmin + 1;
        const curr = new Int32Array(width);
        let rowMin = Infinity;

        for (let j = jmin; j <= jmax; j++) {
            const idx = j - jmin;

            let del = Infinity;
            let ins = Infinity;
            let sub = Infinity;

            if (j >= prevJmin && j <= prevJmax) del = prev[j - prevJmin] + 1;
            if (j > jmin) ins = curr[idx - 1] + 1;

            if (j-1 >= prevJmin && j-1 <= prevJmax) {
                const cost = (a[i-1] === b[j-1]) ? 0 : 1;
                sub = prev[(j-1) - prevJmin] + cost;
            }

            const best = del < ins ? (del < sub ? del : sub) : (ins < sub ? ins : sub);
            curr[idx] = best;
            if (best < rowMin) rowMin = best;
        }

        if (rowMin > limit) return false;
        prev = curr;
        prevJmin = jmin;
        prevJmax = jmax;
    }

    if (lenB < prevJmin || lenB > prevJmax) return false;
    return prev[lenB - prevJmin] <= limit;
}

function registerDnaSample(username, password, sample) {
    if (!username || !password) return { ok:false, status:400 };
    if (!validateDnaSample(sample)) return { ok:false, status:400 };

    const login = loginUser(username, password);
    if (!login.ok) return { ok:false, status:401 };

    if (!usersDna.has(username)) usersDna.set(username, new Map());
    const m = usersDna.get(username);
    if (!m.has(sample)) m.set(sample, encodeSample(sample));

    saveAuthState();
    return { ok:true };
}

function loginWithDna(username, sample) {
    if (!username || !validateDnaSample(sample)) return { ok:false, status:400 };
    if (!users.has(username)) return { ok:false, status:401 };

    const map = usersDna.get(username);
    if (!map || map.size === 0) return { ok:false, status:401 };

    const enc = encodeSample(sample);
    const a = enc.codons;
    const lenA = enc.len;
    const hashA = enc.hash;

    for (const [raw, meta] of map.entries()) {
        if (meta.len === lenA && meta.hash === hashA) {
            const token = crypto.randomBytes(32).toString('hex');
            tokens.set(token, username);
            return { ok:true, token };
        }

        const limit = Math.floor(meta.len / 100000);
        if (limit === 0) {
            if (meta.len !== lenA) continue;
        }

        if (similarEncoded(a, meta.codons, lenA, meta.len, limit)) {
            const t = crypto.randomBytes(32).toString('hex');
            tokens.set(t, username);
            return { ok:true, token: t };
        }
    }

    return { ok:false, status:401 };
}

// ========= exports =========
module.exports = {
    registerUser,
    loginUser,
    changePassword,
    authMiddleware,
    registerDnaSample,
    loginWithDna,
    getUsernameFromToken: t => tokens.get(t) || null,
    getCollateral: u => userCollateral.get(u),
    setCollateral: (u,v)=>{ if(!users.has(u))return{ok:false,status:404}; userCollateral.set(u,v); saveAuthState(); return{ok:true}; }
};
