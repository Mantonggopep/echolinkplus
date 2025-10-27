// app.js (Client-Side WebRTC Application)

// --- Configuration ---
const wsUrl = 'wss://echolinkplus-backend.onrender.com'; // Use WSS in production
let ws;
let localStream = null;
let peerConnection = null;
let username = ''; // Initialize username as empty
let currentCallTarget = null;
let callStartTime = null;
let timerInterval = null;

// --- CRITICAL: STUN/TURN Configuration ---
// ⚠️ REPLACE PLACEHOLDERS WITH YOUR ACTUAL TURN SERVER CREDENTIALS
const iceServers = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    // Add your TURN server(s) here — essential for NAT traversal
    // ...
  ],
  iceTransportPolicy: 'all'
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
const muteButton = document.getElementById('muteButton');
const unmuteButton = document.getElementById('unmuteButton');
const loginForm = document.getElementById('loginForm');
const logoutButton = document.getElementById('logoutButton');
const hangupButton = document.getElementById('hangupButton');
const acceptCallButton = document.getElementById('acceptCallButton');
const rejectCallButton = document.getElementById('rejectCallButton');


// --- On Load: Try Persistent Login & Initial WebSocket Connect ---
window.addEventListener("load", () => {
  const savedUser = localStorage.getItem("echoname");
  if (savedUser) {
    document.getElementById("usernameInput").value = savedUser;
    handleLogin(savedUser); // Attempt to log in with saved user
  } else {
    connectWebSocket(false); // Just connect, don't attempt login
  }

  // --- Initialize DOM Event Listeners ---
  if (loginForm) {
      loginForm.addEventListener('submit', (e) => {
          e.preventDefault();
          handleLogin();
      });
  }
  if (logoutButton) logoutButton.addEventListener('click', showLoginView);
  if (hangupButton) hangupButton.addEventListener('click', hangUp);
  if (muteButton) muteButton.addEventListener('click', toggleMute);
  if (unmuteButton) unmuteButton.addEventListener('click', toggleMute);
  if (acceptCallButton) acceptCallButton.addEventListener('click', acceptCall);
  if (rejectCallButton) rejectCallButton.addEventListener('click', rejectCall);
});

// --- WebSocket Management ---
function connectWebSocket(attemptLoginOnOpen = true) {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    console.log("WebSocket already open or connecting.");
    return;
  }

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log("✅ WebSocket connected.");
    statusMessage.textContent = "Connected to EchoLink+ Server.";
    
    // Attempt to log in if flag is set OR if a username was persisted but not yet set
    if (attemptLoginOnOpen) {
      const userToUse = username || localStorage.getItem("echoname");
      if (userToUse) {
        username = userToUse; // Ensure global state is set before sending
        sendSignalingMessage({ type: "login", username });
      }
    }
  };

  ws.onmessage = async (event) => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch (e) {
      console.error("❌ Invalid JSON from server:", event.data, e);
      statusMessage.textContent = "Error: Invalid server message.";
      return;
    }

    console.log("📥 Signaling:", data.type, data);

    switch (data.type) {
      case "loginSuccess":
        username = data.username; 
        localStorage.setItem("echoname", username);
        showAppView(); // Update UI with successful login
        statusMessage.textContent = `Logged in as ${username}.`;
        break;

      case "loginFailure":
        alert(`Login failed: ${data.message}`);
        statusMessage.textContent = "Login failed. Please try again.";
        username = '';
        localStorage.removeItem("echoname"); 
        showLoginView();
        break;

      case "userList":
        updateUserList(data.users);
        break;

      case "offer":
        if (currentCallTarget) {
          console.warn(`Ignoring offer from ${data.caller}: already in a call or ringing.`);
          sendSignalingMessage({ type: "reject", target: data.caller, message: "Busy" });
          return;
        }
        await onIncomingCall(data.caller, data.offer);
        break;

      case "answer":
        if (!peerConnection || currentCallTarget !== data.callee) {
          console.warn("Received answer without active call or for wrong peer.");
          if (data.callee) sendSignalingMessage({ type: "hangup", target: data.callee, message: "Invalid state" });
          endCall(false);
          return;
        }
        try {
          await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
          console.log("✅ Call established with answer.");
          statusMessage.textContent = `In call with ${currentCallTarget}`;
          startCallTimer();
        } catch (e) {
          console.error("❌ Failed to set remote answer:", e);
          statusMessage.textContent = "Error establishing call.";
          endCall(true);
        }
        break;

      case "iceCandidate":
        if (peerConnection && data.candidate) {
          try {
            await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
            console.log("Added remote ICE candidate.");
          } catch (e) {
            console.warn("ICE candidate error (may be harmless or late):", e.message, e);
          }
        } else {
            console.warn("Received ICE candidate but no active peerConnection or invalid candidate.");
        }
        break;

      case "reject":
        alert(`${data.caller || 'Peer'} rejected your call: ${data.message || 'No reason given.'}`);
        endCall(false);
        break;

      case "hangup":
        alert(`${data.caller || 'Peer'} ended the call.`);
        endCall(false);
        break;

      case "error":
        console.error("❌ Server error:", data.message);
        alert(`Server error: ${data.message}`);
        break;

      default:
        console.warn("Unknown signaling message type:", data.type, data);
    }
  };

  ws.onclose = () => {
    console.warn("🔌 WebSocket closed. Reconnecting in 3 seconds...");
    statusMessage.textContent = "Disconnected. Reconnecting...";
    endCall(false);
    const shouldAttemptLogin = !!username; 
    setTimeout(() => connectWebSocket(shouldAttemptLogin), 3000);
  };

  ws.onerror = (err) => {
    console.error("❌ WebSocket error:", err);
    statusMessage.textContent = "Connection error. Check console.";
  };
}

