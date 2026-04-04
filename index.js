const dgram = require('node:dgram');
const server = dgram.createSocket('udp4');
const dnsPacket = require('dns-packet')
const upstream = dgram.createSocket('udp4')

const db = {
    'piyushgarg.dev': '1.2.3.4',
    'blog.piyushgarg.dev': '4.5.6.7'

}

const cache = new Map()

// receive the packet
server.on('message', (msg, rinfo) => {

    // decode the message
    const incomingreq = dnsPacket.decode(msg)
    const domain = incomingreq.questions[0].name
    const ipFromDb = db[domain]


    if(!ipFromDb){
        const cached = cache.get(domain)
        
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
            cache.set(domain, {
                answers: decoded.answers,
                expiresAt:  Date.now() + (5 * 60) * 1000
            })
            server.send(response, rinfo.port, rinfo.address)
        })
        return
    }


    const ans = dnsPacket.encode({
        id: incomingreq.id,
        type: 'response',
        flags: dnsPacket.AUTHORITATIVE_ANSWER,
        questions: incomingreq.questions,
        answers: [{
            type: 'A',
            name: domain,
            class: 'IN',
            data: ipFromDb
        }]
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