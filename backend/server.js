// app.js (Client-Side WebRTC Application)

// --- Configuration ---
// Use WSS for production deployment
const wsUrl = 'wss://echolinkplus-backend.onrender.com';
let ws, localStream = null, peerConnection = null, currentCallTarget = null, username = '';
let callStartTime = null, timerInterval = null;

// --- CRITICAL: STUN/TURN Configuration ---
// This is essential for NAT traversal and connecting users on different networks.
const iceServers = {
  iceServers: [
    // Google's public STUN servers are reliable for initial connection discovery.
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    // For production, especially for users behind strict firewalls or in different regions,
    // you will need your own TURN server credentials.
    // {
    //   urls: 'turn:your-turn-server.com:3478?transport=udp',
    //   username: 'your_username',
    //   credential: 'your_credential'
    // },
    // {
    //   urls: 'turns:your-turn-server.com:443?transport=tcp',
    //   username: 'your_username',
    //   credential: 'your_credential'
    // }
  ],
  // 'all' allows both direct P2P and relayed connections via TURN if needed.
  iceTransportPolicy: 'all'
};

// --- DOM Elements (Cached for Performance) ---
const loginView = document.getElementById("login-view");
const appView = document.getElementById("app-view");
const statusMessage = document.getElementById("status-message");
const loggedUser = document.getElementById("logged-username");
const userList = document.getElementById("user-list");
const ringtone = document.getElementById("ringtone");
const remoteAudio = document.getElementById("remoteAudio");
const localAudio = document.getElementById("localAudio"); // Optional: for self-monitoring
const callControls = document.getElementById("call-controls");
const incomingCallModal = document.getElementById("incoming-call-modal");
const incomingCallerName = document.getElementById("incoming-caller-name");
const callTimerDisplay = document.getElementById("call-timer");

// --- Persistent Login on Page Load ---
window.addEventListener("load", () => {
  const savedUser = localStorage.getItem("echoname");
  if (savedUser) {
    document.getElementById("usernameInput").value = savedUser;
    // Attempt login with the saved username if WebSocket is ready or connect first.
    handleLogin(savedUser);
  } else {
    // Connect WebSocket early so it's ready when the user submits the login form
    connectWebSocket();
  }
});

