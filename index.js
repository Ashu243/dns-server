const dgram = require('node:dgram');
const server = dgram.createSocket('udp4');
const dnsPacket = require('dns-packet')
const upstream = dgram.createSocket('udp4')
const fs = require('fs')

const zoneData = fs.readFileSync("zone.txt", 'utf-8')
const lines = zoneData.split("\n")

const db = {}

for (const line of lines) {
    if (!line.trim()) continue

    const parts = line.trim().split(/\s+/);
    const domain = parts[0]
    const ttl = parts[1]
    const cls = parts[2]
    const type = parts[3]
    const value = parts.slice(4).join(" ").replace(/^"|"$/g, "");  // removes only starting and ending quotes

    if (!db[domain]) {
        db[domain] = {}
    }

    if (!db[domain][type]) {
        db[domain][type] = [];
    }
    db[domain][type].push(value)
}
// console.log(db)

const cache = new Map()
const pendingRequests = new Map()

// receive the packet
server.on('message', (msg, rinfo) => {

    // decode the message
    const incomingreq = dnsPacket.decode(msg)
    const domain = incomingreq.questions[0].name
    const type = incomingreq.questions[0].type
    const ipFromDb = db[domain]?.[type]
    console.log(ipFromDb)



    // check if it is in cache
    if (!ipFromDb) {
        const cached = cache.get(`${domain}:${type}`)

        if (cached && cached.expiresAt > Date.now()) {
            const ans = dnsPacket.encode({
                id: incomingreq.id,
                type: 'response',
                flags: dnsPacket.AUTHORITATIVE_ANSWER,
                questions: incomingreq.questions,
                answers: cached.answers
            })
            console.log('cached data:', cached)
            server.send(ans, rinfo.port, rinfo.address)
            return
        }

        pendingRequests.set(incomingreq.id, {
            type: type,
            port: rinfo.port,
            domain,
            address: rinfo.address
        })

        // forward the same to google dns server if not found in db and cache

        upstream.send(msg, 53, '8.8.8.8')
        return
    }

    
    
    
    const records = Array.isArray(ipFromDb) ? ipFromDb : [ipFromDb]
    // if not cached and my database has the record
    const ans = dnsPacket.encode({
        id: incomingreq.id,
        type: 'response',
        flags: dnsPacket.AUTHORITATIVE_ANSWER,
        questions: incomingreq.questions,
        answers: records.map((ip) => ({
            type: type,
            name: domain,
            class: 'IN',
            ttl: 300,
            data: ip
        }))
    })
    console.log({
        msg: incomingreq.questions,
        rinfo
    });
    
    // sends the ip address of the domain that is received from the packet
    server.send(ans, rinfo.port, rinfo.address)
})

upstream.on("message", (response) => {
    const decoded = dnsPacket.decode(response)
    const request = pendingRequests.get(decoded.id)

    if(!request) return 

    const ttl = decoded.answers?.[0]?.ttl || 300
    cache.set(`${request.domain}:${request.type}`, {
        answers: decoded.answers,
        expiresAt: Date.now() + ttl * 1000
    })

    server.send(response, request.port, request.address)
    console.log(decoded.rcode)

    pendingRequests.delete(decoded.id)

})


server.bind(53, () => {
    console.log('server is running on port 53')
})