const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 8080;
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('WebRTC Signaling Server is running.\n');
});

const wss = new WebSocket.Server({ server });

const clients = {};

console.log(`Signaling Server running on port ${PORT}`);

const sendTo = (username, message) => {
    const ws = clients[username];
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
    }
};

const broadcastUserList = () => {
    const userList = Object.keys(clients).map(username => ({
        username,
        status: clients[username].status 
    }));

    const message = {
        type: 'userList',
        users: userList
    };

    Object.values(clients).forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(message));
        }
    });
};

wss.on('connection', (ws) => {
    ws.username = null;
    ws.status = 'Available';
    ws.calling = null;

    ws.on('message', (message) => {
        let data;
        try {
            data = JSON.parse(message);
        } catch {
            return console.error('Invalid JSON:', message);
        }

        if (!ws.username && data.type !== 'login') return;

        switch (data.type) {
            case 'login':
                if (data.username && !clients[data.username]) {
                    ws.username = data.username;
                    ws.status = 'Available';
                    clients[data.username] = ws;
                    sendTo(ws.username, { type: 'loginSuccess', message: `Welcome, ${data.username}!` });
                    broadcastUserList();
                } else {
                    sendTo(ws.username, { type: 'loginFailure', message: 'Username is taken or invalid.' });
                }
                break;

            case 'offer':
                if (clients[data.target]) {
                    sendTo(data.target, { type: 'offer', offer: data.offer, caller: ws.username });
                }
                break;

            case 'answer':
                if (clients[data.target]) {
                    sendTo(data.target, { type: 'answer', answer: data.answer, caller: ws.username });
                }
                break;

            case 'iceCandidate':
                if (clients[data.target]) {
                    sendTo(data.target, { type: 'iceCandidate', candidate: data.candidate, caller: ws.username });
                }
                break;

            case 'reject':
            case 'hangup':
                if (clients[data.target]) {
                    sendTo(data.target, { type: data.type, caller: ws.username });
                    clients[data.target].status = 'Available';
                    ws.status = 'Available';
                    broadcastUserList();
                }
                break;

            default:
                console.warn('Unknown message type:', data.type);
        }
    });

    ws.on('close', () => {
        if (ws.username) {
            delete clients[ws.username];
            broadcastUserList();
        }
    });
});

server.listen(PORT, () => console.log(`Server ready on ${PORT}`));
