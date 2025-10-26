// app.js (Client-Side WebRTC Application)

// --- Configuration ---
const wsUrl = 'wss://echolinkplus-backend.onrender.com';
let ws, localStream = null, peerConnection = null, currentCallTarget = null, username = '';
let callStartTime = null, timerInterval = null;

// --- STUN/TURN Configuration ---
const iceServers = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
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

// --- Persistent Login ---
window.addEventListener("load", () => {
  const savedUser = localStorage.getItem("echoname");
  if (savedUser) {
    document.getElementById("usernameInput").value = savedUser;
    handleLogin(savedUser);
  } else {
    connectWebSocket();
  }
});

// --- WebSocket ---
function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log("✅ WebSocket connected.");
    statusMessage.textContent = "Connected to EchoLink+ Server.";
    if (username) sendSignalingMessage({ type: "login", username });
  };

  ws.onmessage = async (event) => {
    let data;
    try { data = JSON.parse(event.data); } 
    catch { return console.error("Invalid JSON:", event.data); }

    switch (data.type) {
      case "loginSuccess":
        username = data.username;
        localStorage.setItem("echoname", username);
        showAppView();
        break;
      case "loginFailure":
        alert(`Login failed: ${data.message}`);
        username = '';
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
        if (!peerConnection || !currentCallTarget) { endCall(false); return; }
        await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
        startCallTimer();
        break;
      case "iceCandidate":
        if (peerConnection && data.candidate) {
          try { await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate)); } 
          catch (err) { console.warn("ICE candidate add error:", err); }
        }
        break;
      case "reject":
        alert(`Call rejected: ${data.message || 'No reason given.'}`);
        endCall(false);
        break;
      case "hangup":
        alert(`${data.caller || 'Peer'} ended the call.`);
        endCall(false);
        break;
      case "error":
        alert(`Server Error: ${data.message}`);
        statusMessage.textContent = `Server Error: ${data.message}`;
        break;
      default:
        console.warn("Unknown message type:", data.type);
    }
  };

  ws.onclose = () => {
    statusMessage.textContent = "Disconnected. Reconnecting...";
    endCall(false);
    setTimeout(connectWebSocket, 3000);
  };

  ws.onerror = (err) => {
    console.error("WebSocket error:", err);
    statusMessage.textContent = "WebSocket error.";
  };
}

function sendSignalingMessage(message) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  else console.warn("Cannot send, WebSocket not open.");
}

// --- UI ---
function handleLogin(savedUser = null) {
  const inputUsername = savedUser || document.getElementById("usernameInput").value.trim();
  if (!inputUsername) { alert("Enter a valid Echo-Name."); return; }
  username = inputUsername;
  if (!ws || ws.readyState !== WebSocket.OPEN) connectWebSocket();
  else sendSignalingMessage({ type: "login", username });
}

function showAppView() { loginView.classList.add("hidden"); appView.classList.remove("hidden"); loggedUser.textContent = username; }
function showLoginView() { loginView.classList.remove("hidden"); appView.classList.add("hidden"); loggedUser.textContent = ''; username=''; localStorage.removeItem("echoname"); document.getElementById("usernameInput").value=''; }

function updateUserList(users) {
  userList.innerHTML = "";
  users.forEach(user => {
    if (user.username === username) return;
    const li = document.createElement("li");
    li.textContent = `${user.username}${user.status!=="Available"?" (Busy)":""}`;
    li.className = "user-item";
    if (user.status==="Available") {
      li.classList.add("available");
      li.onclick = ()=>{ if(!currentCallTarget) callUser(user.username); else alert(`Already in call with ${currentCallTarget}`); };
    } else {
      li.classList.add("busy"); li.style.cursor="not-allowed"; li.style.opacity=0.6;
    }
    userList.appendChild(li);
  });
}

