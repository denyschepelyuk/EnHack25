const crypto = require('crypto');

const users = new Map();   // username -> passwordHash
const tokens = new Map();  // token -> username
const usersDna = new Map(); // username -> Set of dna samples

function hashPassword(password) {
    return crypto.createHash('sha256').update(password, 'utf8').digest('hex');
}

function registerUser(username, password) {
    if (!username || !password) {
        return { ok: false, status: 400, message: 'Invalid input' };
    }
    if (users.has(username)) {
        return { ok: false, status: 409, message: 'Username already exists' };
    }

    const hash = hashPassword(password);
    users.set(username, hash);
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

    const givenHash = hashPassword(password);
    if (storedHash !== givenHash) {
        return { ok: false, status: 401, message: 'Invalid credentials' };
    }

    const token = crypto.randomBytes(32).toString('hex');
    tokens.set(token, username);
    return { ok: true, token };
}

// Invalidate all tokens for a given username
function invalidateTokensForUser(username) {
    for (const [token, user] of tokens.entries()) {
        if (user === username) {
            tokens.delete(token);
        }
    }
}

// Change password and invalidate all tokens for that user
function changePassword(username, oldPassword, newPassword) {
    if (!username || !oldPassword || !newPassword) {
        return { ok: false, status: 400, message: 'Invalid input' };
    }

    const storedHash = users.get(username);
    if (!storedHash) {
        return { ok: false, status: 401, message: 'Invalid credentials' };
    }

    const oldHash = hashPassword(oldPassword);
    if (oldHash !== storedHash) {
        return { ok: false, status: 401, message: 'Invalid credentials' };
    }

    // Update password
    const newHash = hashPassword(newPassword);
    users.set(username, newHash);

    // Invalidate all existing tokens for this user
    invalidateTokensForUser(username);

    return { ok: true };
}

function authMiddleware(req, res, next) {
    const header = req.headers['authorization'] || '';
    if (!header.startsWith('Bearer ')) {
        return res.status(401).end();
    }

    const token = header.slice('Bearer '.length).trim();
    const user = tokens.get(token);
    if (!user) {
        return res.status(401).end();
    }

    req.user = user;
    next();
}

// -------- DNA helpers --------

function validateDnaSample(dna) {
    if (!dna || typeof dna !== 'string') return false;
    if (dna.length === 0 || dna.length % 3 !== 0) return false;
    return /^[CGAT]+$/.test(dna);
}

function splitToCodons(dna) {
    const codons = [];
    for (let i = 0; i < dna.length; i += 3) {
        codons.push(dna.substring(i, i + 3));
    }
    return codons;
}

function isDnaSimilar(sampleDna, referenceDna, limit) {
    const n = sampleDna.length / 3;
    const m = referenceDna.length / 3;

    // Optimization: If length difference is already > limit, impossible to match
    if (Math.abs(n - m) > limit) return false;

    // Optimization: Exact match
    if (limit === 0) return sampleDna === referenceDna;




    // We only need two rows for DP
    let prevRow = new Array(m + 1);
    let currRow = new Array(m + 1);

    // Initialize first row
    for (let j = 0; j <= m; j++) {
        prevRow[j] = j;
    }

    // Loop through codons of sampleDna
    for (let i = 1; i <= n; i++) {
        // Calculate the "band" of indices we need to check.
        // We only care about cells where |i - j| <= limit
        // Because any path outside this band essentially costs > limit.
        const start = Math.max(1, i - limit);
        const end = Math.min(m, i + limit);

        // Current row initialization (infinity for out of bounds logic)
        // We set index 0 explicitly, others are filled in the loop
        currRow[0] = i; 
        
        // Optimization: track min value in this row to exit early if > limit
        let minInRow = Infinity;

        // If start > 1, we effectively treat currRow[start-1] as Infinity
        // so we don't need to fill the whole array with Infinity, just the active window.
        
        for (let j = start; j <= end; j++) {
            // FIX 3: Access substrings directly without splitToCodons array overhead
            const codonS = sampleDna.substring((i - 1) * 3, i * 3);
            const codonT = referenceDna.substring((j - 1) * 3, j * 3);
            
            const cost = (codonS === codonT) ? 0 : 1;

            // prevRow[j]   => deletion (up)
            // currRow[j-1] => insertion (left) -- note: if j=start, check boundary logic
            // prevRow[j-1] => substitution (diagonal)
            
            // Boundary handling for the window:
            // If j is at the start of the window, we assume the cell to the left is effectively infinite
            // UNLESS j=1, where currRow[0] is `i`.
            let left = Infinity;
            if (j > start) {
                left = currRow[j - 1];
            } else if (j === 1) {
                left = currRow[0];
            }

            // If j is far to the right, prevRow[j] might be outside previous window?
            // Since we iterate i one by one, the previous window [i-1-limit, i-1+limit] overlaps correctly.
            
            currRow[j] = Math.min(
                prevRow[j] + 1,       // deletion
                left + 1,             // insertion
                prevRow[j - 1] + cost // substitution
            );

            if (currRow[j] < minInRow) {
                minInRow = currRow[j];
            }
        }

        // Optimization: If the best path in this row exceeds limit, we can stop
        if (minInRow > limit) return false;

        // Swap rows for next iteration
        // Note: We must slice or copy if we want to be safe, but since we 
        // overwrite valid indices in the window, swapping references is fine
        // as long as we handle the 'undefined' or 'dirty' data outside window correctly.
        // To be safe in JS, let's copy the values needed or just swap.
        const temp = prevRow;
        prevRow = currRow;
        currRow = temp;
        // Clean currRow for next usage not strictly necessary if we rely on start/end,
        // but safer to avoid reading stale data if logic changes.
    }

    return prevRow[m] <= limit;
}

function registerDnaSample(username, password, dnaSample) {
    const loginResult = loginUser(username, password);
    if (!loginResult.ok) {
        return { ok: false, status: 401, message: 'Invalid credentials' };
    }

    if (!validateDnaSample(dnaSample)) {
        return { ok: false, status: 400, message: 'Invalid DNA sample' };
    }

    if (!usersDna.has(username)) {
        usersDna.set(username, new Set());
    }
    usersDna.get(username).add(dnaSample);

    return { ok: true };
}

function loginWithDna(username, submittedDna) {
    if (!username || !validateDnaSample(submittedDna)) {
        return { ok: false, status: 400, message: 'Invalid input' };
    }

    const storedSamples = usersDna.get(username);
    if (!users.has(username) || !storedSamples || storedSamples.size === 0) {
        return { ok: false, status: 401, message: 'Authentication failed' };
    }

    let matchFound = false;

    for (const referenceDna of storedSamples) {
        const referenceCodonCount = referenceDna.length / 3;
        const allowedDiff = Math.floor(referenceCodonCount / 100000);

        if (isDnaSimilar(submittedDna, referenceDna, allowedDiff)) {
            matchFound = true;
            break;
        }
    }

    if (!matchFound) {
        return { ok: false, status: 401, message: 'DNA verification failed' };
    }

    const token = crypto.randomBytes(32).toString('hex');
    tokens.set(token, username);
    return { ok: true, token };
}

module.exports = {
    registerUser,
    loginUser,
    changePassword,
    authMiddleware,
    registerDnaSample,
    loginWithDna
};
