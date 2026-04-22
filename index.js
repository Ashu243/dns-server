const dgram = require('node:dgram');
const server = dgram.createSocket('udp4');
const dnsPacket = require('dns-packet');
const upstream = dgram.createSocket('udp4');
const fs = require('fs');
const { decode } = require('node:punycode');

// ---------------- LOAD ZONE ----------------
const zoneData = fs.readFileSync("zone.txt", 'utf-8');
const lines = zoneData.split("\n");

const db = {};
const googleForwarding = true

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
const pendingRequests = new Map();

// ---------------- SERVER ----------------
server.on('message', (msg, rinfo) => {
    const incomingreq = dnsPacket.decode(msg);
    const question = incomingreq.questions?.[0];

    if (!question) return;

    const domain = question.name;
    const type = question.type;

    // ---------------- 1> EXACT MATCH ----------------
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

    // ---------------- 2> CNAME RESOLUTION ----------------
    if (db[domain]?.["CNAME"]) {
        let visited = new Set();
        let current = domain;
        let targetA = null;

        while (db[current]?.["CNAME"]) {
            if (visited.has(current)) break;
            visited.add(current);

            current = db[current]["CNAME"][0];
            targetA = db[current]?.["A"];

            if (targetA) break;
        }

        if (targetA) {
            const answers = [
                {
                    type: 'CNAME',
                    name: domain,
                    class: 'IN',
                    ttl: 300,
                    data: current
                },
                ...targetA.map(ip => ({
                    type: 'A',
                    name: current,
                    class: 'IN',
                    ttl: 300,
                    data: ip
                }))
            ];

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
    }

    // ---------------- 3> NODATA ----------------
    if (db[domain] && !db[domain][type]) {
        const res = dnsPacket.encode({
            id: incomingreq.id,
            type: 'response',
            flags: dnsPacket.AUTHORITATIVE_ANSWER,
            rcode: 'NOERROR',
            questions: incomingreq.questions,
            answers: []
        });

        server.send(res, rinfo.port, rinfo.address);
        return;
    }

    // ---------------- 4. CACHE ----------------
    const cacheKey = `${domain}:${type}`;
    const cached = cache.get(cacheKey);

    if (cached && cached.expiresAt > Date.now()) {
        const res = dnsPacket.encode({
            id: incomingreq.id,
            type: 'response',
            flags: dnsPacket.AUTHORITATIVE_ANSWER,
            rcode: cached.rcode,
            questions: incomingreq.questions,
            answers: cached.answers
        });

        server.send(res, rinfo.port, rinfo.address);
        return;
    }

    // ---------------- 5. FORWARD ----------------
    if (!db[domain]) {
        // if(!googleForwarding){
        //     const ans = dnsPacket.encode({
        //         id: incomingreq.id,
        //         type: type,
        //         rcode: "NXDOMAIN",
        //         questions: incomingreq.questions
        //     })

        //     server.send(ans, rinfo.port, rinfo.address)
        //     return

        // }
        
        
        pendingRequests.set(incomingreq.id, {
            domain,
            type,
            port: rinfo.port,
            address: rinfo.address,
            originalQuery: msg
        });
        
        const ROOT_SERVER = '198.41.0.4';
        upstream.send(msg, 53, ROOT_SERVER);

        // timeout
        setTimeout(() => {
            if (pendingRequests.has(incomingreq.id)) {
                pendingRequests.delete(incomingreq.id);

                const res = dnsPacket.encode({
                    id: incomingreq.id,
                    type: 'response',
                    flags: dnsPacket.AUTHORITATIVE_ANSWER,
                    rcode: 'SERVFAIL',
                    questions: incomingreq.questions
                });

                server.send(res, rinfo.port, rinfo.address);
            }
        }, 3000);

        return;
    }
});

// ---------------- UPSTREAM RESPONSE ----------------
upstream.on("message", (response) => {
    const decoded = dnsPacket.decode(response);
    // console.log(decoded)
    const request = pendingRequests.get(decoded.id);

    if (!request) return;

    function nextServerIp(decoded){
        if(decoded.additionals){
            for (const record of decoded.additionals){
                if (record.type == "A"){
                    return record.data
                }
            }
        }
        return null
    }


    // if the response is final 
    if (decoded.answers && decoded.answers.length > 0){
        const ttl = decoded.answers?.[0]?.ttl || 300;
    
        cache.set(`${request.domain}:${request.type}`, {
            answers: decoded.answers,
            rcode: decoded.rcode,
            expiresAt: Date.now() + ttl * 1000
        });
    
        server.send(response, request.port, request.address);
        pendingRequests.delete(decoded.id);
        return
    }

    const nextIP = nextServerIp(decoded)
    if (nextIP){
        console.log("querying the next server: ", nextIP)
        upstream.send(request.originalQuery, 53, nextIP)
        return
    }

    console.log('No server found, failing')

    const res = dnsPacket.encode({
        id: decoded.id,
        type: "response",
        rcode: "SERVERFAIL",
        questions: [{name: request.domain, type: request.type}]
    })


    server.send(res, request.port, request.address)
    return


});

// ---------------- START SERVER ----------------
server.bind(53, () => {
    console.log('DNS server running on port 53');
});