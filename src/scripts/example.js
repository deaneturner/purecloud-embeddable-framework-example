// Add this code to handle audio resource management
let audioPool = [];
const MAX_AUDIO_POOL_SIZE = 10; // Adjust based on your needs

document.addEventListener('DOMContentLoaded', function () {

    // Initialize the audio pool
    initializeAudioPool();

    // Add WebRTC device initialization
    initializeWebRTCDevices();

    // Setup listener for device changes (headset plug/unplug, etc.)
    setupDeviceChangeListener();

    // Clean up audio resources when the page is unloaded
    window.addEventListener('beforeunload', cleanupAudioResources);

    // Add this new function for WebRTC device handling
    function initializeWebRTCDevices() {
        // Check if the browser supports getUserMedia
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            console.error('Browser does not support getUserMedia API');
            notifySoftphoneOfWebRTCStatus({
                status: 'error',
                error: 'NotSupported',
                message: 'Browser does not support WebRTC'
            });
            return;
        }

        // Instead of immediately requesting permissions, first notify the softphone
        // that we need to get permissions from the user
        notifySoftphoneOfWebRTCStatus({
            status: 'initializing',
            message: 'Waiting for microphone permissions'
        });

        // Create a UI prompt to inform the user
        createPermissionPrompt();

        // Now request audio permission with minimal constraints
        navigator.mediaDevices.getUserMedia({
            audio: true,
            video: false
        })
            .then(stream => {
                // Remove the permission prompt
                removePermissionPrompt();

                // We got access to a microphone, which means permissions are granted
                console.log('Audio permission granted');

                // Stop the stream immediately
                stream.getTracks().forEach(track => track.stop());

                // Now get the device list
                return navigator.mediaDevices.enumerateDevices();
            })
            .then(devices => {
                // Filter for audio input devices
                const audioInputDevices = devices.filter(device => device.kind === 'audioinput');
                console.log('Available audio devices:', audioInputDevices);

                if (audioInputDevices.length === 0) {
                    throw new Error('No audio input devices found');
                }

                // Select the first device with a non-empty ID and label
                let selectedDevice = audioInputDevices[0];

                // Notify the softphone that we have audio devices available
                window.selectedAudioDeviceId = selectedDevice.deviceId;

                notifySoftphoneOfWebRTCStatus({
                    status: 'ready',
                    deviceId: selectedDevice.deviceId,
                    label: selectedDevice.label || 'Default Microphone',
                    devices: audioInputDevices.map(d => ({
                        deviceId: d.deviceId,
                        label: d.label || 'Microphone'
                    }))
                });
            })
            .catch(err => {
                // Remove the permission prompt if it exists
                removePermissionPrompt();

                console.error('WebRTC initialization error:', err);

                // Handle permission denial specifically
                if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
                    // Show a message to the user about permission denial
                    showPermissionDeniedMessage();

                    notifySoftphoneOfWebRTCStatus({
                        status: 'error',
                        error: err.name,
                        message: 'Microphone access was denied. Please allow microphone access in your browser settings.',
                        isPermissionError: true
                    });
                } else {
                    // Handle other errors
                    notifySoftphoneOfWebRTCStatus({
                        status: 'error',
                        error: err.name || 'Error',
                        message: err.message || 'Could not access audio devices',
                        isPermissionError: false
                    });
                }
            });
    }

// Helper function to notify the softphone iframe about WebRTC status
    function notifySoftphoneOfWebRTCStatus(data) {
        document.getElementById("softphone").contentWindow.postMessage(JSON.stringify({
            type: 'audioDeviceStatus',
            data: data
        }), "*");
    }

