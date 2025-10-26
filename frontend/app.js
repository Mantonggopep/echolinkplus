// ===============================================
// Echo-Link+ Frontend (Audio-Only Robust Version)
// ===============================================

// --- Update this to your Render backend WebSocket URL ---
const WS_URL = "wss://echolinkplus-backend.onrender.com";

let ws;
let localStream;
let peerConnection;
let username = null;
let remoteUser = null;
let currentCall = null;

// ======= TURN + STUN configuration for global connectivity =======
const configuration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    // TURN server for users behind NAT/firewalls (use free or paid TURN)
    {
      urls: "turn:relay.metered.ca:80",
      username: "openai",
      credential: "openai123"
    },
    {
      urls: "turn:relay.metered.ca:443",
      username: "openai",
      credential: "openai123"
    },
  ],
};

// ======= DOM Elements =======
const usernameInput = document.getElementById("usernameInput");
const statusMessage = document.getElementById("status-message");
const loginView = document.getElementById("login-view");
const appView = document.getElementById("app-view");
const userList = document.getElementById("user-list");
const callControls = document.getElementById("call-controls");
const micIndicator = document.getElementById("mic-indicator");
const incomingModal = document.getElementById("incoming-call-modal");
const incomingCallerName = document.getElementById("incoming-caller-name");
const localAudio = document.getElementById("localAudio");
const remoteAudio = document.getElementById("remoteAudio");

// ===============================================
// LOGIN HANDLER
// ===============================================
async function handleLogin() {
  if (!usernameInput) {
    console.error("usernameInput element missing.");
    updateStatus("Error: username field missing in HTML.", "error");
    return;
  }

  username = usernameInput.value.trim();
  if (!username) {
    updateStatus("Please enter your Echo-Name.", "error");
    return;
  }

  updateStatus("Connecting to Echo-Link+ server...");

  ws = new WebSocket(WS_URL);

  ws.onopen = async () => {
    updateStatus("Connected. Accessing microphone...");
    ws.send(JSON.stringify({ type: "login", username }));

    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localAudio.srcObject = localStream;
      micIndicator.classList.add("active");
      loginView.classList.add("hidden");
      appView.classList.remove("hidden");
      updateStatus(`Welcome, ${username}! Ready to Echo-Link.`);
    } catch (err) {
      console.error("Microphone error:", err);
      updateStatus("Microphone access denied.", "error");
    }
  };

  ws.onmessage = handleMessage;
  ws.onclose = () => updateStatus("Disconnected from server.", "error");
  ws.onerror = (err) => {
    console.error("WebSocket error:", err);
    updateStatus("Connection error. Please refresh.", "error");
  };
}

// ===============================================
// WEBSOCKET MESSAGE HANDLER
// ===============================================
function handleMessage(msg) {
  const data = JSON.parse(msg.data);
  console.log("Message from server:", data);

  switch (data.type) {
    case "userList":
      renderUserList(data.users);
      break;
    case "loginSuccess":
      updateStatus("Login successful.", "success");
      break;
    case "loginFailure":
      updateStatus("Echo-Name taken. Choose another.", "error");
      break;
    case "offer":
      handleOffer(data.offer, data.caller);
      break;
    case "answer":
      handleAnswer(data.answer);
      break;
    case "candidate":
    case "iceCandidate":
      handleCandidate(data.candidate);
      break;
    case "reject":
      updateStatus(`${data.caller} is unavailable.`, "error");
      break;
    case "hangup":
      handleRemoteHangup();
      break;
    default:
      console.log("Unknown message:", data);
  }
}

// ===============================================
// RENDER USER LIST
// ===============================================
function renderUserList(users) {
  userList.innerHTML = "";
  users
    .filter((u) => u.username !== username)
    .forEach((u) => {
      const li = document.createElement("li");
      li.className = "user-item";
      li.innerHTML = `
        <span>${u.username} <small>(${u.status})</small></span>
        <button class="call-btn" onclick="callUser('${u.username}')">Echo-Link</button>
      `;
      userList.appendChild(li);
    });
}