// Sends a signaling message if WebSocket is open
function sendSignalingMessage(message) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
    console.log("⬆️ Sent signaling:", message.type);
  } else {
    console.warn("WebSocket not open. Dropping message:", message.type);
    statusMessage.textContent = "Not connected to server.";
  }
}

// --- UI Functions ---
function handleLogin(savedUser = null) {
  const inputUsername = document.getElementById("usernameInput")?.value?.trim();
  const userToLogin = savedUser || inputUsername;

  if (!userToLogin) {
    alert("Please enter your Echo-Name.");
    return;
  }
  
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
  loggedUser.textContent = username || 'Guest'; // FIX: Display confirmed username
  muteButton.classList.remove('hidden');
  unmuteButton.classList.add('hidden');
}

function showLoginView() {
  appView.classList.add("hidden");
  loginView.classList.remove("hidden");
  loggedUser.textContent = '';
  // Send logout signal to server before clearing local state
  if (ws?.readyState === WebSocket.OPEN && username) {
      sendSignalingMessage({ type: "logout", username: username });
  }
  username = '';
  localStorage.removeItem("echoname");
  statusMessage.textContent = "Please login.";
}

// FIX: Update function to show 'Call' link and exclude the logged-in user
function updateUserList(users) {
  userList.innerHTML = "";
  if (!users || users.length === 0) {
      userList.innerHTML = '<li><p class="placeholder-text">No other users online.</p></li>';
      return;
  }
  
  let hasOtherUsers = false;
  
  users.forEach(u => {
    // FIX: Skip the current user and users with no defined username
    if (!username || u.username === username) return;
    
    hasOtherUsers = true;

    const li = document.createElement("li");
    li.className = "user-item";
    
    const usernameSpan = document.createElement("span");
    usernameSpan.textContent = u.username;
    
    const statusInfoSpan = document.createElement("span");
    statusInfoSpan.className = "status-info";
    
    const statusDot = document.createElement("span");
    statusDot.className = "status-dot";

    if (u.status === "Available") {
      li.classList.add("available");
      statusDot.style.backgroundColor = 'var(--success-green)'; 
      
      // FIX: Create clickable 'Call' link
      const callLink = document.createElement("a");
      callLink.href = "#";
      callLink.textContent = "Call";
      callLink.className = "call-link";
      callLink.onclick = (e) => {
          e.preventDefault();
          callUser(u.username);
      };

      statusInfoSpan.appendChild(statusDot);
      statusInfoSpan.appendChild(callLink);

    } else {
      li.classList.add("busy");
      li.style.cursor = "not-allowed";
      statusDot.style.backgroundColor = 'var(--warning-orange)';
      statusInfoSpan.textContent = "Busy";
      statusInfoSpan.prepend(statusDot);
    }
    
    li.appendChild(usernameSpan);
    li.appendChild(statusInfoSpan);
    userList.appendChild(li);
  });
  
  if (!hasOtherUsers) {
      userList.innerHTML = '<li><p class="placeholder-text">No other users online.</p></li>';
  }
}