// Helper function to create a permission prompt UI
    function createPermissionPrompt() {
        // Remove any existing prompt first
        removePermissionPrompt();

        const promptDiv = document.createElement('div');
        promptDiv.id = 'webrtc-permission-prompt';
        promptDiv.style.position = 'fixed';
        promptDiv.style.top = '10px';
        promptDiv.style.left = '50%';
        promptDiv.style.transform = 'translateX(-50%)';
        promptDiv.style.zIndex = '9999';
        promptDiv.style.background = '#f0f8ff';
        promptDiv.style.padding = '15px';
        promptDiv.style.borderRadius = '5px';
        promptDiv.style.boxShadow = '0 2px 10px rgba(0,0,0,0.2)';
        promptDiv.style.maxWidth = '400px';

        promptDiv.innerHTML = `
        <h3 style="margin-top: 0; color: #333;">Microphone Access Required</h3>
        <p>This application needs access to your microphone for voice calls.</p>
        <p>Please allow access when prompted by your browser.</p>
    `;

        document.body.appendChild(promptDiv);
    }

// Helper function to remove the permission prompt
    function removePermissionPrompt() {
        const existingPrompt = document.getElementById('webrtc-permission-prompt');
        if (existingPrompt) {
            existingPrompt.remove();
        }
    }

// Helper function to show a permission denied message
    function showPermissionDeniedMessage() {
        const messageDiv = document.createElement('div');
        messageDiv.id = 'webrtc-permission-denied';
        messageDiv.style.position = 'fixed';
        messageDiv.style.top = '10px';
        messageDiv.style.left = '50%';
        messageDiv.style.transform = 'translateX(-50%)';
        messageDiv.style.zIndex = '9999';
        messageDiv.style.background = '#fff0f0';
        messageDiv.style.padding = '15px';
        messageDiv.style.borderRadius = '5px';
        messageDiv.style.boxShadow = '0 2px 10px rgba(0,0,0,0.2)';
        messageDiv.style.maxWidth = '400px';

        messageDiv.innerHTML = `
        <h3 style="margin-top: 0; color: #d32f2f;">Microphone Access Denied</h3>
        <p>You've denied access to your microphone. Voice calling will not be available.</p>
        <p>To enable voice calls, please:</p>
        <ol>
            <li>Click the camera/microphone icon in your browser's address bar</li>
            <li>Select "Allow" for microphone access</li>
            <li>Refresh this page</li>
        </ol>
        <button id="dismiss-permission-message" style="padding: 8px 16px; background: #d32f2f; color: white; border: none; border-radius: 4px; cursor: pointer;">Dismiss</button>
    `;

        document.body.appendChild(messageDiv);

        // Add event listener to the dismiss button
        document.getElementById('dismiss-permission-message').addEventListener('click', function () {
            messageDiv.remove();
        });
    }

// Modify the selectAudioDevice function to work with our new approach
    function selectAudioDevice(deviceId) {
        if (!deviceId) {
            console.error('No device ID provided for selection');
            return;
        }

        window.selectedAudioDeviceId = deviceId;

        // Notify the softphone about the device selection
        notifySoftphoneOfWebRTCStatus({
            status: 'ready',
            deviceId: deviceId
        });
    }

// Add a function to handle device changes
    function setupDeviceChangeListener() {
        if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
            navigator.mediaDevices.addEventListener('devicechange', () => {
                console.log('Media devices changed, updating device list');
                // Check if we already have permission before re-enumerating
                if (window.selectedAudioDeviceId) {
                    updateDeviceList();
                }
            });
        }
    }

