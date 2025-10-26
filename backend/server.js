const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;
const server = new WebSocket.Server({ port: PORT });

const clients = {}; // username -> WebSocket mapping

console.log(`✅ WebSocket signaling server running on port ${PORT}`);

server.on("connection", (ws) => {
  console.log("🟢 New connection established");

  ws.on("message", (message) => {
    let data;
    try {
      data = JSON.parse(message);
    } catch (e) {
      console.error("Invalid JSON:", message);
      return;
    }

    switch (data.type) {
      case "login":
        // store user
        ws.username = data.username;
        clients[data.username] = ws;
        console.log(`👤 ${data.username} logged in`);
        broadcastUserList();
        break;

      case "offer":
      case "answer":
      case "candidate":
        const target = clients[data.target];
        if (target) {
          target.send(JSON.stringify(data));
        }
        break;

      case "leave":
        handleDisconnect(ws);
        break;

      default:
        console.log("Unknown message type:", data.type);
    }
  });

  ws.on("close", () => {
    handleDisconnect(ws);
  });
});

function broadcastUserList() {
  const userList = Object.keys(clients);
  const message = {
    type: "update-user-list",
    users: userList,
  };
  const payload = JSON.stringify(message);
  for (const user in clients) {
    clients[user].send(payload);
  }
}

function handleDisconnect(ws) {
  if (ws.username && clients[ws.username]) {
    console.log(`🔴 ${ws.username} disconnected`);
    delete clients[ws.username];
    broadcastUserList();
  }
}
