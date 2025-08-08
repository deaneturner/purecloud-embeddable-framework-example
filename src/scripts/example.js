// Define sound constants to use across the application
const SOUNDS = {
    INCOMING_CALL: '/sounds/ring.mp3',
    NOTIFICATION: '/sounds/notification.mp3',
    MESSAGE: '/sounds/message.mp3',
    VOICEMAIL: '/sounds/voicemail.mp3'
};

// Audio pool management
let audioPool = [];
const MAX_AUDIO_POOL_SIZE = 15; // Increased from 10 to handle more concurrent sounds

// WebRTC device management
let selectedAudioDeviceId = null;
let deviceAccessGranted = false;

document.addEventListener('DOMContentLoaded', function () {
    // Initialize the audio pool
    initializeAudioPool();

    // Add WebRTC device initialization
    initializeWebRTCDevices();

    // Setup listener for device changes
    setupDeviceChangeListener();

    // Clean up audio resources when the page is unloaded
    window.addEventListener('beforeunload', cleanupAudioResources);

    // Event listeners setup
    setupEventListeners();

    // Handle incoming messages
    setupMessageHandling();
});

/**
 * Initialize the pool of audio elements
 */
function initializeAudioPool() {
    // Clear any existing audio elements in the pool
    audioPool.forEach(audio => {
        cleanupAudioElement(audio);
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

/**
 * Clean up an audio element for reuse
 */
function cleanupAudioElement(audio) {
    if (!audio) return;

    // Clear any timers
    if (audio.safetyTimeout) {
        clearTimeout(audio.safetyTimeout);
        audio.safetyTimeout = null;
    }

    // Remove event listeners
    audio.onended = null;
    audio.onerror = null;

    // Reset audio state
    audio.pause();
    audio.currentTime = 0;
    audio.src = '';
    audio.inUse = false;
    audio.startTime = null;
}

/**
 * Get an available audio element from the pool
 */
function getAudioFromPool() {
    // Try to find an unused audio element
    let audio = audioPool.find(a => !a.inUse);

    if (!audio) {
        // If all are in use, find one that has ended or is paused
        audio = audioPool.find(a => a.ended || a.paused);

        if (audio) {
            cleanupAudioElement(audio);
        } else {
            // Look for an audio element that started playing more than 5 seconds ago
            const now = Date.now();
            audio = audioPool.find(a => a.startTime && (now - a.startTime > 5000));

            if (audio) {
                console.warn('Reclaiming audio element that might be stuck');
                cleanupAudioElement(audio);
            } else if (audioPool.length > 0) {
                // Last resort: take the oldest one in the pool
                audio = audioPool[0];
                console.warn('Audio pool exhausted, forcing reuse of an audio element');
                cleanupAudioElement(audio);
            } else {
                // Create a new one if the pool is somehow empty
                audio = new Audio();
                audioPool.push(audio);
                console.warn('Creating new audio element outside pool');
            }
        }
    }

    // Mark as in use and track start time
    audio.inUse = true;
    audio.startTime = Date.now();
    return audio;
}

/**
 * Release an audio element back to the pool
 */
function releaseAudioToPool(audio) {
    cleanupAudioElement(audio);
}

/**
 * Play a sound with proper resource management
 */
function playSound(url) {
    if (!url) {
        console.error('No URL provided to playSound');
        return null;
    }

    const audio = getAudioFromPool();

    // Set up release on end or error
    audio.onended = () => releaseAudioToPool(audio);
    audio.onerror = () => {
        console.error('Error playing audio:', url);
        releaseAudioToPool(audio);
    };

    // Safety timeout to release after 30 seconds
    audio.safetyTimeout = setTimeout(() => {
        if (audio.inUse) {
            console.warn('Safety timeout triggered for audio element');
            releaseAudioToPool(audio);
        }
    }, 30000);

    // Set source and play
    audio.src = url;

    const playPromise = audio.play();

    if (playPromise !== undefined) {
        playPromise.catch(error => {
            console.error('Audio play failed:', error);
            releaseAudioToPool(audio);
        });
    }

    return audio;
}

/**
 * Clean up all audio resources
 */
function cleanupAudioResources() {
    audioPool.forEach(audio => cleanupAudioElement(audio));
    audioPool = [];
}

/**
 * Initialize WebRTC devices with proper error handling
 */
function initializeWebRTCDevices() {
    // Check browser support
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        console.error('Browser does not support getUserMedia API');
        notifyWebRTCStatus({
            status: 'error',
            error: 'NotSupported',
            message: 'Browser does not support WebRTC'
        });
        return;
    }

    // Notify initialization
    notifyWebRTCStatus({
        status: 'initializing',
        message: 'Waiting for microphone permissions'
    });

    // Show permission prompt
    createPermissionPrompt();

    // Request audio permission
    navigator.mediaDevices.getUserMedia({ audio: true, video: false })
        .then(handlePermissionGranted)
        .catch(handlePermissionError);
}

/**
 * Handle successful permission grant
 */
function handlePermissionGranted(stream) {
    // Remove permission prompt
    removePermissionPrompt();

    console.log('Audio permission granted');
    deviceAccessGranted = true;

    // Extract device info from active track
    const audioTrack = stream.getAudioTracks()[0];
    if (audioTrack) {
        const settings = audioTrack.getSettings();
        if (settings.deviceId) {
            selectedAudioDeviceId = settings.deviceId;
            console.log('Selected device ID from active track:', selectedAudioDeviceId);
        }
    }

    // Stop the stream to release the device
    stream.getTracks().forEach(track => track.stop());

    // Get available devices
    return navigator.mediaDevices.enumerateDevices()
        .then(devices => {
            const audioDevices = devices.filter(d => d.kind === 'audioinput');

            if (audioDevices.length === 0) {
                throw new Error('No audio input devices found');
            }

            // Validate selected device or select a new one
            return validateOrSelectDevice(audioDevices);
        })
        .then(() => {
            // Notify ready status
            notifyWebRTCStatus({
                status: 'ready',
                deviceId: selectedAudioDeviceId
            });

            return navigator.mediaDevices.enumerateDevices();
        })
        .then(devices => {
            // Send the complete device list to the softphone
            const audioDevices = devices.filter(d => d.kind === 'audioinput');

            notifyWebRTCStatus({
                status: 'deviceList',
                deviceId: selectedAudioDeviceId,
                devices: audioDevices.map(d => ({
                    deviceId: d.deviceId,
                    label: d.label || 'Microphone'
                }))
            });
        });
}

/**
 * Handle permission errors
 */
function handlePermissionError(err) {
    // Remove permission prompt
    removePermissionPrompt();

    console.error('WebRTC initialization error:', err);

    // Handle different error types
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        showPermissionDeniedMessage();

        notifyWebRTCStatus({
            status: 'error',
            error: err.name,
            message: 'Microphone access was denied. Please allow microphone access in your browser settings.',
            isPermissionError: true
        });
    } else {
        notifyWebRTCStatus({
            status: 'error',
            error: err.name || 'Error',
            message: err.message || 'Could not access audio devices',
            isPermissionError: false
        });
    }
}

/**
 * Validate the current device or select a new one from available devices
 */
function validateOrSelectDevice(audioDevices) {
    // Check if our current device is in the list
    const deviceExists = selectedAudioDeviceId &&
        audioDevices.some(d => d.deviceId === selectedAudioDeviceId);

    if (!deviceExists) {
        // Find a non-default device if possible
        const deviceWithId = audioDevices.find(d =>
            d.deviceId && d.deviceId !== 'default' && d.deviceId !== '');

        selectedAudioDeviceId = deviceWithId ? deviceWithId.deviceId : audioDevices[0].deviceId;
        console.log('Selected new audio device:', selectedAudioDeviceId);
    }

    // Test the device to make sure it works
    return testAudioDevice(selectedAudioDeviceId);
}

/**
 * Test if a device can be accessed
 */
function testAudioDevice(deviceId) {
    console.log('Testing audio device with ID:', deviceId);

    // Use exact constraint for specific deviceId
    const constraints = deviceId ?
        { audio: { deviceId: { exact: deviceId } } } :
        { audio: true };

    return navigator.mediaDevices.getUserMedia(constraints)
        .then(stream => {
            const audioTrack = stream.getAudioTracks()[0];

            if (audioTrack) {
                // Get actual device settings
                const settings = audioTrack.getSettings();
                if (settings.deviceId) {
                    selectedAudioDeviceId = settings.deviceId;
                }
            }

            // Release the device
            stream.getTracks().forEach(track => track.stop());

            return true;
        })
        .catch(err => {
            console.error('Error testing device:', err);

            // Try with any device if specific one failed
            if (deviceId) {
                console.log('Falling back to any available audio device');
                return testAudioDevice(null);
            }

            // If even default device fails, report error
            notifyWebRTCStatus({
                status: 'error',
                error: 'DeviceAccessError',
                message: 'Could not access any audio device'
            });

            return false;
        });
}

/**
 * Update the device list when devices change
 */
function updateDeviceList() {
    if (!deviceAccessGranted) {
        console.log('Skipping device update - no permission yet');
        return;
    }

    console.log('Updating device list');

    navigator.mediaDevices.enumerateDevices()
        .then(devices => {
            const audioDevices = devices.filter(d => d.kind === 'audioinput');

            if (audioDevices.length === 0) {
                console.warn('No audio devices found during update');
                return;
            }

            // Check if selected device still exists
            const deviceExists = selectedAudioDeviceId &&
                audioDevices.some(d => d.deviceId === selectedAudioDeviceId);

            if (!deviceExists) {
                // Select a new device
                validateOrSelectDevice(audioDevices);
            }

            // Notify about updated devices
            notifyWebRTCStatus({
                status: 'updated',
                deviceId: selectedAudioDeviceId,
                devices: audioDevices.map(d => ({
                    deviceId: d.deviceId,
                    label: d.label || 'Microphone'
                }))
            });
        })
        .catch(err => console.error('Error updating device list:', err));
}

/**
 * Enhanced audio device detection with user notifications
 */
function initializeWebRTCDevices() {
    // Check browser support first
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        const errorMsg = 'Browser does not support WebRTC technology';
        console.error(errorMsg);
        showDeviceErrorNotification(errorMsg, 'BrowserNotSupported');
        return;
    }

    // Show a status message while we check devices
    showStatusMessage('Checking audio devices...');

    // First try to enumerate devices without permissions
    // This will show if devices exist but might have empty labels
    navigator.mediaDevices.enumerateDevices()
        .then(initialDevices => {
            const initialInputDevices = initialDevices.filter(d => d.kind === 'audioinput');
            const initialOutputDevices = initialDevices.filter(d => d.kind === 'audiooutput');

            console.log('Initial device scan found:', {
                inputDevices: initialInputDevices.length,
                outputDevices: initialOutputDevices.length
            });

            // Check if we have any devices at all
            if (initialInputDevices.length === 0 && initialOutputDevices.length === 0) {
                const errorMsg = 'No audio devices detected. Please connect a microphone and speakers.';
                console.error(errorMsg);
                showDeviceErrorNotification(errorMsg, 'NoDevicesFound');
                return Promise.reject(new Error('No audio devices found'));
            }

            // Now request permission to access microphone
            return navigator.mediaDevices.getUserMedia({ audio: true, video: false })
                .then(stream => {
                    // Success! We have microphone access
                    console.log('Microphone access granted');

                    // Store first track's device ID if available
                    const audioTrack = stream.getAudioTracks()[0];
                    if (audioTrack) {
                        const settings = audioTrack.getSettings();
                        if (settings.deviceId) {
                            selectedAudioInputDeviceId = settings.deviceId;
                            console.log('Selected input device from active track:', settings.deviceId);
                        }
                    }

                    // Release the stream
                    stream.getTracks().forEach(track => track.stop());

                    // Now get the full device list with proper labels
                    return navigator.mediaDevices.enumerateDevices();
                });
        })
        .then(devices => {
            // We now have devices with proper labels after permission
            const inputDevices = devices.filter(d => d.kind === 'audioinput');
            const outputDevices = devices.filter(d => d.kind === 'audiooutput');

            console.log('Found audio devices after permission:', {
                inputDevices: inputDevices.length,
                outputDevices: outputDevices.length
            });

            // Log detailed device information for debugging
            inputDevices.forEach((device, index) => {
                console.log(`Input device ${index}:`, {
                    id: device.deviceId,
                    label: device.label || 'Unnamed device'
                });
            });

            outputDevices.forEach((device, index) => {
                console.log(`Output device ${index}:`, {
                    id: device.deviceId,
                    label: device.label || 'Unnamed device'
                });
            });

            // Check if we have input devices
            if (inputDevices.length === 0) {
                const errorMsg = 'No microphone detected. Please connect a microphone.';
                console.error(errorMsg);
                showDeviceErrorNotification(errorMsg, 'NoMicrophoneFound');
                return Promise.reject(new Error('No microphone found'));
            }

            // Check if we have output devices
            if (outputDevices.length === 0) {
                // This is unusual, so we'll warn but continue
                const warnMsg = 'No audio output devices detected. Audio playback may not work.';
                console.warn(warnMsg);
                showDeviceWarningNotification(warnMsg, 'NoSpeakersFound');
                // Continue but set empty string as output device (browser default)
                selectedAudioOutputDeviceId = '';
            } else {
                // Select an output device
                const nonDefaultDevice = outputDevices.find(d =>
                    d.deviceId && d.deviceId !== 'default' && d.deviceId !== '');
                selectedAudioOutputDeviceId = nonDefaultDevice ?
                    nonDefaultDevice.deviceId : outputDevices[0].deviceId || '';
                console.log('Selected output device:', selectedAudioOutputDeviceId);
            }

            // Select an input device if not already set from active track
            if (!selectedAudioInputDeviceId || !inputDevices.some(d => d.deviceId === selectedAudioInputDeviceId)) {
                const nonDefaultDevice = inputDevices.find(d =>
                    d.deviceId && d.deviceId !== 'default' && d.deviceId !== '');
                selectedAudioInputDeviceId = nonDefaultDevice ?
                    nonDefaultDevice.deviceId : inputDevices[0].deviceId;
                console.log('Selected input device:', selectedAudioInputDeviceId);
            }

            // Test selected input device to make sure it works
            return testAudioDevice(selectedAudioInputDeviceId)
                .then(success => {
                    if (success) {
                        // Remove status message
                        removeStatusMessage();

                        // Show success notification
                        showDeviceSuccessNotification('Audio devices detected and ready');

                        // Notify PureCloud about devices
                        notifyWebRTCStatus({
                            status: 'ready',
                            deviceId: selectedAudioInputDeviceId,
                            outputDeviceId: selectedAudioOutputDeviceId,
                            inputDevices: inputDevices.map(d => ({
                                deviceId: d.deviceId,
                                label: d.label || 'Microphone',
                                kind: 'audioinput'
                            })),
                            outputDevices: outputDevices.map(d => ({
                                deviceId: d.deviceId,
                                label: d.label || 'Speaker',
                                kind: 'audiooutput'
                            }))
                        });
                    } else {
                        const errorMsg = 'Unable to access microphone. It may be in use by another application.';
                        console.error(errorMsg);
                        showDeviceErrorNotification(errorMsg, 'MicrophoneAccessFailed');
                        return Promise.reject(new Error('Microphone access failed'));
                    }
                });
        })
        .catch(err => {
            console.error('WebRTC initialization error:', err);

            // Remove status message
            removeStatusMessage();

            // Handle specific errors
            if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
                const errorMsg = 'Microphone access was denied. Please allow microphone access in your browser settings.';
                showDeviceErrorNotification(errorMsg, 'PermissionDenied');

                notifyWebRTCStatus({
                    status: 'error',
                    error: err.name,
                    message: errorMsg,
                    isPermissionError: true
                });
            } else if (err.name === 'NotFoundError') {
                const errorMsg = 'No microphone found. Please connect a microphone and refresh the page.';
                showDeviceErrorNotification(errorMsg, 'DeviceNotFound');

                notifyWebRTCStatus({
                    status: 'error',
                    error: err.name,
                    message: errorMsg,
                    isPermissionError: false
                });
            } else if (err.name === 'NotReadableError' || err.name === 'AbortError') {
                const errorMsg = 'Unable to access microphone. It may be in use by another application.';
                showDeviceErrorNotification(errorMsg, 'DeviceBusy');

                notifyWebRTCStatus({
                    status: 'error',
                    error: err.name,
                    message: errorMsg,
                    isPermissionError: false
                });
            } else {
                const errorMsg = `Audio device error: ${err.message || 'Unknown error'}`;
                showDeviceErrorNotification(errorMsg, 'UnknownError');

                notifyWebRTCStatus({
                    status: 'error',
                    error: err.name || 'Error',
                    message: errorMsg,
                    isPermissionError: false
                });
            }
        });
}

