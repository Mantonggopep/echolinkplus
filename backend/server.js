// backend/server.js

const WebSocket = require("ws");
const http = require("http");

const PORT = process.env.PORT || 3000;
const server = http.createServer();
const wss = new WebSocket.Server({ server });

const clients = {}; // { username: ws }

wss.on("connection", (ws) => {
  console.log("Client connected");

  ws.on("message", (msg) => {
    let data;
    try {
      data = JSON.parse(msg);
    } catch (e) {
      console.error("Invalid JSON:", e);
      return;
    }

    switch (data.type) {
      case "login":
        if (clients[data.username]) {
          ws.send(
            JSON.stringify({
              type: "login",
              success: false,
              message: "Username already taken",
            })
          );
          return;
        }

        ws.username = data.username;
        clients[data.username] = ws;
        console.log(`User logged in: ${data.username}`);
        broadcastUserList();
        break;

      case "offer":
      case "answer":
      case "iceCandidate":
        const target = clients[data.target];
        if (target) target.send(JSON.stringify(data));
        break;

      default:
        console.warn("Unknown message type:", data.type);
    }
  });

  ws.on("close", () => {
    if (ws.username) {
      console.log(`User disconnected: ${ws.username}`);
      delete clients[ws.username];
      broadcastUserList();
    }
  });
});

function broadcastUserList() {
  const users = Object.keys(clients);
  const msg = JSON.stringify({ type: "userList", users