// Function to update the device list without requesting permissions again
    function updateDeviceList() {
        navigator.mediaDevices.enumerateDevices()
            .then(devices => {
                const audioInputDevices = devices.filter(device => device.kind === 'audioinput');

                if (audioInputDevices.length === 0) {
                    console.warn('No audio input devices found during update');
                    return;
                }

                // Check if our selected device is still available
                const selectedDeviceStillExists = audioInputDevices.some(
                    device => device.deviceId === window.selectedAudioDeviceId
                );

                if (!selectedDeviceStillExists && audioInputDevices.length > 0) {
                    // Our selected device is gone, select a new one
                    window.selectedAudioDeviceId = audioInputDevices[0].deviceId;
                }

                // Notify about the updated device list
                notifySoftphoneOfWebRTCStatus({
                    status: 'updated',
                    deviceId: window.selectedAudioDeviceId,
                    devices: audioInputDevices.map(d => ({
                        deviceId: d.deviceId,
                        label: d.label || 'Microphone'
                    }))
                });
            })
            .catch(err => {
                console.error('Error updating device list:', err);
            });
    }

    function testAudioDevice(deviceId) {
        // Try to access the selected audio device using a less strict constraint
        navigator.mediaDevices.getUserMedia({
            audio: deviceId ? {deviceId: {ideal: deviceId}} : true
        })
            .then(stream => {
                console.log('Successfully accessed audio device');
                // Get the actual track being used
                const audioTrack = stream.getAudioTracks()[0];
                if (audioTrack) {
                    console.log('Using audio device:', audioTrack.label);
                    // Update the stored device ID with the actual one being used
                    const settings = audioTrack.getSettings();
                    if (settings.deviceId) {
                        window.selectedAudioDeviceId = settings.deviceId;
                    }
                }

                // Stop all tracks to release the device
                stream.getTracks().forEach(track => track.stop());

                // Notify the softphone that we have a valid device
                document.getElementById("softphone").contentWindow.postMessage(JSON.stringify({
                    type: 'audioDeviceSelected',
                    data: {deviceId: window.selectedAudioDeviceId}
                }), "*");
            })
            .catch(err => {
                console.error('Error accessing selected audio device:', err);

                // If there was an error with the specific device, try with any audio device
                if (deviceId) {
                    console.log('Trying to access any available audio device...');
                    testAudioDevice(null);
                } else {
                    // If we can't access any audio device, notify the softphone about the issue
                    document.getElementById("softphone").contentWindow.postMessage(JSON.stringify({
                        type: 'audioDeviceError',
                        data: {error: err.name, message: err.message}
                    }), "*");
                }
            });
    }


    // Add this function to allow manual device selection if needed
    function selectAudioDevice(deviceId) {
        if (!deviceId) {
            console.error('No device ID provided for selection');
            return;
        }

        window.selectedAudioDeviceId = deviceId;

        // Notify the softphone about the device selection
        document.getElementById("softphone").contentWindow.postMessage(JSON.stringify({
            type: 'audioDeviceSelected',
            data: {deviceId: deviceId}
        }), "*");
    }

    function setupDeviceChangeListener() {
        if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
            navigator.mediaDevices.addEventListener('devicechange', () => {
                console.log('Media devices changed, updating device list');
                // Re-enumerate devices when they change
                initializeWebRTCDevices();
            });
        }
    }


    // Update your existing functions that might need the device ID
    // For example, modify updateAudioConfiguration to include the device ID:
    function updateAudioConfiguration() {
        console.log('Update Audio Configuration');
        var payload = {
            call: document.getElementById('audio-call').checked,
            chat: document.getElementById('audio-chat').checked,
            email: document.getElementById('audio-email').checked,
            callback: document.getElementById('audio-callback').checked,
            message: document.getElementById('audio-message').checked,
            voicemail: document.getElementById('audio-voicemail').checked,
            deviceId: window.selectedAudioDeviceId // Add the selected device ID
        }
        document.getElementById("softphone").contentWindow.postMessage(JSON.stringify({
            type: 'updateAudioConfiguration',
            data: payload
        }), "*");
    }


    document.getElementById("clickToDial").addEventListener("click", clickToDial);
    document.getElementById("addAssociation").addEventListener("click", addAssociation);
    document.getElementById("addAttribute").addEventListener("click", addAttribute);
    document.getElementById('addTransferContext').addEventListener("click", addTransferContext);
    document.getElementById('updateUserStatus').addEventListener("click", updateUserStatus);
    document.getElementById('pickupInteraction').addEventListener("click", updateInteractionState);
    document.getElementById('securePauseInteraction').addEventListener("click", updateInteractionState);
    document.getElementById('disconnectInteraction').addEventListener("click", updateInteractionState);
    document.getElementById('holdInteraction').addEventListener("click", updateInteractionState);
    document.getElementById('muteInteraction').addEventListener("click", updateInteractionState);
    document.getElementById('updateAudioConfiguration').addEventListener("click", updateAudioConfiguration);
    document.getElementById('sendCustomNotification').addEventListener("click", sendCustomNotification);

    document.getElementById('view-interactionList').addEventListener("click", setView);
    document.getElementById('view-calllog').addEventListener("click", setView);
    document.getElementById('view-newInteraction').addEventListener("click", setView);
    document.getElementById('view-callback').addEventListener("click", setView);
    document.getElementById('view-settings').addEventListener("click", setView);

    window.addEventListener("message", function (event) {
        var message = JSON.parse(event.data);
        if (message) {
            if (message.type == "screenPop") {
                document.getElementById("screenPopPayload").value = event.data;
            } else if (message.type == "processCallLog") {
                document.getElementById("processCallLogPayLoad").value = event.data;
            } else if (message.type == "openCallLog") {
                document.getElementById("openCallLogPayLoad").value = event.data;
            } else if (message.type == "interactionSubscription") {
                document.getElementById("interactionSubscriptionPayload").value = event.data;
            } else if (message.type == "userActionSubscription") {
                document.getElementById("userActionSubscriptionPayload").value = event.data;
            } else if (message.type == "notificationSubscription") {
                document.getElementById("notificationSubscriptionPayload").value = event.data;
            } else if (message.type == "contactSearch") {
                document.getElementById("searchText").innerHTML = ": " + message.data.searchString;
                sendContactSearch();
            }
        }
    });

    function clickToDial() {
        console.log('process click to dial');
        document.getElementById("softphone").contentWindow.postMessage(JSON.stringify({
            type: 'clickToDial',
            data: {number: '3172222222', autoPlace: true}
        }), "*");
    }

    function addAssociation() {
        console.log('process add association');
        document.getElementById("softphone").contentWindow.postMessage(JSON.stringify({
            type: 'addAssociation',
            data: JSON.parse(document.getElementById("associationPayload").value)
        }), "*");
    }

    function addAttribute() {
        console.log('process add attribute');
        document.getElementById("softphone").contentWindow.postMessage(JSON.stringify({
            type: 'addAttribute',
            data: JSON.parse(document.getElementById("attributePayload").value)
        }), "*");
    }

    function addTransferContext() {
        console.log('process add Transfer Context');
        document.getElementById("softphone").contentWindow.postMessage(JSON.stringify({
            type: 'addTransferContext',
            data: JSON.parse(document.getElementById("transferContextPayload").value)
        }), "*");
    }

    function sendContactSearch() {
        console.log('process add Search Context');
        document.getElementById("softphone").contentWindow.postMessage(JSON.stringify({
            type: 'sendContactSearch',
            data: JSON.parse(document.getElementById("contactSearchPayload").value)
        }), "*");
    }

    function updateUserStatus() {
        console.log('process user status update');
        document.getElementById("softphone").contentWindow.postMessage(JSON.stringify({
            type: 'updateUserStatus',
            data: {id: document.getElementById("statusDropDown").value}
        }), "*");
    }

    function updateInteractionState(event) {
        console.log('process interaction state change');
        var lastInteractionPayload = JSON.parse(document.getElementById("interactionSubscriptionPayload").value);
        var interactionId;
        if (lastInteractionPayload.data.interaction.old) {
            interactionId = lastInteractionPayload.data.interaction.old.id;
        } else {
            interactionId = lastInteractionPayload.data.interaction.id;
        }
        let payload = {
            action: event.target.outerText,
            id: interactionId
        };
        document.getElementById("softphone").contentWindow.postMessage(JSON.stringify({
            type: 'updateInteractionState',
            data: payload
        }), "*");
    }

    function updateAudioConfiguration() {
        console.log('Update Audio Configuration');
        var payload = {
            call: document.getElementById('audio-call').checked,
            chat: document.getElementById('audio-chat').checked,
            email: document.getElementById('audio-email').checked,
            callback: document.getElementById('audio-callback').checked,
            message: document.getElementById('audio-message').checked,
            voicemail: document.getElementById('audio-voicemail').checked
        }
        document.getElementById("softphone").contentWindow.postMessage(JSON.stringify({
            type: 'updateAudioConfiguration',
            data: payload
        }), "*");
    }


    function setView(event) {
        console.log('process view update');
        let payload = {
            type: "main",
            view: {
                name: event.target.outerText
            }
        };
        document.getElementById("softphone").contentWindow.postMessage(JSON.stringify({
            type: 'setView',
            data: payload
        }), "*");
    }

    function sendCustomNotification() {
        console.log('Send Custom User Notification');
        var payload = {
            message: document.getElementById('customNotificationMessage').value,
            type: document.getElementById('notificationType').value,
            timeout: document.getElementById('notificationTimeout').value
        };
        document.getElementById("softphone").contentWindow.postMessage(JSON.stringify({
            type: 'sendCustomNotification',
            data: payload
        }), "*");
    }

