const WebSocket = require('ws');
const http = require('http');

// --- Server Setup ---
// Use environment PORT for hosting platforms like Render, default to 8080 locally
const PORT = process.env.PORT || 8080;
const server = http.createServer((req, res) => {
    // Simple response for health check on hosting services
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('WebRTC Signaling Server is running.\n');
});

const wss = new WebSocket.Server({ server });

// Store of connected clients: Key is the username.
const clients = {};

console.log(`Signaling Server running on port ${PORT}`);

// Function to send a message to a specific user
const sendTo = (username, message) => {
    const ws = clients[username];
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
    }
};

// Function to broadcast the current list of available users
const broadcastUserList = () => {
    // Get all usernames and their current status
    const userList = Object.keys(clients).map(username => ({
        username,
        status: clients[username].status 
    }));

    const message = {
        type: 'userList',
        users: userList
    };

    // Send the list to every connected client
    Object.values(clients).forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(message));
        }
    });
};

// --- WebSocket Connection Handling ---
wss.on('connection', (ws, req) => {
    ws.username = null;
    ws.status = 'Available'; 
    ws.calling = null; // Who are they currently calling/in call with

    // Handle incoming messages
    ws.on('message', (message) => {
        let data;
        try {
            data = JSON.parse(message);
        } catch (e) {
            console.error('Invalid JSON received:', message);
            return;
        }

        // Must be logged in to send most messages
        if (!ws.username && data.type !== 'login') {
            sendTo(data.username, { type: 'error', message: 'You must log in first.' });
            return;
        }

        // Attach caller info to the message before forwarding
        data.caller = ws.username;

        switch (data.type) {
            case 'login':
                if (data.username && !clients[data.username]) {
                    // Successful login
                    ws.username = data.username;
                    ws.status = 'Available';
                    clients[data.username] = ws;
                    
                    sendTo(ws.username, { type: 'loginSuccess', message: `Welcome, ${data.username}!` });
                    broadcastUserList(); 
                } else {
                    // Failed login (username taken)
                    sendTo(data.username, { type: 'loginFailure', message: 'Username is taken or invalid.' });
                }
                break;

            case 'offer': 
                if (data.target && clients[data.target] && clients[data.target].status === 'Available') {
                    // Update statuses for both caller and receiver
                    ws.status = 'Ringing';
                    ws.calling = data.target;
                    clients[data.target].status = 'Ringing';
                    clients[data.target].calling = ws.username;
                    
                    sendTo(data.target, data); // Forward offer to target
                    broadcastUserList(); // Update user list with "Ringing" status
                } else {
                    // Target is busy or not found, notify caller
                    sendTo(ws.username, { type: 'reject', caller: data.target, reason: clients[data.target] ? 'Busy' : 'Not Found' });
                }
                break;
                
            case 'answer': 
                if (data.target && clients[data.target]) {
                    // Target accepted, update status to 'In Call'
                    ws.status = 'In Call';
                    clients[data.target].status = 'In Call'; 
                    sendTo(data.target, data); // Forward answer to caller
                    broadcastUserList();
                }
                break;
                
            case 'iceCandidate': 
                if (data.target && clients[data.target]) {
                    sendTo(data.target, data); // Forward ICE candidate
                }
                break;

            case 'reject': // Call Rejection
                if (data.target && clients[data.target]) {
                    // Reset statuses for both parties
                    clients[data.target].status = 'Available'; 
                    clients[data.target].calling = null;
                    ws.status = 'Available';
                    ws.calling = null;
                    
                    sendTo(data.target, data); // Notify the caller
                    broadcastUserList(); 
                }
                break;

            case 'hangup': // Call End
                if (data.target && clients[data.target]) {
                    // Reset statuses for both parties
                    clients[data.target].status = 'Available'; 
                    clients[data.target].calling = null;
                    ws.status = 'Available';
                    ws.calling = null;
                    
                    sendTo(data.target, data); // Notify the peer
                    broadcastUserList(); 
                }
                break;

            default:
                console.warn(`Unknown message type: ${data.type}`);
        }
    });

    // Handle client disconnection
    ws.on('close', () => {
        if (ws.username) {
            console.log(`User disconnected: ${ws.username}`);
            
            // Notify the peer if they were in a call
            if (ws.calling && clients[ws.calling]) {
                sendTo(ws.calling, { type: 'hangup', caller: ws.username });
                clients[ws.calling].status = 'Available';
                clients[ws.calling].calling = null;
            }
            delete clients[ws.username];
            broadcastUserList(); 
        }
    });

    ws.on('error', (err) => {
        console.error('WebSocket Error:', err.message);
    });
});

server.listen(PORT);