const wsUrl = 'wss://echolinkplus-backend.onrender.com';
let ws, localStream, peerConnection, currentCall = null, username;
let callStartTime, timerInterval;

const servers = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

// Elements
const loginView = document.getElementById("login-view");
const appView = document.getElementById("app-view");
const statusMessage = document.getElementById("status-message");
const loggedUser = document.getElementById("logged-username");
const userList = document.getElementById("user-list");
const ringtone = document.getElementById("ringtone");
const timerDisplay = document.getElementById("call-timer");

// Persistent Login
window.addEventListener("load", () => {
  const savedUser = localStorage.getItem("echoname");
  if (savedUser) {
    document.getElementById("usernameInput").value = savedUser;
    handleLogin();
  }
});

function connectWebSocket() {
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    statusMessage.textContent = "Connected to Echo-Link Server.";
    if (username) ws.send(JSON.stringify({ type: "login", username }));
  };

  ws.onmessage = (msg) => {
    const data = JSON.parse(msg.data);
    switch (data.type) {
      case "loginSuccess":
        showAppView();
        break;
      case "loginFailure":
        alert(data.message);
        break;
      case "userList":
        updateUserList(data.users);
        break;
      case "offer":
        onIncomingCall(data.caller, data.offer);
        break;
      case "answer":
        peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
        break;
      case "iceCandidate":
        peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
        break;
      case "reject":
      case "hangup":
        endCall();
        break;
    }
  };

  ws.onclose = () => {
    statusMessage.textContent = "Disconnected. Reconnecting...";
    setTimeout(connectWebSocket, 2000);
  };

  ws.onerror = (err) => console.error("WebSocket Error:", err);
}

function handleLogin() {
  username = document.getElementById("usernameInput").value.trim();
  if (!username) return alert("Enter a valid Echo-Name.");

  localStorage.setItem("echoname", username);
  connectWebSocket();
}

function showAppView() {
  loginView.classList.add("hidden");
  appView.classList.remove("hidden");
  loggedUser.textContent = username;
  statusMessage.textContent = `Logged in as ${username}`;
}

function updateUserList(users) {
  userList.innerHTML = "";
  users.forEach(u => {
    if (u.username !== username) {
      const li = document.createElement("li");
      li.textContent = `${u.username}${u.status !== "Available" ? " (in call)" : ""}`;
      li.className = "user-item";
      if (u.status === "Available") {
        li.onclick = () => callUser(u.username);
      } else {
        li.style.opacity = 0.5;
      }
      userList.appendChild(li);
    }
  });
}

async function callUser(target) {
  currentCall = target;
  peerConnection = createPeerConnection(target);

  localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);

  ws.send(JSON.stringify({ type: "offer", target, offer }));
  statusMessage.textContent = `Calling ${target}...`;
}

function onIncomingCall(caller, offer) {
  currentCall = caller;
  document.getElementById("incoming-caller-name").textContent = `Incoming call from ${caller}`;
  document.getElementById("incoming-call-modal").classList.remove("hidden");
  ringtone.play();

  peerConnection = createPeerConnection(caller);
  peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
}

async function acceptCall() {
  ringtone.pause();
  document.getElementById("incoming-call-modal").classList.add("hidden");

  localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);

  ws.send(JSON.stringify({ type: "answer", target: currentCall, answer }));
  startTimer();
}

function rejectCall() {
  ringtone.pause();
  document.getElementById("incoming-call-modal").classList.add("hidden");
  ws.send(JSON.stringify({ type: "reject", target: currentCall }));
  currentCall = null;
}

function createPeerConnection(target) {
  const pc = new RTCPeerConnection(servers);

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      ws.send(JSON.stringify({ type: "iceCandidate", target, candidate: e.candidate }));
    }
  };

  pc.ontrack = (e) => {
    document.getElementById("remoteAudio").srcObject = e.streams[0];
    startTimer();
  };

  return pc;
}

function hangUp() {
  if (currentCall) {
    ws.send(JSON.stringify({ type: "hangup", target: currentCall }));
  }
  endCall();
}

function endCall() {
  if (peerConnection) peerConnection.close();
  peerConnection = null;
  currentCall = null;
  stopTimer();
  statusMessage.textContent = "Call ended.";
}

function startTimer() {
  const callControls = document.getElementById("call-controls");
  callControls.classList.remove("hidden");
  timerDisplay.classList.remove("hidden");

  callStartTime = Date.now();
  timerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - callStartTime) / 1000);
    const m = String(Math.floor(elapsed / 60)).padStart(2, "0");
    const s = String(elapsed % 60).padStart(2, "0");
    timerDisplay.textContent = `${m}:${s}`;
  }, 1000);
}

function stopTimer() {
  clearInterval(timerInterval);
  timerDisplay.textContent = "00:00";
  timerDisplay.classList.add("hidden");
  document.getElementById("call-controls").classList.add("hidden");
}