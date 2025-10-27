// backend/server.js
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const app = express();

// --- CONSTANTS FOR STATUS ---
const STATUS = {
  AVAILABLE: 'Available',
  RINGING: 'Ringing',
  IN_CALL: 'In Call'
};
// -----------------------------

// Basic health check for Render / uptime monitors
app.get('/', (req, res) => res.send('EchoLink+ signaling server OK'));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// users: Map<username, { ws, status, peer }>
const users = new Map();

// --- HELPER FUNCTIONS ---

function broadcastUserList() {
  const list = Array.from(users.entries()).map(([username, data]) => ({
    username,
    status: data.status || STATUS.AVAILABLE
  }));
  const payload = JSON.stringify({ type: 'userList', users: list });
  for (const [, u] of users) {
    // ⚠️ Note: We rely on the ws object being the actual live connection.
    if (u.ws && u.ws.readyState === u.ws.OPEN) {
      u.ws.send(payload);
    }
  }
}

function safeSend(ws, obj) {
  try {
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  } catch (e) {
    // Error often happens if sending during a close event; minor log for tracking
    console.warn('safeSend failed (likely during closing)', e.message);
  }
}

/**
 * Helper to reset user state safely and immutably.
 * FIX 1: Ensures immutable updates to avoid race conditions.
 */
function resetUserState(username) {
  if (!users.has(username)) return;
  const current = users.get(username);
  
  users.set(username, {
    ws: current.ws,
    status: STATUS.AVAILABLE,
    peer: null
  });
}

// --- WEBSOCKET HANDLERS ---

