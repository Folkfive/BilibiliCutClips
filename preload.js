const { contextBridge, ipcRenderer } = require('electron');

// Whitelist of channels to allow sending messages from renderer to main
const validSendChannels = ['get-stream-url', 'start-recording', 'stop-recording', 'open-clips-folder'];
// Whitelist of channels to allow receiving messages from main to renderer
const validReceiveChannels = ['stream-url-reply', 'recording-progress', 'clip-saved', 'cache-duration-update'];

contextBridge.exposeInMainWorld('electron', {
    ipcRenderer: {
        send: (channel, data) => {
            // Send message to main process if channel is in whitelist
            if (validSendChannels.includes(channel)) {
                ipcRenderer.send(channel, data);
            } else {
                console.warn(`[Preload] Blocked sending message to channel '${channel}' from renderer.`);
            }
        },
        // Expose an 'on' method that takes the channel and callback
        on: (channel, callback) => {
            if (validReceiveChannels.includes(channel)) {
                // Define the actual listener that will be registered with Electron's ipcRenderer
                const listener = (event, ...args) => {
                    console.log(`[Preload] Internal listener invoked for '${channel}' with args:`, args);
                    // Call the callback provided by the renderer process, passing the arguments
                    try {
                        callback(args[0]); // 只传第一个参数
                    } catch (e) {
                        console.error(`[Preload] Error executing callback provided by renderer for channel '${channel}':`, e);
                    }
                };
                // Register the listener
                ipcRenderer.on(channel, listener);
                console.log(`[Preload] Registered listener for channel '${channel}'`);

                // Return an unsubscribe function specific to this registration
                return () => {
                    console.log(`[Preload] Removing listener for channel '${channel}'`);
                    ipcRenderer.removeListener(channel, listener);
                };
            } else {
                console.warn(`[Preload] Blocked registration for channel '${channel}' from main.`);
                return () => {}; // Return dummy unsubscribe
            }
        },
        removeAllListeners: (channel) => {
             if (validReceiveChannels.includes(channel)) {
                 console.log(`[Preload] Removing all listeners for channel '${channel}'`);
                 ipcRenderer.removeAllListeners(channel);
             } else {
                 console.warn(`[Preload] Blocked removing listeners for channel '${channel}'.`);
             }
        }
    }
});

console.log('[Preload] Preload script executed successfully.');
