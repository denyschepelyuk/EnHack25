// dna_auth.test.js
// Run with:  node --test dna_auth.test.js
// Requires Node 18+ (built-in test runner)

const test = require('node:test');
const assert = require('assert');

const {
    registerUser,
    loginUser,
    changePassword,
    registerDnaSample,
    loginWithDna
} = require('./auth');

test('DNA: happy path registration + login', () => {
    const username = 'alice';
    const password = 'alice_pw';

    // 1) register user
    let res = registerUser(username, password);
    assert.strictEqual(res.ok, true, 'user registration should succeed');

    // 2) register valid DNA sample
    const dnaSample = 'CGACGACGA'; // 9 chars = 3 codons, all valid chars
    res = registerDnaSample(username, password, dnaSample);
    assert.strictEqual(res.ok, true, 'dna registration should succeed');

    // 3) login using the same DNA
    const loginRes = loginWithDna(username, dnaSample);
    assert.strictEqual(loginRes.ok, true, 'dna login should succeed');
    assert.ok(typeof loginRes.token === 'string' && loginRes.token.length > 0,
        'dna login should return a valid token');
});

test('DNA: /dna-submit invalid credentials → 401', () => {
    const username = 'bob';
    const password = 'bob_pw';

    // Create user
    let res = registerUser(username, password);
    assert.strictEqual(res.ok, true, 'user registration should succeed');

    const dnaSample = 'CGACGACGA';

    // Try to register with wrong password
    res = registerDnaSample(username, 'wrong_pw', dnaSample);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.status, 401,
        'wrong password on dna-submit should return 401');
});

test('DNA: /dna-submit invalid DNA chars → 400', () => {
    const username = 'charlie';
    const password = 'charlie_pw';

    let res = registerUser(username, password);
    assert.strictEqual(res.ok, true);

    const badDna = 'CGAXCG'; // contains X -> invalid

    res = registerDnaSample(username, password, badDna);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.status, 400,
        'invalid DNA characters should give 400 on dna-submit');
});

test('DNA: /dna-submit length not divisible by 3 → 400', () => {
    const username = 'diana';
    const password = 'diana_pw';

    let res = registerUser(username, password);
    assert.strictEqual(res.ok, true);

    const badLengthDna = 'CGAAG'; // 5 chars, not divisible by 3

    res = registerDnaSample(username, password, badLengthDna);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.status, 400,
        'DNA length not divisible by 3 should give 400 on dna-submit');
});

test('DNA: /dna-login invalid DNA → 400', () => {
    const username = 'eve';
    const password = 'eve_pw';

    let res = registerUser(username, password);
    assert.strictEqual(res.ok, true);

    // valid DNA registered
    const goodDna = 'CGACGACGA';
    res = registerDnaSample(username, password, goodDna);
    assert.strictEqual(res.ok, true);

    // invalid DNA for login: bad chars
    const badDnaChars = 'CGAZZZ';
    res = loginWithDna(username, badDnaChars);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.status, 400,
        'dna-login with invalid chars should be 400');

    // invalid DNA for login: bad length
    const badDnaLen = 'CGAAG'; // 5 chars
    res = loginWithDna(username, badDnaLen);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.status, 400,
        'dna-login with length not divisible by 3 should be 400');
});

test('DNA: /dna-login user without DNA or non-existent user → 401', () => {
    const username = 'frank';
    const password = 'frank_pw';

    // register user but do NOT register DNA
    let res = registerUser(username, password);
    assert.strictEqual(res.ok, true);

    const someDna = 'CGACGACGA';

    // user without any DNA
    res = loginWithDna(username, someDna);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.status, 401,
        'dna-login for user without any registered DNA should be 401');

    // completely unknown user
    res = loginWithDna('ghost_user', someDna);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.status, 401,
        'dna-login for non-existent user should be 401');
});

test('DNA: /dna-login fails when DNA does not match any sample → 401', () => {
    const username = 'harry';
    const password = 'harry_pw';

    let res = registerUser(username, password);
    assert.strictEqual(res.ok, true);

    const registeredDna = 'CGACGACGA';  // 3 codons
    res = registerDnaSample(username, password, registeredDna);
    assert.strictEqual(res.ok, true);

    // Different codons; for a short sample allowedDiff = 0,
    // so any difference should fail.
    const differentDna = 'TTTTTTTTT'; // 3 codons, all TTT

    res = loginWithDna(username, differentDna);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.status, 401,
        'dna-login with non-matching DNA should be 401 for short samples');
});

test('DNA: duplicate DNA samples are accepted (idempotent)', () => {
    const username = 'ida';
    const password = 'ida_pw';

    let res = registerUser(username, password);
    assert.strictEqual(res.ok, true);

    const dna = 'CGACGACGA';

    res = registerDnaSample(username, password, dna);
    assert.strictEqual(res.ok, true, 'first dna registration should succeed');

    // Re-register same sample — should still be ok and not error
    res = registerDnaSample(username, password, dna);
    assert.strictEqual(res.ok, true,
        're-registering same DNA should be silently accepted');
});

test('DNA: password change does not affect existing DNA, but blocks old password', () => {
    const username = 'jane';
    const oldPassword = 'old_pw';
    const newPassword = 'new_pw';

    // register + DNA
    let res = registerUser(username, oldPassword);
    assert.strictEqual(res.ok, true);

    const dna = 'CGACGACGA';
    res = registerDnaSample(username, oldPassword, dna);
    assert.strictEqual(res.ok, true);

    // change password via normal flow
    res = changePassword(username, oldPassword, newPassword);
    assert.strictEqual(res.ok, true);

    // old password no longer valid for dna-submit
    res = registerDnaSample(username, oldPassword, dna);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.status, 401,
        'old password must not work after password change');

    // but DNA registration with new password works
    res = registerDnaSample(username, newPassword, dna);
    assert.strictEqual(res.ok, true,
        'new password must work after password change');

    // DNA login still works using the same sample
    const loginRes = loginWithDna(username, dna);
    assert.strictEqual(loginRes.ok, true,
        'dna-login should still succeed for the user after password change');
    assert.ok(typeof loginRes.token === 'string' && loginRes.token.length > 0);
});
