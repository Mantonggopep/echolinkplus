// --- Configuration ---
// ⚠️ IMPORTANT: UPDATE THIS URL
// You MUST replace the placeholder below with the SECURE WebSocket URL 
// (it must start with wss://) of your deployed signaling server (e.g., Render).
const WS_URL = 'wss://YOUR-DEPLOYED-SIGNALING-SERVER-URL.com'; 

// Public STUN servers for rapid, clear P2P connection establishment
// ADDED more servers for better connection reliability (ICE Fix)
const ICE_CONFIG = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' }, 
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19999' }, // Added variety in port
        { urls: 'stun:stun.ekiga.net' },
        { urls: 'stun:stun.voipbuster.com' }
    ]
};

// Media Constraints for AUDIO-ONLY CALL
const MEDIA_CONSTRAINTS = {
    audio: {
        echoCancellation: true,        // Essential for a good audio call experience
        noiseSuppression: true,        // Reduces background noise
        sampleRate: 48000              // High quality audio
    },
    video: false // Explicitly set video to FALSE for the fastest connection
};

// --- Global State ---
let ws = null;
let username = null;
let peerConnection = null;
let localStream = null;
let callingPeer = null; 
let currentIncomingCallOffer = null; 
// Tracks the active RTC senders (for explicit track removal)
let senders = []; 

// --- UI Elements ---
const ui = {
    status: document.getElementById('status-message'),
    loginView: document.getElementById('login-view'),
    appView: document.getElementById('app-view'),
    usernameInput: document.getElementById('usernameInput'),
    userList: document.getElementById('user-list'),
    localAudio: document.getElementById('localAudio'),
    remoteAudio: document.getElementById('remoteAudio'),
    callMessage: document.getElementById('call-message'),
    callControls: document.getElementById('call-controls'),
    modal: document.getElementById('incoming-call-modal'),
    modalCallerName: document.getElementById('incoming-caller-name'),
    // NEW UI Element
    micIndicator: document.getElementById('mic-indicator') 
};

// --- Utility Functions ---

const setStatus = (message, isError = false) => {
    ui.status.textContent = message;
    // Update colors for the new design
    if (isError) {
        ui.status.style.backgroundColor = '#f8d7da';
        ui.status.style.color = '#721c24';
        ui.status.style.border = '1px solid #f5c6cb';
    } else {
        ui.status.style.backgroundColor = '#d4edda';
        ui.status.style.color = '#155724';
        ui.status.style.border = '1px solid #c3e6cb';
    }
};

const updateMicIndicator = (state) => {
    // state: 'active', 'inactive', 'error'
    ui.micIndicator.className = `mic-status ${state}`;
    ui.micIndicator.title = state === 'active' ? 'Microphone Active' : 
                            state === 'error' ? 'Microphone Access Denied' : 
                            'Microphone Inactive';
};


const showAppView = (show = true) => {
    ui.loginView.classList.toggle('hidden', show);
    ui.appView.classList.toggle('hidden', !show);
};

// --- Web Socket (Signaling) Logic ---

const initWebSocket = () => {
    if (ws) ws.close();
    // ⚠️ IMPORTANT: If deploying to a modern host (like GitHub Pages), you MUST use WSS://
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
        setStatus(`Connected to signaling server.`);
        send({ type: 'login', username: username });
    };

    ws.onmessage = (message) => {
        let data;
        try {
            data = JSON.parse(message.data);
        } catch (e) {
            return;
        }
        handleSignalingMessage(data);
    };

    ws.onerror = (error) => {
        console.error('WebSocket Error:', error);
        setStatus('Connection failed. Check WSS server address and your network.', true);
    };

    ws.onclose = () => {
        setStatus('Connection closed. Please refresh to try again.', true);
        showAppView(false);
        hangUp(false); 
    };
};

const send = (message) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
    } else {
        setStatus('Error: Connection to server lost.', true);
    }
};

const handleSignalingMessage = (data) => {
    switch (data.type) {
        case 'loginSuccess':
            setStatus(data.message);
            showAppView(true);
            ui.callMessage.textContent = `Logged in as: ${username}. Select an online user to call.`;
            break;

        case 'loginFailure':
            setStatus(data.message, true);
            username = null;
            ui.usernameInput.value = '';
            break;
            
        case 'userList':
            updateUserList(data.users);
            break;

        case 'offer':
            handleIncomingCall(data.offer, data.caller);
            break;

        case 'answer':
            if (callingPeer === data.caller) {
                handleAnswer(data.answer);
            }
            break;
            
        case 'iceCandidate':
            // Check to ensure we only process candidates from the expected peer
            if (data.sender === callingPeer || data.sender === currentIncomingCallOffer?.caller) { 
                handleNewICECandidate(data.candidate);
            }
            break;

        case 'reject':
            if (callingPeer === data.caller) {
                setStatus(`${data.caller} declined your Echo-Link request.`, true);
                resetCallState();
            }
            break;

        case 'hangup':
            if (callingPeer === data.caller) {
                setStatus(`${data.caller} has ended the Echo-Link call.`, true);
                // hangUp(true) is called implicitly in resetCallState if called from a peer
                resetCallState(); 
            }
            break;
        
        case 'error':
            setStatus(`Server Error: ${data.message}`, true);
            break;
    }
};