// ===============================================
// CALL ANOTHER USER
// ===============================================
async function callUser(targetUser) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    updateStatus("Not connected to the server.", "error");
    return;
  }

  remoteUser = targetUser;
  updateStatus(`Connecting to ${targetUser}...`);

  createPeerConnection();

  // Add local audio
  localStream.getTracks().forEach((track) => peerConnection.addTrack(track, localStream));

  // Create and send offer
  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  ws.send(JSON.stringify({ type: "offer", offer, target: targetUser }));

  currentCall = targetUser;
  callControls.classList.remove("hidden");
  updateStatus(`Calling ${targetUser}...`);
}

// ===============================================
// HANDLE INCOMING OFFER
// ===============================================
async function handleOffer(offer, callerName) {
  remoteUser = callerName;
  incomingCallerName.textContent = `${callerName} is Echo-Linking you...`;
  incomingModal.classList.remove("hidden");

  window.acceptCall = async function () {
    incomingModal.classList.add("hidden");
    createPeerConnection();

    localStream.getTracks().forEach((track) => peerConnection.addTrack(track, localStream));

    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);

    ws.send(JSON.stringify({ type: "answer", answer, target: callerName }));

    currentCall = callerName;
    callControls.classList.remove("hidden");
    updateStatus(`Connected with ${callerName}.`);
  };

  window.rejectCall = function () {
    incomingModal.classList.add("hidden");
    ws.send(JSON.stringify({ type: "reject", target: callerName }));
    updateStatus(`Rejected call from ${callerName}.`, "info");
  };
}

// ===============================================
// PEER CONNECTION SETUP
// ===============================================
function createPeerConnection() {
  peerConnection = new RTCPeerConnection(configuration);

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      ws.send(
        JSON.stringify({
          type: "iceCandidate",
          candidate: event.candidate,
          target: remoteUser,
        })
      );
    }
  };

  peerConnection.onconnectionstatechange = () => {
    const state = peerConnection.connectionState;
    console.log("Connection state:", state);
    if (state === "connected") {
      updateStatus("Echo-Link active and stable.", "success");
    } else if (state === "disconnected" || state === "failed") {
      updateStatus("Connection lost. Attempting to reconnect...", "error");
    }
  };

  peerConnection.ontrack = (event) => {
    remoteAudio.srcObject = event.streams[0];
    updateStatus("Audio stream connected.", "success");
  };
}

// ===============================================
// HANDLE ANSWER
// ===============================================
async function handleAnswer(answer) {
  await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
  updateStatus("Echo-Link established successfully.", "success");
}

// ===============================================
// HANDLE ICE CANDIDATE
// ===============================================
function handleCandidate(candidate) {
  if (candidate && peerConnection) {
    peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
  }
}

// ===============================================
// HANGUP HANDLERS
// ===============================================
function hangUp() {
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }

  if (ws && remoteUser) {
    ws.send(JSON.stringify({ type: "hangup", target: remoteUser }));
  }

  callControls.classList.add("hidden");
  updateStatus("Echo-Link ended.");
  remoteUser = null;
}

function handleRemoteHangup() {
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }

  callControls.classList.add("hidden");
  updateStatus("Remote user ended the call.");
  remoteUser = null;
}

// ===============================================
// HELPER: Update Status Box
// ===============================================
function updateStatus(message, type = "info") {
  statusMessage.textContent = message;
  statusMessage.style.backgroundColor =
    type === "error"
      ? "#f8d7da"
      : type === "success"
      ? "#d4edda"
      : "#e6f7ff";
  statusMessage.style.color =
    type === "error"
      ? "#721c24"
      : type === "success"
      ? "#155724"
      : "#004085";
}

// ===============================================
// FIX FAVICON 404 (Optional)
// ===============================================
const link = document.createElement("link");
link.rel = "icon";
link.href = "data:,";
document.head.appendChild(link);