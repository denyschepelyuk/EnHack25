const crypto = require('crypto');

const users = new Map();   // username -> passwordHash
const tokens = new Map();  // token -> username

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

function registerDnaSample(username, password, dnaSample) {
    // 1. Authenticate user first
    const loginResult = loginUser(username, password);
    if (!loginResult.ok) {
        return { ok: false, status: 401, message: 'Invalid credentials' };
    }

    // 2. Validate DNA format
    if (!validateDnaSample(dnaSample)) {
        return { ok: false, status: 400, message: 'Invalid DNA sample' };
    }

    // 3. Store sample
    if (!usersDna.has(username)) {
        usersDna.set(username, new Set());
    }
    usersDna.get(username).add(dnaSample);

    return { ok: true };
}

function loginWithDna(username, submittedDna) {
    // 1. Basic validation
    if (!username || !validateDnaSample(submittedDna)) {
        // Spec says 400 if invalid DNA or input
        return { ok: false, status: 400, message: 'Invalid input' };
    }

    // 2. Check if user exists and has samples
    const storedSamples = usersDna.get(username);
    if (!users.has(username) || !storedSamples || storedSamples.size === 0) {
        // Spec says 401 if user doesn't exist or no DNA registered
        return { ok: false, status: 401, message: 'Authentication failed' };
    }

    // 3. Check similarity against ALL registered samples
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

    // 4. Generate token
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
