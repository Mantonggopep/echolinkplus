// frontend/app.js

let localStream;
let peerConnection;
let ws;
let username;
let targetUser;

const servers = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

async function initMedia() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    document.getElementById("localAudio").srcObject = localStream;
  } catch (err) {
    console.error("Media error:", err);
  }
}

function connectWebSocket() {
  // Use your Render backend domain here:
  ws = new WebSocket("wss://echolinkplus-backend.onrender.com");

  ws.onopen = () => {
    console.log("Connected to signaling server");
  };

  ws.onmessage = (msg) => {
    const data = JSON.parse(msg.data);
    console.log("Received:", data);

    switch (data.type) {
      case "userList":
      case "update-user-list":
        renderUserList(
          data.users.map((u) => (typeof u === "string" ? u : u.username))
        );
        break;

      case "offer":
        handleOffer(data.offer, data.from);
        break;

      case "answer":
        handleAnswer(data.answer);
        break;

      case "iceCandidate":
        handleCandidate(data.candidate);
        break;

      default:
        console.warn("Unknown message type:", data.type);
    }
  };

  ws.onerror = (err) => console.error("WebSocket error:", err);
}

function handleLogin() {
  username = document.getElementById("username").value.trim();
  if (!username) return alert("Enter a username first!");

  ws.send(JSON.stringify({ type: "login", username }));
}

function renderUserList(users) {
  const list = document.getElementById("users");
  list.innerHTML = "";
  users
    .filter((u) => u !== username)
    .forEach((user) => {
      const li = document.createElement("li");
      li.textContent = user;
      li.onclick = () => initiateCall(user);
      list.appendChild(li);
    });
}

async function initiateCall(user) {
  targetUser = user;
  peerConnection = new RTCPeerConnection(servers);
  localStream.getTracks().forEach((track) =>
    peerConnection.addTrack(track, localStream)
  );

  peerConnection.ontrack = (event) => {
    document.getElementById("remoteAudio").srcObject = event.streams[0];
  };

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

  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);

  ws.send(
    JSON.stringify({
      type: "offer",
      offer: offer,
      target: targetUser,
      from: username,
    })
  );
}

async function handleOffer(offer, from) {
  targetUser = from;
  peerConnection = new RTCPeerConnection(servers);
  localStream.getTracks().forEach((track) =>
    peerConnection.addTrack(track, localStream)
  );

  peerConnection.ontrack = (event) => {
    document.getElementById("remoteAudio").srcObject = event.streams[0];
  };

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

  await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);

  ws.send(
    JSON.stringify({
      type: "answer",
      answer: answer,
      target: targetUser,
    })
  );
}

function handleAnswer(answer) {
  peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
}

function handleCandidate(candidate) {
  peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
}

window.addEventListener("load", async () => {
  await initMedia();
  connectWebSocket();
  document
    .getElementById("loginBtn")
    .addEventListener("click", handleLogin);
});
