// ============================
// Echo-Link+ Frontend Logic
// ============================

// --- Update this to your Render backend WebSocket URL ---
const WS_URL = "wss://echolinkplus-backend.onrender.com";

let ws;
let localStream;
let peerConnection;
let username = null;
let currentCall = null;
let remoteUser = null;

// STUN server configuration (for WebRTC)
const configuration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

// --- DOM Elements ---
const usernameInput = document.getElementById("usernameInput");
const statusMessage = document.getElementById("status-message");
const loginView = document.getElementById("login-view");
const appView = document.getElementById("app-view");
const userList = document.getElementById("user-list");
const callMessage = document.getElementById("call-message");
const callControls = document.getElementById("call-controls");
const micIndicator = document.getElementById("mic-indicator");
const incomingModal = document.getElementById("incoming-call-modal");
const incomingCallerName = document.getElementById("incoming-caller-name");

// --- Audio Elements ---
const localAudio = document.getElementById("localAudio");
const remoteAudio = document.getElementById("remoteAudio");

// ============================
// LOGIN HANDLER
// ============================
async function handleLogin() {
  // Fix for “Cannot read .value of null”
  if (!usernameInput) {
    console.error("usernameInput element missing in HTML.");
    updateStatus("Internal error: missing username input field.", "error");
    return;
  }

  username = usernameInput.value.trim();

  if (!username) {
    updateStatus("Please enter a valid Echo-Name.", "error");
    return;
  }

  try {
    updateStatus("Connecting to Echo-Link+...", "info");

    // Connect to backend WebSocket server
    ws = new WebSocket(WS_URL);

    ws.onopen = async () => {
      updateStatus("Connected. Initializing microphone...");
      ws.send(JSON.stringify({ type: "login", username: username }));

      // Get microphone access
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localAudio.srcObject = localStream;
      micIndicator.classList.add("active");

      loginView.classList.add("hidden");
      appView.classList.remove("hidden");

      updateStatus("Welcome, " + username + "! Ready to Echo-Link.");
    };

    ws.onmessage = handleMessage;
    ws.onclose = () => updateStatus("Disconnected from server.", "error");
    ws.onerror = (err) => {
      console.error("WebSocket error:", err);
      updateStatus("WebSocket connection failed.", "error");
    };
  } catch (err) {
    console.error(err);
    updateStatus("Failed to access microphone or connect.", "error");
  }
}

// ============================
// WEBSOCKET MESSAGE HANDLER
// ============================
function handleMessage(msg) {
  let data = JSON.parse(msg.data);

  switch (data.type) {
    case "userList": // fixed: matches backend broadcast type
      renderUserList(data.users);
      break;

    case "loginSuccess":
      updateStatus("Login successful.", "success");
      break;

    case "loginFailure":
      updateStatus("Username already taken. Try another.", "error");
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
      updateStatus(`${data.caller} is busy or unavailable.`, "error");
      break;

    case "hangup":
      handleRemoteHangup();
      break;

    default:
      console.log("Unknown message type:", data);
  }
}

// ============================
// USER LIST UI
// ============================
function renderUserList(users) {
  userList.innerHTML = "";
  users
    .filter((u) => u.username !== username)
    .forEach((u) => {
      const li = document.createElement("li");
      li.className = "user-item";
      li.innerHTML = `
        <span>${u.username} - <small>${u.status}</small></span>
        <button class="call-btn" onclick="callUser('${u.username}')">Echo-Link</button>
      `;
      userList.appendChild(li);
    });
}

// ============================
// CALLING ANOTHER USER
// ============================
async function callUser(targetUser) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    updateStatus("Not connected to the server.", "error");
    return;
  }

  remoteUser = targetUser;
  updateStatus(`Echo-Linking with ${targetUser}...`);

  peerConnection = new RTCPeerConnection(configuration);

  // Add local audio
  localStream.getTracks().forEach((track) => {
    peerConnection.addTrack(track, localStream);
  });

  // Remote audio
  peerConnection.ontrack = (event) => {
    remoteAudio.srcObject = event.streams[0];
  };

  // ICE candidates
  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      ws.send(
        JSON.stringify({
          type: "iceCandidate",
          candidate: event.candidate,
          target: targetUser,
        })
      );
    }
  };

  // Create and send offer
  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);

  ws.send(
    JSON.stringify({
      type: "offer",
      offer: offer,
      target: targetUser,
    })
  );

  currentCall = targetUser;
  callControls.classList.remove("hidden");
  updateStatus("Calling " + targetUser + "...");
}

// ============================
// RECEIVING AN OFFER
// ============================
async function handleOffer(offer, callerName) {
  remoteUser = callerName;
  incomingCallerName.textContent = `${callerName} is Echo-Linking you...`;
  incomingModal.classList.remove("hidden");

  window.acceptCall = async function () {
    incomingModal.classList.add("hidden");
    peerConnection = new RTCPeerConnection(configuration);

    localStream.getTracks().forEach((track) => {
      peerConnection.addTrack(track, localStream);
    });

    peerConnection.ontrack = (event) => {
      remoteAudio.srcObject = event.streams[0];
    };

    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        ws.send(
          JSON.stringify({
            type: "iceCandidate",
            candidate: event.candidate,
            target: callerName,
          })
        );
      }
    };

    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);

    ws.send(
      JSON.stringify({
        type: "answer",
        answer: answer,
        target: callerName,
      })
    );

    currentCall = callerName;
    callControls.classList.remove("hidden");
    updateStatus("Connected with " + callerName + ".");
  };

  window.rejectCall = function () {
    incomingModal.classList.add("hidden");
    ws.send(JSON.stringify({ type: "reject", target: callerName }));
    updateStatus("Rejected call from " + callerName + ".", "info");
  };
}

// ============================
// ANSWER HANDLER
// ============================
async function handleAnswer(answer) {
  await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
  updateStatus("Echo-Link connected successfully.");
}

// ============================
// CANDIDATE HANDLER
// ============================
function handleCandidate(candidate) {
  if (candidate && peerConnection) {
    peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
  }
}

// ============================
// HANGUP HANDLERS
// ============================
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
  updateStatus("Remote Echo-Link ended.");
  remoteUser = null;
}

// ============================
// HELPER: Update Status Box
// ============================
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

// --- Optional: Avoid favicon 404 ---
const link = document.createElement("link");
link.rel = "icon";
link.href = "data:,";
document.head.appendChild(link);