// --- WebSocket Connection Management ---
function connectWebSocket() {
  // Prevent creating duplicate connections if one is already open/connecting
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    console.log("WebSocket already connected or connecting.");
    return;
  }

  console.log("Connecting to WebSocket server...");
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log("✅ WebSocket connected.");
    statusMessage.textContent = "Connected to EchoLink+ Server.";
    // If the user was already logged in previously (e.g., after a reconnect),
    // send the login message again to re-authenticate with the server.
    if (username) {
      sendSignalingMessage({ type: "login", username });
    }
  };

  ws.onmessage = async (event) => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch (e) {
      console.error("❌ Invalid JSON received from server:", event.data);
      statusMessage.textContent = "Error: Invalid data received.";
      return; // Ignore malformed messages
    }

    console.log("📥 Received signaling message:", data);

    switch (data.type) {
      case "loginSuccess":
        username = data.username; // Confirm username from server (could be sanitized)
        localStorage.setItem("echoname", username); // Persist confirmed username
        showAppView();
        statusMessage.textContent = `Logged in as ${username}.`;
        break;

      case "loginFailure":
        alert(`Login failed: ${data.message}`);
        statusMessage.textContent = "Login failed.";
        username = ''; // Clear local username state
        showLoginView(); // Return to login screen
        break;

      case "userList":
        updateUserList(data.users);
        break;

      case "offer":
        // Prevent multiple incoming calls simultaneously
        if (currentCallTarget) {
          console.warn("Already in a call. Rejecting incoming offer from", data.caller);
          sendSignalingMessage({ type: "reject", target: data.caller, message: "Busy" });
          return;
        }
        await onIncomingCall(data.caller, data.offer);
        break;

      case "answer":
        // Ensure we are expecting an answer for an active call
        if (!peerConnection || !currentCallTarget) {
          console.warn("Received answer, but no active call or peer connection.");
          // Optionally, send a hangup to the sender if the target is known
          if (data.callee) {
            sendSignalingMessage({ type: "hangup", target: data.callee });
          }
          endCall(false); // Clean up local state
          return;
        }
        try {
          await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
          console.log("✅ Answer received and set. Call established!");
          startCallTimer(); // Start timer when answer is received and set
          statusMessage.textContent = `In call with ${currentCallTarget}`;
        } catch (err) {
          console.error("❌ Error setting remote answer:", err);
          statusMessage.textContent = "Error establishing call.";
          endCall(true); // Attempt to hang up gracefully
        }
        break;

      case "iceCandidate":
        if (peerConnection && data.candidate) {
          try {
            await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
            console.log("✅ ICE candidate added.");
          } catch (err) {
            // This can happen if the candidate arrives after the connection is closed.
            // It's usually safe to ignore.
            console.warn("⚠️ Error adding received ICE candidate:", err);
          }
        } else {
          console.warn("Received ICE candidate but no active peer connection or invalid candidate.");
        }
        break;

      case "reject":
        alert(`Call to ${currentCallTarget} was rejected: ${data.message || 'No reason given.'}`);
        endCall(false); // End call locally, no need to send hangup back
        break;

      case "hangup":
        const callerName = data.caller || 'Peer';
        alert(`${callerName} ended the call.`);
        endCall(false); // End call locally, no need to send hangup back
        break;

      case "error":
        console.error("Server sent an error:", data.message);
        alert(`Server Error: ${data.message}`);
        // Depending on the error, you might want to logout or just show the message
        statusMessage.textContent = `Server Error: ${data.message}`;
        break;

      default:
        console.warn("Unknown signaling message type received:", data.type);
        // Optionally send an error back to the server
        // sendSignalingMessage({ type: 'error', message: `Unknown type: ${data.type}` });
    }
  };

  ws.onclose = () => {
    console.warn("🔌 WebSocket connection closed.");
    statusMessage.textContent = "Disconnected from server. Reconnecting...";
    // Clean up any active call state as the connection is lost
    endCall(false); // Don't send hangup signal as the connection is already closed
    // Attempt to reconnect after a delay
    setTimeout(() => {
        console.log("Attempting to reconnect...");
        connectWebSocket();
    }, 3000); // 3 second delay before reconnect
  };

  ws.onerror = (err) => {
    console.error("WebSocket error occurred:", err);
    // The onclose event will usually follow an error
    statusMessage.textContent = "WebSocket connection error.";
  };
}

// Helper function to send signaling messages
function sendSignalingMessage(message) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
    console.log("📤 Sent signaling message:", message);
  } else {
    console.warn("WebSocket is not open. Cannot send message:", message.type);
    statusMessage.textContent = "Not connected to signaling server.";
    // You might want to queue the message or inform the user
  }
}

// --- UI State Management ---
function handleLogin(savedUser = null) {
  // Use the saved user if provided, otherwise get from the input field
  const inputUsername = savedUser || document.getElementById("usernameInput").value.trim();

  if (!inputUsername) {
    alert("Please enter a valid Echo-Name.");
    return;
  }

  username = inputUsername; // Set the global username variable

  // Connect WebSocket if not already connected, then send login
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    connectWebSocket();
    // The login message will be sent in the `onopen` handler
  } else {
    // WebSocket is already open, send login immediately
    sendSignalingMessage({ type: "login", username });
  }
}

function showAppView() {
  loginView.classList.add("hidden");
  appView.classList.remove("hidden");
  loggedUser.textContent = username; // Update the logged-in user display
  statusMessage.textContent = `Logged in as ${username}.`;
}

function showLoginView() {
  appView.classList.add("hidden");
  loginView.classList.remove("hidden");
  loggedUser.textContent = ''; // Clear the logged-in user display
  username = ''; // Clear the username variable
  localStorage.removeItem("echoname"); // Clear the saved username
  // Optionally clear the input field
  document.getElementById("usernameInput").value = '';
}

