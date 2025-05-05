const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fetch = require('node-fetch');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');

// --- Global Variables for Caching ---
let cacheProcess = null;
let cacheFilePath = null;
let cacheStartTime = null;
let currentCachingUrl = null;
let cacheDurationUpdateInterval = null; // Timer for sending duration updates
let mainWindow = null; // Reference to the main window to send IPC messages

// --- Main Window Creation ---
function createWindow() {
    mainWindow = new BrowserWindow({ // Assign to mainWindow
        width: 1200,
        height: 800,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });
    mainWindow.loadFile('index.html');
    // mainWindow.webContents.openDevTools(); // Optional
    mainWindow.on('closed', () => { mainWindow = null; }); // Clear reference on close
}

// --- Bilibili API Logic (Reverted to simpler version) ---
async function getRealRoomId(roomIdentifier) {
    // ... (Keep the existing getRealRoomId function) ...
    let roomId = parseInt(roomIdentifier);
    if (!isNaN(roomId)) {
        try {
            const initUrl = `https://api.live.bilibili.com/room/v1/Room/room_init?id=${roomId}`;
            const response = await fetch(initUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
            if (!response.ok) throw new Error(`Room Init API Error: ${response.statusText}`);
            const data = await response.json();
            if (data.code === 0 && data.data && data.data.room_id) {
                console.log(`Room Init Success: Short ID ${roomId} -> Real ID ${data.data.room_id}`);
                return data.data.room_id;
            } else {
                console.warn(`Room Init API did not return expected data for ID ${roomId}. Assuming it might be the real ID or invalid.`);
                return roomId;
            }
        } catch (error) {
            console.error(`Error fetching real room ID from room_init for ${roomId}:`, error);
            return roomId;
        }
    } else {
        const match = roomIdentifier.match(/live\.bilibili\.com\/(\d+)/);
        if (match && match[1]) return getRealRoomId(match[1]);
    }
    throw new Error('无法识别的房间号或URL格式');
}

async function getBilibiliStreamUrl(roomIdentifier) {
    console.log(`Main process received request for: ${roomIdentifier}`);
    try {
        const realRoomId = await getRealRoomId(roomIdentifier);
        if (!realRoomId) throw new Error('无法获取真实房间号');
        console.log(`Attempting to fetch stream URL for real room ID: ${realRoomId}`);

        const playUrlApi = `https://api.live.bilibili.com/room/v1/Room/playUrl?cid=${realRoomId}&qn=10000&platform=web`;
        const response = await fetch(playUrlApi, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Referer': `https://live.bilibili.com/${realRoomId}`
            }
        });
        if (!response.ok) throw new Error(`PlayUrl API Error: ${response.statusText}`);
        const data = await response.json();

        if (data.code !== 0) throw new Error(data.message || `API错误 (代码: ${data.code})`);
        if (!data.data || !data.data.durl || !Array.isArray(data.data.durl) || data.data.durl.length === 0) {
            throw new Error('API响应中未找到有效的直播流地址 (durl)');
        }

        // Primarily use FLV from durl as before
        let streamUrl = null;
        for (const stream of data.data.durl) {
            if (stream.url && typeof stream.url === 'string' && stream.url.includes('.flv')) {
                streamUrl = stream.url;
                console.log(`Found FLV stream URL: ${streamUrl}`);
                break;
            }
        }
        if (!streamUrl && data.data.durl[0]?.url && typeof data.data.durl[0].url === 'string') {
             streamUrl = data.data.durl[0].url;
             console.log(`No FLV found, using first available stream URL: ${streamUrl}`);
        }
        if (!streamUrl) throw new Error('API响应中未找到可用的直播流 URL');

        // Return only the URL
        return streamUrl;

    } catch (error) {
        console.error("Error fetching Bilibili stream URL in main process:", error);
        throw new Error(`获取直播流失败: ${error.message}`);
    }
}