// --- WebRTC Call Logic (Only essential functions included) ---

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
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (localAudio) localAudio.srcObject = localStream;
    localStream.getAudioTracks().forEach(track => track.enabled = true); 
    muteButton.classList.remove('hidden');
    unmuteButton.classList.add('hidden');

    peerConnection = createPeerConnection(target);
    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    sendSignalingMessage({ type: "offer", target, offer });

  } catch (err) {
    console.error("❌ Error starting call:", err);
    alert("Call failed: " + (err.message || "Microphone access denied."));
    endCall(true);
  }
}
// [ ... other WebRTC functions like createPeerConnection, onIncomingCall, acceptCall, rejectCall, hangUp, endCall, startCallTimer, stopCallTimer, toggleMute ... ]
// (Assuming these large blocks remain unchanged from the previous complete version for brevity)

// Place the full implementations of the following functions here:
// createPeerConnection, onIncomingCall, acceptCall, rejectCall, hangUp, endCall, startCallTimer, stopCallTimer, toggleMute
// ... 

// --- WebRTC Call Logic (Continued - Paste the rest of the WebRTC functions here) ---

function createPeerConnection(target) {
  if (peerConnection) {
    console.warn("Closing existing peer connection before creating a new one.");
    peerConnection.close();
  }

  const pc = new RTCPeerConnection(iceServers);

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      sendSignalingMessage({ type: "iceCandidate", target, candidate: e.candidate });
      console.log("Generated ICE candidate.");
    } else {
      console.log("All ICE candidates generated.");
    }
  };

  pc.ontrack = (e) => {
    console.log("Remote track received:", e.track);
    if (remoteAudio.srcObject !== e.streams[0]) {
      remoteAudio.srcObject = e.streams[0];
      console.log("Attached remote stream to audio element.");
    }
    if (!timerInterval) startCallTimer();
  };

  pc.oniceconnectionstatechange = () => {
    const state = pc.iceConnectionState;
    console.log("ICE connection state changed:", state);
    statusMessage.textContent = `ICE state: ${state}`;
    if (state === "failed" || state === "disconnected") {
      console.error(`CallCheck: ICE connection ${state}. Attempting graceful end.`);
      alert(`Call disconnected due to network issues.`);
      endCall(true);
    }
  };

  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;
    console.log("WebRTC connection state changed:", state);
    statusMessage.textContent = `Connection state: ${state}`;
    if (state === "connected") {
        console.log("✅ WebRTC connection fully established!");
        if (!timerInterval) startCallTimer();
    } else if (state === "failed" || state === "disconnected") {
        console.error(`CallCheck: WebRTC connection ${state}. Attempting graceful end.`);
        if (currentCallTarget) {
            alert(`Call to ${currentCallTarget} disconnected.`);
            endCall(false);
        }
    }
  };

  pc.onnegotiationneeded = async () => {
      console.log("Negotiation needed. Creating offer for renegotiation.");
      if (!currentCallTarget || !username) {
          console.warn('Negotiation needed but no current call target or username. Ignoring.');
          return;
      }
      try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          sendSignalingMessage({ type: "offer", target: currentCallTarget, offer: pc.localDescription });
          statusMessage.textContent = `Re-negotiating with ${currentCallTarget}...`;
          console.log("Sent offer for renegotiation.");
      } catch (e) {
          console.error("❌ Error during renegotiation:", e);
          statusMessage.textContent = "Call renegotiation failed.";
      }
  };

  return pc;
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
    console.error("❌ Error processing incoming offer:", err);
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
    console.error("❌ No current call target to accept.");
    statusMessage.textContent = "Error: no incoming call to accept.";
    return;
  }

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (localAudio) localAudio.srcObject = localStream;
    localStream.getAudioTracks().forEach(track => track.enabled = true);
    muteButton.classList.remove('hidden');
    unmuteButton.classList.add('hidden');

    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    sendSignalingMessage({ type: "answer", target: currentCallTarget, answer });

    statusMessage.textContent = `In call with ${currentCallTarget}`;
    startCallTimer();
  } catch (err) {
    console.error("❌ Error accepting call:", err);
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
