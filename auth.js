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

function changePassword(username, oldPassword, newPassword) {
    // 1. Validate Input
    if (!username || !oldPassword || !newPassword) {
        return { ok: false, status: 400, message: 'Invalid input' };
    }

    // 2. Verify User and Old Password
    const storedHash = users.get(username);
    if (!storedHash) {
        return { ok: false, status: 401, message: 'Invalid credentials' }; // User not found
    }

    const oldHash = hashPassword(oldPassword);
    if (storedHash !== oldHash) {
        return { ok: false, status: 401, message: 'Invalid credentials' }; // Wrong password
    }

    // 3. Update to New Password
    const newHash = hashPassword(newPassword);
    users.set(username, newHash);

    // 4. Invalidate ALL existing tokens for this user
    for (const [token, user] of tokens.entries()) {
        if (user === username) {
            tokens.delete(token);
        }
    }

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

module.exports = {
    registerUser,
    loginUser,
    authMiddleware,
    changePassword 
};