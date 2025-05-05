// --- 返回当前直播按钮逻辑 ---
const backToLiveBtn = document.getElementById('back-to-live-btn');
document.addEventListener('DOMContentLoaded', () => {
    // 为返回当前直播按钮添加点击事件处理
    if (backToLiveBtn) {
        backToLiveBtn.addEventListener('click', () => {
            console.log('点击返回当前直播按钮');
            // 跳转到直播缓存的最新位置（即缓存结尾）
            if (currentCacheDuration > 0) {
                // 使用现有的previewSeekTo函数跳转到缓存末尾
                previewSeekTo(currentCacheDuration);
                // 重置右侧滑块的用户拖动状态，让它跟随缓存长度
                endHandleUserPositioned = false;
                // 更新右侧滑块位置为缓存末尾
                selectedEndTime = currentCacheDuration;
                const trackWidth = timelineTrack ? timelineTrack.offsetWidth : 0;
                if (trackWidth > 0) {
                    endHandlePx = trackWidth;
                    updateHandleStyles();
                    updateSelectionVisuals();
                }
                showNotification('已返回当前直播', 'info');
            } else {
                console.log('缓存尚未开始或无效！');
                showNotification('直播缓存尚未开始', 'warning');
            }
        });
    } else {
        console.warn('返回当前直播按钮未找到！');
    }
    // --- Global Variables & Elements ---
    const tabs = document.querySelectorAll('.tab-button');
    const tabContents = document.querySelectorAll('.tab-content');
    const timelineTrack = document.querySelector('.timeline-track');
    const startHandle = document.querySelector('.selection-handle.start');
    const endHandle = document.querySelector('.selection-handle.end');
    const selectionArea = document.querySelector('.selection-area');
    const selectedDurationSpan = document.getElementById('selected-duration');
    const goBtn = document.querySelector('.go-btn');
    const liveInput = document.querySelector('.input-group input[type="text"]');
    const videoContainer = document.querySelector('#preview');
    const initialPlaceholder = document.querySelector('.video-placeholder');
    const sliceSelectionBtn = document.querySelector('.slice-selection-btn');
    const quickClipBtn = document.querySelector('.bottom-controls .action-btn:first-child');
    const recordingStatus = document.querySelector('.recording-status');
    const stopBtn = document.querySelector('.stop-btn');
    const clipList = document.querySelector('.clip-list');
    const openFolderBtn = document.getElementById('open-folder-btn'); // *** MOVED DECLARATION HERE ***
    const timelineLabels = document.querySelector('.timeline-labels'); // Get the labels container
    let hlsInstance = null;
    let flvPlayer = null;
    const ipcRenderer = window.electron?.ipcRenderer;
    let currentQuickClipFilename = null;
    let currentLoadedStreamUrl = null;
    let currentCacheDuration = 0;
    let cacheFilePath = null;
    let selectedStartTime = 0;
    let selectedEndTime = 0;
    let isDraggingStart = false;
    let isDraggingEnd = false;
    let endHandleUserPositioned = false;
    let dragStartX = 0;
    // *** ADD Pixel State Variables ***
    let startHandlePx = 0;
    let endHandlePx = 0;

    // --- Helper Functions ---
    function formatTime(seconds) {
        if (isNaN(seconds) || seconds < 0) return '00:00';
        const minutes = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }

    const showNotification = (message, type = 'info') => {
        // Implementation for showing notifications to the user
        console.log(`[${type.toUpperCase()}] ${message}`);
    };

    const addClipToRecentList = (filename) => {
        // Implementation for adding the clip to the recent list UI
        console.log(`Clip added to recent list: ${filename}`);
    };

    // --- Tabs Logic ---
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            // 移除所有标签的激活状态
            tabs.forEach(t => t.classList.remove('active'));
            // 隐藏所有标签内容
            tabContents.forEach(content => content.classList.remove('active'));

            // 激活当前点击的标签
            tab.classList.add('active');
            // 显示对应的标签内容
            const targetTab = tab.getAttribute('data-tab');
            const targetContent = document.getElementById(targetTab);
            if (targetContent) {
                targetContent.classList.add('active');
            }
        });
    });

    // --- Timeline Dragging Logic ---

    // *** MODIFIED: Update visuals based on pixel state variables ***
    function updateSelectionVisuals() {
        if (!timelineTrack || !selectionArea || !startHandle || !endHandle || !selectedDurationSpan) return;

        // Use state variables instead of reading offsetLeft
        selectionArea.style.left = `${startHandlePx}px`;
        selectionArea.style.width = `${Math.max(0, endHandlePx - startHandlePx)}px`;

        // Update duration display based on time state variables
        const displayDuration = Math.max(0, selectedEndTime - selectedStartTime);
        const durationLabel = document.getElementById('selected-duration-label');
        if (durationLabel) {
            durationLabel.textContent = `选中时长: ${displayDuration.toFixed(1)}s`;
        }

        // 更新时间戳
        const startTimeLabel = startHandle.querySelector('.handle-time');
        const endTimeLabel = endHandle.querySelector('.handle-time');
        if (startTimeLabel) {
            startTimeLabel.textContent = formatTime(selectedStartTime);
        }
        if (endTimeLabel) {
            endTimeLabel.textContent = formatTime(selectedEndTime);
        }

        // --- DEBUG LOG ---
        console.log(`UpdateVisuals - StartPx: ${startHandlePx}, EndPx: ${endHandlePx}, Width: ${selectionArea.style.width}, Duration: ${displayDuration.toFixed(1)}s`);
        // --- END DEBUG LOG ---
    }

    // Function to update handle styles based on pixel state
    function updateHandleStyles() {
         if (startHandle) startHandle.style.left = `${startHandlePx}px`;
         if (endHandle) endHandle.style.left = `${endHandlePx}px`;
    }


    if (timelineTrack && startHandle && endHandle && selectionArea) {
        // Initial state setup will be handled by cache-started or resize observer

        // --- Drag Event Listeners ---
        startHandle.addEventListener('mousedown', (e) => {
            isDraggingStart = true;
            dragStartX = e.clientX;
            document.body.style.userSelect = 'none';
            console.log("MouseDown - Start Handle");
        });

        endHandle.addEventListener('mousedown', (e) => {
            isDraggingEnd = true;
            dragStartX = e.clientX;
            // Mark user positioned ONLY on mouseup
            // endHandleUserPositioned = true;
            document.body.style.userSelect = 'none';
            console.log("MouseDown - End Handle");
        });

        // *** MODIFIED: mousemove uses and updates pixel state ***
        // --- 拖动滑块时预览视频跳转 ---
        // 防抖定时器
        let previewSeekTimeout = null;
        let lastPreviewSeekTime = null;
        let wasPlayingBeforeSeek = false;

        // 获取当前 video 元素
        function getPreviewVideoElement() {
            return document.getElementById('live-video-player');
        }

        // 预览 seek 逻辑，兼容 HLS、flv、原生 video
        function previewSeekTo(time) {
            const video = getPreviewVideoElement();
            if (!video) return;
            // 判断 flv/hls/原生
            if (flvPlayer && typeof flvPlayer.currentTime === 'number') {
                try {
                    flvPlayer.currentTime = time;
                } catch (e) { console.warn('flv.js seek error', e); }
            } else if (hlsInstance && video.readyState > 0) {
                video.currentTime = time;
            } else if (video.readyState > 0) {
                video.currentTime = time;
            }
        }

        // 拖动时暂停，松开后恢复
        function pauseForPreview() {
            const video = getPreviewVideoElement();
            if (!video) return;
            wasPlayingBeforeSeek = !video.paused;
            video.pause();
        }
        function resumeAfterPreview() {
            const video = getPreviewVideoElement();
            if (!video) return;
            if (wasPlayingBeforeSeek) video.play();
        }

        document.addEventListener('mousemove', (e) => {
            // --- 节流优化：拖动时每帧只seek一次，提升流畅度 ---
            if (!isDraggingStart && !isDraggingEnd) return;

            const trackWidth = timelineTrack ? timelineTrack.offsetWidth : 0;
            if (trackWidth <= 0 || currentCacheDuration <= 0) return; // Need width and duration

            const trackRect = timelineTrack.getBoundingClientRect();
            const mouseX = Math.max(0, Math.min(e.clientX - trackRect.left, trackWidth));

            let previewTime = null;
            if (isDraggingStart) {
                const newStartPx = Math.min(mouseX, endHandlePx - 2);
                startHandlePx = newStartPx;
                selectedStartTime = (startHandlePx / trackWidth) * currentCacheDuration;
                startHandle.style.left = `${startHandlePx}px`;
                previewTime = selectedStartTime;
            } else if (isDraggingEnd) {
                const newEndPx = Math.max(mouseX, startHandlePx + 2);
                endHandlePx = newEndPx;
                selectedEndTime = (endHandlePx / trackWidth) * currentCacheDuration;
                endHandle.style.left = `${endHandlePx}px`;
                previewTime = selectedEndTime;
            }
            updateSelectionVisuals();
            // 节流 seek
            if (previewTime !== null) {
                if (!window._previewSeekRafId) {
                    window._pendingPreviewTime = previewTime;
                    window._previewSeekRafId = requestAnimationFrame(() => {
                        if (window._pendingPreviewTime !== null) {
                            previewSeekTo(window._pendingPreviewTime);
                            lastPreviewSeekTime = window._pendingPreviewTime;
                            window._pendingPreviewTime = null;
                        }
                        window._previewSeekRafId = null;
                    });
                } else {
                    window._pendingPreviewTime = previewTime;
                }
            }
        });

        // *** MODIFIED: mouseup marks user positioned ***
        document.addEventListener('mouseup', () => {
            if (isDraggingStart || isDraggingEnd) {
                const wasDraggingEnd = isDraggingEnd;
                const handleDragged = isDraggingStart ? 'Start' : 'End';

                console.log(`MouseUp - Stopped dragging ${handleDragged} handle`);

                isDraggingStart = false;
                isDraggingEnd = false;
                document.body.style.userSelect = '';

                // 拖动结束后恢复播放
                resumeAfterPreview();

                if (wasDraggingEnd) {
                    endHandleUserPositioned = true; // Mark user positioned AFTER drag ends
                    console.log("Right handle marked as user positioned at:", selectedEndTime.toFixed(2), "seconds");
                }
                // Optional: Force a final state sync if needed, though cache-update should handle it
            }
        });

         // Add ResizeObserver to handle timeline width changes
         const resizeObserver = new ResizeObserver(entries => {
            for (let entry of entries) {
                if (entry.target === timelineTrack) {
                    console.log("Timeline track resized, recalculating handle positions.");
                    const trackWidth = timelineTrack.offsetWidth;
                    if (trackWidth <= 0 || currentCacheDuration <= 0) {
                        startHandlePx = 0;
                        endHandlePx = 0;
                    } else {
                        // 只有未手动拖动过右侧滑块时，selectedEndTime 才自动跟随缓存长度
                        if (!endHandleUserPositioned) {
                            selectedEndTime = currentCacheDuration;
                        }
                        // 右侧滑块像素位置只由 selectedEndTime 决定
                        let targetEndPx = Math.round((selectedEndTime / currentCacheDuration) * trackWidth);
                        endHandlePx = Math.min(targetEndPx, trackWidth);
                        // 左侧滑块不能超过右侧滑块
                        const targetStartPx = Math.round((selectedStartTime / currentCacheDuration) * trackWidth);
                        startHandlePx = Math.max(0, Math.min(targetStartPx, endHandlePx - 2));
                    }
                    updateHandleStyles();
                    updateSelectionVisuals();
                }
            }
         });
         resizeObserver.observe(timelineTrack);


    } else {
        console.warn("Timeline elements not found.");
    }

    // --- 1. Go Button Logic (Load Video) ---
    if (goBtn && liveInput && videoContainer && initialPlaceholder) {
        // Check if running in Electron context to use ipcRenderer
        const ipcRenderer = window.electron?.ipcRenderer; // Assumes ipcRenderer is exposed via preload script

        if (!ipcRenderer) {
            // --- Browser-only fallback logic (using setTimeout) ---
            console.warn("IPC Renderer not available. Running in browser mode with test stream.");
            goBtn.addEventListener('click', () => {
                const roomIdentifier = liveInput.value.trim();
                if (roomIdentifier) {
                    console.log(`尝试加载直播间: ${roomIdentifier}`);
                    initialPlaceholder.innerHTML = `<p>正在解析直播源: ${roomIdentifier}...</p><i class="fas fa-spinner fa-spin"></i>`;
                    if (!videoContainer.contains(initialPlaceholder)) {
                         videoContainer.insertBefore(initialPlaceholder, videoContainer.firstChild);
                    }
                    const existingVideo = videoContainer.querySelector('video');
                    if (existingVideo) existingVideo.remove();
                    if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
                    if (flvPlayer) { flvPlayer.destroy(); flvPlayer = null; } // Destroy FLV player too

                    setTimeout(() => { // Simulate fetching stream URL
                        const streamUrl = "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8"; // Public HLS test stream
                        if (streamUrl) {
                            console.log(`获取到流地址: ${streamUrl}`);
                            initialPlaceholder.remove();
                            const videoElement = document.createElement('video');
                            videoElement.id = 'live-video-player';
                            videoElement.controls = true;
                            videoElement.autoplay = true;
                            videoElement.style.width = '100%';
                            videoElement.style.backgroundColor = '#000';
                            videoElement.style.borderRadius = 'var(--border-radius)';
                            videoElement.style.maxHeight = '400px';

                            if (streamUrl.includes('.m3u8') && Hls.isSupported()) { // Use includes for robustness
                                hlsInstance = new Hls();
                                hlsInstance.loadSource(streamUrl);
                                hlsInstance.attachMedia(videoElement);
                                hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => videoElement.play());
                                console.log("使用 Hls.js 加载 M3U8 流");
                            } else if (videoElement.canPlayType('application/vnd.apple.mpegurl')) {
                                videoElement.src = streamUrl;
                                videoElement.addEventListener('loadedmetadata', () => videoElement.play());
                                console.log("使用原生 HLS 支持加载 M3U8 流");
                            } else {
                                console.error("浏览器不支持 HLS 播放");
                                videoContainer.insertBefore(initialPlaceholder, videoContainer.firstChild);
                                initialPlaceholder.innerHTML = `<p>错误：浏览器不支持 HLS 播放</p>`;
                                return;
                            }
                            videoContainer.insertBefore(videoElement, videoContainer.firstChild);
                        } else {
                            console.error("获取流地址失败");
                            initialPlaceholder.innerHTML = `<p>错误：无法获取直播源 ${roomIdentifier}</p>`;
                        }
                    }, 1000);
                } else {
                     console.log('请输入直播间URL或房间号');
                     liveInput.style.borderColor = 'red';
                     setTimeout(() => { liveInput.style.borderColor = ''; }, 2000);
                }
            });

        } else {
            // --- Electron IPC Logic ---
            console.log("IPC Renderer available. Setting up Electron IPC handlers.");

            goBtn.addEventListener('click', () => {
                const roomIdentifier = liveInput.value.trim();
                if (roomIdentifier) {
                    console.log(`请求主进程获取直播源: ${roomIdentifier}`);
                    // Update UI to show loading state
                    initialPlaceholder.innerHTML = `<p>正在解析直播源: ${roomIdentifier}...</p><i class="fas fa-spinner fa-spin"></i>`;
                    if (!videoContainer.contains(initialPlaceholder)) {
                         videoContainer.insertBefore(initialPlaceholder, videoContainer.firstChild);
                    }
                    const existingVideo = videoContainer.querySelector('video');
                    if (existingVideo) existingVideo.remove();
                     // Destroy previous players
                     if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
                     if (flvPlayer) { flvPlayer.destroy(); flvPlayer = null; }

                    // Send request to main process
                    ipcRenderer.send('get-stream-url', roomIdentifier);

                } else {
                    console.log('请输入直播间URL或房间号');
                    showNotification('请输入直播间URL或房间号', 'error');
                    liveInput.style.borderColor = 'red';
                    setTimeout(() => { liveInput.style.borderColor = ''; }, 2000);
                }
            });

            // --- Listen for Stream URL Reply ---
            const unsubscribeStreamReply = ipcRenderer.on('stream-url-reply', (data) => {
                console.log('Received stream-url-reply:', data); // Log received data

                // Destroy previous players FIRST
                if (hlsInstance) { console.log('Destroying previous HLS instance'); hlsInstance.destroy(); hlsInstance = null; }
                if (flvPlayer) { console.log('Destroying previous FLV player'); flvPlayer.destroy(); flvPlayer = null; }
                // Clear previous video element if exists
                const existingPlayer = videoContainer.querySelector('#live-video-player');
                if (existingPlayer) { console.log('Removing previous video element'); existingPlayer.remove(); }                // Reset cache duration
                currentCacheDuration = 0;
                selectedStartTime = 0;
                selectedEndTime = 0;
                startHandlePx = 0;
                endHandlePx = 0; // Reset pixel state too
                endHandleUserPositioned = false;
                // Call update visuals AFTER resetting state
                updateHandleStyles(); // Reset styles
                updateSelectionVisuals(); // Reset selection area

                if (data.error) {
                    console.error(`获取直播源失败: ${data.error}`);
                    // Ensure placeholder is visible if it was removed
                    if (!document.contains(initialPlaceholder)) {
                         videoContainer.appendChild(initialPlaceholder);
                    }
                    initialPlaceholder.innerHTML = `<p>错误：${data.error}</p>`;
                    showNotification(`获取直播源失败: ${data.error}`, 'error');
                    currentLoadedStreamUrl = null;
                } else if (data.url) {
                    const streamUrl = data.url;
                    console.log(`Stream URL received: ${streamUrl}`);
                    currentLoadedStreamUrl = streamUrl;
                    if (document.contains(initialPlaceholder)) { initialPlaceholder.remove(); }

                    const videoElement = document.createElement('video');
                    videoElement.id = 'live-video-player';
                    videoElement.controls = true;
                    videoElement.autoplay = true; // Autoplay might be restricted by browser/Electron policies
                    videoElement.muted = true; // Try muting initially, sometimes helps with autoplay
                    videoElement.style.width = '100%';
                    videoElement.style.height = '100%';
                    videoElement.style.objectFit = 'contain';
                    console.log('Video element created.');

                    // *** Add video element to DOM BEFORE attaching player ***
                    videoContainer.insertBefore(videoElement, videoContainer.firstChild);
                    console.log('Video element added to DOM.');

                    // Load the stream
                    if (streamUrl.includes('.m3u8')) {
                        if (Hls.isSupported()) {
                            hlsInstance = new Hls();
                            hlsInstance.loadSource(streamUrl);
                            hlsInstance.attachMedia(videoElement);
                            hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => videoElement.play());
                            console.log("使用 Hls.js 加载 M3U8 流");
                        } else if (videoElement.canPlayType('application/vnd.apple.mpegurl')) {
                            videoElement.src = streamUrl; // Native HLS support
                            videoElement.addEventListener('loadedmetadata', () => videoElement.play());
                            console.log("使用原生 HLS 支持加载 M3U8 流");
                        } else {
                             console.error("浏览器不支持 HLS 播放");
                             videoContainer.insertBefore(initialPlaceholder, videoContainer.firstChild);
                             initialPlaceholder.innerHTML = `<p>错误：浏览器不支持 HLS 播放</p>`;
                             showNotification('浏览器不支持 HLS 播放', 'error');
                             return;
                        }
                    } else if (streamUrl.includes('.flv')) {
                        if (typeof flvjs !== 'undefined' && flvjs.isSupported()) {
                            console.log('flv.js is supported. Creating player...');
                            try {
                                flvPlayer = flvjs.createPlayer({
                                    type: 'flv',
                                    url: streamUrl,
                                    isLive: true,
                                    // Optional config:
                                    // enableStashBuffer: false, // Try disabling stash buffer
                                    // autoCleanupSourceBuffer: true
                                });
                                console.log('flv.js player created:', flvPlayer);

                                // *** Listen for flv.js errors ***
                                flvPlayer.on(flvjs.Events.ERROR, (errorType, errorDetail, errorInfo) => {
                                    console.error('flv.js ERROR:', errorType, errorDetail, errorInfo);
                                    showNotification(`播放器错误: ${errorDetail} (${errorType})`, 'error');
                                    // Optional: Try to recover or show error state
                                });
                                flvPlayer.on(flvjs.Events.LOADING_COMPLETE, () => {
                                    console.log('flv.js: Loading Complete (might indicate stream end or issue for live streams)');
                                });
                                flvPlayer.on(flvjs.Events.RECOVERED_EARLY_EOF, () => {
                                    console.warn('flv.js: Recovered Early EOF');
                                });
                                flvPlayer.on(flvjs.Events.MEDIA_INFO, (mediaInfo) => {
                                     console.log('flv.js MEDIA_INFO:', mediaInfo);
                                });
                                 flvPlayer.on(flvjs.Events.STATISTICS_INFO, (stats) => {
                                     // console.log('flv.js STATS:', stats); // Can be very verbose
                                });


                                console.log('Attaching media element...');
                                flvPlayer.attachMediaElement(videoElement);
                                console.log('Media element attached.');

                                console.log('Loading stream...');
                                flvPlayer.load();
                                console.log('Load called.');

                                console.log('Attempting to play...');
                                // Use a promise to see if play() succeeds or fails
                                const playPromise = flvPlayer.play();
                                if (playPromise !== undefined) {
                                    playPromise.then(() => {
                                        console.log('Playback started successfully.');
                                        videoElement.muted = false; // Unmute after successful play start
                                    }).catch(error => {
                                        console.error('Video play() failed:', error);
                                        showNotification(`无法自动播放: ${error.message}`, 'warning');
                                        // Maybe show a play button for the user?
                                    });
                                } else {
                                     console.log('play() did not return a promise (older browser?). Assuming playback started.');
                                     videoElement.muted = false; // Unmute anyway
                                }

                            } catch (e) {
                                console.error("Error during flv.js player setup:", e);
                                showNotification(`播放器设置失败: ${e.message}`, 'error');
                                currentLoadedStreamUrl = null;
                                return;
                            }
                        } else {
                            console.error('flv.js is not supported or not loaded.');
                            showNotification('flv.js 加载失败或浏览器不支持', 'error');
                            currentLoadedStreamUrl = null;
                            return; // Exit if player cannot be created
                        }
                    } else {
                        console.warn(`不支持的流类型: ${streamUrl}`);
                        showNotification('不支持的流类型', 'warning');
                        currentLoadedStreamUrl = null;
                        return; // Exit for unknown types
                    }
                    // videoContainer.insertBefore(videoElement, videoContainer.firstChild); // Moved earlier
                } else {
                     console.error('无效的 stream-url-reply 数据:', data);
                     currentLoadedStreamUrl = null;
                }
            });            // --- Listen for Cache Started event ---
            const unsubscribeCacheStarted = ipcRenderer.on('cache-started', (path) => {
                console.log(`Cache started, file path: ${path}`);
                cacheFilePath = path;
                selectedStartTime = 0;
                selectedEndTime = 0;
                currentCacheDuration = 0;
                endHandleUserPositioned = false;

                requestAnimationFrame(() => {
                    const trackWidth = timelineTrack ? timelineTrack.offsetWidth : 0;
                    startHandlePx = 0;
                    endHandlePx = trackWidth; // Initialize pixel state
                    console.log(`Cache started - Initial EndPx: ${endHandlePx}`);
                    updateHandleStyles(); // Update styles from state
                    updateSelectionVisuals();
                });
            });            // --- Listen for Cache Duration Updates (Modified) ---
            const unsubscribeCacheUpdate = ipcRenderer.on('cache-duration-update', (duration) => {
                console.groupCollapsed(`CacheUpdate - New Duration: ${duration.toFixed(2)}s`);

                const previousCacheDuration = currentCacheDuration;
                currentCacheDuration = duration;

                if (isDraggingStart || isDraggingEnd) {
                    console.log(`Dragging detected, skipping position update.`);
                    // Only update visuals (duration text might change if time calculation depends on currentCacheDuration)
                    // Recalculate time based on current pixel state and NEW duration
                     const trackWidth = timelineTrack ? timelineTrack.offsetWidth : 0;
                     if (trackWidth > 0) {
                         if (isDraggingStart) {
                             selectedStartTime = (startHandlePx / trackWidth) * currentCacheDuration;
                         } else if (isDraggingEnd) {
                             selectedEndTime = (endHandlePx / trackWidth) * currentCacheDuration;
                         }
                     }
                    updateSelectionVisuals();
                    console.groupEnd();
                    return;
                }

                // --- If NOT dragging, update pixel state and styles ---
                requestAnimationFrame(() => {
                    console.log("Applying position updates via requestAnimationFrame (Not Dragging)");
                    const trackWidth = timelineTrack ? timelineTrack.offsetWidth : 0;
                    if (trackWidth <= 0) {
                        console.warn("Track width is zero, cannot update positions.");
                        console.groupEnd();
                        return;
                    }

                    // 只有未手动拖动过右侧滑块时，selectedEndTime 才自动跟随缓存长度
                    if (!endHandleUserPositioned) {
                        selectedEndTime = currentCacheDuration;
                    } else {
                        // 防止缓存缩短导致右侧超出
                        selectedEndTime = Math.min(selectedEndTime, currentCacheDuration);
                    }
                    // 右侧滑块像素位置只由 selectedEndTime 决定
                    let targetEndPx = currentCacheDuration > 0 ? Math.round((selectedEndTime / currentCacheDuration) * trackWidth) : 0;
                    endHandlePx = Math.min(targetEndPx, trackWidth);
                    // 左侧滑块不能超过右侧滑块
                    const targetStartPx = currentCacheDuration > 0 ? Math.round((selectedStartTime / currentCacheDuration) * trackWidth) : 0;
                    startHandlePx = Math.max(0, Math.min(targetStartPx, endHandlePx - 2));

                    // *** Update Styles from State ***
                    updateHandleStyles();
                    // Update selection area and duration text
                    updateSelectionVisuals();
                    console.groupEnd();
                });
            });// --- Listen for Recording Progress ---
            const unsubscribeRecordingProgress = ipcRenderer.on('recording-progress', (data) => {
                console.log('Recording progress:', data);
                if (recordingStatus) {
                    recordingStatus.textContent = data.status || '录制中...'; // Update status message
                    recordingStatus.style.display = 'inline';
                    // Potentially update timer based on progress data if provided
                }
                 // Ensure stop button is visible if recording started successfully
                 if (data.status?.includes('started') || data.status?.includes('Recording')) {
                     if (stopBtn) stopBtn.style.display = 'inline-block';
                 }
            });

            // --- Listen for Clip Saved Confirmation ---
            const unsubscribeClipSaved = ipcRenderer.on('clip-saved', (data) => {
                console.log('Clip saved confirmation:', data);
                if (recordingStatus) {
                    recordingStatus.textContent = '';
                    recordingStatus.style.display = 'none';
                }
                if (stopBtn) {
                    stopBtn.style.display = 'none';
                    // stopBtn.disabled = false; // Re-enable if disabled
                }

                if (data.success && data.filename) {
                    addClipToRecentList(data.filename); // Add to UI list
                    showNotification(`切片 ${data.filename}.mp4 保存成功!`, 'success');
                } else {
                    showNotification(`切片保存失败: ${data.error || '未知错误'}`, 'error');
                }
                // Reset quick clip filename tracker if needed (adjust scope if necessary)
                // currentQuickClipFilename = null;
            });


            // --- Add button listener for opening folder (inside IPC block) ---
            if (openFolderBtn) { // Check if button exists
                openFolderBtn.addEventListener('click', () => {
                    console.log('Requesting main process to open clips folder.');
                    ipcRenderer.send('open-clips-folder');
                });
            }             // Clean up listeners when the window is unloaded
             window.addEventListener('unload', () => {
                 if (unsubscribeStreamReply) unsubscribeStreamReply();
                 if (unsubscribeCacheStarted) unsubscribeCacheStarted();
                 if (unsubscribeCacheUpdate) unsubscribeCacheUpdate();
                 if (unsubscribeRecordingProgress) unsubscribeRecordingProgress();
                 if (unsubscribeClipSaved) unsubscribeClipSaved();
                 // Also clean up document-level event listeners if needed
                 document.removeEventListener('mousemove', null);
                 document.removeEventListener('mouseup', null);
             });
        } // End of 'else' block (ipcRenderer available)
    } else {
         console.warn("Go button, input, video container, or placeholder not found for IPC setup.");
         // --- Add fallback for open folder button in browser mode ---
         if (openFolderBtn) { // Now openFolderBtn should be defined here
             openFolderBtn.addEventListener('click', () => {
                 alert('打开文件夹功能仅在 Electron 应用中可用。');
             });
             openFolderBtn.disabled = true; // Disable in browser mode
         }
    }

    // --- 3. Slice Selected Fragment Logic (Using IPC) ---
    if (sliceSelectionBtn && selectionArea && ipcRenderer) {
        sliceSelectionBtn.addEventListener('click', () => {
            // Check if cache is active (we have a path and duration)
            if (!cacheFilePath || currentCacheDuration <= 0) {
                showNotification('缓存尚未开始或无效！', 'error');
                console.error("Slice Selection Error: Cache not active or duration invalid.");
                return;
            }

            // Calculate duration from state variables
            const duration = selectedEndTime - selectedStartTime;

            if (duration <= 0) {
                 showNotification('选中的时长无效！', 'error');
                 console.error("Slice Selection Error: Calculated duration is zero or negative.");
                 return;
            }

            // Use absolute times directly
            const startTime = selectedStartTime;

            const filename = `选中片段_${new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19)}`;

            console.log(`请求主进程开始录制 (选中片段): 从 ${formatTime(startTime)} 持续 ${formatTime(duration)}`);

            // Update UI immediately (optional)
            // ... (existing UI update code) ...

            const recordingOptions = {
                // streamUrl is no longer needed if backend uses cacheFilePath
                filename: filename,
                startTime: startTime, // Send absolute start time
                duration: duration,   // Send calculated duration
                type: 'selection'
                // Backend needs to know to use cacheFilePath based on this request type or lack of streamUrl
            };
            console.log('Attempting to send start-recording (Selection):', recordingOptions);

            // Send request to main process
            ipcRenderer.send('start-recording', recordingOptions);
        });
    } else if (!ipcRenderer && sliceSelectionBtn) {
         console.warn("Slice Selection button logic skipped: IPC Renderer not available.");
         // Add fallback browser behavior if needed
         sliceSelectionBtn.addEventListener('click', () => alert("录制功能仅在 Electron 应用中可用。"));
    }


    // --- 4. Quick Slice Logic (Using IPC) ---
    if (quickClipBtn && recordingStatus && stopBtn && ipcRenderer) {
        quickClipBtn.addEventListener('click', () => {
            // *** Use the stored URL directly ***
            if (!currentLoadedStreamUrl) {
                showNotification('无法获取当前直播流地址！(Quick Clip)', 'error');
                console.error("Quick Clip Error: currentLoadedStreamUrl is null or undefined.");
                return;
            }

            const quickClipDuration = 30; // 30 seconds
            // *** Calculate startTime for the last 30 seconds ***
            const selectedStartTime = Math.max(0, currentCacheDuration - quickClipDuration);
            const effectiveQuickClipDuration = Math.min(quickClipDuration, currentCacheDuration); // Duration cannot exceed total cache

            currentQuickClipFilename = `快速切片_${new Date().toISOString().replace(/[:.]/g, '-')}`;
            const recordingOptions = {
                streamUrl: currentLoadedStreamUrl,
                filename: currentQuickClipFilename,
                startTime: selectedStartTime, // Send time relative to cache start
                duration: effectiveQuickClipDuration, // Send effective duration
                type: 'quick'
            };
            console.log('Attempting to send start-recording (Quick Clip):', recordingOptions); // *** ADDED LOG ***

            // Send request to main process
            ipcRenderer.send('start-recording', recordingOptions);
        });

        // Modify Stop button to send IPC message
        stopBtn.addEventListener('click', () => {
            if (currentQuickClipFilename) {
                console.log(`请求主进程停止录制: ${currentQuickClipFilename}`);
                ipcRenderer.send('stop-recording', { filename: currentQuickClipFilename });
                // UI will be reset by 'clip-saved' or 'recording-progress' handlers
                // Optionally, provide immediate feedback:
                // recordingStatus.textContent = '正在停止...';
                // stopBtn.disabled = true; // Prevent multiple clicks
            } else {
                console.warn("Stop button clicked but no active quick clip filename found.");
                // Reset UI just in case
                 recordingStatus.style.display = 'none';
                 stopBtn.style.display = 'none';
            }
        });

    } else if (!ipcRenderer && quickClipBtn) {
         console.warn("Quick Clip button logic skipped: IPC Renderer not available.");
         // Add fallback browser behavior if needed
         quickClipBtn.addEventListener('click', () => alert("录制功能仅在 Electron 应用中可用。"));
         if (stopBtn) {
             stopBtn.style.display = 'none'; // Keep stop button hidden in browser mode
         }
    }


    // --- Danmaku Settings Logic ---
    const danmakuToggle = document.getElementById('danmaku-toggle');
    const opacitySlider = document.getElementById('opacity-slider');
    const opacityValue = opacitySlider?.nextElementSibling;
    const fontSizeSlider = document.getElementById('font-size-slider');
    const fontSizeValue = fontSizeSlider?.nextElementSibling;
    const speedSlider = document.getElementById('speed-slider');
    const speedValue = speedSlider?.nextElementSibling;
    const areaSelect = document.getElementById('area-select');
    const advancedSettingsBtn = document.getElementById('advanced-danmaku-settings');
    
    // 弹幕设置对象
    const danmakuSettings = {
        enabled: true,
        opacity: 80,
        fontSize: 22,
        speed: 8,
        area: 'all'
    };
    
    // 更新UI函数
    function updateDanmakuUI() {
        if (danmakuToggle) danmakuToggle.checked = danmakuSettings.enabled;
        if (opacitySlider) opacitySlider.value = danmakuSettings.opacity;
        if (opacityValue) opacityValue.textContent = `${danmakuSettings.opacity}%`;
        if (fontSizeSlider) fontSizeSlider.value = danmakuSettings.fontSize;
        if (fontSizeValue) fontSizeValue.textContent = `${danmakuSettings.fontSize}px`;
        if (speedSlider) speedSlider.value = danmakuSettings.speed;
        if (speedValue) speedValue.textContent = `${danmakuSettings.speed}s`;
        if (areaSelect) areaSelect.value = danmakuSettings.area;
    }
    
    // 应用弹幕设置函数 (实际应用中会与弹幕渲染系统交互)
    function applyDanmakuSettings() {
        console.log('应用弹幕设置:', danmakuSettings);
        
        // 在页面上显示弹幕设置保存通知
        showNotification('弹幕设置已更新', 'success');
        
        // 在实际应用中，这里会调用弹幕系统的API更新设置
    }
    
    // 事件监听器
    if (danmakuToggle) {
        danmakuToggle.addEventListener('change', () => {
            danmakuSettings.enabled = danmakuToggle.checked;
            applyDanmakuSettings();
        });
    }
    
    if (opacitySlider) {
        opacitySlider.addEventListener('input', () => {
            danmakuSettings.opacity = parseInt(opacitySlider.value);
            if (opacityValue) opacityValue.textContent = `${danmakuSettings.opacity}%`;
        });
        opacitySlider.addEventListener('change', applyDanmakuSettings);
    }
    
    if (fontSizeSlider) {
        fontSizeSlider.addEventListener('input', () => {
            danmakuSettings.fontSize = parseInt(fontSizeSlider.value);
            if (fontSizeValue) fontSizeValue.textContent = `${danmakuSettings.fontSize}px`;
        });
        fontSizeSlider.addEventListener('change', applyDanmakuSettings);
    }
    
    if (speedSlider) {
        speedSlider.addEventListener('input', () => {
            danmakuSettings.speed = parseInt(speedSlider.value);
            if (speedValue) speedValue.textContent = `${danmakuSettings.speed}s`;
        });
        speedSlider.addEventListener('change', applyDanmakuSettings);
    }
    
    if (areaSelect) {
        areaSelect.addEventListener('change', () => {
            danmakuSettings.area = areaSelect.value;
            applyDanmakuSettings();
        });
    }
    
    if (advancedSettingsBtn) {
        advancedSettingsBtn.addEventListener('click', () => {
            // 显示高级设置模态框 (未实现)
            alert('高级弹幕设置功能即将推出');
        });
    }
    
    // 初始化UI
    updateDanmakuUI();

    // --- Initial Setup ---
    // ... existing initial setup ...

    // --- Remove the old finishClipping function ---
    /*
    function finishClipping(filename) {
        // ... old logic ...
    }
    */

    // ... existing addClipToRecentList and showNotification functions ...

    // --- Recent Clips Section ---
    const recentClipsContainer = document.querySelector('.recent-clips .clip-list');

    // Mock recent clips data (replace with real data in production)
    const recentClips = [
        { filename: '切片1.mp4', path: '/path/to/clip1.mp4' },
        { filename: '切片2.mp4', path: '/path/to/clip2.mp4' },
        { filename: '切片3.mp4', path: '/path/to/clip3.mp4' }
    ];

    // --- Add recent clips to the UI list ---
    function updateRecentClipsUI(clips) {
        if (!recentClipsContainer) return;
        recentClipsContainer.innerHTML = ''; // Clear existing clips
        clips.forEach(clip => {
            const li = document.createElement('li');
            li.textContent = clip.filename;
            li.classList.add('clip-item');
            // Add click event to play the clip (if needed)
            li.addEventListener('click', () => {
                console.log(`Playing clip: ${clip.filename}`);
                // Add logic to play the clip
            });
            recentClipsContainer.appendChild(li);
        });
    }

    // Initial population of recent clips
    updateRecentClipsUI(recentClips);

}); // End of DOMContentLoaded