/**
 * Show a status message to the user
 */
function showStatusMessage(message) {
    // Remove any existing status message
    removeStatusMessage();

    const statusDiv = document.createElement('div');
    statusDiv.id = 'webrtc-status-message';
    statusDiv.style.position = 'fixed';
    statusDiv.style.top = '10px';
    statusDiv.style.left = '50%';
    statusDiv.style.transform = 'translateX(-50%)';
    statusDiv.style.zIndex = '9999';
    statusDiv.style.background = '#f0f8ff';
    statusDiv.style.padding = '15px';
    statusDiv.style.borderRadius = '5px';
    statusDiv.style.boxShadow = '0 2px 10px rgba(0,0,0,0.2)';
    statusDiv.style.maxWidth = '400px';

    statusDiv.innerHTML = `
        <p style="margin: 0; color: #333;">${message}</p>
        <div style="margin-top: 10px; height: 4px; background: #eee; border-radius: 2px; overflow: hidden;">
            <div id="status-progress" style="height: 100%; width: 0; background: #4a90e2; transition: width 0.3s;"></div>
        </div>
    `;

    document.body.appendChild(statusDiv);

    // Animate the progress bar
    let width = 0;
    const interval = setInterval(() => {
        const progressBar = document.getElementById('status-progress');
        if (progressBar) {
            width = (width + 1) % 100;
            progressBar.style.width = width + '%';
        } else {
            clearInterval(interval);
        }
    }, 30);
}