wss.on('connection', (ws, req) => {
  ws.username = null;
  // FIX 6: Log context in errors
  ws.ip = req.socket.remoteAddress;

  ws.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      console.warn(`Invalid JSON from ${ws.ip}:`, raw.toString().substring(0, 50));
      return;
    }

    const type = data.type;

    switch (type) {
      // -------------------------
      // LOGIN
      // -------------------------
      case 'login': {
        const username = (data.username || '').trim();
        if (!username) {
          safeSend(ws, { type: 'loginFailure', message: 'Invalid username.' });
          return;
        }
        if (users.has(username)) {
          safeSend(ws, { type: 'loginFailure', message: 'Username already in use.' });
          return;
        }

        // register
        users.set(username, { ws, status: STATUS.AVAILABLE, peer: null });
        ws.username = username;

        safeSend(ws, { type: 'loginSuccess', message: `Welcome ${username}` });
        console.log(`✅ ${username} logged in from ${ws.ip}`);
        broadcastUserList();
        break;
      }

      // -------------------------
      // OFFER
      // -------------------------
      case 'offer': {
        const { offer } = data;
        const callerName = ws.username;
        
        // FIX 2: Validate target
        let target = data.target;
        if (typeof target === 'string') target = target.trim();
        if (!callerName || typeof target !== 'string' || !target) {
            safeSend(ws, { type: 'reject', message: 'Invalid target user or not logged in.' });
            return;
        }

        const targetData = users.get(target);
        const callerData = users.get(callerName); // Caller must exist

        // FIX 3: Robust existence check and state check
        if (!targetData || targetData.ws.readyState !== targetData.ws.OPEN) {
          safeSend(ws, { type: 'reject', message: `${target} not found or disconnected.` });
          return;
        }
        
        // FIX 8: Check if caller is already busy (in call or ringing another person)
        if (callerData.status !== STATUS.AVAILABLE) {
            safeSend(ws, { type: 'reject', message: 'You are already in a call or ringing.' });
            return;
        }
        
        // Callee status check
        if (targetData.status !== STATUS.AVAILABLE) {
          safeSend(ws, { type: 'reject', message: `${target} is busy.` });
          return;
        }

        // forward offer to target
        safeSend(targetData.ws, { type: 'offer', caller: callerName, offer });

        // FIX 1 & 7: Update states immutably using constant strings
        users.set(callerName, { ...callerData, status: STATUS.IN_CALL, peer: target });
        users.set(target, { ...targetData, status: STATUS.RINGING, peer: callerName });

        broadcastUserList();
        break;
      }

      // -------------------------
      // ANSWER
      // -------------------------
      case 'answer': {
        const { target, answer } = data;
        
        // FIX 2: Validate target
        if (typeof target === 'string') target = target.trim();
        if (!ws.username || typeof target !== 'string' || !target) return;
        
        const callerData = users.get(target);
        
        if (callerData && callerData.ws && callerData.ws.readyState === callerData.ws.OPEN) {
          safeSend(callerData.ws, { type: 'answer', answer, callee: ws.username });
        }

        // FIX 1 & 7: Mark both as In Call immutably
        if (users.has(ws.username)) {
          const calleeData = users.get(ws.username);
          users.set(ws.username, { ...calleeData, status: STATUS.IN_CALL });
        }
        if (target && users.has(target)) {
          // Caller is already set to 'In Call' but was 'Ringing' or 'In Call' from offer.
          // Ensure peer is correctly set (already done in offer) and set to IN_CALL
          const callerData = users.get(target);
          users.set(target, { ...callerData, status: STATUS.IN_CALL });
        }

        broadcastUserList();
        break;
      }

      // -------------------------
      // ICE CANDIDATE
      // -------------------------
      case 'iceCandidate': {
        const { target, candidate } = data;
        
        // FIX 2: Validate target
        if (typeof target === 'string') target = target.trim();
        if (!ws.username || typeof target !== 'string' || !target) return;
        
        const dest = users.get(target);
        if (dest && dest.ws && dest.ws.readyState === dest.ws.OPEN) {
          safeSend(dest.ws, { type: 'iceCandidate', candidate, caller: ws.username });
        }
        break;
      }

      // -------------------------
      // REJECT
      // -------------------------
      case 'reject': {
        const { target } = data;
        
        // FIX 2: Validate target
        if (typeof target === 'string') target = target.trim();
        if (!ws.username || typeof target !== 'string' || !target) return;
        
        const dest = users.get(target);
        if (dest && dest.ws && dest.ws.readyState === dest.ws.OPEN) {
          // Send reject notification to the caller
          safeSend(dest.ws, { type: 'reject', callee: ws.username, message: data.message || null });
        }
        
        // Reset states on both sides (callee/sender and caller/target)
        resetUserState(ws.username);
        resetUserState(target);
        broadcastUserList();
        break;
      }

      // -------------------------
      // HANGUP (Handles Cancel too)
      // -------------------------
      case 'hangup': {
        const { target } = data;
        
        // FIX 2: Validate target
        if (typeof target === 'string') target = target.trim();
        if (!ws.username || typeof target !== 'string' || !target) return;
        
        const dest = users.get(target);
        if (dest && dest.ws && dest.ws.readyState === dest.ws.OPEN) {
          safeSend(dest.ws, { type: 'hangup', caller: ws.username });
        }
        
        // Reset states on both sides
        resetUserState(ws.username);
        resetUserState(target);
        broadcastUserList();
        break;
      }

      // FIX: Removed 'cancel' case as 'hangup' handles it perfectly.

      // -------------------------
      // UNKNOWN
      // -------------------------
      default:
        console.warn(`Unknown message type (${type}) from ${ws.username || ws.ip}`);
    }
  });

  ws.on('close', () => {
    const username = ws.username;
    if (!username || !users.has(username)) return;

    console.log(`⚠️ ${username} disconnected.`);

    const userData = users.get(username);
    const peerName = userData.peer;
    
    // If they had a peer, notify peer and reset peer state
    if (peerName && users.has(peerName)) {
      const peer = users.get(peerName);
      if (peer.ws && peer.ws.readyState === peer.ws.OPEN) {
        // Send hangup to the peer so their client can clean up
        safeSend(peer.ws, { type: 'hangup', caller: username });
      }
      resetUserState(peerName);
    }

    // finally remove user and broadcast
    users.delete(username);
    
    // FIX 4: Explicitly nullify the ws reference to help GC
    userData.ws = null; 

    broadcastUserList();
  });

  ws.on('error', (err) => {
    console.error(`WebSocket error for ${ws.username || ws.ip}:`, err && err.message);
  });
});

server.listen(PORT, () => {
  console.log(`🚀 EchoLink+ Signaling Server running on port ${PORT}`);
});
=======
import express from 'express';
import http from 'http';
import WebSocket from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Store connected users
const users = new Map();

// Serve client HTML/JS
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/app.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'app.js'));
});

app.get('/ringtone.mp3', (req, res) => {
  res.sendFile(path.join(__dirname, 'ringtone.mp3'));
});

// WebSocket signaling logic
wss.on('connection', (ws) => {
  ws.on('message', (message) => {
    let data;
    try { data = JSON.parse(message); } 
    catch { return console.error("Invalid JSON:", message); }

    switch (data.type) {
      case 'login':
        users.set(data.username, ws);
        ws.username = data.username;
        ws.send(JSON.stringify({ type: 'loginSuccess', username: data.username }));
        broadcastUserList();
        break;

      case 'offer':
      case 'answer':
      case 'iceCandidate':
      case 'hangup':
      case 'reject':
        const target = users.get(data.target);
        if (target && target.readyState === WebSocket.OPEN) {
          target.send(JSON.stringify({ ...data, caller: ws.username }));
        }
        break;
    }
  });

  ws.on('close', () => {
    if (ws.username) {
      users.delete(ws.username);
      broadcastUserList();
    }
  });
});

function broadcastUserList() {
  const list = Array.from(users.keys()).map(u => ({ username: u, status: 'Available' }));
  users.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'userList', users: list }));
    }
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
bd2f2b4 (Update backend and frontend files for WebRTC app)