// --- Live Stream Caching Logic (Single .mp4 file) ---
function stopLiveCaching() {
    // *** Clear the duration update interval ***
    if (cacheDurationUpdateInterval) {
        clearInterval(cacheDurationUpdateInterval);
        cacheDurationUpdateInterval = null;
        console.log('Stopped cache duration updates.');
    }
    return new Promise((resolve) => {
        if (cacheProcess) {
            console.log('Stopping existing live cache process...');
            cacheProcess.stdout.removeAllListeners();
            cacheProcess.stderr.removeAllListeners();
            cacheProcess.removeAllListeners('close');
            cacheProcess.removeAllListeners('error');
            try {
                if (cacheProcess.stdin.writable) {
                    cacheProcess.stdin.write('q\n');
                    console.log("Sent 'q' to cache process stdin.");
                    const killTimeout = setTimeout(() => {
                        console.warn('Cache process did not exit gracefully, killing.');
                        if (cacheProcess && !cacheProcess.killed) cacheProcess.kill('SIGKILL');
                        cacheProcess = null;
                        resolve();
                    }, 2000);
                    cacheProcess.once('close', (code) => {
                        clearTimeout(killTimeout);
                        console.log(`Cache process exited with code ${code}`);
                        cacheProcess = null;
                        resolve();
                    });
                } else {
                    console.warn("Cache process stdin not writable, killing immediately.");
                    if (cacheProcess && !cacheProcess.killed) cacheProcess.kill('SIGKILL');
                    cacheProcess = null;
                    resolve();
                }
            } catch (err) {
                console.error("Error stopping cache process, attempting kill:", err);
                if (cacheProcess && !cacheProcess.killed) cacheProcess.kill('SIGKILL');
                cacheProcess = null;
                resolve();
            }
        } else {
            resolve();
        }
        cacheFilePath = null;
        cacheStartTime = null;
        currentCachingUrl = null;
    });
}

async function startLiveCaching(streamUrl) {
    await stopLiveCaching(); // Stops previous interval too
    currentCachingUrl = streamUrl;
    const tempDir = path.join(app.getPath('temp'), 'BiliCutCache');
    try {
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
        cacheFilePath = path.join(tempDir, `live_cache_${Date.now()}.mp4`);
    } catch (err) {
         console.error("Failed to create cache directory:", err);
         cacheFilePath = path.join(os.tmpdir(), `bili_live_cache_${Date.now()}.mp4`);
    }
    cacheStartTime = Date.now();
    const ffmpegCommand = 'ffmpeg';
    const args = [
        '-y',
        '-i', streamUrl,
        '-c', 'copy', // Keep copying codecs
        // *** ADD movflags for fragmented MP4 output ***
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
        cacheFilePath // Output path remains .mp4
    ];
    console.log(`Starting live caching (fMP4) to: ${cacheFilePath}`); // Update log message
    console.log(`FFmpeg command (Cache): ${ffmpegCommand} ${args.join(' ')}`);
    try {
        cacheProcess = spawn(ffmpegCommand, args);

        // *** Start sending duration updates ***
        if (mainWindow && mainWindow.webContents) {
             cacheDurationUpdateInterval = setInterval(() => {
                 if (cacheStartTime && mainWindow && mainWindow.webContents && !mainWindow.isDestroyed()) {
                     const currentDuration = (Date.now() - cacheStartTime) / 1000;
                     // console.log(`Sending cache duration update: ${currentDuration.toFixed(2)}s`); // Optional debug log
                     mainWindow.webContents.send('cache-duration-update', currentDuration);
                 } else {
                      // Stop interval if something is wrong
                      if(cacheDurationUpdateInterval) clearInterval(cacheDurationUpdateInterval);
                      cacheDurationUpdateInterval = null;
                 }
             }, 1000); // Send update every second
             console.log('Started cache duration updates.');
        } else {
             console.warn('Cannot start cache duration updates: mainWindow not available.');
        }

        // ... existing cache process event handlers (stderr, close, error) ...
        cacheProcess.stderr.on('data', (data) => console.log(`Cache FFmpeg stderr: ${data}`));
        cacheProcess.on('close', (code) => {
            console.log(`Cache FFmpeg process exited unexpectedly with code ${code}. URL: ${currentCachingUrl}`);
            // Stop interval if cache process stops
            if (cacheDurationUpdateInterval) clearInterval(cacheDurationUpdateInterval);
            cacheDurationUpdateInterval = null;
            if (cacheProcess) { cacheProcess = null; cacheFilePath = null; cacheStartTime = null; currentCachingUrl = null; }
        });
        cacheProcess.on('error', (err) => {
            console.error('Failed to start cache FFmpeg process:', err);
            // Stop interval on error
            if (cacheDurationUpdateInterval) clearInterval(cacheDurationUpdateInterval);
            cacheDurationUpdateInterval = null;
            let userErrorMessage = `启动后台缓存失败: ${err.message}`;
            if (err.code === 'ENOENT') userErrorMessage = '无法找到 FFmpeg 命令...';
            dialog.showErrorBox('后台缓存错误', userErrorMessage);
            cacheProcess = null; cacheFilePath = null; cacheStartTime = null; currentCachingUrl = null;
        });
    } catch (err) {
        console.error('Error spawning cache FFmpeg:', err);
        // Stop interval on spawn error
        if (cacheDurationUpdateInterval) clearInterval(cacheDurationUpdateInterval);
        cacheDurationUpdateInterval = null;
        cacheProcess = null; cacheFilePath = null; cacheStartTime = null; currentCachingUrl = null;
    }
}