// Initialize the audio pool
    function initializeAudioPool() {
        // Clear any existing audio elements in the pool
        audioPool.forEach(audio => {
            audio.onended = null;
            audio.pause();
            audio.src = '';
        });

        audioPool = [];

        // Create a pool of reusable audio elements
        for (let i = 0; i < MAX_AUDIO_POOL_SIZE; i++) {
            const audio = new Audio();
            audio.inUse = false;
            audioPool.push(audio);
        }

        console.log('Audio pool initialized with ' + MAX_AUDIO_POOL_SIZE + ' elements');
    }

// Get an available audio element from the pool
    function getAudioFromPool() {
        // First try to find an unused audio element
        let audio = audioPool.find(a => !a.inUse);

        // If all are in use, find one that's not playing
        if (!audio) {
            audio = audioPool.find(a => a.paused || a.ended);

            // If we found one, clean it up for reuse
            if (audio) {
                audio.pause();
                audio.currentTime = 0;
                audio.src = '';
            }
        }

        // If still no available audio, take the oldest one from the pool
        if (!audio && audioPool.length > 0) {
            audio = audioPool[0];
            audio.pause();
            audio.currentTime = 0;
            audio.src = '';
            console.warn('Audio pool exhausted, reusing oldest audio element');
        }

        // If we have an audio element, mark it as in use
        if (audio) {
            audio.inUse = true;
        } else {
            // Create a new one if the pool is empty (shouldn't happen)
            audio = new Audio();
            audio.inUse = true;
            audioPool.push(audio);
            console.warn('Creating new audio element outside pool');
        }

        return audio;
    }

