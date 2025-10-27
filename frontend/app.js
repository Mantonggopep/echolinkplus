// app.js - Cleaned & Fixed WebRTC + Login Logic

// --- Configuration ---
const wsUrl = 'wss://echolinkplus-backend.onrender.com';
let ws = null;
let username = '';
let localStream = null;
let peerConnection = null;
let currentCallTarget = null;
let callStartTime = null;
let timerInterval = null;

// --- ICE/STUN Servers ---
const iceServers = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
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
const callTimerDisplay = document.getElementById("call-timer");
const incomingCallModal = document.getElementById("incoming-call-modal");
const incomingCallerName = document.getElementById("incoming-caller-name");
const muteButton = document.getElementById("muteButton");
const unmuteButton = document.getElementById("unmuteButton");

// --- Persistent Login ---
window.addEventListener("load", () => {
  const savedUser = localStorage.getItem("echoname");
  if (savedUser) {
    document.getElementById("usernameInput").value = savedUser;
    handleLogin(savedUser);
  }
});

// --- WebSocket ---
function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log("WebSocket connected.");
    statusMessage.textContent = "Connected to EchoLink+ Server.";
    if (username) sendSignalingMessage({ type: "login", username });
  };

  ws.onmessage = async (event) => {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }

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
          sendSignalingMessage({ type:"reject", target:data.caller, message:"Busy"}); 
          return; 
        }
        await onIncomingCall(data.caller, data.offer);
        break;
      case "answer":
        if (!peerConnection || currentCallTarget !== data.callee) return;
        await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
        startCallTimer();
        break;
      case "iceCandidate":
        if (peerConnection && data.candidate) { 
          try { await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch {} 
        }
        break;
      case "reject":
        alert(`Call rejected: ${data.message||'No reason given'}`);
        endCall(false); 
        break;
      case "hangup":
        alert(`${data.caller||'Peer'} ended the call.`);
        endCall(false); 
        break;
      case "error":
        alert(`Server Error: ${data.message}`);
        statusMessage.textContent = `Server Error: ${data.message}`;
        break;
    }
  };

  ws.onclose = () => {
    statusMessage.textContent="Disconnected. Reconnecting...";
    endCall(false);
    setTimeout(connectWebSocket,3000);
  };

  ws.onerror = (err) => {
    console.error(err);
    statusMessage.textContent="WebSocket error.";
  };
}

function sendSignalingMessage(msg) {
  if(ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// --- Login ---
function handleLogin(savedUser=null) {
  const inputUsername = savedUser || document.getElementById("usernameInput").value.trim();
  if (!inputUsername) { alert("Enter a valid Echo-Name."); return; }
  username = inputUsername;

  if (!ws || ws.readyState !== WebSocket.OPEN) connectWebSocket();
  else sendSignalingMessage({ type:"login", username });
}

// --- UI ---
function showAppView() {
  loginView.classList.add("hidden");
  appView.classList.remove("hidden");
  loggedUser.textContent = username;
}

function showLoginView() {
  loginView.classList.remove("hidden");
  appView.classList.add("hidden");
  loggedUser.textContent = '';
  username = '';
  localStorage.removeItem("echoname");
}

// --- Users List ---
function updateUserList(users){
  userList.innerHTML="";
  if(!users || users.length === 0){ userList.innerHTML='<li>No users online.</li>'; return; }
  users.forEach(u=>{
    if(u.username===username) return;
    const li = document.createElement("li");
    li.textContent = `${u.username}${u.status!=="Available"?" (Busy)":""}`;
    li.className = "user-item";
    if(u.status==="Available"){ 
      li.classList.add("available"); 
      li.onclick=()=>{ if(!currentCallTarget) callUser(u.username); else alert(`Already in call with ${currentCallTarget}`); };
    } else { 
      li.classList.add("busy"); 
      li.style.cursor="not-allowed"; 
      li.style.opacity=0.6; 
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
  currentCallTarget = target; statusMessage.textContent=`Calling ${target}...`;
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
  try{ await ringtone.play(); } catch{}
  statusMessage.textContent=`Incoming call from ${caller}`;
  try{ peerConnection = createPeerConnection(caller); await peerConnection.setRemoteDescription(new RTCSessionDescription(offer)); } catch(e){ rejectCall(); }
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
    statusMessage.textContent=`In call with ${currentCallTarget}`;
  } catch(e){ rejectCall(); }
}

function rejectCall(){
  ringtone.pause(); ringtone.currentTime=0; incomingCallModal.classList.add("hidden");
  if(currentCallTarget) sendSignalingMessage({ type:"reject", target:currentCallTarget, message:"Call rejected." });
  endCall(false); statusMessage.textContent="Call rejected.";
}

function hangUp(){ if(currentCallTarget) sendSignalingMessage({ type:"hangup", target:currentCallTarget, message:"User hung up." }); endCall(true); }

// --- Call Timer ---
function startCallTimer(){
  callControls.classList.remove("hidden"); callTimerDisplay.classList.remove("hidden");
  callStartTime = Date.now();
  timerInterval = setInterval(()=>{
    const elapsed = Date.now() - callStartTime;
    const m = String(Math.floor(elapsed/60000)).padStart(2,'0');
    const s = String(Math.floor((elapsed%60000)/1000)).padStart(2,'0');
    callTimerDisplay.textContent = `${m}:${s}`;
  },1000);
}

function stopCallTimer(){
  clearInterval(timerInterval); timerInterval = null; callStartTime = null;
  callTimerDisplay.textContent="00:00"; callTimerDisplay.classList.add("hidden"); callControls.classList.add("hidden");
}