// --- Recording Logic (Operates on single .mp4 cache) ---
async function startRecording(event, options) {
    console.log('Main process received start-recording request (for cache):', options);
    if (!cacheProcess || !cacheFilePath || !fs.existsSync(cacheFilePath) || !cacheStartTime) {
        console.error('Cannot start recording: Cache is not active or cache file not found.');
        event.reply('clip-saved', { success: false, filename: options.filename, error: '后台缓存未运行或缓存文件丢失' });
        return;
    }

    const timeSinceCacheStart = (Date.now() - cacheStartTime) / 1000;

    // *** SIMPLIFIED: cacheSeekTime is directly options.startTime ***
    // Remove timelineBufferDuration and uiTimelineStartOffset
    let cacheSeekTime = options.startTime || 0; // Default startTime to 0 if undefined
    cacheSeekTime = Math.max(0, cacheSeekTime); // Ensure non-negative

    // Calculate effective duration based on cache limits
    const maxPossibleDuration = timeSinceCacheStart - cacheSeekTime;
    const requestedDuration = typeof options.duration === 'number' ? options.duration : 0;
    const effectiveDuration = Math.min(requestedDuration, Math.max(0, maxPossibleDuration));

    // Check for zero duration
    if (effectiveDuration <= 0) {
         console.error(`Cannot record: Calculated effective duration is zero or negative. Seek: ${cacheSeekTime}, Cache Duration: ${timeSinceCacheStart}, Requested Start: ${options.startTime}, Requested Duration: ${options.duration}`);
         const requestedStartTimeInCacheStr = new Date(cacheSeekTime * 1000).toISOString().substr(11, 8);
         const cacheDurationStr = new Date(timeSinceCacheStart * 1000).toISOString().substr(11, 8);
         event.reply('clip-saved', { success: false, filename: options.filename, error: `无法切片：请求的时间范围 (开始于缓存 ${requestedStartTimeInCacheStr}) 已超出当前有效缓存时长 (${cacheDurationStr})。请确保选择的时间点在已缓存范围内。` });
         return;
    }

    console.log(`Cache Info: StartTime=${cacheStartTime}, TimeSinceStart=${timeSinceCacheStart.toFixed(2)}s`);
    // Log the received startTime and duration directly
    console.log(`UI Info (relative to cache start): StartTime=${options.startTime?.toFixed(2)}s, Duration=${options.duration?.toFixed(2)}s`);
    console.log(`Calculated: CacheSeekTime=${cacheSeekTime.toFixed(2)}s, EffectiveDuration=${effectiveDuration.toFixed(2)}s`);

    // ... existing output path setup ...
    const outputDir = path.join(app.getPath('videos'), 'BiliCutClips');
    try {
        if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    } catch (err) {
        console.error('Failed to create output directory:', err);
        event.reply('clip-saved', { success: false, filename: options.filename, error: '无法创建输出目录' });
        return;
    }
    const outputPath = path.join(outputDir, `${options.filename}.mp4`);
    const ffmpegCommand = 'ffmpeg';
    // FFmpeg args use the calculated cacheSeekTime and effectiveDuration
    const args = [
        '-y', '-i', cacheFilePath,
        '-ss', cacheSeekTime.toFixed(3),
        '-t', effectiveDuration.toFixed(3),
        '-c', 'copy', '-map', '0',
        outputPath
    ];

    console.log(`Spawning FFmpeg for slicing: ${ffmpegCommand} ${args.map(arg => `"${arg}"`).join(' ')}`);
    event.reply('recording-progress', { status: `开始切片: ${options.filename}.mp4`, filename: options.filename });

    // ... existing FFmpeg slicing process execution (spawn, stderr, close, error) ...
    let slicingProcess = null;
    try {
        slicingProcess = spawn(ffmpegCommand, args);
        const currentSliceFilename = options.filename;

        slicingProcess.stderr.on('data', (data) => {
            console.log(`Slicing FFmpeg stderr: ${data}`);
            event.reply('recording-progress', { status: `处理中: ${currentSliceFilename}.mp4`, filename: currentSliceFilename });
        });
        slicingProcess.on('close', (code) => {
            console.log(`Slicing FFmpeg process exited with code ${code}`);
            const success = code === 0;
            const errorMsg = success ? null : `FFmpeg 切片进程错误 (代码: ${code})`;
            event.reply('clip-saved', { success: success, filename: currentSliceFilename, error: errorMsg });
        });
        slicingProcess.on('error', (err) => {
            console.error('Failed to start slicing FFmpeg process:', err);
            let userErrorMessage = `启动 FFmpeg 切片失败: ${err.message}`;
            if (err.code === 'ENOENT') userErrorMessage = '无法找到 FFmpeg 命令...';
            dialog.showErrorBox('FFmpeg 切片错误', userErrorMessage);
            event.reply('clip-saved', { success: false, filename: currentSliceFilename, error: userErrorMessage });
        });
    } catch (err) {
        console.error('Error spawning slicing FFmpeg:', err);
        event.reply('clip-saved', { success: false, filename: options.filename, error: `执行 FFmpeg 切片出错: ${err.message}` });
    }
}

