// app.js (Client-Side WebRTC Application)

// --- Configuration ---
const wsUrl = 'wss://echolinkplus-backend.onrender.com';
let ws;
let localStream = null;
let peerConnection = null;
let username = '';
let currentCallTarget = null;
let callStartTime = null;
let timerInterval = null;

// --- STUN/TURN Configuration ---
const iceServers = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
  ],
  iceTransportPolicy: 'all'
};

// --- DOM Elements ---
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
const muteButton = document.getElementById('muteButton');
const unmuteButton = document.getElementById('unmuteButton');
const loginForm = document.getElementById('loginForm');
const logoutButton = document.getElementById('logoutButton');
const hangupButton = document.getElementById('hangupButton');
const acceptCallButton = document.getElementById('acceptCallButton');
const rejectCallButton = document.getElementById('rejectCallButton');

// --- On Load: Persistent Login ---
window.addEventListener("load", () => {
  const savedUser = localStorage.getItem("echoname");
  if (savedUser) {
    document.getElementById("usernameInput").value = savedUser;
    handleLogin(savedUser);
  } else {
    connectWebSocket(false);
  }

  // DOM Event Listeners
  loginForm?.addEventListener('submit', (e) => {
      e.preventDefault();
      handleLogin();
  });
  logoutButton?.addEventListener('click', showLoginView);
  hangupButton?.addEventListener('click', hangUp);
  muteButton?.addEventListener('click', toggleMute);
  unmuteButton?.addEventListener('click', toggleMute);
  acceptCallButton?.addEventListener('click', acceptCall);
  rejectCallButton?.addEventListener('click', rejectCall);
});

// --- WebSocket Management ---
function connectWebSocket(attemptLoginOnOpen = true) {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    statusMessage.textContent = "Connected to EchoLink+ Server.";
    if (attemptLoginOnOpen) {
      const userToUse = username || localStorage.getItem("echoname");
      if (userToUse) {
        username = userToUse;
        sendSignalingMessage({ type: "login", username });
      }
    }
  };

  ws.onmessage = async (event) => {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }

    switch (data.type) {
      case "loginSuccess":
        username = data.username;
        localStorage.setItem("echoname", username);
        showAppView();
        statusMessage.textContent = `Logged in as ${username}.`;
        break;
      case "loginFailure":
        alert(`Login failed: ${data.message}`);
        username = '';
        localStorage.removeItem("echoname");
        showLoginView();
        break;
      case "userList":
        updateUserList(data.users);
        break;
      case "offer":
        if (currentCallTarget) {
          sendSignalingMessage({ type: "reject", target: data.caller, message: "Busy" });
          return;
        }
        await onIncomingCall(data.caller, data.offer);
        break;
      case "answer":
        if (!peerConnection || currentCallTarget !== data.callee) {
          if (data.callee) sendSignalingMessage({ type: "hangup", target: data.callee });
          endCall(false);
          return;
        }
        await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
        statusMessage.textContent = `In call with ${currentCallTarget}`;
        startCallTimer();
        break;
      case "iceCandidate":
        if (peerConnection && data.candidate) {
          try { await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch {}
        }
        break;
      case "reject":
        alert(`${data.caller || 'Peer'} rejected your call: ${data.message}`);
        endCall(false);
        break;
      case "hangup":
        alert(`${data.caller || 'Peer'} ended the call.`);
        endCall(false);
        break;
    }
  };

  ws.onclose = () => {
    statusMessage.textContent = "Disconnected. Reconnecting...";
    endCall(false);
    setTimeout(() => connectWebSocket(!!username), 3000);
  };
}

function sendSignalingMessage(message) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

// --- UI Functions ---
function handleLogin(savedUser = null) {
  const inputUsername = document.getElementById("usernameInput")?.value?.trim();
  const userToLogin = savedUser || inputUsername;
  if (!userToLogin) return alert("Enter your Echo-Name.");

  username = userToLogin; 
  if (ws?.readyState === WebSocket.OPEN) {
    sendSignalingMessage({ type: "login", username });
  } else {
    connectWebSocket(true);
  }
}

function showAppView() {
  loginView.classList.add("hidden");
  appView.classList.remove("hidden");
  loggedUser.textContent = username || 'Guest';
  muteButton.classList.remove('hidden');
  unmuteButton.classList.add('hidden');
}

function showLoginView() {
  endCall(false);
  appView.classList.add("hidden");
  loginView.classList.remove("hidden");
  loggedUser.textContent = '';
  if (ws?.readyState === WebSocket.OPEN && username) {
      sendSignalingMessage({ type: "logout", username });
  }
  username = '';
  localStorage.removeItem("echoname");
  statusMessage.textContent = "Please login.";
}

// --- Update User List with Call Buttons ---
function updateUserList(users) {
  userList.innerHTML = "";
  let hasOtherUsers = false;
  
  users.forEach(u => {
    if (!username || u.username === username) return;
    hasOtherUsers = true;

    const li = document.createElement("li");
    li.className = "user-item";

    const nameSpan = document.createElement("span");
    nameSpan.textContent = u.username;

    const statusSpan = document.createElement("span");
    statusSpan.className = "status-info";

    const statusDot = document.createElement("span");
    statusDot.className = "status-dot";

    if (u.status === "Available") {
      li.classList.add("available");
      statusDot.style.backgroundColor = 'var(--success-green)';
      const callLink = document.createElement("a");
      callLink.href = "#";
      callLink.textContent = "Call";
      callLink.className = "call-link";
      callLink.onclick = (e) => { e.preventDefault(); callUser(u.username); };
      statusSpan.appendChild(statusDot);
      statusSpan.appendChild(callLink);
    } else {
      li.classList.add("busy");
      statusDot.style.backgroundColor = 'var(--warning-orange)';
      statusSpan.textContent = "Busy";
      statusSpan.prepend(statusDot);
    }

    li.appendChild(nameSpan);
    li.appendChild(statusSpan);
    userList.appendChild(li);
  });

  if (!hasOtherUsers) userList.innerHTML = '<li><p class="placeholder-text">No other users online.</p></li>';
}

// --- WebRTC Functions ---
// callUser, onIncomingCall, acceptCall, rejectCall, hangUp, endCall, createPeerConnection, toggleMute, startCallTimer, stopCallTimer
// (Keep your existing implementations here exactly as in your original code)

