const crypto = require('crypto');

// In-memory stores
// username -> passwordHash
const users = new Map();
// token -> username
const tokens = new Map();
// username -> Set of DNA samples (strings)
const usersDna = new Map();

/**
 * Hash a password using SHA-256.
 */
function hashPassword(password) {
    return crypto.createHash('sha256').update(password, 'utf8').digest('hex');
}

/**
 * Register a new user with username + password.
 */
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

/**
 * Internal helper – verify username/password without issuing a token.
 */
function verifyCredentials(username, password) {
    if (!username || !password) {
        return false;
    }
    const storedHash = users.get(username);
    if (!storedHash) {
        return false;
    }
    const candidateHash = hashPassword(password);
    return storedHash === candidateHash;
}

/**
 * Log in a user with username + password and issue an auth token.
 */
function loginUser(username, password) {
    if (!verifyCredentials(username, password)) {
        return { ok: false, status: 401, message: 'Invalid credentials' };
    }

    const token = crypto.randomBytes(32).toString('hex');
    tokens.set(token, username);

    return { ok: true, token };
}

/**
 * Invalidate all tokens for a given user.
 */
function invalidateTokensForUser(username) {
    for (const [token, user] of tokens.entries()) {
        if (user === username) {
            tokens.delete(token);
        }
    }
}

/**
 * Change a user's password.
 */
function changePassword(username, oldPassword, newPassword) {
    if (!username || !oldPassword || !newPassword) {
        return { ok: false, status: 400, message: 'Invalid input' };
    }

    if (!verifyCredentials(username, oldPassword)) {
        return { ok: false, status: 401, message: 'Invalid credentials' };
    }

    const newHash = hashPassword(newPassword);
    users.set(username, newHash);

    // Invalidate existing tokens; user will have to log in again.
    invalidateTokensForUser(username);

    return { ok: true };
}

/**
 * Express middleware for Bearer token authentication.
 */
function authMiddleware(req, res, next) {
    const header = req.headers['authorization'] || '';
    if (!header.startsWith('Bearer ')) {
        return res.status(401).end();
    }

    const token = header.slice('Bearer '.length).trim();
    const username = tokens.get(token);
    if (!username) {
        return res.status(401).end();
    }

    // Attach username to request for downstream handlers if needed
    req.user = username;
    return next();
}

/**
 * Validate a DNA sample:
 * - non-empty string
 * - length divisible by 3
 * - only C, G, A, T characters
 */
function validateDnaSample(dna) {
    if (!dna || typeof dna !== 'string') return false;
    if (dna.length === 0) return false;
    if (dna.length % 3 !== 0) return false;
    return /^[CGAT]+$/.test(dna);
}

/**
 * Convert DNA string into array of codons (triplets).
 */
function splitToCodons(dna) {
    const codons = [];
    for (let i = 0; i < dna.length; i += 3) {
        codons.push(dna.substring(i, i + 3));
    }
    return codons;
}

/**
 * Banded Levenshtein distance on codon sequences.
 *
 * Differences are:
 *  - codon removed (deletion)
 *  - codon inserted (insertion)
 *  - codon changed (substitution)
 *
 * We only care whether the distance is <= limit, so we keep
 * a band of width `limit` around the diagonal for performance.
 */
function isDnaSimilar(sampleDna, referenceDna, limit) {
    if (limit < 0) return false;

    const sampleCodons = splitToCodons(sampleDna);
    const referenceCodons = splitToCodons(referenceDna);

    const n = sampleCodons.length;
    const m = referenceCodons.length;

    // Minimal possible edit distance is at least |n-m|.
    if (Math.abs(n - m) > limit) {
        return false;
    }

    // With limit 0 we only allow exact matches.
    if (limit === 0) {
        return sampleDna === referenceDna;
    }

    const prev = new Array(m + 1);
    const curr = new Array(m + 1);

    // Initialize first row: distance from empty prefix of sample
    // to prefix of reference of length j is j (j insertions).
    for (let j = 0; j <= m; j++) {
        prev[j] = j;
    }

    const INF = limit + 1;

    for (let i = 1; i <= n; i++) {
        // Reset current row to "infinite" distances.
        for (let j = 0; j <= m; j++) {
            curr[j] = INF;
        }

        // Distance from first i codons of sample to empty reference prefix:
        curr[0] = i;

        // Only compute within the diagonal band [i-limit, i+limit].
        const start = Math.max(1, i - limit);
        const end = Math.min(m, i + limit);

        let rowMin = INF;

        for (let j = start; j <= end; j++) {
            const cost = (sampleCodons[i - 1] === referenceCodons[j - 1]) ? 0 : 1;

            const deletion = prev[j] + 1;        // remove codon from sample
            const insertion = curr[j - 1] + 1;   // insert codon into sample
            const substitution = prev[j - 1] + cost;

            let val = deletion;
            if (insertion < val) val = insertion;
            if (substitution < val) val = substitution;

            curr[j] = val;
            if (val < rowMin) {
                rowMin = val;
            }
        }

        // If even the best value in this row already exceeds the
        // allowed limit, we can stop early.
        if (rowMin > limit) {
            return false;
        }

        // Next iteration: current row becomes previous row.
        for (let j = 0; j <= m; j++) {
            prev[j] = curr[j];
        }
    }

    return prev[m] <= limit;
}

/**
 * Register a DNA sample for an existing user.
 *
 * Requirements:
 * - User must authenticate with username/password
 * - DNA sample must be valid (see validateDnaSample)
 * - Users may have multiple DNA samples
 * - Duplicate DNA samples are silently accepted
 */
function registerDnaSample(username, password, dnaSample) {
    // Basic input validation first: empty fields -> 400
    if (!username || !password || !dnaSample) {
        return { ok: false, status: 400, message: 'Invalid input' };
    }

    // Verify credentials: invalid credentials -> 401
    if (!verifyCredentials(username, password)) {
        return { ok: false, status: 401, message: 'Invalid credentials' };
    }

    // Validate DNA: invalid characters / length not divisible by 3 -> 400
    if (!validateDnaSample(dnaSample)) {
        return { ok: false, status: 400, message: 'Invalid DNA sample' };
    }

    if (!usersDna.has(username)) {
        usersDna.set(username, new Set());
    }

    // Set semantics make this idempotent for duplicates.
    usersDna.get(username).add(dnaSample);

    return { ok: true };
}

/**
 * Authenticate a user via DNA.
 *
 * Requirements:
 * - 400 on invalid input (empty fields, invalid chars, length not divisible by 3)
 * - 401 if user doesn't exist, has no DNA registered,
 *   or submitted sample doesn't match any reference within threshold.
 * - 200 (handled by server) when ok, returning a token.
 */
function loginWithDna(username, submittedDna) {
    // Validate input fields
    if (!username || !submittedDna) {
        return { ok: false, status: 400, message: 'Invalid input' };
    }

    // Validate DNA format
    if (!validateDnaSample(submittedDna)) {
        return { ok: false, status: 400, message: 'Invalid DNA sample' };
    }

    const storedSamples = usersDna.get(username);

    // User does not exist or has no DNA registered
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

    // Successful DNA authentication: issue token like /login.
    const token = crypto.randomBytes(32).toString('hex');
    tokens.set(token, username);

    return { ok: true, token };
}

/**
 * Helper to get username from token (used by bulk operations in server.js).
 */
function getUsernameFromToken(token) {
    if (!token) return null;
    const username = tokens.get(token);
    return username || null;
}

module.exports = {
    registerUser,
    loginUser,
    changePassword,
    authMiddleware,
    registerDnaSample,
    loginWithDna,
    getUsernameFromToken
};
