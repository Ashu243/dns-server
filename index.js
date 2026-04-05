const dgram = require('node:dgram');
const server = dgram.createSocket('udp4');
const dnsPacket = require('dns-packet')
const upstream = dgram.createSocket('udp4')

const db = {
    'piyushgarg.dev': {
        A: ['1.2.3.4', '3.4.5.6'],
        TXT: 'hello from custom dns',
        MX: 'mail.piyushgarg.dev'
    },
    'blog.piyushgarg.dev': {
        CNAME: 'piyushgarg.dev'
    }

}

const cache = new Map()

// receive the packet
server.on('message', (msg, rinfo) => {

    // decode the message
    const incomingreq = dnsPacket.decode(msg)
    const domain = incomingreq.questions[0].name
    const type = incomingreq.questions[0].type
    const ipFromDb = db[domain]?.[type]
    console.log(ipFromDb)

    // forward the same to google dns server if not found in db
    if(!ipFromDb){
        const cached = cache.get(`${domain}:${type}`)
        
        if(cached && cached.expiresAt > Date.now()){
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


        upstream.send(msg, 53, '8.8.8.8')

        upstream.once('message', (response)=> {
            const decoded = dnsPacket.decode(response)
            const ttl = decoded.answers?.[0]?.ttl || 300
            cache.set(`${domain}:${type}`, {
                answers: decoded.answers,
                expiresAt:  Date.now() + ttl * 1000
            })
            server.send(response, rinfo.port, rinfo.address)
        })
        return
    }

    // if not cached and my database has the record
    const ans = dnsPacket.encode({
        id: incomingreq.id,
        type: 'response',
        flags: dnsPacket.AUTHORITATIVE_ANSWER,
        questions: incomingreq.questions,
        answers: ipFromDb.map((ip)=>({
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



server.bind(53, () => {
    console.log('server is running on port 53')
})