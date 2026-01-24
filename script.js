/**
 * 拼图 Ultimate (Refactored)
 * 核心逻辑：模块化、IndexedDB 持久化、内存防爆、零损坏绘制
 */

const App = (() => {
    // 状态管理
    const state = {
        images: [], // { id, url(blobUrl), name, blob }
        settings: {},
        generatedBlobs: [],
        overlayImg: null,
        targetIndex: -1,
        isCancelled: false,
        db: null,
        sortable: null
    };

    // 常量
    const DB_NAME = 'PuzzleUltimateDB';
    const DB_VERSION = 1;
    const SETTINGS_KEY = 'puzzle_settings_v4';
    const MAX_CANVAS_DIM = 8192; // 安全限制

    // --- IndexedDB 模块 ---
    const DB = {
        init: () => {
            return new Promise((resolve, reject) => {
                const req = indexedDB.open(DB_NAME, DB_VERSION);
                req.onupgradeneeded = (e) => {
                    const db = e.target.result;
                    if (!db.objectStoreNames.contains('images')) {
                        db.createObjectStore('images', { keyPath: 'id', autoIncrement: true });
                    }
                };
                req.onsuccess = (e) => { state.db = e.target.result; resolve(); };
                req.onerror = (e) => reject(e);
            });
        },
        addImages: (files) => {
            return new Promise(async (resolve) => {
                const tx = state.db.transaction('images', 'readwrite');
                const store = tx.objectStore('images');
                for (let file of files) {
                    store.add({ name: file.name, blob: file, created: Date.now() });
                }
                tx.oncomplete = () => resolve();
            });
        },
        getAll: () => {
            return new Promise((resolve) => {
                if(!state.db) return resolve([]);
                const tx = state.db.transaction('images', 'readonly');
                const store = tx.objectStore('images');
                const req = store.getAll();
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => resolve([]);
            });
        },
        clear: () => {
            return new Promise((resolve) => {
                const tx = state.db.transaction('images', 'readwrite');
                tx.objectStore('images').clear();
                tx.oncomplete = () => resolve();
            });
        },
        delete: (id) => {
            const tx = state.db.transaction('images', 'readwrite');
            tx.objectStore('images').delete(id);
        }
    };

    // --- 初始化与生命周期 ---
    const init = async () => {
        loadSettings();
        await DB.init();
        await refreshImagesFromDB();
        setupDragDrop();
        setupDraggableBtn();
        
        // 绑定所有输入事件以更新设置
        document.querySelectorAll('input, select').forEach(el => {
            if(el.type !== 'file') {
                el.addEventListener('change', () => { saveSettings(); updateNumberPreview(); });
                el.addEventListener('input', () => { saveSettings(); updateNumberPreview(); });
            }
        });
        
        // 初始计算与预览
        calculateGroupBatch();
        updateNumberPreview();
    };

    const refreshImagesFromDB = async () => {
        // 释放旧URL
        state.images.forEach(img => URL.revokeObjectURL(img.url));
        
        const records = await DB.getAll();
        state.images = records.map(r => ({
            id: r.id,
            name: r.name,
            url: URL.createObjectURL(r.blob)
        }));
        
        renderGrid();
        updateUI();
        calculateGroupBatch();
    };

    // --- 导入引擎 (防卡死) ---
    const handleFiles = async (files) => {
        if (!files.length) return;
        showToast(true, '正在处理导入...');
        await sleep(100); // UI 刷新缓冲

        // 1. 存入 IDB
        await DB.addImages(Array.from(files));
        
        // 2. 刷新界面
        await refreshImagesFromDB();
        showToast(false);
        document.getElementById('fileInput').value = '';
    };

    const renderGrid = () => {
        const grid = document.getElementById('imageGrid');
        grid.innerHTML = '';
        
        if (state.images.length === 0) {
            document.getElementById('emptyState').style.display = 'flex';
            grid.appendChild(document.getElementById('emptyState'));
            return;
        } else {
            document.getElementById('emptyState').style.display = 'none';
        }

        const fragment = document.createDocumentFragment();
        state.images.forEach((img, index) => {
            const div = document.createElement('div');
            div.className = 'relative aspect-square rounded-xl overflow-hidden bg-gray-100 border border-gray-100 thumbnail-item active:opacity-80 transition cursor-grab active:cursor-grabbing';
            // Lazy load setup
            div.innerHTML = `<img src="${img.url}" class="w-full h-full object-cover pointer-events-none select-none" loading="lazy">`;
            div.onmouseup = () => openImageActions(index);
            fragment.appendChild(div);
        });
        grid.appendChild(fragment);

        if (state.sortable) state.sortable.destroy();
        state.sortable = new Sortable(grid, {
            animation: 150,
            ghostClass: 'sortable-ghost',
            delay: 150,
            delayOnTouchOnly: true,
            onEnd: async (evt) => {
                // 仅更新数组顺序，这里不实现IDB重排序（太复杂），仅内存排序
                // 如果需要严格持久化排序，需要给IDB加 order 字段，此处省略以保性能
                const item = state.images.splice(evt.oldIndex, 1)[0];
                state.images.splice(evt.newIndex, 0, item);
            }
        });
    };

    // --- 生成引擎 (Zero-Corruption) ---
    const generate = async () => {
        if (!state.images.length) return alert('请先添加图片');
        state.isCancelled = false;
        
        const resultArea = document.getElementById('resultArea');
        const container = document.getElementById('seamlessContainer');
        const canvas = document.getElementById('canvas');
        const ctx = canvas.getContext('2d');
        
        resultArea.classList.add('hidden');
        container.innerHTML = '';
        state.generatedBlobs = [];

        // 读取参数
        const cols = parseInt(document.getElementById('cols').value) || 3;
        const rows = parseInt(document.getElementById('group_rows').value) || 3;
        const qVal = parseInt(document.getElementById('customQ_unified').value) || 50;
        const quality = qVal / 100;
        const isPng = qVal === 100;
        const gap = parseInt(document.getElementById('gap').value) || 0;
        
        const batchSize = cols * rows;
        const totalBatches = Math.ceil(state.images.length / batchSize);

        try {
            for (let b = 0; b < totalBatches; b++) {
                if (state.isCancelled) break;
                
                showToast(true, `正在生成 ${b + 1}/${totalBatches} 组... (内存整理中)`);
                await sleep(100); // 强制让出主线程，允许 UI 渲染和 GC

                const batchImgs = state.images.slice(b * batchSize, (b + 1) * batchSize);
                
                // 计算画布尺寸
                const ratio = getAspectRatio();
                let cellW = 1500; // 基准宽度
                // 防止画布过大崩溃
                if (cols * cellW > MAX_CANVAS_DIM) cellW = Math.floor((MAX_CANVAS_DIM - (cols * gap)) / cols);
                const cellH = Math.floor(cellW / ratio);

                const realCols = cols;
                const realRows = Math.ceil(batchImgs.length / realCols);
                
                canvas.width = realCols * cellW + (realCols - 1) * gap;
                canvas.height = realRows * cellH + (realRows - 1) * gap;
                
                ctx.fillStyle = '#FFFFFF';
                ctx.fillRect(0, 0, canvas.width, canvas.height);

                // --- 绘制循环 ---
                for (let i = 0; i < batchImgs.length; i++) {
                    if (state.isCancelled) throw new Error('Cancelled');
                    
                    // 关键性能点：每10张强制暂停，防止浏览器卡死
                    if (i > 0 && i % 10 === 0) await sleep(20);

                    const imgObj = batchImgs[i];
                    const r = Math.floor(i / realCols);
                    const c = i % realCols;
                    const x = c * (cellW + gap);
                    const y = r * (cellH + gap);

                    const img = new Image();
                    img.src = imgObj.url;
                    
                    try {
                        // 关键：等待完全解码，防止黑块
                        await img.decode();
                        
                        // 居中裁剪绘制
                        ctx.save();
                        ctx.beginPath();
                        ctx.rect(x, y, cellW, cellH);
                        ctx.clip();
                        
                        const iRatio = img.width / img.height;
                        const cRatio = cellW / cellH;
                        
                        if (iRatio > cRatio) {
                            const drawW = cellH * iRatio;
                            ctx.drawImage(img, x - (drawW - cellW) / 2, y, drawW, cellH);
                        } else {
                            const drawH = cellW / iRatio;
                            ctx.drawImage(img, x, y - (drawH - cellH) / 2, cellW, drawH);
                        }
                        ctx.restore();
                    } catch (err) {
                        console.error('Image decode failed', err);
                        // 绘制错误占位符
                        ctx.fillStyle = '#eee';
                        ctx.fillRect(x, y, cellW, cellH);
                        ctx.fillStyle = 'red';
                        ctx.font = '40px sans-serif';
                        ctx.fillText('❌', x + cellW/2 - 20, y + cellH/2);
                    } finally {
                        // 立即释放内存
                        img.src = '';
                    }

                    // 绘制序号
                    drawNumber(ctx, i + (b * batchSize), x, y, cellW, cellH);
                }

                // 绘制 Overlay
                if (state.overlayImg) {
                    ctx.save();
                    ctx.globalAlpha = parseFloat(document.getElementById('overlayOpacityRange').value);
                    ctx.globalCompositeOperation = document.getElementById('overlayMode').value;
                    ctx.drawImage(state.overlayImg, 0, 0, canvas.width, canvas.height);
                    ctx.restore();
                }

                // 输出 Blob
                const blob = await new Promise(r => canvas.toBlob(r, isPng ? 'image/png' : 'image/jpeg', quality));
                state.generatedBlobs.push(blob);
                
                // 添加到结果预览
                const previewImg = document.createElement('img');
                previewImg.src = URL.createObjectURL(blob);
                previewImg.className = "w-full block border-b border-gray-100";
                container.appendChild(previewImg);
                
                // 清理 Canvas 显存
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                canvas.width = 1; canvas.height = 1;
            }

            resultArea.classList.remove('hidden');
            resultArea.scrollIntoView({ behavior: 'smooth' });
        } catch (e) {
            console.error(e);
            if (!state.isCancelled) alert('生成出错: ' + e.message);
        } finally {
            showToast(false);
        }
    };

    // --- 序号绘制逻辑 ---
    const drawNumber = (ctx, index, x, y, w, h) => {
        if (!document.getElementById('showNum').checked) return;
        
        const startNum = parseInt(document.getElementById('startNumber').value) || 1;
        const num = startNum + index;
        
        // 动态计算字体大小 (基于宽度)
        const baseSize = 350; // 原基准
        const scale = w / 1500; // 缩放比例
        const fontSize = baseSize * scale; 
        
        const family = document.getElementById('fontFamily').value;
        const weightRaw = document.getElementById('fontWeightSelect').value;
        let weight = weightRaw === 'custom' ? document.getElementById('customWeightRange').value : weightRaw;
        
        ctx.save();
        ctx.font = `${weight} ${fontSize}px ${family}`;
        ctx.fillStyle = document.getElementById('fontColor').value;
        ctx.globalAlpha = parseInt(document.getElementById('fontOpacity').value) / 100;
        
        // 位置计算
        const pos = document.getElementById('fontPos').value;
        let tx = x + w / 2, ty = y + h / 2;
        const pad = 40 * scale;
        
        if (pos.includes('bottom')) ty = y + h - pad;
        else if (pos.includes('top')) {
            ctx.textBaseline = 'top';
            ty = y + pad;
        } else {
            ctx.textBaseline = 'middle';
        }
        
        if (pos.includes('left')) { ctx.textAlign = 'left'; tx = x + pad; }
        else if (pos.includes('right')) { ctx.textAlign = 'right'; tx = x + w - pad; }
        else { ctx.textAlign = 'center'; }

        // 描边
        if (document.getElementById('enableStroke').checked) {
            ctx.strokeStyle = document.getElementById('fontStrokeColor').value;
            ctx.lineWidth = fontSize * 0.05;
            ctx.lineJoin = 'round';
            ctx.strokeText(num, tx, ty);
        }
        
        ctx.fillText(num, tx, ty);
        ctx.restore();
    };

    // --- 实时预览逻辑 ---
    const updateNumberPreview = () => {
        const cvs = document.getElementById('numPreviewCanvas');
        const ctx = cvs.getContext('2d');
        const w = cvs.width, h = cvs.height;
        
        // 背景
        ctx.fillStyle = '#eee';
        ctx.fillRect(0, 0, w, h);
        if (state.images.length > 0) {
            // 尝试绘制第一张图作为背景
            const img = new Image();
            img.src = state.images[0].url;
            // 简单处理，不等待加载，如果是缓存的就能显示，否则下次更新显示
            if (img.complete) ctx.drawImage(img, 0, 0, w, h);
        }
        
        // 复用绘制逻辑，但需要模拟参数
        if (document.getElementById('showNum').checked) {
            // 临时覆盖 getElementById 获取上下文中的值
            // 这里我们手动实现一个简单的预览绘制，逻辑复用有点复杂因为 scale 不同
            
            const startNum = document.getElementById('startNumber').value || 1;
            const family = document.getElementById('fontFamily').value;
            const weightRaw = document.getElementById('fontWeightSelect').value;
            let weight = weightRaw === 'custom' ? document.getElementById('customWeightRange').value : weightRaw;
            
            const fontSize = 60; // 预览固定大小
            
            ctx.save();
            ctx.font = `${weight} ${fontSize}px ${family}`;
            ctx.fillStyle = document.getElementById('fontColor').value;
            ctx.globalAlpha = parseInt(document.getElementById('fontOpacity').value) / 100;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            
            if (document.getElementById('enableStroke').checked) {
                ctx.strokeStyle = document.getElementById('fontStrokeColor').value;
                ctx.lineWidth = 3;
                ctx.strokeText(startNum, w/2, h/2);
            }
            
            ctx.fillText(startNum, w/2, h/2);
            ctx.restore();
        }
    };
    
    const enlargeNumberPreview = () => {
        const modal = document.getElementById('previewModal');
        const img = document.getElementById('enlargedPreviewImg');
        const canvas = document.getElementById('numPreviewCanvas');
        img.src = canvas.toDataURL();
        modal.style.display = 'flex';
    };

    // --- 辅助功能 ---
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    
    const showToast = (show, text) => {
        const el = document.getElementById('progressToast');
        if (show) {
            document.getElementById('progressText').innerText = text;
            el.classList.remove('-translate-y-[200%]', 'opacity-0', 'pointer-events-none');
        } else {
            el.classList.add('-translate-y-[200%]', 'opacity-0', 'pointer-events-none');
        }
    };

    const getAspectRatio = () => {
        const val = document.getElementById('aspectRatio').value;
        if (val === 'custom') {
            const w = parseInt(document.getElementById('customW').value) || 1000;
            const h = parseInt(document.getElementById('customH').value) || 1500;
            return w / h;
        }
        return parseFloat(val);
    };

    const calculateGroupBatch = () => {
        const cols = parseInt(document.getElementById('cols').value) || 3;
        const rows = parseInt(document.getElementById('group_rows').value) || 3;
        const total = state.images.length;
        const hint = document.getElementById('group_hint');
        
        if (cols > 0 && rows > 0) {
            const batchSize = cols * rows;
            const groups = total > 0 ? Math.ceil(total / batchSize) : 0;
            hint.innerHTML = `<span class="text-[#007AFF] font-bold">✅ 已就绪:</span> <span>每组 ${batchSize} 张，共 ${groups} 组</span>`;
        }
    };

    const toggleCustomRatio = () => {
        const isCustom = document.getElementById('aspectRatio').value === 'custom';
        document.getElementById('customRatioBox').style.display = isCustom ? 'flex' : 'none';
    };

    const toggleCustomWeight = () => {
        const isCustom = document.getElementById('fontWeightSelect').value === 'custom';
        const box = document.getElementById('customWeightBox');
        box.style.display = isCustom ? 'block' : 'none';
    };

    // --- 图片操作与设置 ---
    const clearAll = async () => {
        if(confirm('确定清空所有图片？')) {
            await DB.clear();
            await refreshImagesFromDB();
        }
    };
    
    const removeDuplicates = async () => {
        // 简单去重：同名判断
        const seen = new Set();
        const keepIds = [];
        const deleteIds = [];
        
        state.images.forEach(img => {
            if (seen.has(img.name)) deleteIds.push(img.id);
            else {
                seen.add(img.name);
                keepIds.push(img.id);
            }
        });
        
        for (let id of deleteIds) DB.delete(id);
        await refreshImagesFromDB();
    };

    const openImageActions = (index) => {
        state.targetIndex = index;
        document.getElementById('imageActionOverlay').style.display = 'block';
        setTimeout(() => document.getElementById('imageActionSheet').classList.add('show'), 10);
    };

    const closeImageActions = () => {
        document.getElementById('imageActionSheet').classList.remove('show');
        setTimeout(() => document.getElementById('imageActionOverlay').style.display = 'none', 300);
    };

    const triggerReplace = () => { document.getElementById('replaceInput').click(); closeImageActions(); };
    const triggerDelete = async () => {
        if (state.targetIndex > -1) {
            const img = state.images[state.targetIndex];
            DB.delete(img.id);
            await refreshImagesFromDB();
        }
        closeImageActions();
    };
    
    const handleReplaceAction = async (files) => {
        if (files.length && state.targetIndex > -1) {
            // 删除旧的，插入新的（IDB不支持直接替换特定位置，只能删再加，顺序会变到最后，这里简化处理）
            // 完美方案需要IDB支持排序字段。这里为了从简，我们只删旧的，加新的到最后。
            const oldImg = state.images[state.targetIndex];
            DB.delete(oldImg.id);
            await DB.addImages([files[0]]);
            await refreshImagesFromDB();
        }
        document.getElementById('replaceInput').value = '';
    };

    const handleOverlayFile = (files) => {
        if (!files.length) return;
        const img = new Image();
        img.onload = () => {
            state.overlayImg = img;
            document.getElementById('overlayInfoBox').classList.remove('hidden');
            document.getElementById('overlayName').innerText = files[0].name;
            document.getElementById('overlayThumb').src = img.src;
        };
        img.src = URL.createObjectURL(files[0]);
    };

    const clearOverlay = () => {
        state.overlayImg = null;
        document.getElementById('overlayInfoBox').classList.add('hidden');
        document.getElementById('overlayInput').value = '';
    };

    // --- 下载逻辑 ---
    const confirmDownload = (type) => {
        if (!state.generatedBlobs.length) return alert('请先生成');
        if (type === 'zip') {
            const zip = new JSZip();
            const folder = zip.folder("拼图");
            const ext = document.getElementById('customQ_unified').value == 100 ? 'png' : 'jpg';
            state.generatedBlobs.forEach((b, i) => folder.file(`拼图_${i+1}.${ext}`, b));
            zip.generateAsync({type:'blob'}).then(content => {
                const a = document.createElement('a');
                a.href = URL.createObjectURL(content);
                a.download = `拼图打包_${Date.now()}.zip`;
                a.click();
            });
        } else if (type === 'parts') {
            if(!confirm('即将开始逐张下载，请允许浏览器下载多个文件。')) return;
            state.generatedBlobs.forEach((b, i) => {
                setTimeout(() => {
                    const a = document.createElement('a');
                    a.href = URL.createObjectURL(b);
                    a.download = `拼图_${i+1}.${b.type.includes('png')?'png':'jpg'}`;
                    a.click();
                }, i * 1500);
            });
        }
    };

    // --- 拖拽按钮逻辑 ---
    const setupDraggableBtn = () => {
        const btn = document.getElementById('permissionFixBtn');
        let isDragging = false;
        let startY, startTop;

        const onStart = (e) => {
            isDragging = true;
            startY = e.touches ? e.touches[0].clientY : e.clientY;
            startTop = btn.offsetTop;
            btn.style.transition = 'none';
        };

        const onMove = (e) => {
            if (!isDragging) return;
            e.preventDefault();
            const y = e.touches ? e.touches[0].clientY : e.clientY;
            const delta = y - startY;
            btn.style.top = `${startTop + delta}px`;
        };

        const onEnd = () => {
            isDragging = false;
            btn.style.transition = 'top 0.3s';
        };

        btn.addEventListener('touchstart', onStart, {passive: false});
        document.addEventListener('touchmove', onMove, {passive: false});
        document.addEventListener('touchend', onEnd);
        btn.addEventListener('mousedown', onStart);
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onEnd);
    };

    const triggerBrowserPermission = () => {
        const blob = new Blob(["test"], {type: "text/plain"});
        const u = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = u; a.download="1.txt";
        const b = document.createElement('a'); b.href = u; b.download="2.txt";
        document.body.append(a, b);
        a.click();
        setTimeout(() => b.click(), 100);
        setTimeout(() => { a.remove(); b.remove(); alert('请点击地址栏的【允许】'); }, 500);
    };

    // --- Settings Persistence ---
    const saveSettings = () => {
        const s = {
            cols: document.getElementById('cols').value,
            group_rows: document.getElementById('group_rows').value,
            aspectRatio: document.getElementById('aspectRatio').value,
            quality: document.getElementById('customQ_unified').value,
            showNum: document.getElementById('showNum').checked,
            startNumber: document.getElementById('startNumber').value,
            fontFamily: document.getElementById('fontFamily').value,
            fontWeight: document.getElementById('fontWeightSelect').value,
            customWeight: document.getElementById('customWeightRange').value,
            fontColor: document.getElementById('fontColor').value,
            enableStroke: document.getElementById('enableStroke').checked,
            fontStrokeColor: document.getElementById('fontStrokeColor').value,
            fontOpacity: document.getElementById('fontOpacity').value,
            fontPos: document.getElementById('fontPos').value
        };
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
    };

    const loadSettings = () => {
        try {
            const s = JSON.parse(localStorage.getItem(SETTINGS_KEY));
            if (!s) return;
            if(s.cols) document.getElementById('cols').value = s.cols;
            if(s.group_rows) document.getElementById('group_rows').value = s.group_rows;
            if(s.aspectRatio) { document.getElementById('aspectRatio').value = s.aspectRatio; toggleCustomRatio(); }
            if(s.quality) document.getElementById('customQ_unified').value = s.quality;
            if(s.showNum !== undefined) document.getElementById('showNum').checked = s.showNum;
            if(s.startNumber) document.getElementById('startNumber').value = s.startNumber;
            if(s.fontFamily) document.getElementById('fontFamily').value = s.fontFamily;
            if(s.fontWeight) { document.getElementById('fontWeightSelect').value = s.fontWeight; toggleCustomWeight(); }
            if(s.customWeight) document.getElementById('customWeightRange').value = s.customWeight;
            if(s.fontColor) document.getElementById('fontColor').value = s.fontColor;
            if(s.enableStroke !== undefined) document.getElementById('enableStroke').checked = s.enableStroke;
            if(s.fontStrokeColor) document.getElementById('fontStrokeColor').value = s.fontStrokeColor;
            if(s.fontOpacity) document.getElementById('fontOpacity').value = s.fontOpacity;
            if(s.fontPos) document.getElementById('fontPos').value = s.fontPos;
        } catch(e) {}
    };

    const setupDragDrop = () => {
        document.addEventListener('dragover', e => { e.preventDefault(); document.getElementById('dragOverlay').classList.add('active'); });
        document.addEventListener('dragleave', e => { if(!e.relatedTarget) document.getElementById('dragOverlay').classList.remove('active'); });
        document.addEventListener('drop', e => {
            e.preventDefault();
            document.getElementById('dragOverlay').classList.remove('active');
            handleFiles(e.dataTransfer.files);
        });
    };
    
    const hardReset = () => {
        if(confirm('重置将清空所有图片和设置。确定吗？')) {
            localStorage.removeItem(SETTINGS_KEY);
            DB.clear().then(() => location.reload());
        }
    };
    
    const cancelProcess = () => { state.isCancelled = true; };

    // 暴露 API
    return {
        init,
        handleFiles,
        generate,
        clearAll,
        removeDuplicates,
        openImageActions,
        closeImageActions,
        triggerReplace,
        triggerDelete,
        handleReplaceAction,
        handleOverlayFile,
        clearOverlay,
        confirmDownload,
        calculateGroupBatch,
        toggleCustomRatio,
        toggleCustomWeight,
        updateNumberPreview,
        enlargeNumberPreview,
        handleStickerFile: () => {}, // 占位
        hardReset,
        cancelProcess,
        triggerBrowserPermission
    };

})();

// 启动
window.app = App;
window.addEventListener('DOMContentLoaded', App.init);
