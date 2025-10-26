let ws;
let localStream;
let peerConnection;
let username;
let targetUser;

const wsUrl = "wss://echolinkplus-backend.onrender.com"; // your Render backend

function handleLogin() {
  username = document.getElementById("username").value.trim();
  if (!username) {
    alert("Enter a username");
    return;
  }

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log("Connected to signaling server");
    ws.send(JSON.stringify({ type: "login", username }));
  };

  ws.onmessage = (msg) => {
    const data = JSON.parse(msg.data);
    switch (data.type) {
      case "update-user-list":
        renderUserList(data.users);
        break;
      case "offer":
        handleOffer(data.offer, data.username);
        break;
      case "answer":
        handleAnswer(data.answer);
        break;
      case "candidate":
        handleCandidate(data.candidate);
        break;
    }
  };

  ws.onerror = (err) => {
    console.error("WebSocket error:", err);
  };
}

function renderUserList(users) {
  const list = document.getElementById("userList");
  list.innerHTML = "";
  users.forEach((user) => {
    if (user !== username) {
      const li = document.createElement("li");
      li.textContent = user;
      li.onclick = () => startCall(user);
      list.appendChild(li);
    }
  });
}

async function startCall(user) {
  targetUser = user;
  await setupPeerConnection();

  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);

  ws.send(
    JSON.stringify({
      type: "offer",
      offer,
      target: targetUser,
      username,
    })
  );
}

async function handleOffer(offer, user) {
  targetUser = user;
  await setupPeerConnection();

  await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);

  ws.send(
    JSON.stringify({
      type: "answer",
      answer,
      target: targetUser,
      username,
    })
  );
}

async function handleAnswer(answer) {
  await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
}

function handleCandidate(candidate) {
  peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
}

async function setupPeerConnection() {
  peerConnection = new RTCPeerConnection();

  peerConnection.onicecandidate = ({ candidate }) => {
    if (candidate) {
      ws.send(
        JSON.stringify({
          type: "candidate",
          candidate,
          target: targetUser,
          username,
        })
      );
    }
  };

  peerConnection.ontrack = (event) => {
    document.getElementById("remoteAudio").srcObject = event.streams[0];
  };

  localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  localStream.getTracks().forEach((track) => peerConnection.addTrack(track, localStream));
  document.getElementById("localAudio").srcObject = localStream;
}

document.getElementById("loginBtn").onclick = handleLogin;
