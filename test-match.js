// test-match.js
// Full automated test suite for the matching engine.
// Uses your local galacticbuf.encodeMessage/decodeMessage so payloads
// match the grader exactly.
//
// Run: node test-match.js

const http = require('http');
const { encodeMessage, decodeMessage } = require('./galacticbuf');

function send(path, obj, token) {
    return new Promise((resolve) => {
        const body = encodeMessage(obj);

        const options = {
            hostname: 'localhost',
            port: 8080,
            path,
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-galacticbuf',
                'Content-Length': body.length
            }
        };

        if (token) options.headers['Authorization'] = 'Bearer ' + token;

        const req = http.request(options, (res) => {
            const chunks = [];
            res.on('data', (d) => chunks.push(d));
            res.on('end', () => {
                const buf = Buffer.concat(chunks);
                try {
                    const decoded = decodeMessage(buf);
                    resolve(decoded);
                } catch {
                    // decode failed (likely non-galacticbuf plain text), return status + raw string
                    resolve({ status: res.statusCode, raw: buf.toString() });
                }
            });
        });

        req.on('error', (err) => resolve({ error: err.message }));
        req.write(body);
        req.end();
    });
}

function get(path) {
    return new Promise((resolve) => {
        http.get("http://localhost:8080" + path, (res) => {
            const chunks = [];
            res.on("data", (d) => chunks.push(d));
            res.on("end", () => {
                const buf = Buffer.concat(chunks);
                try {
                    const decoded = decodeMessage(buf);
                    resolve(decoded);
                } catch {
                    resolve({ status: res.statusCode, raw: buf.toString() });
                }
            });
        }).on('error', (err) => resolve({ error: err.message }));
    });
}

// Compute a valid 1-hour aligned delivery window (start % 3600000 === 0)
// Floors "now" to the previous hour so it's valid.
const ONE_HOUR = 3600000;
const now = Date.now();
const delivery_start = now - (now % ONE_HOUR); // floored to hour
const delivery_end = delivery_start + ONE_HOUR;

// Another different (non-overlapping) valid window for contract-isolation test:
const delivery_start2 = delivery_start + ONE_HOUR * 2;
const delivery_end2 = delivery_start2 + ONE_HOUR;

(async () => {
    console.log("=== REGISTER ===");
    await send('/register', { username: "alice", password: "pass" });
    await send('/register', { username: "bob", password: "pass" });

    console.log("=== LOGIN ===");
    const loginA = await send('/login', { username: "alice", password: "pass" });
    const loginB = await send('/login', { username: "bob", password: "pass" });

    if (!loginA.token || !loginB.token) {
        console.error("Login failed — server response:", loginA, loginB);
        return;
    }

    const tA = loginA.token;
    const tB = loginB.token;

    console.log("\nUsing delivery window:");
    console.log("delivery_start =", delivery_start);
    console.log("delivery_end   =", delivery_end);
    console.log();

    // TEST 1 — Exact match
    console.log("=== TEST 1: Exact Match ===");
    const sell1 = await send("/v2/orders", {
        side: "SELL",
        price: 150,
        quantity: 1000,
        delivery_start,
        delivery_end
    }, tA);
    console.log("SELL:", sell1);

    const buy1 = await send("/v2/orders", {
        side: "BUY",
        price: 150,
        quantity: 1000,
        delivery_start,
        delivery_end
    }, tB);
    console.log("BUY:", buy1);

    console.log("Orderbook after Test1:");
    console.log(await get(`/v2/orders?delivery_start=${delivery_start}&delivery_end=${delivery_end}`));
    console.log();

    // TEST 2 — Price improvement (maker price)
    console.log("=== TEST 2: Price Improvement ===");
    await send("/v2/orders", {
        side: "SELL",
        price: 150,
        quantity: 500,
        delivery_start,
        delivery_end
    }, tA);

    const buy2 = await send("/v2/orders", {
        side: "BUY",
        price: 155,
        quantity: 500,
        delivery_start,
        delivery_end
    }, tB);
    console.log("BUY:", buy2);
    console.log("Orderbook after Test2:");
    console.log(await get(`/v2/orders?delivery_start=${delivery_start}&delivery_end=${delivery_end}`));
    console.log();

    // TEST 3 — Partial fill (incoming larger)
    console.log("=== TEST 3: Partial Fill ===");
    await send("/v2/orders", {
        side: "SELL",
        price: 150,
        quantity: 500,
        delivery_start,
        delivery_end
    }, tA);

    const buy3 = await send("/v2/orders", {
        side: "BUY",
        price: 150,
        quantity: 1200,
        delivery_start,
        delivery_end
    }, tB);
    console.log("BUY (partial):", buy3);
    console.log("Orderbook after Test3:");
    console.log(await get(`/v2/orders?delivery_start=${delivery_start}&delivery_end=${delivery_end}`));
    console.log();

    // TEST 4 — Multi-match FIFO
    console.log("=== TEST 4: Multi-match FIFO ===");
    await send("/v2/orders", { side: "SELL", price: 148, quantity: 400, delivery_start, delivery_end }, tA);
    await send("/v2/orders", { side: "SELL", price: 148, quantity: 300, delivery_start, delivery_end }, tA);
    await send("/v2/orders", { side: "SELL", price: 150, quantity: 500, delivery_start, delivery_end }, tA);

    const buy4 = await send("/v2/orders", {
        side: "BUY",
        price: 150,
        quantity: 1000,
        delivery_start,
        delivery_end
    }, tB);
    console.log("BUY (multi-match):", buy4);
    console.log("Orderbook after Test4:");
    console.log(await get(`/v2/orders?delivery_start=${delivery_start}&delivery_end=${delivery_end}`));
    console.log();

    // TEST 5 — No match
    console.log("=== TEST 5: No Match ===");
    await send("/v2/orders", { side: "SELL", price: 150, quantity: 1000, delivery_start, delivery_end }, tA);

    const buy5 = await send("/v2/orders", {
        side: "BUY",
        price: 145,
        quantity: 500,
        delivery_start,
        delivery_end
    }, tB);
    console.log("BUY (no match):", buy5);
    console.log("Orderbook after Test5:");
    console.log(await get(`/v2/orders?delivery_start=${delivery_start}&delivery_end=${delivery_end}`));
    console.log();

    // TEST 6 — Contract isolation
    console.log("=== TEST 6: Contract Isolation ===");
    await send("/v2/orders", {
        side: "SELL",
        price: 150,
        quantity: 1000,
        delivery_start: delivery_start2,
        delivery_end: delivery_end2
    }, tA);

    const buy6 = await send("/v2/orders", {
        side: "BUY",
        price: 150,
        quantity: 1000,
        delivery_start,
        delivery_end
    }, tB);
    console.log("BUY (should not match different window):", buy6);
    console.log();

    // TEST 7 — V1/V2 isolation
    console.log("=== TEST 7: V1/V2 Isolation ===");
    await send("/orders", {
        price: 150,
        quantity: 999,
        delivery_start,
        delivery_end
    }, tA);

    const buy7 = await send("/v2/orders", {
        side: "BUY",
        price: 150,
        quantity: 999,
        delivery_start,
        delivery_end
    }, tB);
    console.log("BUY (should NOT match V1):", buy7);

    console.log("\n=== ALL TESTS COMPLETED ===");
})();
