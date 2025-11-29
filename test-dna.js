// test-dna.js
// Local tests for DNA-based login

const {
    encodeMessage,
    decodeMessage
} = require('./galacticbuf');

const BASE_URL = 'http://localhost:8080';

// --------------- Helpers ---------------

async function sendGalactic(method, path, bodyObj, token) {
    const url = BASE_URL + path;

    const init = {
        method,
        headers: {}
    };

    if (bodyObj) {
        const buf = encodeMessage(bodyObj); // v2 by default
        init.body = buf;
        init.headers['Content-Type'] = 'application/x-galacticbuf';
    }

    if (token) {
        init.headers['Authorization'] = `Bearer ${token}`;
    }

    const res = await fetch(url, init);
    const status = res.status;
    const contentType = res.headers.get('content-type') || '';

    let decoded = null;
    if (contentType && contentType.startsWith('application/x-galacticbuf')) {
        const arrayBuf = await res.arrayBuffer();
        const nodeBuf = Buffer.from(arrayBuf);
        decoded = decodeMessage(nodeBuf);
    } else {
        decoded = await res.text();
    }

    return { status, decoded };
}

function ensure(condition, label, detailObj) {
    if (!condition) {
        throw {
            _ensureFail: true,
            detail: {
                message: label,
                ...(detailObj || {})
            }
        };
    }
}

async function runStep(label, fn) {
    try {
        await fn();
        console.log(label + ' - OK');
    } catch (err) {
        if (err && err._ensureFail) {
            console.error(label + ' - FAILED');
            console.error('DETAILS:', JSON.stringify(err.detail, null, 2));
        } else {
            console.error(label + ' - FAILED (unhandled error)');
            console.error(err);
        }
        process.exit(1);
    }
}

// --------------- Test Flow ---------------

async function main() {
    const ts = Date.now();
    const username = `dna-user-${ts}`;
    const password = 'dna-password';

    const dnaValid = 'CGACGACGA';       // 9 chars -> 3 codons, allowedDiff = 0
    const dnaValid2 = 'CGACGACGT';      // 9 chars, last codon differs by 1 base
    const dnaInvalidChars = 'XYZCGAA';  // invalid chars, length not multiple of 3
    const dnaInvalidLen = 'CGA';        // valid chars but only 1 codon (still multiple of 3, so valid)
    const dnaInvalidLen2 = 'CGACGA';    // 6 chars -> 2 codons (valid length), but we can still use it for tests

    // 1) Health check
    await runStep('GET /health', async () => {
        const res = await fetch(BASE_URL + '/health');
        const text = await res.text();
        ensure(
            res.status === 200,
            'health check status',
            { expected: 200, got: res.status, body: text }
        );
    });

    // 2) Register user
    await runStep('POST /register (dna user)', async () => {
        const r = await sendGalactic('POST', '/register', {
            username,
            password
        });
        ensure(
            r.status === 204,
            'register dna user',
            { expectedStatus: 204, gotStatus: r.status, body: r.decoded }
        );
    });

    // 3) dna-submit with wrong password -> 401
    await runStep('POST /dna-submit (wrong password)', async () => {
        const r = await sendGalactic('POST', '/dna-submit', {
            username,
            password: 'wrong-password',
            dna_sample: dnaValid
        });
        ensure(
            r.status === 401,
            'dna-submit wrong password -> 401',
            { expectedStatus: 401, gotStatus: r.status, body: r.decoded }
        );
    });

    // 4) dna-submit with invalid DNA (bad chars + wrong length) -> 400
    await runStep('POST /dna-submit (invalid dna sample)', async () => {
        const r = await sendGalactic('POST', '/dna-submit', {
            username,
            password,
            dna_sample: dnaInvalidChars
        });
        ensure(
            r.status === 400,
            'dna-submit invalid dna -> 400',
            { expectedStatus: 400, gotStatus: r.status, body: r.decoded }
        );
    });

    // 5) dna-submit with valid DNA -> 204
    await runStep('POST /dna-submit (valid dna)', async () => {
        const r = await sendGalactic('POST', '/dna-submit', {
            username,
            password,
            dna_sample: dnaValid
        });
        ensure(
            r.status === 204,
            'dna-submit valid dna -> 204',
            { expectedStatus: 204, gotStatus: r.status, body: r.decoded }
        );
    });

    // 6) dna-submit duplicate DNA -> still 204 (idempotent)
    await runStep('POST /dna-submit (duplicate dna)', async () => {
        const r = await sendGalactic('POST', '/dna-submit', {
            username,
            password,
            dna_sample: dnaValid
        });
        ensure(
            r.status === 204,
            'dna-submit duplicate dna -> 204',
            { expectedStatus: 204, gotStatus: r.status, body: r.decoded }
        );
    });

    // 7) dna-login with exact sample -> 200 + token
    let dnaToken = null;
    await runStep('POST /dna-login (exact match)', async () => {
        const r = await sendGalactic('POST', '/dna-login', {
            username,
            dna_sample: dnaValid
        });
        ensure(
            r.status === 200 && r.decoded && typeof r.decoded.token === 'string',
            'dna-login exact match -> 200',
            { expectedStatus: 200, gotStatus: r.status, body: r.decoded }
        );
        dnaToken = r.decoded.token;
    });

    // 8) dna-login with one-codon difference, allowedDiff = 0 -> 401
    await runStep('POST /dna-login (one codon difference, expect 401)', async () => {
        const r = await sendGalactic('POST', '/dna-login', {
            username,
            dna_sample: dnaValid2
        });
        ensure(
            r.status === 401,
            'dna-login one codon diff when allowedDiff=0 -> 401',
            { expectedStatus: 401, gotStatus: r.status, body: r.decoded }
        );
    });

    // 9) dna-login with invalid DNA (bad chars) -> 400
    await runStep('POST /dna-login (invalid dna, bad chars)', async () => {
        const r = await sendGalactic('POST', '/dna-login', {
            username,
            dna_sample: dnaInvalidChars
        });
        ensure(
            r.status === 400,
            'dna-login invalid dna -> 400',
            { expectedStatus: 400, gotStatus: r.status, body: r.decoded }
        );
    });

    // 10) dna-login for non-existent user -> 401
    await runStep('POST /dna-login (nonexistent user)', async () => {
        const r = await sendGalactic('POST', '/dna-login', {
            username: 'nonexistent-user-' + Date.now(),
            dna_sample: dnaValid
        });
        ensure(
            r.status === 401,
            'dna-login nonexistent user -> 401',
            { expectedStatus: 401, gotStatus: r.status, body: r.decoded }
        );
    });

    console.log('All DNA tests passed!');
    process.exit(0);
}

main().catch((err) => {
    console.error('UNEXPECTED ERROR IN DNA TESTS:', err);
    process.exit(1);
});