// Release an audio element back to the pool
    function releaseAudioToPool(audio) {
        if (!audio) return;

        // Clean up the audio element
        audio.onended = null;
        audio.onerror = null;
        audio.pause();
        audio.currentTime = 0;
        audio.src = '';
        audio.inUse = false;
    }

// Play a sound with proper resource management
    function playSound(url) {
        const audio = getAudioFromPool();

        // Set up the audio to be released back to the pool when done
        audio.onended = function () {
            releaseAudioToPool(audio);
        };

        audio.onerror = function () {
            console.error('Error playing audio:', url);
            releaseAudioToPool(audio);
        };

        // Set source and play
        audio.src = url;

        // Use a promise to handle autoplay restrictions
        const playPromise = audio.play();

        if (playPromise !== undefined) {
            playPromise.catch(error => {
                console.error('Audio play failed:', error);
                releaseAudioToPool(audio);
            });
        }

        return audio;
    }

// Clean up all audio resources
    function cleanupAudioResources() {
        audioPool.forEach(audio => {
            audio.onended = null;
            audio.onerror = null;
            audio.pause();
            audio.src = '';
        });

        audioPool = [];
    }

// Initialize the audio pool when the page loads
    document.addEventListener('DOMContentLoaded', function () {
        // Initialize the audio pool
        initializeAudioPool();

        // Add WebRTC device initialization
        initializeWebRTCDevices();

        // Setup listener for device changes
        setupDeviceChangeListener();

        // Clean up audio resources when the page is unloaded
        window.addEventListener('beforeunload', cleanupAudioResources);

        // Rest of your existing code...
    });
})