/**
 * Remove the status message
 */
function removeStatusMessage() {
    const statusDiv = document.getElementById('webrtc-status-message');
    if (statusDiv) {
        statusDiv.remove();
    }
}

/**
 * Show an error notification when device issues occur
 */
function showDeviceErrorNotification(message, errorCode) {
    // Remove any existing error notification
    const existingNotification = document.getElementById('webrtc-device-notification');
    if (existingNotification) {
        existingNotification.remove();
    }

    const notificationDiv = document.createElement('div');
    notificationDiv.id = 'webrtc-device-notification';
    notificationDiv.style.position = 'fixed';
    notificationDiv.style.top = '10px';
    notificationDiv.style.left = '50%';
    notificationDiv.style.transform = 'translateX(-50%)';
    notificationDiv.style.zIndex = '9999';
    notificationDiv.style.background = '#fff0f0';
    notificationDiv.style.padding = '15px';
    notificationDiv.style.borderRadius = '5px';
    notificationDiv.style.boxShadow = '0 2px 10px rgba(0,0,0,0.2)';
    notificationDiv.style.maxWidth = '400px';

    notificationDiv.innerHTML = `
        <div style="display: flex; align-items: center;">
            <div style="margin-right: 15px; color: #d32f2f; font-size: 24px;">⚠️</div>
            <div>
                <h3 style="margin-top: 0; margin-bottom: 5px; color: #d32f2f;">Audio Device Error</h3>
                <p style="margin: 0;">${message}</p>
                <p style="margin-top: 5px; font-size: 12px; color: #666;">Error code: ${errorCode}</p>
            </div>
        </div>
        <div style="display: flex; justify-content: space-between; margin-top: 15px;">
            <button id="troubleshoot-device-button" style="padding: 8px 16px; background: #f5f5f5; color: #333; border: none; border-radius: 4px; cursor: pointer;">Troubleshoot</button>
            <button id="dismiss-device-notification" style="padding: 8px 16px; background: #d32f2f; color: white; border: none; border-radius: 4px; cursor: pointer;">Dismiss</button>
        </div>
    `;

    document.body.appendChild(notificationDiv);

    // Add event listeners to buttons
    document.getElementById('dismiss-device-notification').addEventListener('click', function() {
        notificationDiv.remove();
    });

    document.getElementById('troubleshoot-device-button').addEventListener('click', function() {
        showTroubleshootingGuide(errorCode);
    });

    // Also send a notification to the softphone
    const softphone = document.getElementById("softphone");
    if (softphone && softphone.contentWindow) {
        softphone.contentWindow.postMessage(JSON.stringify({
            type: 'sendCustomNotification',
            data: {
                message: message,
                type: 'ERROR',
                timeout: 0 // Doesn't auto-dismiss
            }
        }), "*");
    }
}