function updateUserList(users) {
  userList.innerHTML = ""; // Clear the current list

  users.forEach(user => {
    // Don't list the current user
    if (user.username === username) {
      return;
    }

    const li = document.createElement("li");
    li.textContent = `${user.username}${user.status !== "Available" ? " (Busy)" : ""}`;
    li.className = "user-item";

    if (user.status === "Available") {
      li.classList.add("available");
      li.onclick = () => {
          if (!currentCallTarget) { // Only allow calling if not already in a call
              callUser(user.username);
          } else {
              alert(`You are already in a call with ${currentCallTarget}.`);
          }
      };
    } else {
      li.classList.add("busy");
      li.style.cursor = "not-allowed"; // Indicate unclickable
      li.style.opacity = 0.6; // Visually indicate busy
    }
    userList.appendChild(li);
  });
}

// --- WebRTC Call Logic ---
function createPeerConnection(target) {
  // Close any existing peer connection before creating a new one
  if (peerConnection) {
    console.log("Closing existing peer connection before creating a new one.");
    peerConnection.close();
  }

  const pc = new RTCPeerConnection(iceServers);

  // Handle ICE candidate generation
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      console.log("Generated ICE candidate:", event.candidate);
      sendSignalingMessage({ type: "iceCandidate", target, candidate: event.candidate });
    }
    // event.candidate is null when all candidates have been generated
  };

  // Handle incoming remote media streams
  pc.ontrack = (event) => {
    console.log("Remote track received.");
    // Attach the received stream to the remote audio element
    if (remoteAudio.srcObject !== event.streams[0]) {
      remoteAudio.srcObject = event.streams[0];
    }
    // Start the call timer when the first track arrives (indicates media flow)
    if (!timerInterval) {
        startCallTimer();
    }
  };

  // Optional: Listen for connection state changes for better debugging
  pc.onconnectionstatechange = () => {
    console.log("WebRTC Connection State changed:", pc.connectionState);
    statusMessage.textContent = `Connection State: ${pc.connectionState}`;
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        console.warn(`Call connection ${pc.connectionState}. Ending call.`);
        alert(`Call connection ${pc.connectionState}. Ending call.`);
        endCall(true); // Attempt to notify peer and clean up
    }
  };

  // Optional: Listen for ICE connection state changes
  pc.oniceconnectionstatechange = () => {
    console.log("ICE Connection State changed:", pc.iceConnectionState);
    if (pc.iceConnectionState === 'failed') {
        console.error("ICE connection failed. This often requires a TURN server for some networks.");
        statusMessage.textContent = "Connection failed (ICE).";
        // In many cases, an ICE failure means the call cannot proceed without a TURN server.
        // You might want to inform the user or try re-negotiating with different ICE candidates.
        // For now, we'll end the call.
        endCall(true);
    }
  };

  return pc;
}

// Initiates an outgoing call
async function callUser(target) {
  if (currentCallTarget) {
    alert(`You are already in a call with ${currentCallTarget}.`);
    return;
  }

  console.log(`Initiating call to ${target}...`);
  currentCallTarget = target;
  statusMessage.textContent = `Calling ${target}...`;

  try {
    // Request access to the user's microphone
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    console.log("Local media stream acquired.");

    // Optional: Attach local stream to local audio element for self-monitoring
    if (localAudio) {
        localAudio.srcObject = localStream;
    }

    // Create the peer connection
    peerConnection = createPeerConnection(target);

    // Add the local audio track to the peer connection
    localStream.getTracks().forEach(track => {
        peerConnection.addTrack(track, localStream);
    });

    // Create an offer
    const offer = await peerConnection.createOffer();
    console.log("Created offer:", offer);

    // Set the offer as the local description
    await peerConnection.setLocalDescription(offer);

    // Send the offer to the target user via the signaling server
    sendSignalingMessage({ type: "offer", target, offer });

  } catch (error) {
    console.error("Error starting call:", error);
    statusMessage.textContent = "Failed to start call. Check microphone permissions.";
    alert("Failed to start call. Please check microphone access and try again.");
    // Clean up any partial state if the call setup failed
    endCall(false);
  }
}