// --- WebRTC (Peer Connection) Logic ---

const initPeerConnection = () => {
    peerConnection = new RTCPeerConnection(ICE_CONFIG);
    senders = []; // Reset senders list

    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            send({
                type: 'iceCandidate',
                target: callingPeer,
                candidate: event.candidate,
                sender: username // Include sender for verification
            });
        }
    };
    
    // Explicitly add tracks to the PC and store the sender
    if (localStream) {
        localStream.getTracks().forEach(track => {
            const sender = peerConnection.addTrack(track, localStream);
            senders.push(sender); // Store the sender object
        });
    }

    // Assign stream to remoteAudio element
    peerConnection.ontrack = (event) => {
        // Ensure remote stream is only attached once
        if (ui.remoteAudio.srcObject !== event.streams[0]) {
            ui.remoteAudio.srcObject = event.streams[0];
            // Attempt to play, catching errors caused by browser autoplay policies
            ui.remoteAudio.play().catch(e => {
                console.warn("Autoplay was prevented. User interaction required to hear audio.");
                setStatus("Click anywhere on the screen to enable audio playback.", true);
            });
            ui.callMessage.textContent = `Echo-Link established with ${callingPeer}`;
            ui.callControls.classList.remove('hidden');
        }
    };
    
    peerConnection.onconnectionstatechange = () => {
        console.log(`RTC Connection State: ${peerConnection.connectionState}`);
        if (peerConnection.connectionState === 'disconnected' || peerConnection.connectionState === 'failed') {
            if (callingPeer) {
                setStatus(`Echo-Link with ${callingPeer} disconnected.`, true);
                hangUp(true);
            }
        }
    };

    // Log the connection status for debugging audio issues
    peerConnection.oniceconnectionstatechange = () => {
        console.log(`ICE Connection State: ${peerConnection.iceConnectionState}`);
        if (peerConnection.iceConnectionState === 'failed') {
             setStatus(`ICE connection failed. Peer could not be reached. Try restarting the call.`, true);
        }
    };
};

/** Gets access to the user's microphone ONLY. */
const initMedia = async () => {
    // If stream already exists, reuse it
    if (localStream) return true; 

    try {
        localStream = await navigator.mediaDevices.getUserMedia(MEDIA_CONSTRAINTS);
        // Assign stream to localAudio element (muted)
        ui.localAudio.srcObject = localStream;
        ui.localAudio.play();
        setStatus('Microphone access granted. Ready to connect.');
        updateMicIndicator('active'); // Indicate mic is active
        return true;
    } catch (e) {
        setStatus('Failed to access microphone. Please allow access.', true);
        updateMicIndicator('error'); // Indicate mic error
        console.error('getUserMedia Error:', e);
        return false;
    }
};

const createOffer = async () => {
    try {
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);

        send({
            type: 'offer',
            target: callingPeer,
            offer: peerConnection.localDescription,
            caller: username // Include caller's username
        });
        ui.callMessage.textContent = `Attempting Echo-Link with ${callingPeer}...`;
        ui.callControls.classList.remove('hidden');
    } catch (e) {
        console.error('Error creating offer:', e);
        setStatus('Error during Echo-Link attempt.', true);
        hangUp(false);
    }
};

const handleOffer = async (offer, callerUsername) => {
    try {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);

        send({
            type: 'answer',
            target: callerUsername,
            answer: peerConnection.localDescription,
            caller: username // Include caller's username (now the answerer)
        });
        setStatus(`Preparing Echo-Link connection with ${callerUsername}...`);

    } catch (e) {
        console.error('Error handling offer:', e);
        setStatus('Error processing Echo-Link offer.', true);
        hangUp(true);
    }
};

const handleAnswer = async (answer) => {
    try {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
        setStatus(`Echo-Link connected with ${callingPeer}!`);
    } catch (e) {
        console.error('Error handling answer:', e);
        setStatus('Error processing Echo-Link answer.', true);
        hangUp(true);
    }
};

const handleNewICECandidate = async (candidate) => {
    try {
        if (peerConnection.remoteDescription) {
             await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        }
    } catch (e) {
        // This is normal if candidate has already been processed or is invalid
        console.warn('Error adding ICE candidate (often harmless):', e);
    }
};

