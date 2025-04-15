// electron-app/robotjsControl.js

const { app, BrowserWindow, desktopCapturer, ipcMain } = require("electron");
const robot = require("robotjs");
const io = require("socket.io-client");
const path = require("path");
const os = require('os');

let globalSocket = null;
let currentClientId = null;

function createWindow() {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
    icon: path.join(__dirname, 'icon.png'),
  });

  // Load the HTML file
  win.loadFile(path.join(__dirname, 'index.html'));

  // Connect to the socket.io server with reconnection settings
  const socket = io("http://15.206.194.12:8080", {
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    timeout: 20000,
    autoConnect: true,
    path: '/socket.io',
    transports: ['polling', 'websocket'],
    upgrade: true,
    rememberUpgrade: true,
    forceJSONP: false,
    extraHeaders: {
      "User-Agent": "ElectronApp/1.0"
    }
  });
  
  // Store socket reference globally
  globalSocket = socket;
  
  let screenShareInterval = null;
  let pingInterval = null;

  // Handle connection
  socket.on("connect", () => {
    console.log("Connected as host with ID:", socket.id);
    
    // Get computer name
    const computerName = os.hostname();
    
    win.webContents.send('connection-id', socket.id);
    win.webContents.send('connect');
    
    // Emit host-ready with computer name
    socket.emit("host-ready", { computerName });
    
    // Setup ping interval to keep connection alive
    if (pingInterval) clearInterval(pingInterval);
    pingInterval = setInterval(() => {
      socket.emit("keep-alive");
    }, 10000); // Send a ping every 10 seconds
  });

  // Handle controller connection
  socket.on("controller-connected", (controllerId) => {
    console.log("Controller connected:", controllerId);
    currentClientId = controllerId;
    win.webContents.send('status-update', `Controller ${controllerId} connected`);
  });

  // Start screen sharing when requested
  socket.on("request-screen", async (data) => {
    try {
      console.log("Screen sharing requested by:", data.from);
      currentClientId = data.from;
      win.webContents.send('status-update', 'Starting screen sharing...');
      
      // Clear any existing interval
      if (screenShareInterval) {
        clearInterval(screenShareInterval);
      }
      
      // Function to capture and send screen
      const sendScreen = async () => {
        try {
          const sources = await desktopCapturer.getSources({ 
            types: ['screen'],
            thumbnailSize: { width: 960, height: 720 }
          });
          
          if (sources.length > 0) {
            const imageDataUrl = sources[0].thumbnail.toDataURL('image/jpeg', 0.3);
            socket.emit("screen-data", { 
              to: data.from,
              imageData: imageDataUrl
            });
          }
        } catch (err) {
          console.error("Error capturing screen:", err);
        }
      };
      
      // Send initial screen capture
      await sendScreen();
      
      screenShareInterval = setInterval(sendScreen, 1000);
    } catch (err) {
      console.error("Error setting up screen sharing:", err);
      win.webContents.send('status-update', 'Screen sharing error: ' + err.message);
    }
  });

  // Handle when controller disconnects
  socket.on("controller-disconnected", () => {
    currentClientId = null;
    if (screenShareInterval) {
      clearInterval(screenShareInterval);
      screenShareInterval = null;
    }
    win.webContents.send('status-update', 'Controller disconnected');
  });

  // Handle mouse movement with improved positioning
  socket.on("remote-mouse-move", (data) => {
    try {
      const { x, y, screenWidth, screenHeight } = data;
      
      // Get the local screen size
      const { width: localWidth, height: localHeight } = robot.getScreenSize();
      
      // Convert the coordinates proportionally based on the remote screen size
      const scaledX = Math.round((x / screenWidth) * localWidth);
      const scaledY = Math.round((y / screenHeight) * localHeight);
      
      console.log(`Mouse move: Original(${x},${y}) => Scaled(${scaledX},${scaledY})`);
      
      // Move the mouse to the scaled position
      robot.moveMouse(scaledX, scaledY);
    } catch (err) {
      console.error("Error handling mouse move:", err);
    }
  });

  // Handle improved key events (down/up)
  socket.on("remote-key-event", (data) => {
    try {
      const { type, key, modifiers } = data;
      console.log(`Received key ${type}:`, key, "Modifiers:", JSON.stringify(modifiers));
      
      // Map keys from browser format to robotjs format
      const keyMap = {
        'ArrowUp': 'up',
        'ArrowDown': 'down',
        'ArrowLeft': 'left',
        'ArrowRight': 'right',
        'Backspace': 'backspace',
        'Delete': 'delete',
        'Enter': 'enter',
        'Tab': 'tab',
        'Escape': 'escape',
        'Home': 'home',
        'End': 'end',
        'PageUp': 'pageup',
        'PageDown': 'pagedown',
        ' ': 'space',
        'Control': 'control',
        'Shift': 'shift',
        'Alt': 'alt',
        'Meta': 'command',
        'CapsLock': 'caps_lock'
      };
      
      // Explicitly define the toggle state as a string value
      const toggleState = (type === 'down') ? 'down' : 'up';
      
      // Special handling for CapsLock
      if (key === 'CapsLock') {
        // Instead of trying to toggle CapsLock (which can be problematic),
        // let's use a key tap approach
        if (type === 'down') {
          robot.keyTap('caps_lock');
          console.log("Tapped caps_lock key");
        }
        win.webContents.send('status-update', `CapsLock tap`);
        return;
      }
      
      // Get robotjs key
      let robotKey = keyMap[key] || key.toLowerCase();
      
      // Build modifier array
      const activeModifiers = [];
      if (modifiers.shift) activeModifiers.push('shift');
      if (modifiers.control) activeModifiers.push('control');
      if (modifiers.alt) activeModifiers.push('alt');
      if (modifiers.meta) activeModifiers.push('command');
      
      // For modifier keys themselves
      if (key === 'Shift' || key === 'Control' || key === 'Alt' || key === 'Meta') {
        robot.keyToggle(robotKey, toggleState);
      } 
      // For regular keys with modifiers
      else if (activeModifiers.length > 0 && type === 'down') {
        robot.keyTap(robotKey, activeModifiers);
      } 
      // For regular keys
      else {
        if (type === 'down') {
          robot.keyToggle(robotKey, 'down');
        } else {
          robot.keyToggle(robotKey, 'up');
        }
      }
      
      win.webContents.send('status-update', `Key ${type}: ${key}`);
    } catch (err) {
      console.error(`Error handling key ${type}:`, err);
      console.error("Key data:", data);
      win.webContents.send('status-update', `Error with key ${type}: ${data.key} - ${err.message}`);
    }
  });

  // Handle mouse click
  socket.on("remote-mouse-click", (data) => {
    try {
      const { button } = data;
      robot.mouseClick(button || "left");
    } catch (err) {
      console.error("Error handling mouse click:", err);
    }
  });

  // Handle mouse scrolling
  socket.on("remote-mouse-scroll", (data) => {
    try {
      const { deltaY } = data;
      
      // In browser wheel events:
      // deltaY > 0 means scroll down, deltaY < 0 means scroll up
      // For robotjs, we need to convert this to direction and amount
      
      // Determine scroll direction
      const direction = deltaY < 0 ? "up" : "down";
      
      // Calculate scroll amount (normalize it to something reasonable)
      // Average wheel delta is around 100-125 per scroll "click"
      const scrollAmount = Math.ceil(Math.abs(deltaY) / 100);
      
      console.log(`Scroll ${direction} by ${scrollAmount}`);
      
      // Execute the scroll
      for (let i = 0; i < scrollAmount; i++) {
        robot.scrollMouse(1, direction);
      }
      
      win.webContents.send('status-update', `Scrolled ${direction}`);
    } catch (err) {
      console.error("Error handling mouse scroll:", err);
    }
  });

  // Add better error handling
  socket.on('connect_error', (error) => {
    console.error("Connection error:", error.message);
    win.webContents.send('status-update', `Connection error: ${error.message}`);
    win.webContents.send('disconnect');
  });

  socket.on('connect_timeout', () => {
    console.error("Connection timeout");
    win.webContents.send('status-update', 'Connection timeout');
    win.webContents.send('disconnect');
  });

  socket.on('reconnect_attempt', (attemptNumber) => {
    console.log(`Reconnection attempt #${attemptNumber}`);
    win.webContents.send('status-update', `Reconnecting (attempt ${attemptNumber})...`);
    win.webContents.send('reconnect_attempt');
  });

  socket.on('disconnect', (reason) => {
    console.log(`Disconnected: ${reason}`);
    currentClientId = null;
    if (screenShareInterval) {
      clearInterval(screenShareInterval);
      screenShareInterval = null;
    }
    win.webContents.send('status-update', 'Connection lost. Attempting to reconnect...');
    win.webContents.send('disconnect');
    
    if (reason === 'io server disconnect') {
      // Server disconnected us, try to reconnect manually
      setTimeout(() => {
        socket.connect();
      }, 1000);
    }
  });

  // Handle window close
  win.on('closed', () => {
    if (screenShareInterval) {
      clearInterval(screenShareInterval);
    }
    if (pingInterval) {
      clearInterval(pingInterval);
    }
    socket.disconnect();
  });
  
  // Handle disconnect client request from renderer
  ipcMain.on('disconnect-client', () => {
    if (currentClientId) {
      console.log(`Manually disconnecting client: ${currentClientId}`);
      socket.emit("disconnect-client", currentClientId);
      
      // Cleanup
      if (screenShareInterval) {
        clearInterval(screenShareInterval);
        screenShareInterval = null;
      }
      
      win.webContents.send('status-update', 'Client manually disconnected');
      currentClientId = null;
    } else {
      win.webContents.send('status-update', 'No client connected to disconnect');
    }
  });

  // Add this new socket listener to handle client-initiated disconnects
  socket.on("client-disconnect-request", (data) => {
    // If a client is requesting to disconnect
    if (data.from && data.from === currentClientId) {
      console.log(`Client ${currentClientId} requested to disconnect`);
      
      // Clean up screen sharing
      if (screenShareInterval) {
        clearInterval(screenShareInterval);
        screenShareInterval = null;
      }
      
      // Update UI
      win.webContents.send('status-update', 'Client disconnected by their request');
      
      // Reset the client ID
      currentClientId = null;
      
      // Acknowledge the disconnect to the client
      socket.emit("host-disconnect-ack", { to: data.from });
    }
  });
}

// Initialize the app when Electron is ready
app.whenReady().then(createWindow);

// Quit when all windows are closed
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

module.exports = { createWindow };


