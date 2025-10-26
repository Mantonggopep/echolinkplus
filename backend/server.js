// ==============================
// EchoLink+ Robust Signaling Server
// ==============================

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const cors = require("cors");

// -------------------------------
// Setup HTTP + WebSocket servers
// -------------------------------
const PORT = process.env.PORT || 8080;
const app = express();
app.use(cors());
app.use(express.json());

// Simple health check route
app.get("/", (req, res) => {
  res.status(200).send("✅ EchoLink+ Signaling Server is running.");
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Store connected clients
const clients = {}; // { username: WebSocket }

// -------------------------------
// Helper Functions
// -------------------------------
function sendTo(username, message) {
  const ws = clients[username];
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function broadcastUserList() {
  const userList = Object.keys(clients).map((u) => ({
    username: u,
    status: clients[u].status || "Available",
  }));

  const payload = JSON.stringify({ type: "userList", users: userList });

  for (const user of Object.values(clients)) {
    if (user.readyState === WebSocket.OPEN) {
      user.send(payload);
    }
  }
}

// -------------------------------
// WebSocket Event Handling
// -------------------------------
wss.on("connection", (ws) => {
  ws.username = null;
  ws.status = "Available";
  ws.calling = null;

  ws.on("message", (msg) => {
    let data;
    try {
      data = JSON.parse(msg);
    } catch (err) {
      console.error("❌ Invalid JSON:", msg);
      return;
    }

    // Ignore unlogged users except login attempts
    if (!ws.username && data.type !== "login") return;

    switch (data.type) {
      // ---------------------------
      // LOGIN HANDLER
      // ---------------------------
      case "login":
        const username = data.username?.trim();
        if (!username) {
          ws.send(JSON.stringify({ type: "loginFailure", message: "Invalid username." }));
          return;
        }

        if (clients[username]) {
          ws.send(JSON.stringify({ type: "loginFailure", message: "Username already taken." }));
          return;
        }

        ws.username = username;
        ws.status = "Available";
        clients[username] = ws;

        ws.send(JSON.stringify({ type: "loginSuccess", message: `Welcome ${username}` }));
        broadcastUserList();
        console.log(`✅ ${username} connected`);
        break;

      // ---------------------------
      // OFFER / ANSWER / ICE
      // ---------------------------
      case "offer":
        if (clients[data.target]) {
          ws.status = "Busy";
          clients[data.target].status = "Ringing";
          sendTo(data.target, {
            type: "offer",
            offer: data.offer,
            caller: ws.username,
          });
          broadcastUserList();
        }
        break;

      case "answer":
        if (clients[data.target]) {
          sendTo(data.target, {
            type: "answer",
            answer: data.answer,
            caller: ws.username,
          });
        }
        break;

      case "iceCandidate":
        if (clients[data.target]) {
          sendTo(data.target, {
            type: "iceCandidate",
            candidate: data.candidate,
            caller: ws.username,
          });
        }
        break;

      // ---------------------------
      // REJECT / HANGUP
      // ---------------------------
      case "reject":
      case "hangup":
        if (clients[data.target]) {
          sendTo(data.target, { type: data.type, caller: ws.username });
          clients[data.target].status = "Available";
        }
        ws.status = "Available";
        broadcastUserList();
        break;

      // ---------------------------
      // UNKNOWN MESSAGES
      // ---------------------------
      default:
        console.warn("⚠️ Unknown message type:", data.type);
    }
  });

  ws.on("close", () => {
    if (ws.username && clients[ws.username]) {
      delete clients[ws.username];
      broadcastUserList();
      console.log(`❌ ${ws.username} disconnected`);
    }
  });
});

// -------------------------------
// Start Server
// -------------------------------
server.listen(PORT, () => {
  console.log(`🚀 EchoLink+ Signaling Server running on port ${PORT}`);
});