const resetCallState = () => {
    // 1. Clean up Peer Connection
    if (peerConnection) {
        // Explicitly remove all tracks (important cleanup)
        senders.forEach(sender => {
            if (peerConnection.removeTrack) {
                peerConnection.removeTrack(sender);
            }
        });
        peerConnection.close();
        peerConnection = null;
    }
    senders = [];

    // 2. Stop local tracks only if not already stopped and no ongoing call is preventing it
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
        ui.localAudio.srcObject = null;
    }
    
    // 3. Reset state variables and UI
    callingPeer = null;
    currentIncomingCallOffer = null;
    ui.remoteAudio.srcObject = null;
    ui.callControls.classList.add('hidden');
    ui.modal.classList.add('hidden');
    ui.callMessage.textContent = `Logged in as: ${username}. Select an online user to call.`;
    setStatus('Ready to establish an Echo-Link.');
    updateMicIndicator('inactive');

    // Re-enable call buttons
    document.querySelectorAll('.call-btn').forEach(btn => btn.disabled = false);
};


// --- UI Interaction Handlers ---

const handleLogin = () => {
    const input = ui.usernameInput.value.trim();
    if (input.length < 3) {
        setStatus('Echo-Name must be at least 3 characters.', true);
        return;
    }
    username = input;
    initWebSocket();
};

const updateUserList = (users) => {
    ui.userList.innerHTML = '';
    
    const availableUsers = users.filter(user => user.username !== username);

    if (availableUsers.length === 0) {
        ui.userList.innerHTML = `<li class="user-item">No other Echo-Link users online.</li>`;
        return;
    }

    availableUsers.forEach(user => {
        const li = document.createElement('li');
        li.className = 'user-item';
        const isDisabled = callingPeer || user.status !== 'Available'; 
        const statusClass = user.status.replace(/\s/g, ''); 
        
        li.innerHTML = `
            <span>
                ${user.username}
                <span class="status ${statusClass}">(${user.status})</span>
            </span>
            <button class="call-btn" onclick="callUser('${user.username}')" ${isDisabled ? 'disabled' : ''}>
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2 2A18.5 18.5 0 0 1 2 4a2 2 0 0 1 2-2h3l1.83 4.58 2.5-3.5 1.84 4.58 3 1.5 2.5-3.5 1.83 4.58z"/></svg>
                Link
            </button>
        `;
        ui.userList.appendChild(li);
    });
};

const callUser = async (targetUsername) => {
    if (callingPeer) {
        setStatus('Already linked or establishing a link.', true);
        return;
    }

    // 1. Get media access
    const mediaReady = await initMedia();
    if (!mediaReady) return;

    // 2. Init connection and offer
    callingPeer = targetUsername;
    initPeerConnection(); 
    await createOffer();

    document.querySelectorAll('.call-btn').forEach(btn => btn.disabled = true);
};

const handleIncomingCall = (offer, callerUsername) => {
    if (callingPeer) {
        send({ type: 'reject', target: callerUsername, sender: username });
        return;
    }

    callingPeer = callerUsername;
    currentIncomingCallOffer = offer;
    
    ui.modalCallerName.textContent = `Incoming Echo-Link from ${callerUsername}`;
    ui.modal.classList.remove('hidden');
    setStatus('Incoming Echo-Link! Respond quickly.', false);
};

const acceptCall = async () => {
    ui.modal.classList.add('hidden');
    
    // 1. Get media access
    const mediaReady = await initMedia();
    if (!mediaReady) {
        rejectCall();
        return;
    }
    
    // 2. Init connection and answer
    if (currentIncomingCallOffer) {
        initPeerConnection();
        await handleOffer(currentIncomingCallOffer, callingPeer);
        currentIncomingCallOffer = null;
    } else {
        setStatus("Error: Missing call offer data.", true);
        rejectCall();
    }
};

const rejectCall = () => {
    ui.modal.classList.add('hidden');
    if (callingPeer) {
        send({ type: 'reject', target: callingPeer, sender: username });
        setStatus(`Echo-Link declined from ${callingPeer}.`);
    }
    resetCallState();
};

const hangUp = (notifyPeer = true) => {
    if (notifyPeer && callingPeer) {
        send({ type: 'hangup', target: callingPeer, sender: username });
        setStatus(`Echo-Link ended with ${callingPeer}.`);
    }

    resetCallState();
};

// --- Initial Setup ---

window.handleLogin = handleLogin;
window.callUser = callUser;
window.acceptCall = acceptCall;
window.rejectCall = rejectCall;
window.hangUp = hangUp;

document.addEventListener('DOMContentLoaded', () => {
    showAppView(false);
    setStatus('Welcome to Echo-Link! Enter your Echo-Name and connect.');
    updateMicIndicator('inactive'); // Initial state
});