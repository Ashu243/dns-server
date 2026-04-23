const dgram = require('node:dgram');
const dnsPacket = require('dns-packet');
const fs = require('fs');

const server = dgram.createSocket('udp4');

// ---------------- LOAD ZONE ----------------
const zoneData = fs.readFileSync("zone.txt", 'utf-8');
const lines = zoneData.split("\n");

const db = {};

for (const line of lines) {
    if (!line.trim()) continue;

    const parts = line.trim().split(/\s+/);
    const domain = parts[0];
    const type = parts[3];
    const value = parts.slice(4).join(" ").replace(/^"|"$/g, "");

    if (!db[domain]) db[domain] = {};
    if (!db[domain][type]) db[domain][type] = [];

    db[domain][type].push(value);
}

// ---------------- CACHE ----------------
const cache = new Map();

// ---------------- QUERY FUNCTION ----------------
function queryDNS(serverIP, domain, type = "A") {
    return new Promise((resolve, reject) => {
        const socket = dgram.createSocket("udp4");
        const id = Math.floor(Math.random() * 65535);

        const query = dnsPacket.encode({
            type: "query",
            id,
            questions: [{ type, name: domain }]
        });

        socket.send(query, 53, serverIP);

        const timeout = setTimeout(() => {
            socket.close();
            reject(new Error("Timeout"));
        }, 2000);

        socket.on("message", (msg) => {
            const decoded = dnsPacket.decode(msg);

            if (decoded.id === id) {
                clearTimeout(timeout);
                socket.close();
                resolve(decoded);
            }
        });
    });
}

// ---------------- RECURSIVE RESOLVER ----------------
async function resolveDomain(domain, type = "A", visited = new Set()) {

    if (visited.has(domain)) {
        console.log("Loop detected:", domain);
        return null;
    }

    visited.add(domain);

    let currentServer = "198.41.0.4"; // root server

    while (true) {
        let response;

        try {
            response = await queryDNS(currentServer, domain, type);
        } catch (err) {
            console.log("Query failed:", err.message);
            return null;
        }

        //  Final answer
        if (response.answers && response.answers.length > 0) {
            const answer = response.answers.find(r => r.type === type);
            if (answer) return answer.data;
        }

        // Use additionals (fast path)
        if (response.additionals && response.additionals.length > 0) {
            const record = response.additionals.find(r => r.type === "A");
            if (record) {
                currentServer = record.data;
                continue;
            }
        }

        //  Resolve NS if no additionals
        const nsRecords = response.authorities?.filter(r => r.type === "NS");

        if (nsRecords && nsRecords.length > 0) {
            let found = false;

            for (const ns of nsRecords) {
                const nsIP = await resolveDomain(ns.data, "A", visited);

                if (nsIP) {
                    currentServer = nsIP;
                    found = true;
                    break;
                }
            }

            if (found) continue;
        }

        return null;
    }
}

// ---------------- SERVER ----------------
server.on('message', async (msg, rinfo) => {
    const incomingreq = dnsPacket.decode(msg);
    const question = incomingreq.questions?.[0];

    if (!question) return;

    const domain = question.name;
    const type = question.type;

    const cacheKey = `${domain}:${type}`;

    // ---------------- CACHE ----------------
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
        const res = dnsPacket.encode({
            id: incomingreq.id,
            type: 'response',
            questions: incomingreq.questions,
            answers: cached.answers
        });

        server.send(res, rinfo.port, rinfo.address);
        return;
    }

    // ---------------- AUTHORITATIVE ----------------
    if (db[domain]?.[type]) {
        const answers = db[domain][type].map(val => ({
            type,
            name: domain,
            class: 'IN',
            ttl: 300,
            data: val
        }));

        const res = dnsPacket.encode({
            id: incomingreq.id,
            type: 'response',
            flags: dnsPacket.AUTHORITATIVE_ANSWER,
            questions: incomingreq.questions,
            answers
        });

        server.send(res, rinfo.port, rinfo.address);
        return;
    }

    // ---------------- CNAME ----------------
    if (db[domain]?.["CNAME"]) {
        let current = db[domain]["CNAME"][0];
        const ip = await resolveDomain(current, "A");

        if (ip) {
            const answers = [
                {
                    type: "CNAME",
                    name: domain,
                    data: current,
                    ttl: 300
                },
                {
                    type: "A",
                    name: current,
                    data: ip,
                    ttl: 300
                }
            ];

            const res = dnsPacket.encode({
                id: incomingreq.id,
                type: 'response',
                questions: incomingreq.questions,
                answers
            });

            server.send(res, rinfo.port, rinfo.address);
            return;
        }
    }

    // ---------------- RECURSIVE RESOLUTION ----------------
    const ip = await resolveDomain(domain, type);

    if (ip) {
        const answers = [{
            type,
            name: domain,
            ttl: 300,
            data: ip
        }];

        cache.set(cacheKey, {
            answers,
            expiresAt: Date.now() + 300 * 1000
        });

        const res = dnsPacket.encode({
            id: incomingreq.id,
            type: 'response',
            questions: incomingreq.questions,
            answers
        });

        server.send(res, rinfo.port, rinfo.address);
    } else {
        const res = dnsPacket.encode({
            id: incomingreq.id,
            type: 'response',
            rcode: 'SERVFAIL',
            questions: incomingreq.questions
        });

        server.send(res, rinfo.port, rinfo.address);
    }
});

// ---------------- START ----------------
server.bind(53, () => {
    console.log('DNS server running on port 53');
});