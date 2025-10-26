// app.js (Client-Side WebRTC Application)

// --- Configuration ---
const wsUrl = 'wss://echolinkplus-backend.onrender.com'; // Use WSS in production
let ws;
let localStream = null;
let peerConnection = null;
let currentCallTarget = null;
let username = '';
let callStartTime = null;
let timerInterval = null;

// --- CRITICAL: STUN/TURN Configuration ---
// ⚠️ REPLACE PLACEHOLDERS WITH YOUR ACTUAL TURN SERVER CREDENTIALS
const iceServers = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    // Add your TURN server(s) here — essential for NAT traversal
    // {
    //   urls: 'turn:your.turn.server.com:3478?transport=udp',
    //   username: 'your_turn_username',
    //   credential: 'your_turn_password'
    // },
    // {
    //   urls: 'turns:your.turn.server.com:443?transport=tcp',
    //   username: 'your_turn_username',
    //   credential: 'your_turn_password'
    // }
  ],
  iceTransportPolicy: 'all' // 'relay' only if you want to force TURN (not recommended by default)
};

// --- DOM Elements (Cache once) ---
const loginView = document.getElementById("login-view");
const appView = document.getElementById("app-view");
const statusMessage = document.getElementById("status-message");
const loggedUser = document.getElementById("logged-username");
const userList = document.getElementById("user-list");
const ringtone = document.getElementById("ringtone");
const remoteAudio = document.getElementById("remoteAudio");
const localAudio = document.getElementById("localAudio");
const callControls = document.getElementById("call-controls");
const incomingCallModal = document.getElementById("incoming-call-modal");
const incomingCallerName = document.getElementById("incoming-caller-name");
const callTimerDisplay = document.getElementById("call-timer");

// --- On Load: Try Persistent Login ---
window.addEventListener("load", () => {
  const savedUser = localStorage.getItem("echoname");
  if (savedUser) {
    document.getElementById("usernameInput").value = savedUser;
    handleLogin(savedUser);
  } else {
    connectWebSocket(); // Connect early so login is fast
  }
});

// --- WebSocket Management ---
function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log("✅ WebSocket connected.");
    statusMessage.textContent = "Connected to EchoLink+ Server.";
    if (username) {
      sendSignalingMessage({ type: "login", username });
    }
  };

  ws.onmessage = async (event) => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch (e) {
      console.error("❌ Invalid JSON from server:", event.data);
      return;
    }

    console.log("📥 Signaling:", data.type, data);

    switch (data.type) {
      case "loginSuccess":
        username = data.username;
        localStorage.setItem("echoname", username);
        showAppView();
        statusMessage.textContent = `Logged in as ${username}.`;
        break;

      case "loginFailure":
        alert(`Login failed: ${data.message}`);
        statusMessage.textContent = "Login failed.";
        username = '';
        showLoginView();
        break;

      case "userList":
        updateUserList(data.users);
        break;

      case "offer":
        if (currentCallTarget) {
          console.warn("Ignoring offer: already in a call.");
          sendSignalingMessage({ type: "reject", target: data.caller, message: "Busy" });
          return;
        }
        await onIncomingCall(data.caller, data.offer);
        break;

      case "answer":
        if (!peerConnection || !currentCallTarget) {
          console.warn("Received answer without active call. Sending hangup.");
          if (data.callee) sendSignalingMessage({ type: "hangup", target: data.callee });
          endCall(false);
          return;
        }
        try {
          await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
          console.log("✅ Call established with answer.");
          startCallTimer();
          statusMessage.textContent = `In call with ${currentCallTarget}`;
        } catch (e) {
          console.error("Failed to set remote answer:", e);
          endCall(true);
        }
        break;

      case "iceCandidate":
        if (peerConnection && data.candidate) {
          try {
            await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
          } catch (e) {
            console.warn("ICE candidate error (may be harmless):", e.message);
          }
        }
        break;

      case "reject":
        alert(`CallCheck: ${data.message || 'Rejected'}`);
        endCall(false);
        break;

      case "hangup":
        alert(`${data.caller || 'Peer'} ended the call.`);
        endCall(false);
        break;

      case "error":
        console.error("Server error:", data.message);
        alert(`Server: ${data.message}`);
        break;

      default:
        console.warn("Unknown message:", data.type);
    }
  };

  ws.onclose = () => {
    console.warn("🔌 WebSocket closed. Reconnecting...");
    statusMessage.textContent = "Disconnected. Reconnecting...";
    endCall(false); // Clean up any call state
    setTimeout(() => connectWebSocket(), 3000);
  };

  ws.onerror = (err) => {
    console.error("WebSocket error:", err);
    statusMessage.textContent = "Connection error.";
  };
}

function sendSignalingMessage(message) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  } else {
    console.warn("WebSocket not ready. Dropping message:", message.type);
  }
}

// --- UI Functions ---
function handleLogin(savedUser = null) {
  const input = savedUser || document.getElementById("usernameInput")?.value?.trim();
  if (!input) {
    alert("Please enter a username.");
    return;
  }
  username = input;
  if (ws?.readyState === WebSocket.OPEN) {
    sendSignalingMessage({ type: "login", username });
  } else {
    connectWebSocket();
  }
}

function showAppView() {
  loginView.classList.add("hidden");
  appView.classList.remove("hidden");
  loggedUser.textContent = username;
}