/**
 * Show a warning notification for less critical device issues
 */
function showDeviceWarningNotification(message, warningCode) {
    // Similar to error notification but with warning styling
    const notificationDiv = document.createElement('div');
    notificationDiv.id = 'webrtc-device-notification';
    notificationDiv.style.position = 'fixed';
    notificationDiv.style.top = '10px';
    notificationDiv.style.left = '50%';
    notificationDiv.style.transform = 'translateX(-50%)';
    notificationDiv.style.zIndex = '9999';
    notificationDiv.style.background = '#fffde7';
    notificationDiv.style.padding = '15px';
    notificationDiv.style.borderRadius = '5px';
    notificationDiv.style.boxShadow = '0 2px 10px rgba(0,0,0,0.2)';
    notificationDiv.style.maxWidth = '400px';

    notificationDiv.innerHTML = `
        <div style="display: flex; align-items: center;">
            <div style="margin-right: 15px; color: #f57c00; font-size: 24px;">⚠️</div>
            <div>
                <h3 style="margin-top: 0; margin-bottom: 5px; color: #f57c00;">Audio Device Warning</h3>
                <p style="margin: 0;">${message}</p>
                <p style="margin-top: 5px; font-size: 12px; color: #666;">Warning code: ${warningCode}</p>
            </div>
        </div>
        <button id="dismiss-device-notification" style="margin-top: 10px; padding: 8px 16px; background: #f57c00; color: white; border: none; border-radius: 4px; cursor: pointer;">Dismiss</button>
    `;

    document.body.appendChild(notificationDiv);

    // Add event listener to dismiss button
    document.getElementById('dismiss-device-notification').addEventListener('click', function() {
        notificationDiv.remove();
    });

    // Also send a notification to the softphone
    const softphone = document.getElementById("softphone");
    if (softphone && softphone.contentWindow) {
        softphone.contentWindow.postMessage(JSON.stringify({
            type: 'sendCustomNotification',
            data: {
                message: message,
                type: 'WARNING',
                timeout: 10000 // Auto-dismiss after 10 seconds
            }
        }), "*");
    }
}