// --- WebRTC ---
function createPeerConnection(target){
  if(peerConnection){ peerConnection.close(); peerConnection=null; }
  const pc = new RTCPeerConnection(iceServers);
  pc.onicecandidate = e=>{ if(e.candidate) sendSignalingMessage({ type:"iceCandidate", target, candidate:e.candidate }); };
  pc.ontrack = e=>{ if(remoteAudio.srcObject!==e.streams[0]) remoteAudio.srcObject=e.streams[0]; if(!timerInterval) startCallTimer(); };
  pc.onconnectionstatechange = ()=>{ if(pc.connectionState==='failed'||pc.connectionState==='disconnected'){ alert(`Call connection ${pc.connectionState}. Ending call.`); endCall(true); } };
  pc.oniceconnectionstatechange = ()=>{ if(pc.iceConnectionState==='failed'){ statusMessage.textContent="Connection failed (ICE)."; endCall(true); } };
  return pc;
}

async function callUser(target){
  if(currentCallTarget){ alert(`Already in call with ${currentCallTarget}`); return; }
  currentCallTarget = target; statusMessage.textContent = `Calling ${target}...`;
  try{
    localStream = await navigator.mediaDevices.getUserMedia({ audio:true });
    if(localAudio) localAudio.srcObject = localStream;
    peerConnection = createPeerConnection(target);
    localStream.getTracks().forEach(track=>peerConnection.addTrack(track, localStream));
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    sendSignalingMessage({ type:"offer", target, offer });
  } catch(e){ alert("Failed to start call. Check microphone."); endCall(false); }
}

async function onIncomingCall(caller, offer){
  currentCallTarget = caller;
  incomingCallerName.textContent = `Incoming call from ${caller}`;
  incomingCallModal.classList.remove("hidden");
  try{ await ringtone.play(); } catch {}
  statusMessage.textContent = `Incoming call from ${caller}`;
  try{ peerConnection=createPeerConnection(caller); await peerConnection.setRemoteDescription(new RTCSessionDescription(offer)); } catch(e){ rejectCall(); }
}

async function acceptCall(){
  ringtone.pause(); ringtone.currentTime=0; incomingCallModal.classList.add("hidden");
  if(!currentCallTarget||!peerConnection) return;
  try{
    localStream = await navigator.mediaDevices.getUserMedia({ audio:true });
    if(localAudio) localAudio.srcObject=localStream;
    localStream.getTracks().forEach(track=>peerConnection.addTrack(track, localStream));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    sendSignalingMessage({ type:"answer", target:currentCallTarget, answer });
    statusMessage.textContent = `In call with ${currentCallTarget}`;
  } catch(e){ rejectCall(); }
}

function rejectCall(){
  ringtone.pause(); ringtone.currentTime=0; incomingCallModal.classList.add("hidden");
  if(currentCallTarget) sendSignalingMessage({ type:"reject", target:currentCallTarget, message:"Call rejected." });
  endCall(false); statusMessage.textContent="Call rejected.";
}

function hangUp(){ if(currentCallTarget) sendSignalingMessage({ type:"hangup", target:currentCallTarget, message:"User hung up." }); endCall(true); }

function endCall(sendHangupSignal=false){
  stopCallTimer();
  if(localStream){ localStream.getTracks().forEach(t=>t.stop()); localStream=null; if(localAudio) localAudio.srcObject=null; }
  if(peerConnection){ peerConnection.close(); peerConnection=null; }
  if(remoteAudio) remoteAudio.srcObject=null;
  if(sendHangupSignal && currentCallTarget) sendSignalingMessage({ type:"hangup", target:currentCallTarget, message:"User hung up." });
  currentCallTarget=null;
  ringtone.pause(); ringtone.currentTime=0;
  incomingCallModal.classList.add("hidden");
  statusMessage.textContent="Ready.";
}

// --- Call Timer ---
function startCallTimer(){
  callControls.classList.remove("hidden");
  callTimerDisplay.classList.remove("hidden");
  callStartTime=Date.now();
  timerInterval=setInterval(()=>{
    const elapsed=Date.now()-callStartTime;
    const minutes=Math.floor(elapsed/60000);
    const seconds=Math.floor((elapsed%60000)/1000);
    callTimerDisplay.textContent=`${minutes.toString().padStart(2,'0')}:${seconds.toString().padStart(2,'0')}`;
  },1000);
}

function stopCallTimer(){
  clearInterval(timerInterval); timerInterval=null; callStartTime=null;
  callTimerDisplay.textContent="00:00";
  callTimerDisplay.classList.add("hidden");
  callControls.classList.add("hidden");
}