// --- IPC Handlers (Reverted) ---
ipcMain.on('get-stream-url', async (event, roomIdentifier) => {
    try {
        const streamUrl = await getBilibiliStreamUrl(roomIdentifier);
        await startLiveCaching(streamUrl);
        console.log('[Main Process] Sending stream-url-reply (Success):', { url: streamUrl, error: null }); // <-- 添加日志
        event.reply('stream-url-reply', { url: streamUrl, error: null });
    } catch (error) {
        console.error('[Main Process] Error in get-stream-url handler:', error); // <-- 添加错误日志
        // 确保即使出错也发送包含错误信息的数据对象
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.log('[Main Process] Sending stream-url-reply (Error):', { url: null, error: errorMessage }); // <-- 添加日志
        try {
             await stopLiveCaching(); // 尝试停止缓存，即使失败也要继续发送回复
        } catch (stopError) {
             console.error('[Main Process] Error stopping cache during error handling:', stopError);
        }
        event.reply('stream-url-reply', { url: null, error: errorMessage });
    }
});

ipcMain.on('start-recording', startRecording);
// ipcMain.on('stop-recording', stopRecording); // Keep commented out

ipcMain.on('open-clips-folder', (event) => {
    const outputDir = path.join(app.getPath('videos'), 'BiliCutClips');
     try {
        if (!fs.existsSync(outputDir)){
            fs.mkdirSync(outputDir, { recursive: true });
        }
        shell.openPath(outputDir); // Use shell.openPath
    } catch (err) {
        console.error('Failed to open or create output directory:', err);
        dialog.showErrorBox('打开失败', `无法打开或创建目录: ${outputDir}`);
    }
});

// --- App Lifecycle ---
app.whenReady().then(() => {
    createWindow();
    app.on('activate', function () {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});
app.on('window-all-closed', async () => {
    await stopLiveCaching();
    if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', async (event) => {
     console.log('App before-quit event');
     event.preventDefault();
     try { await stopLiveCaching(); }
     catch (e) { console.error("Error during stopLiveCaching in before-quit:", e); }
     finally { app.quit(); }
});