/**
 * Show a success notification when devices are successfully detected
 */
function showDeviceSuccessNotification(message) {
    const notificationDiv = document.createElement('div');
    notificationDiv.id = 'webrtc-device-notification';
    notificationDiv.style.position = 'fixed';
    notificationDiv.style.top = '10px';
    notificationDiv.style.left = '50%';
    notificationDiv.style.transform = 'translateX(-50%)';
    notificationDiv.style.zIndex = '9999';
    notificationDiv.style.background = '#e8f5e9';
    notificationDiv.style.padding = '15px';
    notificationDiv.style.borderRadius = '5px';
    notificationDiv.style.boxShadow = '0 2px 10px rgba(0,0,0,0.2)';
    notificationDiv.style.maxWidth = '400px';

    notificationDiv.innerHTML = `
        <div style="display: flex; align-items: center;">
            <div style="margin-right: 15px; color: #4caf50; font-size: 24px;">✅</div>
            <div>
                <h3 style="margin-top: 0; margin-bottom: 5px; color: #4caf50;">Audio Ready</h3>
                <p style="margin: 0;">${message}</p>
            </div>
        </div>
    `;

    document.body.appendChild(notificationDiv);

    // Auto-dismiss after 5 seconds
    setTimeout(() => {
        if (notificationDiv.parentNode) {
            notificationDiv.remove();
        }
    }, 5000);

    // Also send a notification to the softphone
    const softphone = document.getElementById("softphone");
    if (softphone && softphone.contentWindow) {
        softphone.contentWindow.postMessage(JSON.stringify({
            type: 'sendCustomNotification',
            data: {
                message: message,
                type: 'SUCCESS',
                timeout: 5000 // Auto-dismiss after 5 seconds
            }
        }), "*");
    }
}

/**
 * Show a troubleshooting guide for specific error codes
 */
