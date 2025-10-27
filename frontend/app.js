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

// --- CRITICAL: STUN/TURN Configuration ---
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
    console.log("✅ WebSocket connected.");
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
    const shouldAttemptLogin = !!username; 
    setTimeout(() => connectWebSocket(shouldAttemptLogin), 3000);
  };
}

function sendSignalingMessage(message) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  } else {
    console.warn("Attempted to send signaling message while WebSocket is closed or closing.");
  }
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

// --- Update User List with Call Buttons (FIXED FILTERING) ---
function updateUserList(users) {
  userList.innerHTML = "";
  let hasOtherUsers = false;
  
  users.forEach(u => {
    const peerUsername = u.username;
    // CRITICAL FIX: Robust check to exclude the current user and invalid names
    if (!peerUsername || peerUsername === username || peerUsername === 'undefined') return; 

    hasOtherUsers = true;

    const li = document.createElement("li");
    li.className = "user-item";

    const nameSpan = document.createElement("span");
    nameSpan.textContent = peerUsername;

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
      callLink.onclick = (e) => { e.preventDefault(); callUser(peerUsername); };
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

// --- WebRTC Helper Functions (Integrated for Completeness) ---

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
    if (!timerInterval) startCallTimer();
  };

  pc.oniceconnectionstatechange = () => {
    const state = pc.iceConnectionState;
    statusMessage.textContent = `ICE state: ${state}`;
    if (state === "failed" || state === "disconnected") {
      console.warn(`Call disconnected due to network issues. ICE State: ${state}`);
      // Only end call if we have a target, to avoid false positives during setup
      if (currentCallTarget) endCall(true); 
    }
  };

  pc.onnegotiationneeded = async () => {
      if (!currentCallTarget || !username) return;
      try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          sendSignalingMessage({ type: "offer", target: currentCallTarget, offer: pc.localDescription });
          statusMessage.textContent = `Re-negotiating with ${currentCallTarget}...`;
      } catch (e) {
          statusMessage.textContent = "Call renegotiation failed.";
      }
  };

  return pc;
}

async function callUser(target) {
  if (currentCallTarget) {
    alert(`You are already in a call or attempting to call ${currentCallTarget}.`);
    return;
  }
  if (!username) {
      alert("Please log in first to make a call.");
      return;
  }

  currentCallTarget = target;
  statusMessage.textContent = `Calling ${target}...`;

  try {
    // Get local audio stream
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (localAudio) localAudio.srcObject = localStream;
    localStream.getAudioTracks().forEach(track => track.enabled = true); 

    peerConnection = createPeerConnection(target);
    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

    // Create and send offer
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    sendSignalingMessage({ type: "offer", target, offer: peerConnection.localDescription });

  } catch (err) {
    alert("Call failed: " + (err.message || "Microphone access denied."));
    endCall(true);
  }
}

async function onIncomingCall(caller, offer) {
  currentCallTarget = caller;
  incomingCallerName.textContent = `Incoming call from ${caller}`;
  incomingCallModal.classList.remove("hidden");
  ringtone.play().catch(e => console.warn("Ringtone blocked by browser (autoplay policy):", e));
  statusMessage.textContent = `Incoming call from ${caller}`;

  try {
    peerConnection = createPeerConnection(caller);
    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
  } catch (err) {
    statusMessage.textContent = "Error with incoming call.";
    sendSignalingMessage({ type: "reject", target: caller, message: "Offer processing failed" });
    endCall(false);
  }
}

async function acceptCall() {
  ringtone.pause();
  ringtone.currentTime = 0;
  incomingCallModal.classList.add("hidden");

  if (!currentCallTarget) {
    statusMessage.textContent = "Error: no incoming call to accept.";
    return;
  }

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (localAudio) localAudio.srcObject = localStream;
    localStream.getAudioTracks().forEach(track => track.enabled = true);
    
    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    sendSignalingMessage({ type: "answer", target: currentCallTarget, answer });

    statusMessage.textContent = `In call with ${currentCallTarget}`;
    startCallTimer();
  } catch (err) {
    alert("Failed to accept call. Please check microphone access.");
    rejectCall();
  }
}

function rejectCall() {
  ringtone.pause();
  ringtone.currentTime = 0;
  incomingCallModal.classList.add("hidden");
  
  if (currentCallTarget) {
    sendSignalingMessage({ type: "reject", target: currentCallTarget, message: "User rejected call." });
  }
  endCall(false);
  statusMessage.textContent = "Call rejected.";
}

function hangUp() {
  if (currentCallTarget) {
    sendSignalingMessage({ type: "hangup", target: currentCallTarget, message: "User hung up." });
  }
  endCall(true);
  statusMessage.textContent = "Call ended.";
}

function endCall(sendHangupSignal = false) {
  stopCallTimer();

  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
    if (localAudio) localAudio.srcObject = null;
  }
  if (remoteAudio) {
    remoteAudio.srcObject = null;
  }

  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }

  if (currentCallTarget && sendHangupSignal) {
    sendSignalingMessage({ type: "hangup", target: currentCallTarget, message: "User hung up." });
  }

  currentCallTarget = null;
  ringtone.pause();
  ringtone.currentTime = 0;
  incomingCallModal.classList.add("hidden");
  
  if (muteButton) muteButton.classList.remove('hidden');
  if (unmuteButton) unmuteButton.classList.add('hidden');

  statusMessage.textContent = "Ready.";
}

function startCallTimer() {
  callControls.classList.remove("hidden");
  callTimerDisplay.classList.remove("hidden");
  
  if (timerInterval) clearInterval(timerInterval);

  callStartTime = Date.now();
  timerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - callStartTime) / 1000);
    const m = String(Math.floor(elapsed / 60)).padStart(2, "0");
    const s = String(elapsed % 60).padStart(2, "0");
    callTimerDisplay.textContent = `${m}:${s}`;
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

function toggleMute() {
    if (!localStream) {
        statusMessage.textContent = "No active microphone.";
        return;
    }

    const audioTracks = localStream.getAudioTracks();
    if (audioTracks.length === 0) {
        statusMessage.textContent = "No audio input available.";
        return;
    }
    
    // Check the first audio track's enabled state
    const currentlyMuted = !audioTracks[0].enabled;
    const newState = !currentlyMuted;
    
    audioTracks.forEach(track => track.enabled = newState);

    if (newState) {
        muteButton.classList.remove('hidden');
        unmuteButton.classList.add('hidden');
        statusMessage.textContent = "Microphone ON";
    } else {
        muteButton.classList.add('hidden');
        unmuteButton.classList.remove('hidden');
        statusMessage.textContent = "Microphone MUTED";
    }
}