// Handles an incoming call offer
async function onIncomingCall(caller, offer) {
  console.log(`Incoming call from ${caller}.`);
  // Prevent multiple incoming calls
  if (currentCallTarget) {
      console.warn(`Already in a call (${currentCallTarget}). Rejecting incoming call from ${caller}.`);
      sendSignalingMessage({ type: "reject", target: caller, message: "Busy" });
      return;
  }

  currentCallTarget = caller; // Set the target for the incoming call

  // Update the incoming call modal
  incomingCallerName.textContent = `Incoming call from ${caller}`;
  incomingCallModal.classList.remove("hidden");
  // Attempt to play ringtone (browsers often require user interaction first)
  try {
      await ringtone.play();
  } catch (e) {
      console.warn("Ringtone play failed (autoplay policy):", e);
      // The user might need to interact with the page first to enable sound.
      // This is okay, the visual notification is the priority.
  }

  statusMessage.textContent = `Incoming call from ${caller}`;

  try {
    // Create the peer connection for the incoming call
    peerConnection = createPeerConnection(caller);

    // Set the received offer as the remote description
    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    console.log("Remote offer set for incoming call.");

  } catch (error) {
    console.error("Error processing incoming offer:", error);
    alert("Failed to process incoming call. Rejecting.");
    // Reject the call if setting the offer fails
    rejectCall();
  }
}

// Accepts the incoming call
async function acceptCall() {
  console.log("Accepting incoming call...");
  ringtone.pause(); // Stop the ringtone
  ringtone.currentTime = 0; // Reset ringtone to start
  incomingCallModal.classList.add("hidden"); // Hide the modal

  if (!currentCallTarget || !peerConnection) {
    console.error("Accept call called but no target or peer connection.");
    return; // Safety check
  }

  try {
    // Request access to the user's microphone
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    console.log("Local media stream acquired for incoming call.");

    // Optional: Attach local stream for self-monitoring
    if (localAudio) {
        localAudio.srcObject = localStream;
    }

    // Add the local audio track to the peer connection
    localStream.getTracks().forEach(track => {
        peerConnection.addTrack(track, localStream);
    });

    // Create an answer to the offer
    const answer = await peerConnection.createAnswer();
    console.log("Created answer:", answer);

    // Set the answer as the local description
    await peerConnection.setLocalDescription(answer);

    // Send the answer back to the caller via the signaling server
    sendSignalingMessage({ type: "answer", target: currentCallTarget, answer });

    statusMessage.textContent = `In call with ${currentCallTarget}`;
    // Timer will start in `ontrack` event handler

  } catch (error) {
    console.error("Error accepting call:", error);
    alert("Failed to accept call. Please check microphone access.");
    // Reject or end the call if accepting fails
    rejectCall();
  }
}

// Rejects the incoming call
function rejectCall() {
  console.log("Rejecting incoming call...");
  ringtone.pause(); // Stop the ringtone
  ringtone.currentTime = 0; // Reset ringtone
  incomingCallModal.classList.add("hidden"); // Hide the modal

  if (currentCallTarget) {
    sendSignalingMessage({ type: "reject", target: currentCallTarget, message: "Call rejected." });
  }
  // End the call locally without sending a hangup signal
  endCall(false);
  statusMessage.textContent = "Call rejected.";
}

// Hangs up the current call
function hangUp() {
  console.log("Hanging up call...");
  if (currentCallTarget) {
    sendSignalingMessage({ type: "hangup", target: currentCallTarget, message: "User hung up." });
  }
  // End the call locally and send hangup signal
  endCall(true);
}

// Cleans up all call-related resources
function endCall(sendHangupSignal = false) {
  console.log("Ending call and cleaning up resources.");
  stopCallTimer(); // Stop the timer

  // Stop local media tracks
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null; // Clear the reference
    if (localAudio) localAudio.srcObject = null; // Clear local audio source
  }

  // Close the peer connection
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null; // Clear the reference
  }

  // Clear the remote audio source
  if (remoteAudio) remoteAudio.srcObject = null;

  // Send hangup signal only if explicitly requested and a target exists
  if (sendHangupSignal && currentCallTarget) {
    sendSignalingMessage({ type: "hangup", target: currentCallTarget, message: "User hung up." });
  }

  currentCallTarget = null; // Clear the call target
  ringtone.pause(); // Stop ringtone if it was playing
  ringtone.currentTime = 0; // Reset ringtone
  document.getElementById("incoming-call-modal").classList.add("hidden"); // Hide modal just in case

  statusMessage.textContent = "Ready.";
}

// --- Call Timer Functions ---
function startCallTimer() {
  console.log("Starting call timer.");
  callControls.classList.remove("hidden"); // Show call control buttons
  callTimerDisplay.classList.remove("hidden"); // Show th