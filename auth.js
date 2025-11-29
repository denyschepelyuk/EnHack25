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
    const n = sampleDna.length / 3;  // Number of codons in sample
    const m = referenceDna.length / 3;  // Number of codons in reference

    // Early exit if length difference exceeds the allowed limit
    if (Math.abs(n - m) > limit) return false;

    // If limit is 0, we only accept exact matches
    if (limit === 0) return sampleDna === referenceDna;

    const sampleCodons = [];
    const referenceCodons = [];

    // Split both DNA samples into codons (chunks of 3 characters)
    for (let i = 0; i < sampleDna.length; i += 3) {
        sampleCodons.push(sampleDna.substring(i, i + 3));
    }
    for (let i = 0; i < referenceDna.length; i += 3) {
        referenceCodons.push(referenceDna.substring(i, i + 3));
    }

    // Use only two rows for the dynamic programming table to save memory
    let prevRow = new Array(m + 1).fill(0);
    let currRow = new Array(m + 1).fill(0);

    // Initialize the first row (distance from an empty reference)
    for (let j = 0; j <= m; j++) {
        prevRow[j] = j;
    }

    // Fill in the dynamic programming table
    for (let i = 1; i <= n; i++) {
        // Calculate the valid range of j's we need to consider
        const start = Math.max(1, i - limit);
        const end = Math.min(m, i + limit);

        // Initialize the current row with a large value (for better band management)
        currRow[0] = i;

        let minRowValue = Infinity;

        for (let j = start; j <= end; j++) {
            // Calculate the cost of substitution (0 if equal, 1 if different)
            const cost = sampleCodons[i - 1] === referenceCodons[j - 1] ? 0 : 1;

            // Compute the minimum of deletion, insertion, or substitution
            currRow[j] = Math.min(
                prevRow[j] + 1,       // Deletion
                currRow[j - 1] + 1,   // Insertion
                prevRow[j - 1] + cost // Substitution
            );

            // Track the minimum value in the current row
            minRowValue = Math.min(minRowValue, currRow[j]);
        }

        // If the minimum value in the current row exceeds the limit, stop early
        if (minRowValue > limit) return false;

        // Swap the previous and current rows for the next iteration
        [prevRow, currRow] = [currRow, prevRow];
    }

    // Return whether the last row's value is within the allowed limit
    return prevRow[m] <= limit;
}

function registerDnaSample(username, password, dnaSample) {
    // Ensure the user is registered before attempting to add a DNA sample
    if (!users.has(username)) {
        return { ok: false, status: 401, message: 'User does not exist' };
    }

    const loginResult = loginUser(username, password);
    if (!loginResult.ok) {
        return { ok: false, status: 401, message: 'Invalid credentials' };
    }

    // Validate the DNA sample
    if (!validateDnaSample(dnaSample)) {
        return { ok: false, status: 400, message: 'Invalid DNA sample' };
    }

    // Register the DNA sample
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