function showTroubleshootingGuide(errorCode) {
    // Remove any existing troubleshooting guide
    const existingGuide = document.getElementById('webrtc-troubleshooting-guide');
    if (existingGuide) {
        existingGuide.remove();
    }

    // Define troubleshooting steps based on error code
    let troubleshootingSteps = [];

    switch(errorCode) {
        case 'NoDevicesFound':
            troubleshootingSteps = [
                'Make sure your microphone and speakers are properly connected to your computer.',
                'Try unplugging and plugging your devices back in.',
                'Check if your devices are recognized in your operating system settings.',
                'Restart your browser and try again.',
                'If using a USB headset, try a different USB port.'
            ];
            break;

        case 'NoMicrophoneFound':
            troubleshootingSteps = [
                'Connect a microphone to your computer.',
                'If using a built-in microphone, make sure it\'s not disabled in your system settings.',
                'Try using a different microphone if available.',
                'Check if your microphone is recognized in your operating system settings.',
                'Restart your computer and try again.'
            ];
            break;

        case 'NoSpeakersFound':
            troubleshootingSteps = [
                'Make sure your speakers or headphones are properly connected.',
                'Check if your audio output device is selected in your system settings.',
                'Try adjusting the volume using your system controls.',
                'Try using different speakers or headphones if available.',
                'Restart your browser and try again.'
            ];
            break;

        case 'PermissionDenied':
            troubleshootingSteps = [
                'Click the camera/microphone icon in your browser\'s address bar and select "Allow".',
                'Check your browser settings to ensure microphone permissions are enabled for this site.',
                'If using Chrome, go to chrome://settings/content/microphone to manage permissions.',
                'If using Firefox, go to about:preferences#privacy and scroll to Permissions.',
                'Refresh the page after allowing microphone access.'
            ];
            break;

        case 'DeviceNotFound':
            troubleshootingSteps = [
                'Connect a microphone to your computer.',
                'Try using a different USB port if using an external microphone.',
                'Check if your microphone is muted with a hardware switch.',
                'Make sure no other application is exclusively using your microphone.',
                'Restart your browser after connecting your microphone.'
            ];
            break;

        case 'DeviceBusy':
            troubleshootingSteps = [
                'Close other applications that might be using your microphone (like Zoom, Teams, etc.).',
                'Check if you have multiple browser tabs open that might be using the microphone.',
                'Restart your browser to release microphone resources.',
                'Try disconnecting and reconnecting your microphone.',
                'Restart your computer if the issue persists.'
            ];
            break;

        case 'BrowserNotSupported':
            troubleshootingSteps = [
                'Update your browser to the latest version.',
                'Try using a different browser like Chrome, Firefox, or Edge.',
                'Check if your browser has WebRTC enabled in its settings.',
                'If you\'re on a corporate network, contact your IT department to ensure WebRTC is not blocked.',
                'Try disabling browser extensions that might interfere with WebRTC.'
            ];
            break;

        default:
            troubleshootingSteps = [
                'Refresh the page and try again.',
                'Check if your microphone and speakers are properly connected.',
                'Try using different audio devices if available.',
                'Restart your browser.',
                'Clear your browser cache and cookies.',
                'Restart your computer.',
                'Contact support if the issue persists.'
            ];
    }

    // Create the troubleshooting guide
    const guideDiv = document.createElement('div');
    guideDiv.id = 'webrtc-troubleshooting-guide';
    guideDiv.style.position = 'fixed';
    guideDiv.style.top = '50%';
    guideDiv.style.left = '50%';
    guideDiv.style.transform = 'translate(-50%, -50%)';
    guideDiv.style.zIndex = '10000';
    guideDiv.style.background = 'white';
    guideDiv.style.padding = '20px';
    guideDiv.style.borderRadius = '8px';
    guideDiv.style.boxShadow = '0 4px 20px rgba(0,0,0,0.3)';
    guideDiv.style.maxWidth = '500px';
    guideDiv.style.width = '90%';
    guideDiv.style.maxHeight = '80vh';
    guideDiv.style.overflow = 'auto';

    // Create the HTML for the guide
    let stepsHtml = '';
    troubleshootingSteps.forEach((step, index) => {
        stepsHtml += `<li style="margin-bottom: 10px;">${step}</li>`;
    });

    guideDiv.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
            <h2 style="margin: 0; color: #333;">Troubleshooting Guide</h2>
            <button id="close-troubleshooting-guide" style="background: none; border: none; font-size: 20px; cursor: pointer;">×</button>
        </div>
        <p style="color: #666;">Problem: <strong>${errorCodeToHumanReadable(errorCode)}</strong></p>
        <h3 style="margin-top: 15px; color: #333;">Try these steps:</h3>
        <ol style="padding-left: 20px; color: #333;">
            ${stepsHtml}
        </ol>
        <div style="margin-top: 20px; padding-top: 15px; border-top: 1px solid #eee;">
            <p style="color: #666; margin-bottom: 10px;">Still having issues?</p>
            <button id="retry-device-detection" style="padding: 8px 16px; background: #4a90e2; color: white; border: none; border-radius: 4px; cursor: pointer; margin-right: 10px;">Retry Device Detection</button>
            <button id="continue-without-audio" style="padding: 8px 16px; background: #f5f5f5; color: #333; border: none; border-radius: 4px; cursor: pointer;">Continue Without Audio</button>
        </div>
    `;

    document.body.appendChild(guideDiv);

    // Add event listeners
    document.getElementById('close-troubleshooting-guide').addEventListener('click', function() {
        guideDiv.remove();
    });

    document.getElementById('retry-device-detection').addEventListener('click', function() {
        guideDiv.remove();
        initializeWebRTCDevices();
    });

    document.getElementById('continue-without-audio').addEventListener('click', function() {
        guideDiv.remove();
        // Notify app to continue with default devices
        notifyWebRTCStatus({
            status: 'ready',
            deviceId: '',
            outputDeviceId: '',
            forceFallback: true
        });
    });
}

/**
 * Convert error codes to human-readable descriptions
 */
function errorCodeToHumanReadable(errorCode) {
    switch(errorCode) {
        case 'NoDevicesFound':
            return 'No audio devices detected';
        case 'NoMicrophoneFound':
            return 'No microphone detected';
        case 'NoSpeakersFound':
            return 'No speakers detected';
        case 'PermissionDenied':
            return 'Microphone access denied';
        case 'DeviceNotFound':
            return 'Microphone not found or disconnected';
        case 'DeviceBusy':
            return 'Microphone is being used by another application';
        case 'BrowserNotSupported':
            return 'Browser does not support WebRTC';
        default:
            return 'Unknown audio device error';
    }
}

/**
 * Select a specific audio device
 */
function selectAudioDevice(deviceId) {
    if (!deviceId) {
        console.error('No device ID provided for selection');
        return;
    }

    console.log('Selecting audio device:', deviceId);

    // Validate device exists
    navigator.mediaDevices.enumerateDevices()
        .then(devices => {
            const audioDevices = devices.filter(d => d.kind === 'audioinput');
            const deviceExists = audioDevices.some(d => d.deviceId === deviceId);

            if (deviceExists) {
                // Test device before confirming selection
                testAudioDevice(deviceId)
                    .then(success => {
                        if (success) {
                            selectedAudioDeviceId = deviceId;

                            notifyWebRTCStatus({
                                status: 'ready',
                                deviceId: deviceId
                            });
                        }
                    });
            } else {
                console.error('Selected device does not exist:', deviceId);
                validateOrSelectDevice(audioDevices);
            }
        })
        .catch(err => console.error('Error in device selection:', err));
}

/**
 * Set up device change listener
 */
function setupDeviceChangeListener() {
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
        navigator.mediaDevices.addEventListener('devicechange', () => {
            console.log('Media devices changed');
            updateDeviceList();
        });
    }
}

/**
 * Notify the softphone about WebRTC status
 */
function notifyWebRTCStatus(data) {
    const softphone = document.getElementById("softphone");
    if (softphone && softphone.contentWindow) {
        softphone.contentWindow.postMessage(JSON.stringify({
            type: 'audioDeviceStatus',
            data: data
        }), "*");
    } else {
        console.error('Softphone iframe not found');
    }
}

/**
 * Create UI for permission prompt
 */
function createPermissionPrompt() {
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

/**
 * Remove permission prompt
 */
function removePermissionPrompt() {
    const prompt = document.getElementById('webrtc-permission-prompt');
    if (prompt) prompt.remove();
}

/**
 * Show message when permission is denied
 */
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

    document.getElementById('dismiss-permission-message').addEventListener('click', () => {
        messageDiv.remove();
    });
}

/**
 * Handle sound for interaction events
 */
function handleInteractionSound(message) {
    if (!message.data || !message.data.interaction) return;

    const interaction = message.data.interaction;

    // Check if this is a new alerting interaction
    if (interaction.state === 'alerting' && (!interaction.old || interaction.old.state !== 'alerting')) {
        // Play appropriate sound for the interaction type
        if (interaction.type === 'call') {
            playSound(SOUNDS.INCOMING_CALL);
        } else if (interaction.type === 'message') {
            playSound(SOUNDS.MESSAGE);
        } else if (interaction.type === 'voicemail') {
            playSound(SOUNDS.VOICEMAIL);
        } else {
            playSound(SOUNDS.NOTIFICATION);
        }
    }
}

/**
 * Set up all event listeners
 */
function setupEventListeners() {
    const elements = {
        clickToDial: document.getElementById("clickToDial"),
        addAssociation: document.getElementById("addAssociation"),
        addAttribute: document.getElementById("addAttribute"),
        addTransferContext: document.getElementById("addTransferContext"),
        updateUserStatus: document.getElementById("updateUserStatus"),
        updateAudioConfiguration: document.getElementById("updateAudioConfiguration"),
        sendCustomNotification: document.getElementById("sendCustomNotification"),
        pickupInteraction: document.getElementById("pickupInteraction"),
        securePauseInteraction: document.getElementById("securePauseInteraction"),
        disconnectInteraction: document.getElementById("disconnectInteraction"),
        holdInteraction: document.getElementById("holdInteraction"),
        muteInteraction: document.getElementById("muteInteraction"),
        viewInteractionList: document.getElementById("view-interactionList"),
        viewCalllog: document.getElementById("view-calllog"),
        viewNewInteraction: document.getElementById("view-newInteraction"),
        viewCallback: document.getElementById("view-callback"),
        viewSettings: document.getElementById("view-settings")
    };

    // Add click listeners
    if (elements.clickToDial) elements.clickToDial.addEventListener("click", clickToDial);
    if (elements.addAssociation) elements.addAssociation.addEventListener("click", addAssociation);
    if (elements.addAttribute) elements.addAttribute.addEventListener("click", addAttribute);
    if (elements.addTransferContext) elements.addTransferContext.addEventListener("click", addTransferContext);
    if (elements.updateUserStatus) elements.updateUserStatus.addEventListener("click", updateUserStatus);
    if (elements.updateAudioConfiguration) elements.updateAudioConfiguration.addEventListener("click", updateAudioConfiguration);
    if (elements.sendCustomNotification) elements.sendCustomNotification.addEventListener("click", sendCustomNotification);

    // Interaction state controls
    if (elements.pickupInteraction) elements.pickupInteraction.addEventListener("click", updateInteractionState);
    if (elements.securePauseInteraction) elements.securePauseInteraction.addEventListener("click", updateInteractionState);
    if (elements.disconnectInteraction) elements.disconnectInteraction.addEventListener("click", updateInteractionState);
    if (elements.holdInteraction) elements.holdInteraction.addEventListener("click", updateInteractionState);
    if (elements.muteInteraction) elements.muteInteraction.addEventListener("click", updateInteractionState);

    // View controls
    if (elements.viewInteractionList) elements.viewInteractionList.addEventListener("click", setView);
    if (elements.viewCalllog) elements.viewCalllog.addEventListener("click", setView);
    if (elements.viewNewInteraction) elements.viewNewInteraction.addEventListener("click", setView);
    if (elements.viewCallback) elements.viewCallback.addEventListener("click", setView);
    if (elements.viewSettings) elements.viewSettings.addEventListener("click", setView);
}

/**
 * Set up message handling
 */
function setupMessageHandling() {
    window.addEventListener("message", function(event) {
        try {
            const message = JSON.parse(event.data);
            if (message) {
                if (message.type === "screenPop") {
                    document.getElementById("screenPopPayload").value = event.data;
                    playSound(SOUNDS.INCOMING_CALL);
                } else if (message.type === "processCallLog") {
                    document.getElementById("processCallLogPayLoad").value = event.data;
                } else if (message.type === "openCallLog") {
                    document.getElementById("openCallLogPayLoad").value = event.data;
                } else if (message.type === "interactionSubscription") {
                    document.getElementById("interactionSubscriptionPayload").value = event.data;
                    handleInteractionSound(message);
                } else if (message.type === "userActionSubscription") {
                    document.getElementById("userActionSubscriptionPayload").value = event.data;
                } else if (message.type === "notificationSubscription") {
                    document.getElementById("notificationSubscriptionPayload").value = event.data;
                    playSound(SOUNDS.NOTIFICATION);
                } else if (message.type === "contactSearch") {
                    document.getElementById("searchText").innerHTML = ": " + message.data.searchString;
                    sendContactSearch();
                } else if (message.type === "selectAudioDevice" && message.data && message.data.deviceId) {
                    selectAudioDevice(message.data.deviceId);
                }
            }
        } catch (e) {
            console.error('Error processing message:', e);
        }
    });
}

// Action functions
function clickToDial() {
    console.log('Process click to dial');
    sendToSoftphone({
        type: 'clickToDial',
        data: {number: '3172222222', autoPlace: true}
    });
}

function addAssociation() {
    console.log('Process add association');
    sendToSoftphone({
        type: 'addAssociation',
        data: JSON.parse(document.getElementById("associationPayload").value)
    });
}

function addAttribute() {
    console.log('Process add attribute');
    sendToSoftphone({
        type: 'addAttribute',
        data: JSON.parse(document.getElementById("attributePayload").value)
    });
}

function addTransferContext() {
    console.log('Process add Transfer Context');
    sendToSoftphone({
        type: 'addTransferContext',
        data: JSON.parse(document.getElementById("transferContextPayload").value)
    });
}

function sendContactSearch() {
    console.log('Process contact search');
    sendToSoftphone({
        type: 'sendContactSearch',
        data: JSON.parse(document.getElementById("contactSearchPayload").value)
    });
}

function updateUserStatus() {
    console.log('Process user status update');
    sendToSoftphone({
        type: 'updateUserStatus',
        data: {id: document.getElementById("statusDropDown").value}
    });
}

function updateInteractionState(event) {
    console.log('Process interaction state change');

    const lastInteractionPayload = JSON.parse(
        document.getElementById("interactionSubscriptionPayload").value
    );

    let interactionId;
    if (lastInteractionPayload.data.interaction.old) {
        interactionId = lastInteractionPayload.data.interaction.old.id;
    } else {
        interactionId = lastInteractionPayload.data.interaction.id;
    }

    sendToSoftphone({
        type: 'updateInteractionState',
        data: {
            action: event.target.outerText,
            id: interactionId
        }
    });
}

function updateAudioConfiguration() {
    console.log('Update Audio Configuration');

    sendToSoftphone({
        type: 'updateAudioConfiguration',
        data: {
            call: document.getElementById('audio-call').checked,
            chat: document.getElementById('audio-chat').checked,
            email: document.getElementById('audio-email').checked,
            callback: document.getElementById('audio-callback').checked,
            message: document.getElementById('audio-message').checked,
            voicemail: document.getElementById('audio-voicemail').checked,
            deviceId: selectedAudioDeviceId
        }
    });
}

function setView(event) {
    console.log('Process view update');

    sendToSoftphone({
        type: 'setView',
        data: {
            type: "main",
            view: {
                name: event.target.outerText
            }
        }
    });
}

function sendCustomNotification() {
    console.log('Send Custom User Notification');

    // Play notification sound
    playSound(SOUNDS.NOTIFICATION);

    sendToSoftphone({
        type: 'sendCustomNotification',
        data: {
            message: document.getElementById('customNotificationMessage').value,
            type: document.getElementById('notificationType').value,
            timeout: document.getElementById('notificationTimeout').value
        }
    });
}

/**
 * Helper to send messages to the softphone iframe
 */
function sendToSoftphone(data) {
    const softphone = document.getElementById("softphone");
    if (softphone && softphone.contentWindow) {
        softphone.contentWindow.postMessage(JSON.stringify(data), "*");
    } else {
        console.error('Softphone iframe not found');
    }
}