function showLoginView() {
  appView.classList.add("hidden");
  loginView.classList.remove("hidden");
  username = '';
  localStorage.removeItem("echoname");
}

function updateUserList(users) {
  userList.innerHTML = "";
  users.forEach(u => {
    if (u.username === username) return;

    const li = document.createElement("li");
    li.textContent = `${u.username}${u.status !== "Available" ? " (Busy)" : ""}`;
    li.className = "user-item";
    
    if (u.status === "Available") {
      li.classList.add("available");
      li.onclick = () => callUser(u.username);
    } else {
      li.classList.add("busy");
      li.style.cursor = "not-allowed";
    }
    userList.appendChild(li);
  });
}

// --- WebRTC Call Logic ---
function createPeerConnection(target) {
  if (peerConnection) {
    peerConnection.close();
  }

  const pc = new RTCPeerConnection(iceServers);

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      sendSignalingMessage({ type: "iceCandidate", target, candidate: e.candidate });
    }
  };

  pc.ontrack = (e) => {
    if (remoteAudio.srcObject !== e.streams[0]) {
      remoteAudio.srcObject = e.streams[0];
    }
    // Start timer on first track (more reliable than connectionstate)
    if (!timerInterval) startCallTimer();
  };

  pc.oniceconnectionstatechange = () => {
    const state = pc.iceConnectionState;
    console.log("ICE state:", state);
    if (state === "failed") {
      alert("Call failed: unable to establish connection.");
      endCall(true);
    }
  };

  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;
    console.log("Connection state:", state);
    if (state === "failed") {
      alert("Call connection failed.");
      endCall(true);
    }
  };

  return pc;
}

async function callUser(target) {
  if (currentCallTarget) {
    alert(`Already in a call with ${currentCallTarget}`);
    return;
  }

  currentCallTarget = target;
  statusMessage.textContent = `Calling ${target}...`;

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (localAudio) localAudio.srcObject = localStream;

    peerConnection = createPeerConnection(target);
    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    sendSignalingMessage({ type: "offer", target, offer });

  } catch (err) {
    console.error("CallCheck error:", err);
    alert("CallCheck failed: " + (err.message || "Microphone access denied"));
    endCall(true);
  }
}

async function onIncomingCall(caller, offer) {
  currentCallTarget = caller;
  incomingCallerName.textContent = `Call from ${caller}`;
  incomingCallModal.classList.remove("hidden");
  ringtone.play().catch(e => console.warn("Ringtone blocked by browser:", e));

  try {
    peerConnection = createPeerConnection(caller);
    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
  } catch (err) {
    console.error("CallCheck offer error:", err);
    sendSignalingMessage({ type: "reject", target: caller, message: "Invalid offer" });
    endCall(false);
  }
}

async function acceptCall() {
  ringtone.pause();
  incomingCallModal.classList.add("hidden");

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (localAudio) localAudio.srcObject = localStream;
    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    sendSignalingMessage({ type: "answer", target: currentCallTarget, answer });

    statusMessage.textContent = `In call with ${currentCallTarget}`;
  } catch (err) {
    console.error("Accept call error:", err);
    alert("Failed to accept call.");
    rejectCall();
  }
}

function rejectCall() {
  ringtone.pause();
  incomingCallModal.classList.add("hidden");
  if (currentCallTarget) {
    sendSignalingMessage({ type: "reject", target: currentCallTarget });
  }
  endCall(false);
}

function hangUp() {
  if (currentCallTarget) {
    sendSignalingMessage({ type: "hangup", target: currentCallTarget });
  }
  endCall(true);
}

function endCall(sendHangup = false) {
  stopCallTimer();

  // Stop local media
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  if (localAudio) localAudio.srcObject = null;
  if (remoteAudio) remoteAudio.srcObject = null;

  // Close peer connection
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }

  // Send hangup only if requested AND still in a call
  if (sendHangup && currentCallTarget) {
    sendSignalingMessage({ type: "hangup", target: currentCallTarget });
  }

  currentCallTarget = null;
  ringtone.pause();
  ringtone.currentTime = 0;
  incomingCallModal.classList.add("hidden");
  statusMessage.textContent = "Ready.";
}

// --- Timer ---
function startCallTimer() {
  callControls.classList.remove("hidden");
  callTimerDisplay.classList.remove("hidden");
  callStartTime = Date.now();
  timerInterval = setInterval(() => {
    const sec = Math.floor((Date.now() - callStartTime) / 1000);
    callTimerDisplay.textContent = `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
  }, 1000);
}

function stopCallTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  callTimerDisplay.textContent = "00:00";
  callTimerDisplay.classList.add("hidden");
  callControls.classList.add("hidden");
}

// --- Event Listeners ---
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("loginForm")?.addEventListener("submit", e => {
    e.preventDefault();
    handleLogin();
  });

  document.getElementById("acceptCallButton")?.addEventListener("click", acceptCall);
  document.getElementById("rejectCallButton")?.addEventListener("click", rejectCall);
  document.getElementById("hangupButton")?.addEventListener("click", hangUp);

  document.getElementById("logoutButton")?.addEventListener("click", () => {
    if (ws) ws.close();
    localStorage.removeItem("echoname");
    endCall(false);
    showLoginView();
  });
});