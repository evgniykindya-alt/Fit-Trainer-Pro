window.addEventListener('error', (e) => { 
    console.error('[FT error]', e.error || e.message);
    try {
        const log = readStoredArray('ft_error_log');
        log.push({ ts: Date.now(), msg: String(e.message || e.error || 'Unknown'), src: String(e.filename || ''), line: e.lineno });
        while (log.length > 50) log.shift();
        localStorage.setItem('ft_error_log', JSON.stringify(log));
    } catch(err) {}
});
window.addEventListener('unhandledrejection', (e) => { 
    console.error('[FT unhandled]', e.reason);
    try {
        const log = readStoredArray('ft_error_log');
        log.push({ ts: Date.now(), msg: 'Promise rejection: ' + String(e.reason || 'Unknown') });
        while (log.length > 50) log.shift();
        localStorage.setItem('ft_error_log', JSON.stringify(log));
    } catch(err) {}
});

const APP_VERSION = '1.2.8';
const TAB_ID = 'tab_' + Math.random().toString(36).slice(2) + '_' + Date.now();
const TAB_LOCK_KEY = 'ft_tab_lock';
/** Чужой lock «жив», если heartbeat был недавно (учитываем throttling фона) */
const TAB_LOCK_STALE_MS = 8000;
const TAB_HEARTBEAT_MS = 1500;
/** После refresh/kill ждём, пока «мертвый» lock протухнет, прежде чем считать его второй вкладкой */
const TAB_LOCK_CONFIRM_MS = 8500;
let tabLockInterval = null;
let multiTabWarningShown = false;
let tabLockCheckTimer = null;
let tabLockChannel = null;
let isPrimaryTab = false;
let tabLockListenersBound = false;
let swRegistrationGlobal = null;
let swError = false;
function openImportPicker(mode) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;';
    document.body.appendChild(input);

    const clickResult = input.click();

    const cleanup = () => { try { input.remove(); } catch(e) {} };

    input.addEventListener('change', (event) => {
        const file = event.target.files[0];
        if (!file) { cleanup(); return; }
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                if (mode === 'workout') {
                    importWorkoutFromJson(e.target.result);
                } else {
                    importDataFromJson(e.target.result);
                }
            } catch (err) { showToast('Ошибка: ' + err.message); }
            cleanup();
        };
        reader.onerror = () => { showToast('Не удалось прочитать файл'); cleanup(); };
        reader.readAsText(file);
    });

    input.addEventListener('cancel', cleanup);
    setTimeout(cleanup, 5 * 60 * 1000);
}

function importWorkoutFromJson(text) {
    try {
        const data = JSON.parse(text);
        if (data.type !== 'fit-trainer-workout' || !data.workout) { showToast('Не файл тренировки'); return; }
        const w = data.workout;
        if (!w.name || !w.exercises || !Array.isArray(w.exercises)) { showToast('Неверный формат'); return; }
        const nw = { id: Date.now(), name: w.name + ' (импорт)', autoStart: w.autoStart || false, exercises: w.exercises, settings: w.settings || null };
        DB.workouts.push(nw); saveDB('workouts');
        showToast(`Импортировано: ${nw.name}`);
        showScreen('screen-workouts');
    } catch(err) { showToast('Ошибка: ' + err.message); }
}

async function importDataFromJson(text) {
    try {
        let data;
        try { data = JSON.parse(text); } catch(e) { showToast('Файл повреждён или не является JSON'); return; }
        if (data && data.type === 'fit-trainer-backup-encrypted') {
            const password = await askBackupPassword({ title: 'Импорт бэкапа', info: 'Файл зашифрован. Введите пароль, который использовали при экспорте.', confirmText: '🔓 Расшифровать', mode: 'decrypt' });
            if (!password) return;
            const decryptedText = await decryptBackupData(data, password);
            if (!decryptedText) { showToast('Неверный пароль или повреждённый файл', 4000); return; }
            try { data = JSON.parse(decryptedText); } catch(e) { showToast('Расшифрованные данные повреждены'); return; }
        }
        const ok = await customConfirm(`Импортировать данные?\nТренировок: ${data.workouts?.length || 0}\nШаблонов: ${data.templates?.length || 0}\nПрограмм: ${data.programs?.length || 0}\nЗаписей: ${data.history?.length || 0}\nЗамеров: ${data.measurements?.length || 0}\n\nТекущие данные будут ЗАМЕНЕНЫ.`, { title: 'Импорт данных', okText: '📥 Импортировать', danger: true });
        if (!ok) return;
        if (data.workouts && Array.isArray(data.workouts)) DB.workouts = data.workouts;
        if (data.templates && Array.isArray(data.templates)) DB.templates = data.templates;
        if (data.programs && Array.isArray(data.programs)) DB.programs = data.programs;
        if (data.history && Array.isArray(data.history)) DB.history = data.history;
        if (data.measurements && Array.isArray(data.measurements)) DB.measurements = data.measurements;
        if (data.settings) { DB.settings = Object.assign(DB.settings, data.settings); if ('announceConfirm' in DB.settings) delete DB.settings.announceConfirm; }
        if (!Array.isArray(DB.settings.hiddenBuiltins)) DB.settings.hiddenBuiltins = [];
        if (DB.settings.soundMode !== 'voice' && DB.settings.soundMode !== 'beep') DB.settings.soundMode = 'beep';
        if ('voice' in DB.settings) delete DB.settings.voice;
        if (!['auto','light','dark'].includes(DB.settings.themeMode)) DB.settings.themeMode = 'auto';
        if (![0.8,1,1.3].includes(DB.settings.voiceRate)) DB.settings.voiceRate = 1;
        if (typeof DB.settings.autoBackupReminder !== 'boolean') DB.settings.autoBackupReminder = true;
        if (typeof DB.settings.lastBackupAt !== 'number') DB.settings.lastBackupAt = 0;
        if (typeof DB.settings.lastBackupRecordCount !== 'number') DB.settings.lastBackupRecordCount = 0;
        if (typeof DB.settings.askReps !== 'boolean') DB.settings.askReps = true;
        if (typeof DB.settings.askWeight !== 'boolean') DB.settings.askWeight = false;
        if (typeof DB.settings.announceWorkoutName !== 'boolean') DB.settings.announceWorkoutName = true;
        if (typeof DB.settings.announceExerciseName !== 'boolean') DB.settings.announceExerciseName = true;
        if (typeof DB.settings.announceExerciseGoal !== 'boolean') DB.settings.announceExerciseGoal = true;
        if (typeof DB.settings.announceRestName !== 'boolean') DB.settings.announceRestName = true;
        if (typeof DB.settings.overtimeStopwatch !== 'boolean') DB.settings.overtimeStopwatch = false;
        if (typeof DB.settings.finalWarnSeconds !== 'number' || ![0,5,10,15,20,30].includes(DB.settings.finalWarnSeconds)) DB.settings.finalWarnSeconds = 5;
        if (typeof DB.settings.showActivityCalendar !== 'boolean') DB.settings.showActivityCalendar = true;
        if (typeof DB.settings.notifyScheduledWorkouts !== 'boolean') DB.settings.notifyScheduledWorkouts = true;
        if (typeof DB.settings.notifyShowCompleted !== 'boolean') DB.settings.notifyShowCompleted = true;
        if (typeof DB.settings.showBottomNav !== 'boolean') DB.settings.showBottomNav = true;
        if (!DB.settings.accordions || typeof DB.settings.accordions !== 'object') DB.settings.accordions = {};
        if (!DB.settings.dismissedUntil || typeof DB.settings.dismissedUntil !== 'object' || Array.isArray(DB.settings.dismissedUntil)) DB.settings.dismissedUntil = {};
        if (typeof DB.settings.lastNotifAutoShow !== 'string') DB.settings.lastNotifAutoShow = '';
        if (![1,2,3,4,24].includes(DB.settings.snoozeDuration)) DB.settings.snoozeDuration = 2;
        if (!Array.isArray(DB.settings.hiddenMenuItems)) DB.settings.hiddenMenuItems = [];
        if (!Array.isArray(DB.settings.hiddenBottomNavItems)) DB.settings.hiddenBottomNavItems = [];
        DB.settings.hiddenMenuItems = DB.settings.hiddenMenuItems.filter(k => HIDEABLE_MENU_KEYS.includes(k));
        DB.settings.hiddenBottomNavItems = DB.settings.hiddenBottomNavItems.filter(k => HIDEABLE_MENU_KEYS.includes(k));
        if (!['small','normal','large'].includes(DB.settings.fontSizeMode)) DB.settings.fontSizeMode = 'normal';
        if (typeof DB.settings.highContrast !== 'boolean') DB.settings.highContrast = false;
        if (typeof DB.settings.compactWorkouts !== 'boolean') DB.settings.compactWorkouts = false;
        if (typeof DB.settings.streakGuard !== 'boolean') DB.settings.streakGuard = true;
        if (typeof DB.settings.streakGuardHour !== 'number') DB.settings.streakGuardHour = 18;
        if (typeof DB.settings.weeklyDigest !== 'boolean') DB.settings.weeklyDigest = true;
        if (typeof DB.settings.quietHours !== 'boolean') DB.settings.quietHours = false;
        if (typeof DB.settings.quietHoursStart !== 'number') DB.settings.quietHoursStart = 22;
        if (typeof DB.settings.quietHoursEnd !== 'number') DB.settings.quietHoursEnd = 8;
        if (typeof DB.settings.programsCalendarCollapsed !== 'boolean') DB.settings.programsCalendarCollapsed = false;
        if (!DB.settings.historyProgramDayCollapsed || typeof DB.settings.historyProgramDayCollapsed !== 'object' || Array.isArray(DB.settings.historyProgramDayCollapsed)) DB.settings.historyProgramDayCollapsed = {};
        if (!DB.settings.historyProgramCollapsed || typeof DB.settings.historyProgramCollapsed !== 'object' || Array.isArray(DB.settings.historyProgramCollapsed)) DB.settings.historyProgramCollapsed = {};
        if (typeof DB.settings.builtinTemplatesCollapsed !== 'boolean') DB.settings.builtinTemplatesCollapsed = false;
        if (typeof DB.settings.weekMetric !== 'string') DB.settings.weekMetric = 'work';
        if (![4,8,12].includes(DB.settings.weekRange)) DB.settings.weekRange = 8;
        if (typeof DB.settings.homeStreakCollapsed !== 'boolean') DB.settings.homeStreakCollapsed = false;
        if (typeof DB.settings.homePlanCollapsed !== 'boolean') DB.settings.homePlanCollapsed = false;
        if (typeof DB.settings.quickStartCollapsed !== 'boolean') DB.settings.quickStartCollapsed = false;
        saveDB('workouts'); saveDB('templates'); saveDB('programs'); saveDB('history'); saveDB('measurements'); saveDB('settings');
        validateAndMigrateDB();
        applyTheme(); applyFontSize(); applyCompactWorkouts(); applyHomeMenuVisibility();
        invalidateActivityCache();
        showToast('Импорт успешен');
        showScreen('screen-home');
    } catch(err) { showToast('Ошибка: ' + err.message); }
}
function updateFooter() {
    const el = document.getElementById('app-footer');
    if (!el) return;
    let modeText, isError = false;
    if (!navigator.onLine) { modeText = 'офлайн режим'; }
    else if (swError) { modeText = 'ошибка кэша'; isError = true; }
    else { modeText = 'онлайн режим'; }
    el.textContent = `v${APP_VERSION} · ${modeText}`;
    el.classList.toggle('error', isError);
}

function isSafeToApplyAppUpdate() {
    // Не перезагружаем страницу во время тренировки или редактирования данных.
    const active = document.querySelector('.screen.active');
    if (!active) return false;
    if (active.id === 'screen-run' || active.id === 'screen-editor' || active.id === 'screen-program-editor') return false;
    if (runState && runState.phase !== 'finish') return false;
    if (document.querySelector('.notif-side-overlay, .bottom-sheet-overlay, .multi-tab-warning')) return false;
    return true;
}

async function activateWaitingAppUpdate() {
    const reg = swRegistrationGlobal;
    if (!reg || !reg.waiting || !isSafeToApplyAppUpdate()) return false;
    try {
        reg.waiting.postMessage({ type: 'SKIP_WAITING' });
        return true;
    } catch (e) {
        console.warn('[SW] cannot activate waiting update', e);
        return false;
    }
}

async function checkForAppUpdate() {
    if (!('serviceWorker' in navigator) || !swRegistrationGlobal) return 'unavailable';
    try {
        await swRegistrationGlobal.update();
        // Даём установке нового worker немного времени завершиться.
        if (swRegistrationGlobal.installing) {
            await new Promise((resolve) => {
                const worker = swRegistrationGlobal.installing;
                if (!worker) return resolve();
                const timeout = setTimeout(resolve, 1800);
                worker.addEventListener('statechange', () => {
                    if (worker.state === 'installed' || worker.state === 'redundant') {
                        clearTimeout(timeout);
                        resolve();
                    }
                });
            });
        }
        if (swRegistrationGlobal.waiting) {
            return isSafeToApplyAppUpdate() ? 'waiting' : 'deferred';
        }
        return 'checked';
    } catch (e) {
        console.warn('[SW] update check failed', e);
        return 'offline';
    }
}

async function initServiceWorker() {
    if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
    try {
        // Сброс залипшего SW: откройте сайт с ?resetsw=1
        if (/[?&]resetsw=1\b/.test(location.search)) {
            try {
                const regs = await navigator.serviceWorker.getRegistrations();
                await Promise.all(regs.map((r) => r.unregister()));
                if (window.caches) {
                    const keys = await caches.keys();
                    await Promise.all(keys.filter(k => k.startsWith('fit-trainer-')).map((k) => caches.delete(k)));
                }
            } catch (e) {}
            try {
                const u = new URL(location.href);
                u.searchParams.delete('resetsw');
                history.replaceState(null, '', u.pathname + u.search + u.hash);
            } catch (e) {}
        }
        swRegistrationGlobal = await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
        // Проверяем обновления, но не активируем их автоматически: это может прервать работу.
        try { await swRegistrationGlobal.update(); } catch (e) {}
        swRegistrationGlobal.addEventListener('updatefound', () => {
            const worker = swRegistrationGlobal.installing;
            if (!worker) return;
            worker.addEventListener('statechange', () => {
                if (worker.state === 'installed' && navigator.serviceWorker.controller) {
                    showToast('Доступно обновление. Потяните экран вниз, чтобы установить его.', 4500);
                }
            });
        });
        updateFooter();
    } catch (e) {
        console.warn('[SW] registration failed', e);
        swError = true;
        updateFooter();
    }
}
window.addEventListener('online', updateFooter);
window.addEventListener('offline', updateFooter);

function readTabLock() {
    try {
        const raw = localStorage.getItem(TAB_LOCK_KEY);
        if (!raw) return null;
        const lock = JSON.parse(raw);
        if (!lock || typeof lock !== 'object' || !lock.id) return null;
        return lock;
    } catch (e) { return null; }
}
function writeTabLock() {
    try {
        localStorage.setItem(TAB_LOCK_KEY, JSON.stringify({ id: TAB_ID, ts: Date.now() }));
        isPrimaryTab = true;
    } catch (e) {}
}
function releaseTabLock() {
    try {
        const lock = readTabLock();
        if (lock && lock.id === TAB_ID) localStorage.removeItem(TAB_LOCK_KEY);
        isPrimaryTab = false;
    } catch (e) {}
}
/** Чужой lock ещё «живой» (недавно обновлялся) */
function isForeignActiveLock(lock, now = Date.now()) {
    if (!lock || !lock.id || lock.id === TAB_ID) return false;
    const age = now - (Number(lock.ts) || 0);
    return age >= 0 && age < TAB_LOCK_STALE_MS;
}
function dismissMultiTabWarning() {
    try {
        const ov = document.querySelector('.multi-tab-warning');
        if (ov) ov.remove();
    } catch (e) {}
    multiTabWarningShown = false;
}
function showMultiTabWarning() {
    if (multiTabWarningShown) return;
    if (document.querySelector('.multi-tab-warning')) return;
    // Ещё раз проверить: возможно lock уже протух
    try {
        if (!isForeignActiveLock(readTabLock())) {
            writeTabLock();
            return;
        }
    } catch (e) {}
    multiTabWarningShown = true;
    isPrimaryTab = false;
    const ov = document.createElement('div');
    ov.className = 'multi-tab-warning';
    ov.innerHTML = `<div class="mtw-card">
        <div class="mtw-icon">⚠️</div>
        <div class="mtw-title">Открыто в другой вкладке</div>
        <div class="mtw-text">Приложение уже запущено в другом окне. Чтобы избежать потери данных, используйте одну вкладку.</div>
        <button class="btn accent" onclick="stealTabLock()">Использовать эту вкладку</button>
    </div>`;
    document.body.appendChild(ov);
}
/**
 * iOS может убить PWA без pagehide. Свежий lock после refresh не = вторая вкладка:
 * ждём подтверждения, что чужой процесс продолжает heartbeat.
 */
function scheduleTabLockCheck(delay = TAB_LOCK_CONFIRM_MS) {
    if (tabLockCheckTimer) return;
    tabLockCheckTimer = setTimeout(() => {
        tabLockCheckTimer = null;
        try {
            if (!checkTabLock()) showMultiTabWarning();
            else dismissMultiTabWarning();
        } catch (e) {}
    }, delay);
}
/** true = эта вкладка владеет (или только что забрала) lock */
function checkTabLock() {
    try {
        const now = Date.now();
        const lock = readTabLock();
        if (isForeignActiveLock(lock, now)) {
            isPrimaryTab = false;
            return false;
        }
        writeTabLock();
        return true;
    } catch (e) {
        isPrimaryTab = true;
        return true;
    }
}
function startTabLockHeartbeat() {
    if (tabLockInterval) clearInterval(tabLockInterval);
    tabLockInterval = setInterval(() => {
        try {
            const now = Date.now();
            const lock = readTabLock();
            if (isForeignActiveLock(lock, now)) {
                isPrimaryTab = false;
                // Видимая вкладка — показать сразу; иначе отложить до возврата
                if (document.visibilityState === 'visible') showMultiTabWarning();
                else scheduleTabLockCheck(Math.min(TAB_LOCK_CONFIRM_MS, 2000));
                return;
            }
            // Свободен или наш — продлеваем (в т.ч. в фоне, пока браузер даёт тики)
            writeTabLock();
            try {
                if (tabLockChannel) tabLockChannel.postMessage({ type: 'heartbeat', id: TAB_ID, ts: now });
            } catch (e) {}
            if (multiTabWarningShown) {
                const cur = readTabLock();
                if (cur && cur.id === TAB_ID) dismissMultiTabWarning();
            }
        } catch (e) {}
    }, TAB_HEARTBEAT_MS);
}
function stealTabLock() {
    try {
        writeTabLock();
        dismissMultiTabWarning();
        try {
            if (tabLockChannel) tabLockChannel.postMessage({ type: 'steal', id: TAB_ID, ts: Date.now() });
        } catch (e) {}
        startTabLockHeartbeat();
    } catch (e) {}
}
function bindTabLockListeners() {
    if (tabLockListenersBound) return;
    tabLockListenersBound = true;
    try {
        if (typeof BroadcastChannel !== 'undefined') {
            tabLockChannel = new BroadcastChannel('ft_tab_lock_ch');
            tabLockChannel.onmessage = (ev) => {
                try {
                    const data = ev && ev.data;
                    if (!data || data.id === TAB_ID) return;
                    if (data.type === 'steal' || data.type === 'heartbeat' || data.type === 'claim') {
                        const lock = readTabLock();
                        if (isForeignActiveLock(lock) || data.type === 'steal') {
                            isPrimaryTab = false;
                            if (document.visibilityState === 'visible') showMultiTabWarning();
                            else scheduleTabLockCheck(1500);
                        }
                    }
                } catch (e) {}
            };
        }
    } catch (e) { tabLockChannel = null; }

    window.addEventListener('storage', (e) => {
        if (e.key !== TAB_LOCK_KEY || !e.newValue) return;
        try {
            const lock = JSON.parse(e.newValue);
            if (isForeignActiveLock(lock)) {
                isPrimaryTab = false;
                if (document.visibilityState === 'visible') showMultiTabWarning();
                else scheduleTabLockCheck(1500);
            }
        } catch (err) {}
    });

    window.addEventListener('pagehide', releaseTabLock);
    window.addEventListener('beforeunload', releaseTabLock);
    document.addEventListener('visibilitychange', () => {
        try {
            if (document.visibilityState === 'visible') {
                const lock = readTabLock();
                if (isForeignActiveLock(lock)) {
                    // Другая вкладка жива — не ждём полный grace, достаточно короткой проверки
                    scheduleTabLockCheck(2000);
                } else if (!multiTabWarningShown) {
                    writeTabLock();
                }
            }
        } catch (e) {}
    });
}
/**
 * Старт: слушатели + heartbeat + отложенная проверка чужого лока
 * (чтобы refresh / kill PWA не давали ложное предупреждение).
 */
function initTabLock() {
    try {
        bindTabLockListeners();
        const claimed = checkTabLock();
        startTabLockHeartbeat();
        if (claimed) {
            try {
                if (tabLockChannel) tabLockChannel.postMessage({ type: 'claim', id: TAB_ID, ts: Date.now() });
            } catch (e) {}
            return;
        }
        // Чужой lock есть — мог остаться от прошлого процесса. Ждём heartbeat.
        scheduleTabLockCheck(TAB_LOCK_CONFIRM_MS);
    } catch (e) {}
}

const SCHEMA_VERSION = 2;
(function initSchema() {
    try {
        const v = parseInt(localStorage.getItem('ft_schema_version') || '0', 10);
        if (v < SCHEMA_VERSION) localStorage.setItem('ft_schema_version', String(SCHEMA_VERSION));
    } catch(e) {}
})();

function checkStorageAvailable() {
    try { localStorage.setItem('__ft_test__', '1'); localStorage.removeItem('__ft_test__'); return true; }
    catch(e) { return false; }
}
if (!checkStorageAvailable()) {
    setTimeout(() => showToast('⚠️ Хранилище недоступно — данные не сохраняются.', 12000), 1500);
}

function getToastContainer() {
    let c = document.getElementById('toast-container');
    if (!c) { c = document.createElement('div'); c.id = 'toast-container'; document.body.appendChild(c); }
    return c;
}
function showToast(text, duration = 2500) {
    try {
        const t = document.createElement('div');
        t.className = 'ft-toast';
        t.textContent = text;
        getToastContainer().appendChild(t);
        setTimeout(() => { try { t.remove(); } catch(e) {} }, duration);
    } catch(e) {}
}
function showUndoToast(text, onUndo, duration = 8000) {
    try {
        const t = document.createElement('div');
        t.className = 'ft-toast';
        t.style.cssText = 'display:flex;align-items:center;gap:12px;min-width:220px;justify-content:space-between;';
        const span = document.createElement('span');
        span.textContent = text; span.style.flex = '1'; t.appendChild(span);
        const btn = document.createElement('button');
        btn.textContent = 'Отменить';
        btn.style.cssText = 'background:transparent;border:none;color:var(--accent);font-weight:700;font-size:0.9rem;cursor:pointer;padding:4px 8px;white-space:nowrap;';
        t.appendChild(btn);
        getToastContainer().appendChild(t);
        let removed = false;
        const remove = () => { if (removed) return; removed = true; try { t.remove(); } catch(e) {} };
        btn.onclick = () => { remove(); try { onUndo(); } catch(e) { console.error(e); } };
        setTimeout(remove, duration);
    } catch(e) {}
}

const Storage = {
    get(key, defaultValue) {
        try { const item = localStorage.getItem(key); return item ? JSON.parse(item) : defaultValue; }
        catch (e) { return defaultValue; }
    },
    set(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); return true; }
        catch (e) { console.warn('[Storage.set]', key, e); return false; }
    }
};

// Безопасное чтение списков из localStorage: повреждённая запись не должна
// ломать интерфейс журналов и диагностики.
function readStoredArray(key) {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return [];
        const value = JSON.parse(raw);
        return Array.isArray(value)
            ? value.filter(item => item && typeof item === 'object' && !Array.isArray(item))
            : [];
    } catch (e) {
        console.warn('[Storage.array]', key, e);
        return [];
    }
}

(async function() {
    try {
        if (navigator.storage && navigator.storage.persist) {
            const granted = await navigator.storage.persist();
            if (!granted) setTimeout(() => showToast('⚠️ Браузер может удалить данные при очистке кэша', 5000), 8000);
        }
    } catch(e) {}
})();

const DB = {
    workouts: Storage.get('ft_workouts', []),
    templates: Storage.get('ft_templates', []),
    programs: Storage.get('ft_programs', []),
    history: Storage.get('ft_history', []),
    measurements: Storage.get('ft_measurements', []),
    settings: Storage.get('ft_settings', {})
};
DB.settings = Object.assign({
    wakeLock: false, voice: false, countdown: false,
    workoutSettingsPriority: 'workout',
    defaultAutoStart: true, continuousBeep: false, overtimeStopwatch: false, finalWarnSeconds: 5,
    alarmSound: 'alarm', hiddenBuiltins: [],
    minuteBeep: false, minuteBeepInterval: 60,
    announceNumbers: true, announceWorkoutName: true, announceExerciseName: true, announceExerciseGoal: true, announceRestName: true, countdownDuration: 3, showStartTime: false,
    themeMode: 'auto', voiceRate: 1, voiceURI: null,
    announceButtons: false,
    notifyScheduledWorkouts: true, notifyShowCompleted: true,
    showActivityCalendar: true,
    autoBackupReminder: true, lastBackupAt: 0, lastBackupRecordCount: 0,
    askReps: true, askWeight: false,
    showLastExercise: true, autoFillWeight: true, autoFillReps: true, trackPRs: true, shareImageCard: true,
    roundWeight: false, largeRunControls: false, showVolumeStats: true, confirmSkipExercise: false,
    hiddenMenuItems: [],
    hiddenBottomNavItems: [],
    showBottomNav: true,
    accordions: {},
    dismissedUntil: {},
    lastNotifAutoShow: '',
    snoozeDuration: 2,
    fontSizeMode: 'normal',
    highContrast: false,
    compactWorkouts: false,
    streakGuard: true, streakGuardHour: 18,
    weeklyDigest: true,
    quietHours: false, quietHoursStart: 22, quietHoursEnd: 8,
    programsCalendarCollapsed: false,
    builtinTemplatesCollapsed: false,
    weekMetric: 'work',
    weekRange: 8,
    homeStreakCollapsed: false,
    homePlanCollapsed: false,
    quickStartCollapsed: false,
    measurementsChartCollapsed: false,
    measurementsSummaryCollapsed: false,
    measurementsCurrentCollapsed: false,
    measurementsBodyCollapsed: false,
    historyPersonalRecordsCollapsed: false
}, DB.settings);
if ('announceConfirm' in DB.settings) delete DB.settings.announceConfirm;
if (!Array.isArray(DB.settings.hiddenBuiltins)) DB.settings.hiddenBuiltins = [];
if (!['auto','light','dark'].includes(DB.settings.themeMode)) DB.settings.themeMode = 'auto';
if (![0.8, 1, 1.3].includes(DB.settings.voiceRate)) DB.settings.voiceRate = 1;
if (DB.settings.soundMode !== 'voice' && DB.settings.soundMode !== 'beep') DB.settings.soundMode = 'beep';
if ('voice' in DB.settings) delete DB.settings.voice;
if (typeof DB.settings.autoBackupReminder !== 'boolean') DB.settings.autoBackupReminder = true;
if (typeof DB.settings.lastBackupAt !== 'number') DB.settings.lastBackupAt = 0;
if (typeof DB.settings.lastBackupRecordCount !== 'number') DB.settings.lastBackupRecordCount = 0;
if (typeof DB.settings.askReps !== 'boolean') DB.settings.askReps = true;
if (typeof DB.settings.askWeight !== 'boolean') DB.settings.askWeight = false;
if (typeof DB.settings.showLastExercise !== 'boolean') DB.settings.showLastExercise = true;
if (typeof DB.settings.autoFillWeight !== 'boolean') DB.settings.autoFillWeight = true;
if (typeof DB.settings.autoFillReps !== 'boolean') DB.settings.autoFillReps = true;
if (typeof DB.settings.trackPRs !== 'boolean') DB.settings.trackPRs = true;
if (typeof DB.settings.shareImageCard !== 'boolean') DB.settings.shareImageCard = true;
if (typeof DB.settings.roundWeight !== 'boolean') DB.settings.roundWeight = false;
if ('showProgressionHint' in DB.settings) delete DB.settings.showProgressionHint;
if (typeof DB.settings.largeRunControls !== 'boolean') DB.settings.largeRunControls = false;
if (typeof DB.settings.showVolumeStats !== 'boolean') DB.settings.showVolumeStats = true;
if (typeof DB.settings.confirmSkipExercise !== 'boolean') DB.settings.confirmSkipExercise = false;
if ('weightUnit' in DB.settings) delete DB.settings.weightUnit;
if (typeof DB.settings.announceWorkoutName !== 'boolean') DB.settings.announceWorkoutName = true;
if (typeof DB.settings.announceExerciseName !== 'boolean') DB.settings.announceExerciseName = true;
if (typeof DB.settings.announceExerciseGoal !== 'boolean') DB.settings.announceExerciseGoal = true;
if (typeof DB.settings.announceRestName !== 'boolean') DB.settings.announceRestName = true;
if (typeof DB.settings.overtimeStopwatch !== 'boolean') DB.settings.overtimeStopwatch = false;
if (typeof DB.settings.finalWarnSeconds !== 'number' || ![0,5,10,15,20,30].includes(DB.settings.finalWarnSeconds)) DB.settings.finalWarnSeconds = 5;
if (typeof DB.settings.showActivityCalendar !== 'boolean') DB.settings.showActivityCalendar = true;
if (typeof DB.settings.notifyScheduledWorkouts !== 'boolean') DB.settings.notifyScheduledWorkouts = true;
if (typeof DB.settings.notifyShowCompleted !== 'boolean') DB.settings.notifyShowCompleted = true;
if (typeof DB.settings.showBottomNav !== 'boolean') DB.settings.showBottomNav = true;
if (!DB.settings.accordions || typeof DB.settings.accordions !== 'object') DB.settings.accordions = {};
if (!DB.settings.dismissedUntil || typeof DB.settings.dismissedUntil !== 'object' || Array.isArray(DB.settings.dismissedUntil)) DB.settings.dismissedUntil = {};
if (typeof DB.settings.lastNotifAutoShow !== 'string') DB.settings.lastNotifAutoShow = '';
if (![1,2,3,4,24].includes(DB.settings.snoozeDuration)) DB.settings.snoozeDuration = 2;
if (!['small','normal','large'].includes(DB.settings.fontSizeMode)) DB.settings.fontSizeMode = 'normal';
if (typeof DB.settings.highContrast !== 'boolean') DB.settings.highContrast = false;
if (typeof DB.settings.compactWorkouts !== 'boolean') DB.settings.compactWorkouts = false;
if (typeof DB.settings.streakGuard !== 'boolean') DB.settings.streakGuard = true;
if (typeof DB.settings.streakGuardHour !== 'number') DB.settings.streakGuardHour = 18;
if (typeof DB.settings.weeklyDigest !== 'boolean') DB.settings.weeklyDigest = true;
if (typeof DB.settings.quietHours !== 'boolean') DB.settings.quietHours = false;
if (typeof DB.settings.quietHoursStart !== 'number') DB.settings.quietHoursStart = 22;
if (typeof DB.settings.quietHoursEnd !== 'number') DB.settings.quietHoursEnd = 8;
if (typeof DB.settings.programsCalendarCollapsed !== 'boolean') DB.settings.programsCalendarCollapsed = false;
if (!DB.settings.historyProgramDayCollapsed || typeof DB.settings.historyProgramDayCollapsed !== 'object' || Array.isArray(DB.settings.historyProgramDayCollapsed)) DB.settings.historyProgramDayCollapsed = {};
if (!DB.settings.historyProgramCollapsed || typeof DB.settings.historyProgramCollapsed !== 'object' || Array.isArray(DB.settings.historyProgramCollapsed)) DB.settings.historyProgramCollapsed = {};
if (typeof DB.settings.builtinTemplatesCollapsed !== 'boolean') DB.settings.builtinTemplatesCollapsed = false;
if (typeof DB.settings.weekMetric !== 'string') DB.settings.weekMetric = 'work';
if (![4,8,12].includes(DB.settings.weekRange)) DB.settings.weekRange = 8;
if (typeof DB.settings.homeStreakCollapsed !== 'boolean') DB.settings.homeStreakCollapsed = false;
if (typeof DB.settings.homePlanCollapsed !== 'boolean') DB.settings.homePlanCollapsed = false;
if (typeof DB.settings.quickStartCollapsed !== 'boolean') DB.settings.quickStartCollapsed = false;
if (typeof DB.settings.measurementsChartCollapsed !== 'boolean') DB.settings.measurementsChartCollapsed = false;
if (typeof DB.settings.measurementsSummaryCollapsed !== 'boolean') DB.settings.measurementsSummaryCollapsed = false;
if (typeof DB.settings.measurementsCurrentCollapsed !== 'boolean') DB.settings.measurementsCurrentCollapsed = false;
if (typeof DB.settings.measurementsBodyCollapsed !== 'boolean') DB.settings.measurementsBodyCollapsed = false;
if (typeof DB.settings.historyPersonalRecordsCollapsed !== 'boolean') DB.settings.historyPersonalRecordsCollapsed = false;
// Миграция: старое «summary» → current+body
if (DB.settings.measurementsSummaryCollapsed) {
    if (DB.settings.measurementsCurrentCollapsed === false) DB.settings.measurementsCurrentCollapsed = true;
    if (DB.settings.measurementsBodyCollapsed === false) DB.settings.measurementsBodyCollapsed = true;
}
if (!DB.settings.accordions || typeof DB.settings.accordions !== 'object') DB.settings.accordions = {};
if (!Array.isArray(DB.settings.accordions.measurementsOrder)) {
    DB.settings.accordions.measurementsOrder = ['current', 'body'];
} else {
    DB.settings.accordions.measurementsOrder = DB.settings.accordions.measurementsOrder.filter(k => k === 'current' || k === 'body');
    if (!DB.settings.accordions.measurementsOrder.includes('current')) DB.settings.accordions.measurementsOrder.unshift('current');
    if (!DB.settings.accordions.measurementsOrder.includes('body')) DB.settings.accordions.measurementsOrder.push('body');
}
if (!Array.isArray(DB.measurements)) DB.measurements = [];
const HIDEABLE_MENU_KEYS = ['templates','programs','activity','history','measurements'];
if (!Array.isArray(DB.settings.hiddenMenuItems)) DB.settings.hiddenMenuItems = [];
DB.settings.hiddenMenuItems = DB.settings.hiddenMenuItems.filter(k => HIDEABLE_MENU_KEYS.includes(k));
if (!Array.isArray(DB.settings.hiddenBottomNavItems)) DB.settings.hiddenBottomNavItems = [];
DB.settings.hiddenBottomNavItems = DB.settings.hiddenBottomNavItems.filter(k => HIDEABLE_MENU_KEYS.includes(k));

const activityCache = { key: null, value: null };
function invalidateActivityCache() { activityCache.key = null; activityCache.value = null; }
function getActivityCacheKey() {
    const h = Array.isArray(DB.history) ? DB.history : [];
    const lastId = h.length ? (h[h.length - 1].id || 0) : 0;
    return `${h.length}|${lastId}|${DB.settings.weekMetric}|${DB.settings.weekRange}`;
}

function isVoiceMode() { return getEffectiveSetting('soundMode') === 'voice'; }
function isBeepMode() { return getEffectiveSetting('soundMode') !== 'voice'; }
function getAutoAdvanceDelay() { return isVoiceMode() ? 1500 : 900; }
function workoutUsesPersonalSettings(w) {
    if (!w) return false;
    if (typeof w.usePersonalSettings === 'boolean') return !!w.usePersonalSettings;
    // Совместимость: старый глобальный режим «настройки тренировки»
    if (w.settings && typeof w.settings === 'object' && DB.settings && DB.settings.workoutSettingsPriority === 'workout') return true;
    return false;
}
function getEffectiveSetting(key) {
    if (runState && runState.workout) {
        const w = runState.workout;
        const personal = !!runState.isTemp || workoutUsesPersonalSettings(w);
        if (personal && w.settings && typeof w.settings === 'object') {
            const v = w.settings[key];
            if (v !== undefined && v !== null) return v;
        }
    }
    return DB.settings[key];
}

/** Нормализация названия упражнения для сопоставления в истории/PR */
function normalizeExerciseName(name) {
    return String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}
function weightUnitLabel() { return 'кг'; }
function isWeightRounded() {
    return !!(typeof DB !== 'undefined' && DB.settings && DB.settings.roundWeight);
}
/** Квантование веса при сохранении: округление вкл → 0.1; выкл → 0.001 */
function quantizeWeight(kg) {
    let v = Number(kg);
    if (!isFinite(v) || v < 0) v = 0;
    v = Math.max(0, Math.min(9999, v));
    if (isWeightRounded()) {
        return Math.round(v * 10) / 10;
    }
    return Math.round(v * 1000) / 1000;
}
function formatWeightVal(kg) {
    let v = Number(kg);
    if (!isFinite(v) || v < 0) v = 0;
    // roundWeight: true — до 1 знака (72.2); false — всегда 3 знака (71.150)
    if (isWeightRounded()) {
        const n = Math.round(v * 10) / 10;
        return (Math.abs(n - Math.round(n)) < 1e-9 ? String(Math.round(n)) : n.toFixed(1)) + ' кг';
    }
    return (Math.round(v * 1000) / 1000).toFixed(3) + ' кг';
}
function weightInputStep() {
    return isWeightRounded() ? '0.1' : '0.001';
}
/** Шаг кнопок ± для веса в диалоге */
function weightAdjustStep() {
    return isWeightRounded() ? 0.5 : 0.001;
}
/** Достаёт массив из объекта с числовым/строковым ключом (после JSON ключи часто строки). */
function pickKeyedArray(obj, key) {
    if (!obj || typeof obj !== 'object') return null;
    if (obj[key] === 'skipped' || obj[String(key)] === 'skipped') return 'skipped';
    if (Array.isArray(obj[key])) return obj[key];
    if (Array.isArray(obj[String(key)])) return obj[String(key)];
    return null;
}
/**
 * Автоподстановка повторов строго по номеру подхода:
 * 1) тот же подход из прошлой тренировки
 * 2) иначе — предыдущий подход этой сессии
 * 3) иначе — любой ненулевой из истории
 * 4) иначе — целевое значение упражнения
 */
function getSuggestedReps(exerciseName, setIndex1Based, targetReps) {
    const idx = Math.max(0, (setIndex1Based || 1) - 1);
    const prev = getLastExerciseStats(exerciseName);
    if (prev && Array.isArray(prev.sets) && idx < prev.sets.length) {
        const same = Number(prev.sets[idx]) || 0;
        if (same > 0) return same;
    }
    if (runState && runState.setResults && Array.isArray(runState.setResults[runState.index])) {
        const cur = runState.setResults[runState.index];
        if (cur.length > 0) {
            const lastCur = Number(cur[cur.length - 1]) || 0;
            if (lastCur > 0) return lastCur;
        }
    }
    if (prev && Array.isArray(prev.sets) && prev.sets.length) {
        for (let i = prev.sets.length - 1; i >= 0; i--) {
            const v = Number(prev.sets[i]) || 0;
            if (v > 0) return v;
        }
    }
    return Math.max(0, parseInt(targetReps, 10) || 0);
}
/** Автоподстановка веса строго по номеру подхода (та же логика, что у повторов). */
function getSuggestedWeight(exerciseName, setIndex1Based) {
    const idx = Math.max(0, (setIndex1Based || 1) - 1);
    // 1) Вес того же подхода в текущей сессии (уже вводили ранее в этом упражнении)
    if (runState && runState.setWeights && Array.isArray(runState.setWeights[runState.index])) {
        const cur = runState.setWeights[runState.index];
        if (idx < cur.length && Number(cur[idx]) > 0) return Number(cur[idx]);
        if (cur.length > 0) {
            const last = Number(cur[cur.length - 1]) || 0;
            if (last > 0) return last;
        }
    }
    const prev = getLastExerciseStats(exerciseName);
    if (prev && Array.isArray(prev.weights) && idx < prev.weights.length) {
        const same = Number(prev.weights[idx]) || 0;
        if (same > 0) return same;
    }
    if (prev && Array.isArray(prev.weights) && prev.weights.length) {
        for (let i = prev.weights.length - 1; i >= 0; i--) {
            const v = Number(prev.weights[i]) || 0;
            if (v > 0) return v;
        }
    }
    if (prev && prev.maxWeight > 0) return prev.maxWeight;
    return 0;
}
function formatSetsLine(sets, weights) {
    const s = Array.isArray(sets) ? sets : [];
    const w = Array.isArray(weights) ? weights : [];
    if (!s.length && !w.length) return '';
    if (s.length && w.some(x => x > 0)) {
        return s.map((rep, i) => {
            const ww = w[i] || 0;
            return ww > 0 ? `${rep}×${formatWeightVal(ww)}` : String(rep);
        }).join(' · ');
    }
    if (s.length) return s.join(' · ');
    if (w.some(x => x > 0)) return w.filter(x => x > 0).map(formatWeightVal).join(' · ');
    return '';
}
/** Строка «прошлый раз» с подсветкой текущего подхода (1-based). */
function formatSetsLineForCurrent(sets, weights, currentSet1Based) {
    const s = Array.isArray(sets) ? sets : [];
    const w = Array.isArray(weights) ? weights : [];
    if (!s.length && !w.some(x => Number(x) > 0)) return '';
    const n = Math.max(s.length, w.length);
    const cur = Math.max(1, currentSet1Based || 1);
    const parts = [];
    for (let i = 0; i < n; i++) {
        const rep = s[i];
        const ww = Number(w[i]) || 0;
        let cell;
        if (rep != null && rep !== '' && ww > 0) cell = `${rep}×${formatWeightVal(ww)}`;
        else if (rep != null && rep !== '') cell = String(rep);
        else if (ww > 0) cell = formatWeightVal(ww);
        else cell = '—';
        const num = i + 1;
        if (num === cur) parts.push(`[${num}: ${cell}]`);
        else parts.push(`${num}: ${cell}`);
    }
    return parts.join('  ·  ');
}
/**
 * Последний результат упражнения из истории (по имени).
 * sets/weights — массивы по подходам: [подход1, подход2, …].
 */
function getLastExerciseStats(exerciseName) {
    const key = normalizeExerciseName(exerciseName);
    if (!key || !Array.isArray(DB.history) || !DB.history.length) return null;
    const sorted = [...DB.history].sort((a, b) => new Date(b.startTime) - new Date(a.startTime));
    for (const r of sorted) {
        const names = r.exerciseNames || [];
        const origIdxs = (typeof getExerciseOriginalIndices === 'function') ? getExerciseOriginalIndices(r) : names.map((_, i) => i);
        for (let i = 0; i < names.length; i++) {
            if (normalizeExerciseName(names[i]) !== key) continue;
            const orig = origIdxs[i] !== undefined ? origIdxs[i] : i;
            const sets = pickKeyedArray(r.setResults, orig);
            if (sets === 'skipped') continue;
            const weights = pickKeyedArray(r.setWeights, orig) || [];
            const arrSets = Array.isArray(sets) ? sets.map(x => Number(x) || 0) : [];
            const arrW = Array.isArray(weights) ? weights.map(x => Number(x) || 0) : [];
            if (!arrSets.length && !arrW.some(x => x > 0)) continue;
            let maxWeight = 0, volume = 0;
            for (let k = 0; k < Math.max(arrSets.length, arrW.length); k++) {
                const rep = arrSets[k] || 0;
                const ww = arrW[k] || 0;
                if (ww > maxWeight) maxWeight = ww;
                volume += rep * ww;
            }
            return {
                sets: arrSets,
                weights: arrW,
                date: new Date(r.startTime),
                workoutName: r.workoutName || '',
                maxWeight,
                volume,
                recordId: r.id
            };
        }
    }
    return null;
}
/** Лучшие показатели упражнения за всю историю */
function getExercisePR(exerciseName, history = DB.history) {
    const key = normalizeExerciseName(exerciseName);
    if (!key || !Array.isArray(history)) {
        return { maxWeight: 0, maxRepsAtMaxWeight: 0, maxVolume: 0, maxSetVolume: 0, maxReps: 0, maxTotalReps: 0 };
    }
    let maxWeight = 0, maxRepsAtMaxWeight = 0, maxVolume = 0, maxSetVolume = 0;
    let maxReps = 0, maxTotalReps = 0;
    for (const r of history) {
        const names = r.exerciseNames || [];
        const origIdxs = (typeof getExerciseOriginalIndices === 'function') ? getExerciseOriginalIndices(r) : names.map((_, i) => i);
        for (let i = 0; i < names.length; i++) {
            if (normalizeExerciseName(names[i]) !== key) continue;
            const orig = origIdxs[i] !== undefined ? origIdxs[i] : i;
            const sets = (r.setResults && r.setResults[orig]);
            if (!Array.isArray(sets)) continue;
            const weights = (r.setWeights && r.setWeights[orig]) || [];
            let vol = 0;
            let totalReps = 0;
            sets.forEach((rep, k) => {
                const ww = Number(weights[k]) || 0;
                const rr = Number(rep) || 0;
                totalReps += rr;
                if (rr > maxReps) maxReps = rr;
                vol += rr * ww;
                if (ww > maxWeight) { maxWeight = ww; maxRepsAtMaxWeight = rr; }
                else if (ww === maxWeight && rr > maxRepsAtMaxWeight) maxRepsAtMaxWeight = rr;
                const sv = rr * ww;
                if (sv > maxSetVolume) maxSetVolume = sv;
            });
            if (vol > maxVolume) maxVolume = vol;
            if (totalReps > maxTotalReps) maxTotalReps = totalReps;
        }
    }
    return { maxWeight, maxRepsAtMaxWeight, maxVolume, maxSetVolume, maxReps, maxTotalReps };
}
/** Сравнить текущие подходы с PR; вернуть список новых рекордов */
function detectNewPRs(exerciseName, sets, weights, history = DB.history, retrospective = false) {
    if (!retrospective && !getEffectiveSetting('trackPRs')) return [];
    const pr = getExercisePR(exerciseName, history);
    const arrSets = Array.isArray(sets) ? sets.map(x => Number(x) || 0) : [];
    const arrW = Array.isArray(weights) ? weights.map(x => Number(x) || 0) : [];
    let maxWeight = 0, maxRepsAtMax = 0, volume = 0, maxSetVolume = 0;
    let maxReps = 0, totalReps = 0;
    arrSets.forEach((rep, i) => {
        const ww = arrW[i] || 0;
        const rr = Number(rep) || 0;
        totalReps += rr;
        if (rr > maxReps) maxReps = rr;
        volume += rr * ww;
        const sv = rr * ww;
        if (sv > maxSetVolume) maxSetVolume = sv;
        if (ww > maxWeight) { maxWeight = ww; maxRepsAtMax = rr; }
        else if (ww === maxWeight && rr > maxRepsAtMax) maxRepsAtMax = rr;
    });
    const out = [];
    // Рекорд по повторам в одном подходе (турник, отжимания и т.п.)
    if (maxReps > 0 && maxReps > (pr.maxReps || 0)) {
        out.push({ type: 'max_reps', label: 'Рекорд повторов за подход', value: maxReps + ' повт.', detail: (pr.maxReps > 0 ? ('было ' + pr.maxReps) : 'первый результат') });
    }
    // Рекорд суммы повторов за упражнение в тренировке
    if (totalReps > 0 && arrSets.length > 1 && totalReps > (pr.maxTotalReps || 0)) {
        out.push({ type: 'total_reps', label: 'Рекорд суммы повторов', value: totalReps + ' повт.', detail: arrSets.length + ' подход(а/ов)' + (pr.maxTotalReps > 0 ? (', было ' + pr.maxTotalReps) : '') });
    }
    // Вес
    if (maxWeight > 0 && maxWeight > (pr.maxWeight || 0) + 1e-6) {
        out.push({ type: 'weight', label: 'Новый макс. вес', value: formatWeightVal(maxWeight), detail: maxRepsAtMax ? (maxRepsAtMax + ' повт.') : '' });
    } else if (maxWeight > 0 && Math.abs(maxWeight - (pr.maxWeight || 0)) < 1e-6 && maxRepsAtMax > (pr.maxRepsAtMaxWeight || 0)) {
        out.push({ type: 'reps_at_weight', label: 'Больше повторов на макс. весе', value: maxRepsAtMax + ' × ' + formatWeightVal(maxWeight), detail: '' });
    }
    if (volume > 0 && volume > (pr.maxVolume || 0) + 1e-6) {
        out.push({ type: 'volume', label: 'Рекорд объёма', value: formatWeightVal(volume), detail: 'сумма подходов' });
    }
    if (maxSetVolume > 0 && maxSetVolume > (pr.maxSetVolume || 0) + 1e-6) {
        out.push({ type: 'set', label: 'Лучший подход (повт. × вес)', value: formatWeightVal(maxSetVolume), detail: '' });
    }
    return out;
}
function updateWorkLastPerfUI() {
    const box = document.getElementById('work-last-perf');
    const main = document.getElementById('work-last-perf-main');
    const meta = document.getElementById('work-last-perf-meta');
    if (!box || !main) return;
    if (!runState || runState.phase !== 'work') { box.style.display = 'none'; return; }
    const showLast = getEffectiveSetting('showLastExercise') !== false;
    if (!showLast) { box.style.display = 'none'; return; }
    const el = runState.workout && runState.workout.exercises[runState.index];
    if (!el || el.kind !== 'exercise') { box.style.display = 'none'; return; }
    if (!((el.type === 'sets') || (el.type === 'reps'))) { box.style.display = 'none'; return; }
    const stats = getLastExerciseStats(el.name);
    if (!stats) { box.style.display = 'none'; return; }
    const curSet = (el.type === 'sets') ? (runState.currentSet || 1) : 1;
    // Вес в «прошлый раз» только если сейчас включён учёт веса
    const showWeight = !!getEffectiveSetting('askWeight');
    let line = '';
    if (el.type === 'sets' && Array.isArray(stats.sets) && stats.sets.length) {
        const idx = Math.max(0, curSet - 1);
        const rep = stats.sets[idx];
        const ww = showWeight ? ((stats.weights && stats.weights[idx]) || 0) : 0;
        if (rep != null && Number(rep) > 0) {
            line = ww > 0
                ? `Подход ${curSet}: ${rep}×${formatWeightVal(ww)}`
                : `Подход ${curSet}: ${rep}`;
        } else if (ww > 0) {
            line = `Подход ${curSet}: ${formatWeightVal(ww)}`;
        }
    }
    if (!line) {
        // Упражнение на повторы (без подходов) или нет данных по этому подходу
        if (showWeight) {
            line = formatSetsLine(stats.sets, stats.weights);
        } else if (Array.isArray(stats.sets) && stats.sets.length) {
            // Только повторы, без веса
            const nums = stats.sets.map(x => Number(x) || 0).filter(x => x > 0);
            line = nums.length === 1 ? String(nums[0]) : nums.join(' · ');
        }
    }
    if (!line) { box.style.display = 'none'; return; }
    main.textContent = line;
    if (meta) {
        try {
            const d = (stats.date ? formatDate(stats.date) : '') + (stats.workoutName ? ' · ' + stats.workoutName : '');
            meta.textContent = d || '';
        } catch(e) { meta.textContent = ''; }
    }
    box.style.display = 'block';
}
function calcSessionVolume(setResults, setWeights) {
    let vol = 0;
    if (!setResults || typeof setResults !== 'object') return 0;
    Object.keys(setResults).forEach(k => {
        const sets = setResults[k];
        if (!Array.isArray(sets)) return;
        const weights = (setWeights && setWeights[k]) || [];
        sets.forEach((reps, i) => {
            const r = Number(reps) || 0;
            const w = Number(weights[i]) || 0;
            if (r > 0 && w > 0) vol += r * w;
        });
    });
    return vol;
}
function getRecordVolume(r) {
    if (!r) return 0;
    if (typeof r.totalVolume === 'number' && r.totalVolume > 0) return r.totalVolume;
    return calcSessionVolume(r.setResults, r.setWeights);
}
/** Проверка и лёгкая починка данных (дубликаты, битые записи, застрявшая тренировка). */
function runDataIntegrityCheck(showResult) {
    const report = { historyRemoved: 0, historyDupes: 0, measurementsDupes: 0, workoutsFixed: 0, stuckCleared: false };
    try {
        // Застрявшая тренировка в памяти / localStorage
        try {
            if (typeof ensureNoStuckRunState === 'function') ensureNoStuckRunState();
            const saved = typeof loadSavedRunState === 'function' ? loadSavedRunState() : null;
            if (saved && saved.phase === 'finish') {
                if (typeof clearSavedRunState === 'function') clearSavedRunState();
                report.stuckCleared = true;
            }
            if (runState && runState.phase === 'finish') {
                const onRun = document.getElementById('screen-run') && document.getElementById('screen-run').classList.contains('active');
                if (!onRun) {
                    if (typeof forceClearRunState === 'function') forceClearRunState();
                    report.stuckCleared = true;
                }
            }
        } catch (e) {}

        // История: только объекты с id и датой; убрать дубликаты id
        if (Array.isArray(DB.history)) {
            const seen = new Set();
            const cleaned = [];
            for (const r of DB.history) {
                if (!r || typeof r !== 'object') { report.historyRemoved++; continue; }
                if (!r.id || !r.startTime) { report.historyRemoved++; continue; }
                if (seen.has(r.id)) { report.historyDupes++; continue; }
                seen.add(r.id);
                if (typeof r.totalVolume !== 'number' || !(r.totalVolume > 0)) {
                    const v = calcSessionVolume(r.setResults, r.setWeights);
                    if (v > 0) r.totalVolume = v;
                }
                cleaned.push(r);
            }
            if (cleaned.length !== DB.history.length) {
                DB.history = cleaned;
                saveDB('history');
            }
        }

        // Замеры: дубликаты id
        if (Array.isArray(DB.measurements)) {
            const seen = new Set();
            const cleaned = [];
            for (const m of DB.measurements) {
                if (!m || typeof m !== 'object' || !m.id) { report.measurementsDupes++; continue; }
                if (seen.has(m.id)) { report.measurementsDupes++; continue; }
                seen.add(m.id);
                cleaned.push(m);
            }
            if (cleaned.length !== DB.measurements.length) {
                DB.measurements = cleaned;
                saveDB('measurements');
            }
        }

        // Тренировки: пустые имена
        if (Array.isArray(DB.workouts)) {
            DB.workouts.forEach(w => {
                if (w && (!w.name || !String(w.name).trim())) {
                    w.name = 'Без названия';
                    report.workoutsFixed++;
                }
                if (w && !Array.isArray(w.exercises)) {
                    w.exercises = [];
                    report.workoutsFixed++;
                }
            });
            if (report.workoutsFixed) saveDB('workouts');
        }
    } catch (e) {
        console.warn('[integrity]', e);
    }
    if (showResult) {
        const parts = [];
        if (report.historyRemoved) parts.push(`удалено битых записей истории: ${report.historyRemoved}`);
        if (report.historyDupes) parts.push(`дубликатов истории: ${report.historyDupes}`);
        if (report.measurementsDupes) parts.push(`дубликатов замеров: ${report.measurementsDupes}`);
        if (report.workoutsFixed) parts.push(`починено тренировок: ${report.workoutsFixed}`);
        if (report.stuckCleared) parts.push('сброшена застрявшая тренировка');
        showToast(parts.length ? ('🩺 ' + parts.join(' · ')) : '🩺 Данные в порядке', 4500);
    }
    return report;
}
function applyLargeRunControls() {
    try {
        const on = !!(runState && getEffectiveSetting('largeRunControls'));
        document.body.classList.toggle('large-run-controls', on);
    } catch(e) {}
}

function hasOpenOverlay() { return !!document.querySelector('.notif-side-overlay') || !!document.querySelector('.bottom-sheet-overlay') || !!document.querySelector('.multi-tab-warning'); }
function formatAge(sec) {
    sec = Math.max(0, Math.floor(sec));
    if (sec < 60) return 'только что';
    if (sec < 3600) return `${Math.floor(sec/60)} мин назад`;
    if (sec < 86400) return `${Math.floor(sec/3600)} ч назад`;
    return `${Math.floor(sec/86400)} дн назад`;
}
function isQuietHours() {
    if (!DB.settings.quietHours) return false;
    const now = new Date().getHours();
    const start = DB.settings.quietHoursStart ?? 22;
    const end = DB.settings.quietHoursEnd ?? 8;
    if (start === end) return false;
    if (start < end) return now >= start && now < end;
    return now >= start || now < end;
}
function applyFontSize() {
    document.documentElement.classList.remove('font-small', 'font-large');
    if (DB.settings.fontSizeMode === 'small') document.documentElement.classList.add('font-small');
    else if (DB.settings.fontSizeMode === 'large') document.documentElement.classList.add('font-large');
}
function applyCompactWorkouts() { document.body.classList.toggle('compact-workouts', !!DB.settings.compactWorkouts); }
function applyHomeMenuVisibility() {
    const narrowIdToKey = {
        'menu-btn-templates': 'templates', 'menu-btn-programs': 'programs',
        'menu-btn-activity': 'activity', 'menu-btn-history': 'history',
        'menu-btn-measurements': 'measurements'
    };
    Object.keys(narrowIdToKey).forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.style.display = DB.settings.hiddenMenuItems.includes(narrowIdToKey[id]) ? 'none' : '';
        el.classList.remove('menu-wide');
    });
    const visibleNarrowCount = Object.keys(narrowIdToKey).filter(id => {
        const el = document.getElementById(id);
        return el && el.style.display !== 'none';
    }).length;
    const settingsBtn = document.getElementById('menu-btn-settings');
    if (settingsBtn) { settingsBtn.classList.toggle('menu-wide', (visibleNarrowCount % 2 === 0)); }
    document.querySelectorAll('.nav-btn[data-hideable]').forEach(btn => {
        btn.style.display = DB.settings.hiddenBottomNavItems.includes(btn.dataset.hideable) ? 'none' : '';
    });
}
function applyNavVisibility() {
    const active = document.querySelector('.screen.active');
    if (!active) return;
    const id = active.id;
    const showNav = !NO_NAV_SCREENS.includes(id) && id !== 'screen-home' && DB.settings.showBottomNav !== false;
    document.body.classList.toggle('nav-visible', showNav);
    document.querySelectorAll('.nav-btn').forEach(btn => { btn.classList.toggle('active', btn.dataset.screen === id); });
}
function setupSideSwipe(sheet, overlay, onDismiss) {
    if (!sheet || !overlay) return;
    const controller = new AbortController();
    const signal = controller.signal;
    let startX = 0, startY = 0, dragging = false, swiping = false, currentX = 0;
    const grabber = sheet.querySelector('.notif-side-grabber');
    const startEl = grabber || sheet;
    const onStart = (e) => {
        startX = e.touches ? e.touches[0].clientX : e.clientX;
        startY = e.touches ? e.touches[0].clientY : e.clientY;
        dragging = true; swiping = false; currentX = 0;
        sheet.style.transition = 'none';
    };
    const onMove = (e) => {
        if (!dragging) return;
        const cx = e.touches ? e.touches[0].clientX : e.clientX;
        const cy = e.touches ? e.touches[0].clientY : e.clientY;
        const dx = cx - startX, dy = cy - startY;
        if (!swiping && Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 10) {
            dragging = false; sheet.style.transition = 'transform 0.2s'; sheet.style.transform = ''; return;
        }
        if (dx > 10) swiping = true;
        if (swiping) {
            if (e.cancelable) e.preventDefault();
            currentX = Math.max(0, dx);
            sheet.style.transform = `translateX(${currentX}px)`;
        }
    };
    const onEnd = () => {
        if (!dragging) return;
        dragging = false;
        sheet.style.transition = 'transform 0.2s ease-out';
        if (currentX > 100) {
            sheet.style.transform = `translateX(100%)`;
            overlay.style.opacity = '0';
            if (typeof onDismiss === 'function') onDismiss();
            setTimeout(() => { try { overlay.remove(); } catch(e) {} if (typeof updateNotifGrabber === 'function') updateNotifGrabber(); }, 200);
        } else { sheet.style.transform = ''; }
    };
    startEl.addEventListener('touchstart', onStart, { passive: true, signal });
    startEl.addEventListener('mousedown', onStart, { signal });
    document.addEventListener('touchmove', onMove, { passive: false, signal });
    document.addEventListener('mousemove', onMove, { signal });
    document.addEventListener('touchend', onEnd, { signal });
    document.addEventListener('mouseup', onEnd, { signal });
    const cleanupInterval = setInterval(() => {
        if (!document.body.contains(overlay)) { try { controller.abort(); } catch(e) {} clearInterval(cleanupInterval); }
    }, 500);
}

const customConfirmQueue = [];
let customConfirmBusy = false;
function customConfirm(message, options = {}) {
    return new Promise((resolve) => {
        customConfirmQueue.push({ message, options, resolve });
        if (!customConfirmBusy) processNextConfirm();
    });
}
function _resetStuckConfirmIfNeeded() {
    // Если флаг «занято» завис, а диалога уже нет — разблокируем очередь
    if (!customConfirmBusy) return;
    const hasConfirm = !!document.querySelector('.notif-side-overlay #cc-ok');
    if (!hasConfirm) customConfirmBusy = false;
}
function processNextConfirm() {
    _resetStuckConfirmIfNeeded();
    if (customConfirmBusy || customConfirmQueue.length === 0) return;
    const item = customConfirmQueue.shift();
    customConfirmBusy = true;
    const okText = item.options.okText || 'OK';
    const cancelText = item.options.cancelText || 'Отмена';
    const isDanger = item.options.danger !== false;
    const title = item.options.title || 'Подтверждение';
    const overlay = document.createElement('div');
    overlay.className = 'notif-side-overlay';
    overlay.setAttribute('data-ft-confirm', '1');
    overlay.innerHTML = `<div class="notif-side-sheet">
        <div class="notif-side-grabber" id="confirm-grabber"><div class="notif-side-grabber-bar"></div></div>
        <h2 class="sheet-title">${escapeHtml(title)}</h2>
        <div style="text-align:center; white-space:pre-line; padding: 4px 8px; line-height: 1.5; color: var(--text); flex: 1; overflow-y: auto;">${escapeHtml(item.message)}</div>
        <button type="button" class="btn ${isDanger ? 'danger' : 'accent'}" id="cc-ok">${escapeHtml(okText)}</button>
        <button type="button" class="btn ghost" id="cc-cancel">${escapeHtml(cancelText)}</button>
    </div>`;
    document.body.appendChild(overlay);
    let resolved = false;
    const finish = (r) => {
        if (resolved) return;
        resolved = true;
        customConfirmBusy = false;
        try { if (observer) observer.disconnect(); } catch(e) {}
        const s = overlay.querySelector('.notif-side-sheet');
        if (s) s.style.transform = 'translateX(100%)';
        overlay.style.opacity = '0';
        try { item.resolve(!!r); } catch(e) {}
        setTimeout(() => {
            try { overlay.remove(); } catch(e) {}
            try { updateNotifGrabber(); } catch(e) {}
            setTimeout(() => processNextConfirm(), 50);
        }, 200);
    };
    const okBtn = overlay.querySelector('#cc-ok');
    const cancelBtn = overlay.querySelector('#cc-cancel');
    if (okBtn) okBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); finish(true); };
    if (cancelBtn) cancelBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); finish(false); };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) finish(false); });
    setupSideSwipe(overlay.querySelector('.notif-side-sheet'), overlay, () => finish(false));
    // Если оверлей сняли извне (глобальный свайп / closeTopSheet) — не оставляем очередь в тупике
    let observer = null;
    try {
        observer = new MutationObserver(() => {
            if (!resolved && !document.body.contains(overlay)) finish(false);
        });
        observer.observe(document.body, { childList: true, subtree: true });
    } catch(e) {}
}

const askRepsQueue = [];
let askRepsBusy = false;
/** @deprecated use askSetResult */
function askRepsCount(defaultValue) {
    return askSetResult({ askReps: true, askWeight: false, defaultReps: defaultValue, defaultWeight: 0 }).then(r => r === null ? null : (r.reps ?? 0));
}
function askSetResult({ askReps = true, askWeight = false, defaultReps = 0, defaultWeight = 0 } = {}) {
    return new Promise((resolve) => {
        askRepsQueue.push({ askReps: !!askReps, askWeight: !!askWeight, defaultReps, defaultWeight, resolve });
        if (!askRepsBusy) processNextAskReps();
    });
}
function processNextAskReps() {
    if (askRepsBusy || askRepsQueue.length === 0) return;
    const item = askRepsQueue.shift();
    askRepsBusy = true;
    const needReps = !!item.askReps;
    const needWeight = !!item.askWeight;
    const defReps = Math.max(0, parseInt(item.defaultReps) || 0);
    const defWeight = Math.max(0, parseFloat(item.defaultWeight) || 0);
    let title = 'Результат подхода';
    if (needReps && !needWeight) title = 'Сколько раз сделал?';
    else if (!needReps && needWeight) title = 'Какой вес?';
    else if (needReps && needWeight) title = 'Повторы и вес';
    const goalLine = '';
    // Повторы: -3 / +3 и -1 / +1. Вес: шаг зависит от «Округлять вес».
    const fieldBlockReps = (id, value, opts) => `
        ${opts.label ? `<div class="ask-field-label" style="text-align:center; color:var(--muted); font-size:0.78rem; text-transform:uppercase; letter-spacing:1px; font-weight:600; margin-bottom:8px;">${opts.label}</div>` : ''}
        <div class="reps-row-main">
            <button class="btn small ghost reps-btn" data-target="${id}" data-d="-3">-3</button>
            <input type="number" id="${id}" class="input reps-input" min="0" max="${opts.max}" step="${opts.step}" inputmode="${opts.inputmode}" autocomplete="off" value="${value}">
            <button class="btn small ghost reps-btn" data-target="${id}" data-d="+3">+3</button>
        </div>
        <div class="reps-row-aux">
            <button class="btn small ghost reps-btn" data-target="${id}" data-d="-1">-1</button>
            <button class="btn small ghost reps-btn" data-target="${id}" data-d="+1">+1</button>
        </div>`;
    const wRounded = isWeightRounded();
    const wStepBig = wRounded ? 2.5 : 1;
    const wStepSmall = wRounded ? 0.5 : 0.001;
    const wValStr = wRounded
        ? String(quantizeWeight(defWeight || 0))
        : quantizeWeight(defWeight || 0).toFixed(3);
    const fieldBlockWeight = (id) => `
        <div class="ask-field-label" style="text-align:center; color:var(--muted); font-size:0.78rem; text-transform:uppercase; letter-spacing:1px; font-weight:600; margin-bottom:8px;">Вес (кг)</div>
        <div class="reps-row-main">
            <button class="btn small ghost reps-btn" data-target="${id}" data-d="${-wStepBig}">-${wStepBig}</button>
            <input type="number" id="${id}" class="input reps-input" min="0" max="9999" step="${weightInputStep()}" inputmode="decimal" autocomplete="off" value="${wValStr}">
            <button class="btn small ghost reps-btn" data-target="${id}" data-d="${wStepBig}">+${wStepBig}</button>
        </div>
        <div class="reps-row-aux">
            <button class="btn small ghost reps-btn" data-target="${id}" data-d="${-wStepSmall}">-${wStepSmall}</button>
            <button class="btn small ghost reps-btn" data-target="${id}" data-d="${wStepSmall}">+${wStepSmall}</button>
        </div>`;
    let bodyHtml = '';
    const dual = needReps && needWeight;
    if (dual) {
        bodyHtml = fieldBlockReps('ask-reps-input', defReps, { label: 'Повторы', max: 999, step: 1, inputmode: 'numeric' })
            + `<div class="ask-divider" role="separator" aria-hidden="true"></div>`
            + fieldBlockWeight('ask-weight-input');
    } else if (needReps) {
        bodyHtml = fieldBlockReps('ask-reps-input', defReps, { label: '', max: 999, step: 1, inputmode: 'numeric' });
    } else if (needWeight) {
        bodyHtml = fieldBlockWeight('ask-weight-input');
    }
    const overlay = document.createElement('div');
    overlay.className = 'notif-side-overlay action-menu-overlay';
    overlay.innerHTML = `<div class="notif-side-sheet ask-set-sheet${dual ? ' ask-set-dual' : ''}">
        <div class="notif-side-grabber"><div class="notif-side-grabber-bar"></div></div>
        <h2 class="sheet-title">${title}</h2>
        ${goalLine}
        ${bodyHtml}
        <button class="btn accent ask-save-btn" id="ask-reps-save" style="width: 100%;">✅ Сохранить</button>
        <button class="btn ghost ask-cancel-btn" id="ask-reps-cancel" style="width: 100%; margin: 0;">Отмена</button>
    </div>`;
    document.body.appendChild(overlay);
    const repsInput = overlay.querySelector('#ask-reps-input');
    const weightInput = overlay.querySelector('#ask-weight-input');
    overlay.querySelectorAll('[data-d]').forEach(btn => {
        btn.onclick = () => {
            const targetId = btn.dataset.target;
            const input = overlay.querySelector('#' + targetId);
            if (!input) return;
            const d = parseFloat(btn.dataset.d);
            const isWeight = targetId === 'ask-weight-input';
            const cur = isWeight ? (parseFloat(input.value) || 0) : (parseInt(input.value) || 0);
            const next = isWeight
                ? quantizeWeight(cur + d)
                : Math.max(0, Math.min(999, cur + d));
            input.value = isWeight
                ? (isWeightRounded() ? String(next) : next.toFixed(3))
                : String(next);
        };
    });
    let resolved = false;
    const finish = (val) => {
        if (resolved) return;
        resolved = true;
        try {
            if (overlay._ftAskObserver) { overlay._ftAskObserver.disconnect(); overlay._ftAskObserver = null; }
        } catch(e) {}
        const s = overlay.querySelector('.notif-side-sheet');
        if (s) s.style.transform = 'translateX(100%)';
        overlay.style.opacity = '0';
        // Сразу снимаем busy/флаги логики, чтобы кнопка «Завершить» не зависала,
        // даже если DOM-оверлей ещё анимируется.
        askRepsBusy = false;
        try { item.resolve(val); } catch(e) {}
        setTimeout(() => {
            try { if (overlay.parentNode) overlay.remove(); } catch(e) {}
            try { updateNotifGrabber(); } catch(e) {}
            setTimeout(() => processNextAskReps(), 50);
        }, 200);
    };
    // Единый хук для любого способа закрытия (свайп, closeTopSheet, клик по фону)
    overlay._ftOnDismiss = () => finish(null);
    overlay.dataset.ftAskDialog = '1';
    // Если оверлей удалили из DOM без вызова finish (глобальный свайп / closeTopSheet) — всё равно резолвим
    try {
        const obs = new MutationObserver(() => {
            if (!document.body.contains(overlay) && !resolved) finish(null);
        });
        obs.observe(document.body, { childList: true });
        overlay._ftAskObserver = obs;
    } catch(e) {}
    setupSideSwipe(overlay.querySelector('.notif-side-sheet'), overlay, () => finish(null));
    overlay.querySelector('#ask-reps-save').onclick = () => {
        const result = {};
        if (needReps) result.reps = Math.max(0, Math.min(999, parseInt(repsInput && repsInput.value) || 0));
        if (needWeight) {
            const w = parseFloat(weightInput && weightInput.value);
            result.weight = isNaN(w) ? 0 : quantizeWeight(w);
        }
        finish(result);
    };
    overlay.querySelector('#ask-reps-cancel').onclick = () => finish(null);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) finish(null); });
    const onKey = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); overlay.querySelector('#ask-reps-save').click(); }
        if (e.key === 'Escape') { e.preventDefault(); finish(null); }
    };
    if (repsInput) repsInput.addEventListener('keydown', onKey);
    if (weightInput) weightInput.addEventListener('keydown', onKey);
}

function showShareFallback(text) {
    const ov = document.createElement('div');
    ov.className = 'notif-side-overlay';
    ov.innerHTML = `<div class="notif-side-sheet">
        <div class="notif-side-grabber"><div class="notif-side-grabber-bar"></div></div>
        <h2 class="sheet-title">Скопировать текст</h2>
        <textarea class="input share-textarea" readonly>${escapeHtml(text)}</textarea>
        <button class="btn accent" id="share-copy-btn">📋 Копировать</button>
        <button class="btn ghost" id="share-close-btn">Закрыть</button>
    </div>`;
    document.body.appendChild(ov);
    setupSideSwipe(ov.querySelector('.notif-side-sheet'), ov);
    const ta = ov.querySelector('textarea');
    ov.querySelector('#share-copy-btn').onclick = () => {
        try { ta.select(); document.execCommand('copy'); ov.querySelector('#share-copy-btn').textContent = '✅ Скопировано'; }
        catch(e) { try { navigator.clipboard.writeText(text); ov.querySelector('#share-copy-btn').textContent = '✅ Скопировано'; } catch(err) {} }
    };
    ov.querySelector('#share-close-btn').onclick = () => ov.remove();
    ov.addEventListener('click', (e) => { if (e.target === ov) ov.remove(); });
}

function bufToB64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
}
function b64ToBuf(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
}
async function deriveBackupKey(password, salt, iterations) {
    const enc = new TextEncoder();
    const baseKey = await crypto.subtle.importKey('raw', enc.encode(password), { name: 'PBKDF2' }, false, ['deriveKey']);
    return crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
        baseKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
    );
}
async function encryptBackupData(jsonString, password) {
    if (!crypto || !crypto.subtle) throw new Error('Web Crypto недоступен в этом браузере');
    const iterations = 200000;
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveBackupKey(password, salt, iterations);
    const enc = new TextEncoder();
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(jsonString));
    return {
        type: 'fit-trainer-backup-encrypted',
        version: 1,
        kdf: 'PBKDF2-SHA256',
        iterations,
        salt: bufToB64(salt),
        iv: bufToB64(iv),
        ciphertext: bufToB64(ciphertext),
        createdAt: new Date().toISOString()
    };
}
async function decryptBackupData(envelope, password) {
    try {
        if (!crypto || !crypto.subtle) return null;
        const salt = b64ToBuf(envelope.salt);
        const iv = b64ToBuf(envelope.iv);
        const iterations = envelope.iterations || 200000;
        const key = await deriveBackupKey(password, salt, iterations);
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, b64ToBuf(envelope.ciphertext));
        return new TextDecoder().decode(plain);
    } catch(e) { return null; }
}
function askBackupPassword(opts = {}) {
    return new Promise((resolve) => {
        const mode = opts.mode || 'decrypt';
        const title = opts.title || (mode === 'encrypt' ? 'Пароль для бэкапа' : 'Импорт бэкапа');
        const info = opts.info || '';
        const confirmText = opts.confirmText || (mode === 'encrypt' ? '🔒 Зашифровать' : '🔓 Расшифровать');
        const minLen = 8;
        const overlay = document.createElement('div');
        overlay.className = 'notif-side-overlay';
        overlay.innerHTML = `<div class="notif-side-sheet" style="padding-bottom: 20px;">
            <div class="notif-side-grabber"><div class="notif-side-grabber-bar"></div></div>
            <h2 class="sheet-title" style="margin-bottom: 4px;">${escapeHtml(title)}</h2>
            ${info ? `<div class="sheet-info" style="margin-bottom: 8px; text-align:center; background: var(--card-2); border-radius: var(--r-sm); padding: 10px;"><div class="sheet-info-details" style="font-size: 0.85rem; color: var(--muted);">${escapeHtml(info)}</div></div>` : ''}
            <input type="password" id="bk-pass1" class="pw-field" placeholder="Пароль (минимум ${minLen} символов)" autocomplete="new-password" autocapitalize="off" spellcheck="false">
            ${mode === 'encrypt' ? `<input type="password" id="bk-pass2" class="pw-field" placeholder="Повторите пароль" autocomplete="new-password" autocapitalize="off" spellcheck="false">` : ''}
            <div class="pw-error" id="bk-error"></div>
            <div class="pw-hint">Пароль нигде не сохраняется. Если забудете — бэкап не восстановить.</div>
            <button class="btn accent" id="bk-ok" style="margin-top:8px;">${escapeHtml(confirmText)}</button>
            <button class="btn ghost" id="bk-cancel" style="margin-top:4px;">Отмена</button>
        </div>`;
        document.body.appendChild(overlay);
        setupSideSwipe(overlay.querySelector('.notif-side-sheet'), overlay);
        const p1 = overlay.querySelector('#bk-pass1');
        const p2 = overlay.querySelector('#bk-pass2');
        const errEl = overlay.querySelector('#bk-error');
        const okBtn = overlay.querySelector('#bk-ok');
        const cancelBtn = overlay.querySelector('#bk-cancel');
        setTimeout(() => { try { p1.focus(); } catch(e) {} }, 100);
        const finish = (val) => {
            const s = overlay.querySelector('.notif-side-sheet');
            if (s) s.style.transform = 'translateX(100%)';
            overlay.style.opacity = '0';
            setTimeout(() => { try { overlay.remove(); } catch(e) {} resolve(val); }, 200);
        };
        const submit = () => {
            const v1 = p1.value || '';
            if (v1.length < minLen) { errEl.textContent = `Минимум ${minLen} символов`; return; }
            if (mode === 'encrypt') {
                const v2 = p2 ? (p2.value || '') : '';
                if (v1 !== v2) { errEl.textContent = 'Пароли не совпадают'; return; }
            }
            finish(v1);
        };
        okBtn.onclick = submit;
        cancelBtn.onclick = () => finish(null);
        p1.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); if (mode === 'encrypt' && p2) p2.focus(); else submit(); }
            if (e.key === 'Escape') { e.preventDefault(); finish(null); }
        });
        if (p2) p2.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); submit(); }
            if (e.key === 'Escape') { e.preventDefault(); finish(null); }
        });
        overlay.addEventListener('click', (e) => { if (e.target === overlay) finish(null); });
    });
}

const HISTORY_PRUNE_LIMIT = 2000;
const HISTORY_HARD_LIMIT = 2000;
function pruneHistory(maxRecords = HISTORY_PRUNE_LIMIT) {
    if (!Array.isArray(DB.history)) return 0;
    const before = DB.history.length;
    // Удаляем битые записи
    const valid = DB.history.filter(r => r && r.startTime && r.id);
    if (valid.length !== DB.history.length) DB.history = valid;
    if (DB.history.length <= maxRecords) return before - DB.history.length;
    // Оставляем самые новые
    const sorted = [...DB.history].sort((a, b) => new Date(b.startTime) - new Date(a.startTime));
    DB.history = sorted.slice(0, maxRecords);
    return before - DB.history.length;
}
function saveDBWithQuotaRecovery(key) {
    const map = { workouts: 'ft_workouts', templates: 'ft_templates', programs: 'ft_programs', history: 'ft_history', measurements: 'ft_measurements', settings: 'ft_settings' };
    const storageKey = map[key];
    if (!storageKey) return;
    const ok = Storage.set(storageKey, DB[key]);
    if (ok) { if (key === 'history') invalidateActivityCache(); return; }

    // Поэтапная аварийная обрезка при нехватке места (мягче → жёстче)
    const steps = [1000, 500, 200, 50];
    let totalRemoved = 0;
    for (const limit of steps) {
        const removed = pruneHistory(limit);
        if (removed > 0) {
            totalRemoved += removed;
            Storage.set('ft_history', DB.history);
            const ok2 = Storage.set(storageKey, DB[key]);
            if (ok2) {
                if (key === 'history') invalidateActivityCache();
                showToast(`💾 Мало места. Удалено ${totalRemoved} старых записей истории.`, 4500);
                return;
            }
        }
    }
    showToast('⚠️ Не удалось сохранить. Освободите место в браузере.', 5000);
}
function saveDB(key) { saveDBWithQuotaRecovery(key); }

const DAY_KEYS = ['mon','tue','wed','thu','fri','sat','sun'];
const DAY_NAMES_SHORT = { mon:'Пн', tue:'Вт', wed:'Ср', thu:'Чт', fri:'Пт', sat:'Сб', sun:'Вс' };
const DAY_NAMES_FULL = { mon:'Понедельник', tue:'Вторник', wed:'Среда', thu:'Четверг', fri:'Пятница', sat:'Суббота', sun:'Воскресенье' };

function validateAndMigrateDB() {
    if (!Array.isArray(DB.workouts)) DB.workouts = [];
    if (!Array.isArray(DB.templates)) DB.templates = [];
    if (!Array.isArray(DB.programs)) DB.programs = [];
    if (!Array.isArray(DB.history)) DB.history = [];
    if (!Array.isArray(DB.measurements)) DB.measurements = [];
    if (!DB.settings || typeof DB.settings !== 'object' || Array.isArray(DB.settings)) DB.settings = {};

    DB.workouts = DB.workouts.filter(w => w && typeof w === 'object' && w.id && Array.isArray(w.exercises));
    DB.templates = DB.templates.filter(t => t && typeof t === 'object' && t.id && Array.isArray(t.exercises));
    DB.programs = DB.programs.filter(p => p && typeof p === 'object' && p.id);
    DB.history = DB.history.filter(h => h && typeof h === 'object' && h.id && h.startTime);
    DB.measurements = DB.measurements.filter(m => m && typeof m === 'object' && m.id && m.date);

    if (!DB.settings.dismissedUntil || typeof DB.settings.dismissedUntil !== 'object' || Array.isArray(DB.settings.dismissedUntil)) DB.settings.dismissedUntil = {};
    if (typeof DB.settings.lastNotifAutoShow !== 'string') DB.settings.lastNotifAutoShow = '';
    if (![1,2,3,4,24].includes(DB.settings.snoozeDuration)) DB.settings.snoozeDuration = 2;

    let migrated = false;
    if (DB.history.length > HISTORY_HARD_LIMIT) {
        const removed = pruneHistory(HISTORY_HARD_LIMIT);
        if (removed > 0) { saveDB('history'); setTimeout(() => showToast(`📜 История обрезана до ${HISTORY_HARD_LIMIT} записей`), 500); }
    }

    const migrateExercisesList = (list) => {
        const hasKind = list.some(e => e && (e.kind === 'exercise' || e.kind === 'rest' || e.kind === 'warmup'));
        if (hasKind) {
            return list.map(e => {
                if (!e || typeof e !== 'object') return null;
                if (e.kind === 'rest') return { kind: 'rest', restType: e.restType === 'water' ? 'water' : 'rest', duration: (typeof e.duration === 'number') ? e.duration : (e.duration === null ? null : 60), notes: e.notes || '' };
                if (e.kind === 'warmup') {
                    const mode = e.mode === 'free' ? 'free' : 'timer';
                    if (mode === 'free') return { kind: 'warmup', name: 'Разминка', duration: null, mode: 'free' };
                    let dur = (typeof e.duration === 'number') ? e.duration : 180;
                    if (dur < 5) dur = 5;
                    return { kind: 'warmup', name: 'Разминка', duration: dur, mode: 'timer' };
                }
                const ex = { kind: 'exercise', name: e.name || '', type: e.type === 'reps' || e.type === 'sets' || e.type === 'timer' ? e.type : 'time', notes: e.notes || '' };
                if (ex.type === 'timer') ex.timerDuration = (typeof e.timerDuration === 'number' && e.timerDuration >= 5) ? e.timerDuration : 60;
                if (ex.type === 'reps') ex.targetReps = e.targetReps || 10;
                if (ex.type === 'sets') {
                    ex.setsCount = e.setsCount || 3;
                    ex.setMode = e.setMode === 'time' ? 'time' : 'reps';
                    if (ex.setMode === 'reps') ex.targetReps = e.targetReps || 10;
                    else ex.setDuration = e.setDuration || 45;
                    ex.restBetweenSets = e.restBetweenSets || 60;
                }
                return ex;
            }).filter(Boolean);
        }
        const result = [];
        list.forEach((ex, i) => {
            if (!ex || typeof ex !== 'object') return;
            const next = list[i + 1];
            const isLast = i === list.length - 1;
            if (ex.waterBreak) { result.push({ kind: 'rest', restType: 'water', duration: isLast ? null : (ex.restSeconds || 60), notes: ex.notes || '' }); return; }
            const newEx = { kind: 'exercise', name: ex.name || '', type: ex.type === 'reps' || ex.type === 'sets' || ex.type === 'timer' ? ex.type : 'time', notes: ex.notes || '' };
            if (newEx.type === 'timer') newEx.timerDuration = (typeof ex.timerDuration === 'number' && ex.timerDuration >= 5) ? ex.timerDuration : 60;
            if (newEx.type === 'reps') newEx.targetReps = ex.targetReps || 10;
            if (newEx.type === 'sets') {
                newEx.setsCount = ex.setsCount || 3;
                newEx.setMode = ex.setMode === 'time' ? 'time' : 'reps';
                if (newEx.setMode === 'reps') newEx.targetReps = ex.targetReps || 10;
                else newEx.setDuration = ex.setDuration || 45;
                newEx.restBetweenSets = ex.restBetweenSets || 60;
            }
            result.push(newEx);
            const nextIsWater = next && next.waterBreak;
            if (!isLast && ex.restSeconds > 0 && !nextIsWater) result.push({ kind: 'rest', restType: 'rest', duration: ex.restSeconds, notes: '' });
        });
        return result;
    };

    [...DB.workouts, ...DB.templates].forEach(w => {
        const before = JSON.stringify(w.exercises);
        w.exercises = migrateExercisesList(w.exercises);
        if (before !== JSON.stringify(w.exercises)) migrated = true;
    });

    DB.programs.forEach(p => {
        if (!p.weeks || !Array.isArray(p.weeks) || p.weeks.length === 0) {
            const oldDays = p.days || {};
            const newDays = {};
            DAY_KEYS.forEach(k => { newDays[k] = Array.isArray(oldDays[k]) ? oldDays[k] : (oldDays[k] ? [oldDays[k]] : []); });
            const monday = startOfWeekMonday(new Date());
            p.weeks = [{ startDate: formatDateKey(monday), days: newDays }];
            delete p.days;
            migrated = true;
        } else {
            p.weeks.forEach(w => {
                if (!w || typeof w !== 'object') { migrated = true; return; }
                if (!w.startDate || typeof w.startDate !== 'string' || !w.startDate.match(/^\d{4}-\d{2}-\d{2}$/)) { w.startDate = formatDateKey(startOfWeekMonday(new Date())); migrated = true; }
                if (!w.days || typeof w.days !== 'object') { w.days = { mon:[], tue:[], wed:[], thu:[], fri:[], sat:[], sun:[] }; migrated = true; }
                else { DAY_KEYS.forEach(k => { if (!Array.isArray(w.days[k])) { w.days[k] = w.days[k] ? [w.days[k]] : []; migrated = true; } }); }
                if (!w.deloadDays || typeof w.deloadDays !== 'object') { w.deloadDays = {}; migrated = true; }
                DAY_KEYS.forEach(k => { if (typeof w.deloadDays[k] !== 'boolean') { w.deloadDays[k] = false; migrated = true; } });
            });
        }
    });

    if (migrated) { saveDB('workouts'); saveDB('templates'); saveDB('programs'); }

    if (!DB.settings.accordions || typeof DB.settings.accordions !== 'object') DB.settings.accordions = {};
    if (!Array.isArray(DB.settings.accordions.activityOrder)) DB.settings.accordions.activityOrder = [...ACTIVITY_CARDS_DEFAULT];
    if (!DB.settings.accordions.activityCollapsed || typeof DB.settings.accordions.activityCollapsed !== 'object') DB.settings.accordions.activityCollapsed = {};
    ensureActivityOrderSanity();

    const MIGRATION_KEY = 'ft_backfill_exnames_v1';
    try {
        if (!localStorage.getItem(MIGRATION_KEY)) {
            let fixed = 0, skipped = 0;
            (DB.history || []).forEach(r => {
                if (Array.isArray(r.exerciseNames) && r.exerciseNames.length > 0) return;
                const w = r.workoutId ? DB.workouts.find(x => x.id === r.workoutId) : null;
                if (!w || !Array.isArray(w.exercises)) { skipped++; return; }
                const exerciseEls = w.exercises.filter(e => e && e.kind === 'exercise');
                if (exerciseEls.length === 0) { skipped++; return; }
                let names = [];
                if (Array.isArray(r.exerciseOriginalIndices) && r.exerciseOriginalIndices.length) {
                    r.exerciseOriginalIndices.forEach(i => {
                        const el = w.exercises[i];
                        names.push(el && el.kind === 'exercise' ? (el.name || '') : '');
                    });
                    if (names.filter(Boolean).length === 0) names = exerciseEls.map(e => e.name || '');
                } else {
                    names = exerciseEls.map(e => e.name || '');
                }
                if (Array.isArray(r.exerciseTimes) && r.exerciseTimes.length > 0) {
                    if (names.length > r.exerciseTimes.length) names = names.slice(0, r.exerciseTimes.length);
                    while (names.length < r.exerciseTimes.length) names.push('');
                }
                r.exerciseNames = names;
                fixed++;
            });
            if (fixed > 0) saveDB('history');
            localStorage.setItem(MIGRATION_KEY, '1');
        }
    } catch(e) { console.warn('[backfill exerciseNames]', e); }
}

function getTodayKey() { const d = new Date().getDay(); return ['sun','mon','tue','wed','thu','fri','sat'][d]; }
function formatDateKey(d) { 
    try {
        if (!(d instanceof Date) || isNaN(d.getTime())) return '1970-01-01';
        const y = d.getFullYear(); const m = String(d.getMonth() + 1).padStart(2, '0'); const dd = String(d.getDate()).padStart(2, '0'); return `${y}-${m}-${dd}`;
    } catch(e) { return '1970-01-01'; }
}
function parseDateKey(key) {
    if (typeof key !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return new Date();
    const [y, m, d] = key.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    return isNaN(date.getTime()) ? new Date() : date;
}
function addDays(date, n) { const d = new Date(date); d.setDate(d.getDate() + n); return d; }
function startOfWeekMonday(date) { const d = new Date(date); d.setHours(0,0,0,0); const day = d.getDay(); const diff = (day === 0 ? -6 : 1 - day); d.setDate(d.getDate() + diff); return d; }
function formatWeekRange(startKey) {
    const start = parseDateKey(startKey); const end = addDays(start, 6);
    const months = ['янв','фев','мар','апр','май','июн','июл','авг','сен','окт','ноя','дек'];
    if (start.getMonth() === end.getMonth()) return `${start.getDate()}–${end.getDate()} ${months[end.getMonth()]}`;
    return `${start.getDate()} ${months[start.getMonth()]} – ${end.getDate()} ${months[end.getMonth()]}`;
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function formatTime(s) {
    s = Math.max(0, Math.floor(s || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}:${m.toString().padStart(2,'0')}:${sec.toString().padStart(2,'0')}`;
    return `${m.toString().padStart(2,'0')}:${sec.toString().padStart(2,'0')}`;
}
function formatClock(d) { return d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0'); }
function formatDate(d) { const months = ['янв','фев','мар','апр','май','июн','июл','авг','сен','окт','ноя','дек']; return `${d.getDate()} ${months[d.getMonth()]}, ${formatClock(d)}`; }
function formatShortDate(d) { const months = ['янв','фев','мар','апр','май','июн','июл','авг','сен','окт','ноя','дек']; return `${d.getDate()} ${months[d.getMonth()]}`; }
function pluralDays(n) { const m10 = n % 10, m100 = n % 100; if (m10 === 1 && m100 !== 11) return 'день'; if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'дня'; return 'дней'; }
function pluralWeeks(n) { const m10 = n % 10, m100 = n % 100; if (m10 === 1 && m100 !== 11) return 'неделя'; if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'недели'; return 'недель'; }
function pluralApproaches(n) { const m10 = n % 10, m100 = n % 100; if (m10 === 1 && m100 !== 11) return 'подход'; if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'подхода'; return 'подходов'; }
function pluralReps(n) { const m10 = n % 10, m100 = n % 100; if (m10 === 1 && m100 !== 11) return 'повторение'; if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'повторения'; return 'повторений'; }
function pluralMinutes(n) { const m10 = n % 10, m100 = n % 100; if (m10 === 1 && m100 !== 11) return 'минута'; if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'минуты'; return 'минут'; }
function pluralWorkouts(n) { const m10 = n % 10, m100 = n % 100; if (m10 === 1 && m100 !== 11) return 'тренировка'; if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'тренировки'; return 'тренировок'; }
function pluralMeasurements(n) { const m10 = n % 10, m100 = n % 100; if (m10 === 1 && m100 !== 11) return 'замер'; if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'замера'; return 'замеров'; }
function getExerciseNumber(exercises, i) { let n = 0; for (let j = 0; j <= i; j++) if (exercises[j] && exercises[j].kind === 'exercise') n++; return n; }
function getTotalExerciseCount(exercises) { return exercises.filter(e => e && e.kind === 'exercise').length; }
function getTotalRestTime(exercises) { return exercises.filter(e => e && e.kind === 'rest' && e.duration).reduce((s, e) => s + (e.duration || 0), 0); }
function findPrevExerciseIndex(exercises, fromIndex) { for (let i = fromIndex - 1; i >= 0; i--) if (exercises[i] && exercises[i].kind === 'exercise') return i; return -1; }
function findNextElement(exercises, fromIndex) { for (let i = fromIndex + 1; i < exercises.length; i++) if (exercises[i]) return { el: exercises[i], idx: i }; return null; }
function getExerciseOriginalIndices(r) {
    const names = Array.isArray(r && r.exerciseNames) ? r.exerciseNames : [];
    if (Array.isArray(r && r.exerciseOriginalIndices) && r.exerciseOriginalIndices.length === names.length) return r.exerciseOriginalIndices;
    const sr = (r && r.setResults && typeof r.setResults === 'object') ? r.setResults : {};
    const keys = Object.keys(sr).filter(k => /^\d+$/.test(k)).map(k => parseInt(k, 10)).sort((a, b) => a - b);
    if (keys.length === names.length) return keys;
    return names.map((_, i) => i);
}
function getExerciseTypes(r) {
    if (Array.isArray(r && r.exerciseTypes) && r.exerciseTypes.length === (r.exerciseNames || []).length) return r.exerciseTypes;
    return null;
}
function estimateWorkoutDuration(w) {
    if (!w || !Array.isArray(w.exercises)) return 0;
    let total = 0;
    const exCount = w.exercises.filter(e => e && e.kind === 'exercise').length;
    const useWorkoutSettings = workoutUsesPersonalSettings(w);
    const cdOn = (useWorkoutSettings && w.settings && w.settings.countdown !== undefined) ? w.settings.countdown : DB.settings.countdown;
    const cdDur = (useWorkoutSettings && w.settings && w.settings.countdownDuration) || DB.settings.countdownDuration || 3;
    if (cdOn) total += exCount * cdDur;
    w.exercises.forEach(el => {
        if (!el) return;
        if (el.kind === 'warmup') { if (el.mode === 'free') return; total += (el.duration || 180); return; }
        if (el.kind === 'rest') { if (el.duration) total += el.duration; }
        else if (el.kind === 'exercise') {
            if (el.type === 'time') total += (el.estimatedDuration || 60);
            else if (el.type === 'timer') total += (el.timerDuration || 60);
            else if (el.type === 'reps') total += (el.targetReps || 10) * 3;
            else if (el.type === 'sets') {
                const sets = el.setsCount || 3;
                const perSet = el.setMode === 'time' ? (el.setDuration || 45) : (el.targetReps || 10) * 3;
                total += sets * perSet + (sets - 1) * (el.restBetweenSets || 60);
            }
        }
    });
    return total;
}

const BUILTIN_TEMPLATES = [
    { builtin: true, id: 'bt_1', name: 'Пресс 10 минут', autoStart: true, exercises: [
        { kind: 'exercise', name: 'Скручивания', type: 'sets', setsCount: 3, setMode: 'reps', targetReps: 15, restBetweenSets: 30, notes: '' },
        { kind: 'rest', restType: 'rest', duration: 30, notes: '' },
        { kind: 'exercise', name: 'Подъём ног', type: 'sets', setsCount: 3, setMode: 'reps', targetReps: 12, restBetweenSets: 30, notes: '' },
        { kind: 'rest', restType: 'rest', duration: 30, notes: '' },
        { kind: 'exercise', name: 'Планка', type: 'sets', setsCount: 2, setMode: 'time', setDuration: 45, restBetweenSets: 30, notes: '' },
        { kind: 'rest', restType: 'rest', duration: 30, notes: '' },
        { kind: 'exercise', name: 'Велосипед', type: 'reps', targetReps: 20, notes: '' }
    ]},
    { builtin: true, id: 'bt_2', name: 'Отжимания прогрессия', autoStart: true, exercises: [
        { kind: 'exercise', name: 'Отжимания классические', type: 'sets', setsCount: 3, setMode: 'reps', targetReps: 12, restBetweenSets: 60, notes: '' },
        { kind: 'rest', restType: 'rest', duration: 60, notes: '' },
        { kind: 'exercise', name: 'Отжимания узкие', type: 'sets', setsCount: 3, setMode: 'reps', targetReps: 10, restBetweenSets: 60, notes: '' },
        { kind: 'rest', restType: 'rest', duration: 60, notes: '' },
        { kind: 'exercise', name: 'Отжимания широкие', type: 'sets', setsCount: 3, setMode: 'reps', targetReps: 10, restBetweenSets: 60, notes: '' },
        { kind: 'rest', restType: 'rest', duration: 60, notes: '' },
        { kind: 'exercise', name: 'Алмазные', type: 'reps', targetReps: 8, notes: '' }
    ]},
    { builtin: true, id: 'bt_3', name: 'Планка Challenge', autoStart: false, exercises: [
        { kind: 'warmup', name: 'Разминка', duration: 180, mode: 'timer' },
        { kind: 'exercise', name: 'Планка на локтях', type: 'time', notes: 'Максимум' },
        { kind: 'rest', restType: 'rest', duration: 60, notes: '' },
        { kind: 'exercise', name: 'Планка на руках', type: 'time', notes: '' },
        { kind: 'rest', restType: 'rest', duration: 60, notes: '' },
        { kind: 'exercise', name: 'Боковая планка (лево)', type: 'time', notes: '' },
        { kind: 'rest', restType: 'rest', duration: 45, notes: '' },
        { kind: 'exercise', name: 'Боковая планка (право)', type: 'time', notes: '' }
    ]},
    { builtin: true, id: 'bt_4', name: 'Растяжка', autoStart: false, exercises: [
        { kind: 'warmup', name: 'Разминка', duration: null, mode: 'free' },
        { kind: 'exercise', name: 'Наклон к ногам', type: 'time', notes: '30 сек' },
        { kind: 'rest', restType: 'rest', duration: 90, notes: '' },
        { kind: 'exercise', name: 'Бабочка', type: 'time', notes: '' },
        { kind: 'rest', restType: 'rest', duration: 90, notes: '' },
        { kind: 'exercise', name: 'Поза ребёнка', type: 'time', notes: '' },
        { kind: 'rest', restType: 'rest', duration: 120, notes: '' },
        { kind: 'exercise', name: 'Кошка-корова', type: 'time', notes: '' },
        { kind: 'rest', restType: 'water', duration: null, notes: '' }
    ]}
];

try { validateAndMigrateDB(); } catch (e) { console.error('[validateDB]', e); }

function applyTheme() {
    try {
        const mode = DB.settings.themeMode || 'auto';
        let effective = mode;
        if (mode === 'auto') effective = (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
        document.body.classList.toggle('light', effective === 'light');
        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta) meta.setAttribute('content', effective === 'light' ? '#f5f5f8' : '#0a0a10');
    } catch(e) {}
}
function renderThemeModeOptions() {
    const c = document.getElementById('theme-mode-options');
    if (!c) return;
    const modes = [{ v: 'auto', name: '🌗 Авто', desc: 'Как в системе' }, { v: 'light', name: '☀️ Светлая', desc: 'Всегда светлая' }, { v: 'dark', name: '🌙 Тёмная', desc: 'Всегда тёмная' }];
    const cur = DB.settings.themeMode || 'auto';
    c.innerHTML = modes.map(m => `<div class="sound-option ${cur === m.v ? 'selected' : ''}" onclick="selectThemeMode('${m.v}')"><div class="radio"></div><div class="sound-info"><div class="sound-name">${m.name}</div><div class="sound-desc">${m.desc}</div></div></div>`).join('');
}
function selectThemeMode(mode) { if (!['auto','light','dark'].includes(mode)) return; DB.settings.themeMode = mode; saveDB('settings'); applyTheme(); renderThemeModeOptions(); }
function renderFontSizeOptions() {
    const c = document.getElementById('font-size-options');
    if (!c) return;
    const opts = [{ v: 'small', name: '🔡 Мелкий', desc: 'Больше на экране' }, { v: 'normal', name: '🔤 Обычный', desc: 'Стандартный' }, { v: 'large', name: '🔠 Крупный', desc: 'Легче читать' }];
    const cur = DB.settings.fontSizeMode || 'normal';
    c.innerHTML = opts.map(m => `<div class="sound-option ${cur === m.v ? 'selected' : ''}" onclick="selectFontSize('${m.v}')"><div class="radio"></div><div class="sound-info"><div class="sound-name">${m.name}</div><div class="sound-desc">${m.desc}</div></div></div>`).join('');
}
function selectFontSize(v) { if (!['small','normal','large'].includes(v)) return; DB.settings.fontSizeMode = v; saveDB('settings'); applyFontSize(); renderFontSizeOptions(); }

let availableVoices = [];
function refreshVoices() {
    if (!('speechSynthesis' in window)) return;
    try { availableVoices = speechSynthesis.getVoices() || []; } catch(e) { availableVoices = []; }
    renderVoiceOptions();
}
function renderVoiceOptions() {
    const c = document.getElementById('voice-options');
    if (!c) return;
    const ru = availableVoices.filter(v => (v.lang || '').toLowerCase().startsWith('ru'));
    let html = `<div class="sound-option ${!DB.settings.voiceURI ? 'selected' : ''}" onclick="selectVoice(null)"><div class="radio"></div><div class="sound-info"><div class="sound-name">По умолчанию</div><div class="sound-desc">Системный голос</div></div></div>`;
    if (ru.length === 0) html += `<div style="color:var(--muted); font-size:0.85rem; padding:10px; text-align:center;">Русские голоса не найдены</div>`;
    else ru.forEach(v => {
        const sel = DB.settings.voiceURI === v.voiceURI;
        const safe = String(v.voiceURI).replace(/'/g, '&#39;');
        html += `<div class="sound-option ${sel ? 'selected' : ''}" onclick="selectVoice('${safe}')"><div class="radio"></div><div class="sound-info"><div class="sound-name">${escapeHtml(v.name || 'Голос')}</div><div class="sound-desc">${v.lang}</div></div><button class="preview-btn" onclick="event.stopPropagation(); previewVoice('${safe}')" aria-label="Прослушать">▶</button></div>`;
    });
    c.innerHTML = html;
}
function selectVoice(uri) { DB.settings.voiceURI = uri || null; saveDB('settings'); renderVoiceOptions(); if (isVoiceMode()) speakCritical('голос выбран'); }
function previewVoice(uri) {
    try {
        speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance('Приготовься. Одна минута');
        u.lang = 'ru-RU'; u.rate = DB.settings.voiceRate || 1;
        const v = availableVoices.find(x => x.voiceURI === uri);
        if (v) u.voice = v;
        speechSynthesis.speak(u);
    } catch(e) {}
}
function renderVoiceRateOptions() {
    const c = document.getElementById('voice-rate-options');
    if (!c) return;
    const rates = [{ v: 0.8, name: '🐢 Медленная', desc: 'Понятнее' }, { v: 1.0, name: '🚶 Обычная', desc: 'Как в системе' }, { v: 1.3, name: '🐇 Быстрая', desc: 'Меньше пауз' }];
    const cur = DB.settings.voiceRate || 1;
    c.innerHTML = rates.map(r => `<div class="sound-option ${cur === r.v ? 'selected' : ''}" onclick="selectVoiceRate(${r.v})"><div class="radio"></div><div class="sound-info"><div class="sound-name">${r.name}</div><div class="sound-desc">${r.desc}</div></div></div>`).join('');
}
function selectVoiceRate(v) { DB.settings.voiceRate = v; saveDB('settings'); renderVoiceRateOptions(); if (isVoiceMode()) speakCritical('скорость изменена'); }

const SNOOZE_OPTIONS = [{ v: 1, t: '1 час' }, { v: 2, t: '2 часа' }, { v: 3, t: '3 часа' }, { v: 4, t: '4 часа' }, { v: 24, t: 'До завтра' }];
function renderSnoozeDurationOptions() {
    const c = document.getElementById('snooze-duration-options');
    if (!c) return;
    const cur = DB.settings.snoozeDuration || 2;
    c.innerHTML = SNOOZE_OPTIONS.map(o => `<div class="sound-option ${cur === o.v ? 'selected' : ''}" onclick="selectSnoozeDuration(${o.v})"><div class="radio"></div><div class="sound-info"><div class="sound-name">${o.t}</div></div></div>`).join('');
}
function selectSnoozeDuration(v) { DB.settings.snoozeDuration = v; saveDB('settings'); renderSnoozeDurationOptions(); }

const ACTIVITY_CARDS_DEFAULT = ['week','heatmap','timeofday','weeks','besthour','exercise-progress','plan','total'];
const ACTIVITY_CARDS_LABELS = {
    week: '📈 Неделя',
    heatmap: '📅 Активность 30 дней',
    timeofday: '🕐 Когда вы тренируетесь',
    weeks: '📈 Работа по неделям',
    besthour: '⏰ Лучшее время',
    'exercise-progress': '📈 Прогресс по упражнениям',
    plan: '📋 Выполнение программ (30 дней)',
    total: '🏆 Всего'
};
function getActivityOrder() {
    if (!DB.settings.accordions) DB.settings.accordions = {};
    if (!Array.isArray(DB.settings.accordions.activityOrder)) DB.settings.accordions.activityOrder = [...ACTIVITY_CARDS_DEFAULT];
    return DB.settings.accordions.activityOrder;
}
function getActivityCollapsed() {
    if (!DB.settings.accordions) DB.settings.accordions = {};
    if (!DB.settings.accordions.activityCollapsed || typeof DB.settings.accordions.activityCollapsed !== 'object') DB.settings.accordions.activityCollapsed = {};
    return DB.settings.accordions.activityCollapsed;
}
function ensureActivityOrderSanity() {
    const order = getActivityOrder().filter(k => ACTIVITY_CARDS_DEFAULT.includes(k));
    const missing = ACTIVITY_CARDS_DEFAULT.filter(k => !order.includes(k));
    if (missing.length) {
        DB.settings.accordions.activityOrder = [...order, ...missing];
        Storage.set('ft_settings', DB.settings);
    }
}
function toggleActivityCard(key) {
    const c = getActivityCollapsed();
    c[key] = !c[key];
    Storage.set('ft_settings', DB.settings);
    const el = document.querySelector(`.activity-card[data-card-key="${key}"]`);
    if (!el) { renderActivity(); return; }
    const collapsed = !!c[key];
    el.classList.toggle('collapsed', collapsed);
    const body = el.querySelector('.activity-card-body');
    if (body) body.style.display = collapsed ? 'none' : '';
    const btn = el.querySelector('.activity-card-header .icon-toggle-btn');
    if (btn) {
        btn.innerHTML = collapsed
            ? '<svg viewBox="0 0 24 24" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>'
            : '<svg viewBox="0 0 24 24" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>';
        btn.setAttribute('aria-label', collapsed ? 'Развернуть' : 'Свернуть');
    }
}
function wrapActivityCard(key, bodyHtml) {
    const collapsed = !!getActivityCollapsed()[key];
    const title = ACTIVITY_CARDS_LABELS[key] || '';
    const icon = collapsed
        ? '<svg viewBox="0 0 24 24" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>'
        : '<svg viewBox="0 0 24 24" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>';
    return `<div class="card activity-card${collapsed ? ' collapsed' : ''}" data-card-key="${key}">
        <div class="activity-card-header" onclick="toggleActivityCard('${key}')">
            <div class="activity-card-title">${title}</div>
            <button class="icon-toggle-btn" aria-label="${collapsed ? 'Развернуть' : 'Свернуть'}">${icon}</button>
        </div>
        <div class="activity-card-body" style="${collapsed ? 'display:none;' : ''}">${bodyHtml}</div>
    </div>`;
}

let activityExerciseSelected = null;
let activityExercisePeriod = 30;
let activityExerciseMetric = 'max';
let activityTableSort = 'date-desc';
let activityExerciseWorkoutFilter = 'all';

function ensureExerciseNamesForRecord(r) {
    if (!r || typeof r !== 'object') return [];
    if (Array.isArray(r.exerciseNames) && r.exerciseNames.length > 0) return r.exerciseNames;
    const w = r.workoutId ? DB.workouts.find(x => x.id === r.workoutId) : null;
    if (!w || !Array.isArray(w.exercises)) return [];
    const exEls = w.exercises.filter(e => e && e.kind === 'exercise');
    if (exEls.length === 0) return [];
    let names = [];
    if (Array.isArray(r.exerciseOriginalIndices) && r.exerciseOriginalIndices.length) {
        r.exerciseOriginalIndices.forEach(i => {
            const el = w.exercises[i];
            names.push(el && el.kind === 'exercise' ? (el.name || '') : '');
        });
    }
    if (names.filter(Boolean).length === 0) names = exEls.map(e => e.name || '');
    if (Array.isArray(r.exerciseTimes) && r.exerciseTimes.length > 0) {
        if (names.length > r.exerciseTimes.length) names = names.slice(0, r.exerciseTimes.length);
        while (names.length < r.exerciseTimes.length) names.push('');
    }
    r.exerciseNames = names;
    return names;
}

function ensureExerciseTypesForRecord(r) {
    if (!r || typeof r !== 'object') return null;
    const names = r.exerciseNames || [];
    if (Array.isArray(r.exerciseTypes) && r.exerciseTypes.length === names.length) return r.exerciseTypes;
    const w = r.workoutId ? DB.workouts.find(x => x.id === r.workoutId) : null;
    if (!w || !Array.isArray(w.exercises)) return null;
    const origIdxs = getExerciseOriginalIndices(r);
    const types = [];
    let ok = true;
    for (let i = 0; i < names.length; i++) {
        const origIdx = origIdxs[i] !== undefined ? origIdxs[i] : i;
        const el = w.exercises[origIdx];
        if (el && el.kind === 'exercise') {
            types.push(el.type === 'timer' ? 'time' : (el.type === 'sets' && el.setMode === 'time' ? 'time' : 'reps'));
        } else {
            types.push(null); ok = false;
        }
    }
    if (ok) { r.exerciseTypes = types; return types; }
    return null;
}

function getExerciseUniqueNames(workoutFilter) {
    const seen = new Set();
    const targetNorm = workoutFilter && workoutFilter !== 'all' ? String(workoutFilter) : null;
    (DB.history || []).forEach(r => {
        if (targetNorm && String(r.workoutId) !== targetNorm && r.workoutName !== targetNorm) return;
        const names = ensureExerciseNamesForRecord(r);
        names.forEach(n => {
            const name = (n || '').trim();
            if (name) seen.add(name);
        });
    });
    return [...seen].sort((a, b) => a.localeCompare(b, 'ru'));
}

function getWorkoutUniqueNames() {
    const seen = new Set();
    (DB.history || []).forEach(r => {
        if (r.workoutName) seen.add(r.workoutName);
    });
    return [...seen].sort((a, b) => a.localeCompare(b, 'ru'));
}

function normalizeExerciseName(s) { return String(s || '').trim().replace(/\s+/g, ' ').toLowerCase(); }

function getExerciseProgressData(exName, periodDays, metric, workoutFilter) {
    const now = Date.now();
    const cutoff = periodDays ? now - periodDays * 24 * 60 * 60 * 1000 : 0;
    const result = [];
    const targetNorm = normalizeExerciseName(exName);
    const targetWorkout = workoutFilter && workoutFilter !== 'all' ? String(workoutFilter) : null;
    (DB.history || []).forEach(r => {
        if (targetWorkout && String(r.workoutId) !== targetWorkout && r.workoutName !== targetWorkout) return;
        let ts;
        try { ts = new Date(r.startTime).getTime(); } catch(e) { return; }
        if (!ts || isNaN(ts)) return;
        if (cutoff && ts < cutoff) return;
        const names = ensureExerciseNamesForRecord(r);
        if (!names || names.length === 0) return;
        const origIdxs = getExerciseOriginalIndices(r);
        const times = r.exerciseTimes || [];
        const sr = r.setResults || {};
        const types = ensureExerciseTypesForRecord(r);
        let exIdx = -1;
        for (let i = 0; i < names.length; i++) {
            if (normalizeExerciseName(names[i]) === targetNorm) { exIdx = i; break; }
        }
        if (exIdx === -1) return;
        const origIdx = origIdxs[exIdx] !== undefined ? origIdxs[exIdx] : exIdx;
        const sets = sr[origIdx];
        const weights = ((r.setWeights || {})[origIdx]) || null;
        const timeVal = times[exIdx];
        const knownType = types ? types[exIdx] : null;
        let type = 'reps';
        let value = 0;
        let setsArr = null;
        let weightsArr = null;
        if (Array.isArray(weights)) weightsArr = weights.map(x => parseFloat(x) || 0);
        const isWeightMetric = metric && String(metric).startsWith('weight');
        if (isWeightMetric) {
            type = 'weight';
            if (!weightsArr || !weightsArr.length || !weightsArr.some(w => w > 0)) return;
            if (metric === 'weight-sum') value = weightsArr.reduce((a, b) => a + b, 0);
            else if (metric === 'weight-first') value = weightsArr[0] || 0;
            else value = Math.max(...weightsArr);
        } else if (knownType === 'time') {
            type = 'time';
            const t = (typeof timeVal === 'number' && timeVal > 0) ? timeVal : 0;
            value = t;
        } else if (Array.isArray(sets)) {
            type = 'reps';
            setsArr = sets.map(x => parseInt(x, 10) || 0);
            if (metric === 'sum') value = setsArr.reduce((a, b) => a + b, 0);
            else if (metric === 'first') value = setsArr[0] || 0;
            else value = setsArr.length ? Math.max(...setsArr) : 0;
        } else if (sets === 'skipped' || sets === undefined || sets === null) {
            type = 'time';
            const t = (typeof timeVal === 'number' && timeVal > 0) ? timeVal : 0;
            value = t;
        } else {
            type = 'reps';
            const n = parseInt(sets, 10) || 0;
            setsArr = [n];
            value = n;
        }
        if ((type === 'time' || type === 'weight') && value <= 0) return;
        const d = new Date(ts);
        result.push({
            date: d,
            dateKey: formatDateKey(d),
            time: formatClock(d),
            value,
            type,
            sets: setsArr,
            weights: weightsArr,
            timeVal: timeVal
        });
    });
    result.sort((a, b) => a.date - b.date);
    return result;
}

function renderExerciseChart(records) {
    if (!records || records.length < 2) {
        return `<div style="text-align:center; color:var(--muted); padding:20px; font-size:0.85rem;">Недостаточно данных для графика</div>`;
    }
    const w = 340, h = 140, pad = 24;
    const vals = records.map(r => r.value);
    const maxV = Math.max(...vals);
    const minV = Math.min(...vals);
    const range = (maxV - minV) || 1;
    const stepX = (w - pad * 2) / (records.length - 1);
    const points = records.map((r, i) => {
        const x = pad + i * stepX;
        const y = pad + (1 - (r.value - minV) / range) * (h - pad * 2);
        return { x, y, r };
    });
    const maxVal = Math.max(...vals);
    const pathD = points.map((p, i) => (i === 0 ? 'M' : 'L') + p.x.toFixed(1) + ',' + p.y.toFixed(1)).join(' ');
    const gridLines = [0, 0.5, 1].map(frac => {
        const y = pad + frac * (h - pad * 2);
        return `<line class="grid-line" x1="${pad}" y1="${y}" x2="${w - pad}" y2="${y}"/>`;
    }).join('');
    let trendD = '';
    try {
        const n = points.length;
        let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
        points.forEach(p => { sumX += p.x; sumY += p.y; sumXY += p.x * p.y; sumXX += p.x * p.x; });
        const denom = n * sumXX - sumX * sumX;
        if (denom !== 0) {
            const slope = (n * sumXY - sumX * sumY) / denom;
            const intercept = (sumY - slope * sumX) / n;
            const x1 = pad, y1 = slope * x1 + intercept;
            const x2 = w - pad, y2 = slope * x2 + intercept;
            trendD = `<path class="trend-line" d="M${x1.toFixed(1)},${y1.toFixed(1)} L${x2.toFixed(1)},${y2.toFixed(1)}"/>`;
        }
    } catch(e) {}
    const dots = points.map(p => {
        const isRecord = p.r.value === maxVal;
        const dateIso = p.r.date instanceof Date ? p.r.date.toISOString() : String(p.r.date);
        const type = p.r.type || 'reps';
        return `<circle class="dot${isRecord ? ' record' : ''}" tabindex="0" role="button" aria-label="${p.r.value} · ${formatShortDate(p.r.date)}" data-ex-value="${p.r.value}" data-ex-date="${dateIso}" data-ex-type="${type}" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${isRecord ? 6 : 5}"><title>${p.r.value} · ${formatShortDate(p.r.date)}</title></circle>`;
    }).join('');
    const labels = points.map((p, i) => {
        if (i !== 0 && i !== points.length - 1 && i !== Math.floor(points.length / 2)) return '';
        return `<text class="label" x="${p.x.toFixed(1)}" y="${h - 4}" text-anchor="middle">${formatShortDate(p.r.date)}</text>`;
    }).join('');
    return `<div class="exercise-chart-wrap"><svg class="weight-chart-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${gridLines}${trendD}<path class="line" d="${pathD}"/>${dots}${labels}</svg></div>`;
}

function renderExerciseTable(records, sortBy) {
    if (!records || records.length === 0) {
        return `<div style="text-align:center; color:var(--muted); padding:16px; font-size:0.85rem;">Нет записей</div>`;
    }
    const maxVal = Math.max(...records.map(r => r.value));
    const sorted = [...records];
    if (sortBy === 'date-asc') sorted.sort((a, b) => a.date - b.date);
    else if (sortBy === 'val-desc') sorted.sort((a, b) => b.value - a.value);
    else if (sortBy === 'val-asc') sorted.sort((a, b) => a.value - b.value);
    else sorted.sort((a, b) => b.date - a.date);
    const fmtKg = (w) => {
        const n = Number(w) || 0;
        return (Math.round(n * 10) / 10).toString().replace(/\.0$/, '');
    };
    const rows = sorted.map(r => {
        let unit = 'сек';
        let mainVal = formatTime(r.value);
        if (r.type === 'reps') { unit = 'повт.'; mainVal = r.value; }
        else if (r.type === 'weight') { unit = 'кг'; mainVal = fmtKg(r.value); }
        const isRecord = r.value === maxVal;
        let setsHtml = '';
        if (Array.isArray(r.sets) && r.sets.length > 1) {
            setsHtml = `<div class="sets-row">Подходы: ${r.sets.join(' / ')}</div>`;
        }
        if (Array.isArray(r.weights) && r.weights.some(w => w > 0)) {
            const wStr = r.weights.map(w => fmtKg(w) + ' кг').join(' · ');
            setsHtml += `<div class="sets-row" style="color:var(--warn); margin-top:2px;">📏 ${wStr}</div>`;
        }
        return `<tr>
            <td>${formatShortDate(r.date)} <span style="color:var(--muted); font-size:0.75rem;">${r.time}</span></td>
            <td class="val-cell">${isRecord ? '🏅 ' : ''}${mainVal} <span style="color:var(--muted); font-size:0.75rem; font-weight:400;">${unit}</span>${setsHtml}</td>
        </tr>`;
    }).join('');
    return `<div class="exercise-table-wrap"><table class="exercise-table"><thead><tr><th>Дата</th><th>Результат</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function renderActivityExerciseChart() {
    const allWorkoutNames = getWorkoutUniqueNames();
    if (allWorkoutNames.length === 0) {
        return `<div style="text-align:center; color:var(--muted); padding:16px; font-size:0.85rem;">Пока нет данных по тренировкам.<br>Сделайте тренировку — здесь появится график прогресса.</div>`;
    }
    let names = getExerciseUniqueNames(activityExerciseWorkoutFilter);
    if (names.length === 0 && activityExerciseWorkoutFilter !== 'all') {
        names = getExerciseUniqueNames('all');
    }
    if (names.length === 0) {
        return `<div style="text-align:center; color:var(--muted); padding:16px; font-size:0.85rem;">Пока нет данных по упражнениям.<br>Сделайте тренировку — здесь появится график прогресса.</div>`;
    }
    if (!activityExerciseSelected || !names.includes(activityExerciseSelected)) {
        activityExerciseSelected = names[0];
    }
    const periodOpts = [
        { v: 7, t: '7 дней' }, { v: 30, t: '30 дней' }, { v: 90, t: '90 дней' }, { v: 365, t: 'Год' }
    ];
    const metricOpts = [
        { v: 'max', t: 'Макс. повторы' }, { v: 'sum', t: 'Сумма повторов' }, { v: 'first', t: 'Первый подход' },
        { v: 'weight-max', t: 'Макс. вес' }, { v: 'weight-sum', t: 'Сумма весов' }, { v: 'weight-first', t: 'Первый вес' }
    ];
    const sortOpts = [
        { v: 'date-desc', t: 'Новые' }, { v: 'date-asc', t: 'Старые' },
        { v: 'val-desc', t: 'Больше' }, { v: 'val-asc', t: 'Меньше' }
    ];

    const recordsProbe = getExerciseProgressData(activityExerciseSelected, activityExercisePeriod, activityExerciseMetric, activityExerciseWorkoutFilter);
    let isTimeType = false;
    if (recordsProbe.length > 0) {
        isTimeType = recordsProbe.every(r => r.type === 'time');
    }
    const metricDisabled = isTimeType && !(activityExerciseMetric && String(activityExerciseMetric).startsWith('weight'));

    const workoutSelectHtml = `<select class="select" style="margin:0;" onchange="activityExerciseWorkoutFilter=this.value; activityExerciseSelected=null; renderActivity();">
        <option value="all" ${activityExerciseWorkoutFilter === 'all' ? 'selected' : ''}>🏋️ Все тренировки</option>
        ${allWorkoutNames.map(n => `<option value="${escapeHtml(n)}" ${n === activityExerciseWorkoutFilter ? 'selected' : ''}>${escapeHtml(n)}</option>`).join('')}
    </select>`;
    const exSelectHtml = `<select class="select" style="margin:0;" onchange="activityExerciseSelected=this.value; renderActivity();">
        ${names.map(n => `<option value="${escapeHtml(n)}" ${n === activityExerciseSelected ? 'selected' : ''}>${escapeHtml(n)}</option>`).join('')}
    </select>`;
    const periodSelectHtml = `<select class="select" style="margin:0;" onchange="activityExercisePeriod=parseInt(this.value)||30; renderActivity();">
        ${periodOpts.map(o => `<option value="${o.v}" ${o.v === activityExercisePeriod ? 'selected' : ''}>${o.t}</option>`).join('')}
    </select>`;
    const metricSelectHtml = `<select class="select" style="margin:0;" ${metricDisabled ? 'disabled' : ''} onchange="activityExerciseMetric=this.value; renderActivity();">
        ${metricOpts.map(o => `<option value="${o.v}" ${o.v === activityExerciseMetric ? 'selected' : ''}>${o.t}</option>`).join('')}
    </select>`;
    const sortSelectHtml = `<select class="select" style="margin:0;" onchange="activityTableSort=this.value; renderActivity();">
        ${sortOpts.map(o => `<option value="${o.v}" ${o.v === activityTableSort ? 'selected' : ''}>${o.t}</option>`).join('')}
    </select>`;

    const chartHtml = renderExerciseChart(recordsProbe);
    const tableHtml = renderExerciseTable(recordsProbe, activityTableSort);
    let compareHtml = '';
    try {
        if (recordsProbe.length > 0) {
            const prev = getExerciseProgressData(activityExerciseSelected, activityExercisePeriod * 2, activityExerciseMetric, activityExerciseWorkoutFilter)
                .filter(r => r.date.getTime() < (Date.now() - activityExercisePeriod * 24 * 60 * 60 * 1000));
            if (prev.length > 0) {
                const avgCur = recordsProbe.reduce((s, r) => s + r.value, 0) / recordsProbe.length;
                const avgPrev = prev.reduce((s, r) => s + r.value, 0) / prev.length;
                const delta = avgCur - avgPrev;
                const pct = avgPrev > 0 ? Math.round(delta / avgPrev * 100) : 0;
                const cls = delta > 0 ? 'down' : (delta < 0 ? 'up' : 'same');
                const sign = delta > 0 ? '+' : '';
                compareHtml = `<div style="margin-top:6px; font-size:0.78rem; color:var(--muted); text-align:center;">Среднее vs прошлый период: <span class="measure-delta ${cls}" style="margin:0; padding:2px 8px; font-size:0.75rem;">${sign}${pct}%</span></div>`;
            }
        }
    } catch(e) {}

    return `
        <div style="display:flex; gap:6px; margin-bottom:8px; flex-wrap:wrap;">
            <div style="flex:1 1 100%;">${workoutSelectHtml}</div>
        </div>
        <div style="display:flex; gap:6px; margin-bottom:8px; flex-wrap:wrap;">
            <div style="flex:1 1 100%;">${exSelectHtml}</div>
            <div style="flex:1 1 100px;">${periodSelectHtml}</div>
            <div style="flex:1 1 120px;">${metricSelectHtml}</div>
        </div>
        ${metricDisabled ? `<div style="color:var(--muted); font-size:0.75rem; margin-bottom:8px;">Упражнение на время — метрика не применима</div>` : ''}
        ${chartHtml}
        ${compareHtml}
        <div style="display:flex; justify-content:space-between; align-items:center; margin:12px 0 6px; gap:8px;">
            <div style="font-weight:600; font-size:0.85rem; color:var(--muted);">Таблица</div>
            <div style="flex:0 0 auto; width:130px;">${sortSelectHtml}</div>
        </div>
        ${tableHtml}
    `;
}

function setWeekMetric(v) { if (!['work','duration','count','plan'].includes(v)) return; DB.settings.weekMetric = v; saveDB('settings'); invalidateActivityCache(); renderActivity(); }
function setWeekRange(v) { v = parseInt(v) || 8; if (![4,8,12].includes(v)) v = 8; DB.settings.weekRange = v; saveDB('settings'); invalidateActivityCache(); renderActivity(); }

function getWeekRecords(startKey) {
    const s = parseDateKey(startKey); s.setHours(0,0,0,0);
    const e = addDays(s, 7);
    return DB.history.filter(r => { try { const d = new Date(r.startTime); return d >= s && d < e; } catch(err) { return false; } });
}
function getWeekPlanStats(startKey, opts) {
    const s = parseDateKey(startKey); s.setHours(0,0,0,0);
    const today = new Date(); today.setHours(0,0,0,0);
    const todayKey = formatDateKey(today);
    const partialOnlyPast = !!(opts && opts.partialOnlyPast);
    let planned = 0, done = 0;
    DB.programs.forEach(p => {
        (p.weeks || []).forEach(w => {
            if (!w || !w.days || !w.startDate) return;
            DAY_KEYS.forEach((dk, dayIdx) => {
                const date = addDays(parseDateKey(w.startDate), dayIdx);
                const dateKey = formatDateKey(date);
                if (date < s || date >= addDays(s, 7)) return;
                if (partialOnlyPast && dateKey >= todayKey) return;
                const ids = w.days[dk] || [];
                if (ids.length === 0) return;
                const occMap = {};
                ids.forEach(wid => {
                    const occIdx = occMap[wid] || 0;
                    occMap[wid] = occIdx + 1;
                    planned++;
                    const st = getPlanStatus(wid, date, occIdx);
                    if (st.status === 'done') done++;
                });
            });
        });
    });
    return { planned, done, pct: planned > 0 ? Math.round(done / planned * 100) : 0 };
}
function getWeekValue(startKey, metric) {
    const records = getWeekRecords(startKey);
    if (metric === 'duration') return Math.round(records.reduce((s, r) => s + (r.totalDuration || 0), 0) / 60);
    if (metric === 'count') return records.length;
    if (metric === 'plan') {
        const today = new Date(); today.setHours(0,0,0,0);
        const s = parseDateKey(startKey); s.setHours(0,0,0,0);
        const isCurrent = formatDateKey(s) === formatDateKey(startOfWeekMonday(today));
        const st = isCurrent ? getWeekPlanStats(startKey, { partialOnlyPast: true }) : getWeekPlanStats(startKey);
        return st.planned > 0 ? st.pct : null;
    }
    return Math.round(records.reduce((s, r) => s + (r.workTime || 0), 0) / 60);
}
function getWeekMetricUnit(metric) {
    if (metric === 'count') return 'трен.';
    if (metric === 'plan') return '%';
    return 'мин';
}

function buildWeekWorkChart() {
    try {
        const metric = DB.settings.weekMetric || 'work';
        const range = [4,8,12].includes(DB.settings.weekRange) ? DB.settings.weekRange : 8;
        const unit = getWeekMetricUnit(metric);
        const today = new Date(); today.setHours(0,0,0,0);
        const mondayThis = startOfWeekMonday(today);
        const weeks = [];
        for (let i = range - 1; i >= 0; i--) {
            const start = addDays(mondayThis, -7 * i);
            const startKey = formatDateKey(start);
            const value = getWeekValue(startKey, metric);
            weeks.push({ start, startKey, value, isCurrent: i === 0 });
        }
        const validForAvg = weeks.filter(w => w.value !== null && w.value !== undefined);
        const avg = validForAvg.length > 0 ? validForAvg.reduce((s, w) => s + (w.value || 0), 0) / validForAvg.length : 0;
        const maxValRaw = Math.max(...validForAvg.map(w => Math.abs(w.value || 0)), 0);
        const maxVal = Math.max(1, maxValRaw);
        const avgPct = Math.min(100, Math.max(0, (avg / maxVal) * 100));
        const isLowAvg = avgPct < 12 && avgPct > 0;

        const barsHtml = weeks.map(w => {
            const hasValue = w.value !== null && w.value !== undefined;
            const v = hasValue ? w.value : 0;
            const pct = Math.max(v > 0 ? 4 : 0, Math.min(100, Math.round((v / maxVal) * 100)));
            const belowAvg = hasValue && v < avg;
            const isNoPlan = metric === 'plan' && !hasValue;
            const fillCls = 'durations-bar-fill'
                + (isNoPlan ? ' no-plan' : '')
                + (w.isCurrent ? ' current-week' : '')
                + (belowAvg ? ' below-avg' : '')
                + (v <= 0 && !isNoPlan ? ' empty' : '');
            const labelText = formatShortDate(w.start);
            const ariaLabel = `${formatWeekRange(w.startKey)}: ${isNoPlan ? 'нет плана' : v + ' ' + unit}`;
            return `<div class="durations-bar${w.isCurrent ? ' current-week' : ''}${isNoPlan ? ' no-plan' : ''}" role="button" tabindex="0" aria-label="${ariaLabel}" data-week-start="${w.startKey}" onclick="showWeekActivityDetail('${w.startKey}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();showWeekActivityDetail('${w.startKey}');}">
                <div class="durations-bar-value">${isNoPlan ? '—' : (v > 0 ? v : '')}</div>
                <div class="${fillCls}" style="height:${isNoPlan ? Math.max(2, Math.round(100 / Math.max(1, range))) : pct}%;"></div>
                <div class="durations-bar-label">${labelText}</div>
            </div>`;
        }).join('');

        return `<div class="week-metric-row">
            <select class="select" onchange="setWeekMetric(this.value)" aria-label="Метрика">
                <option value="work" ${metric === 'work' ? 'selected' : ''}>💪 Работа</option>
                <option value="duration" ${metric === 'duration' ? 'selected' : ''}>⏱ Длительность</option>
                <option value="count" ${metric === 'count' ? 'selected' : ''}>🏋️ Тренировки</option>
                <option value="plan" ${metric === 'plan' ? 'selected' : ''}>📋 План</option>
            </select>
            <select class="select" onchange="setWeekRange(this.value)" aria-label="Диапазон">
                <option value="4" ${range === 4 ? 'selected' : ''}>4 нед.</option>
                <option value="8" ${range === 8 ? 'selected' : ''}>8 нед.</option>
                <option value="12" ${range === 12 ? 'selected' : ''}>12 нед.</option>
            </select>
        </div>
        <div class="durations-chart" style="position:relative;">
            ${avgPct > 0 ? `<div class="durations-avg-line${isLowAvg ? ' low' : ''}" style="bottom:${avgPct}%;"><div class="durations-avg-label">сред. ${avg > 0 ? avg.toFixed(0) : 0} ${unit}</div></div>` : ''}
            ${barsHtml}
        </div>
        <div style="display:flex; justify-content:space-between; font-size:0.7rem; color:var(--muted); margin-top:6px;">
            <span>Нажмите на столбик, чтобы увидеть детали недели</span>
            <span>${range} нед.</span>
        </div>`;
    } catch(e) { console.error('[buildWeekWorkChart]', e); return '<div style="color:var(--muted); font-size:0.85rem;">Не удалось построить график</div>'; }
}

function showWeekActivityDetail(startKey) {
    try {
        const start = parseDateKey(startKey); start.setHours(0,0,0,0);
        const end = addDays(start, 6);
        const records = getWeekRecords(startKey).sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
        const today = new Date(); today.setHours(0,0,0,0);
        const isCurrent = formatDateKey(start) === formatDateKey(startOfWeekMonday(today));
        const planStats = isCurrent ? getWeekPlanStats(startKey, { partialOnlyPast: true }) : getWeekPlanStats(startKey);
        const totalDuration = records.reduce((s, r) => s + (r.totalDuration || 0), 0);
        const totalWork = records.reduce((s, r) => s + (r.workTime || 0), 0);
        const totalWarmup = records.reduce((s, r) => s + (r.warmupSeconds || 0), 0);
        const title = formatWeekRange(startKey) + ' ' + start.getFullYear();
        let rowsHtml = '';
        if (records.length === 0) {
            rowsHtml = `<div style="text-align:center; color:var(--muted); padding:24px; font-size:0.9rem;">Тренировок на этой неделе нет</div>`;
        } else {
            rowsHtml = records.map(r => {
                const startT = new Date(r.startTime);
                const wExists = r.workoutId && DB.workouts.find(w => w.id === r.workoutId);
                return `<div class="history-card" style="margin:0; cursor:pointer;" onclick="openHistoryItemDetail(${r.id})">
                    <div class="history-top"><div class="history-info"><div class="name">${escapeHtml(r.workoutName || 'Тренировка')}${r.isDeload ? ' 🏷' : ''}</div><div class="stats">📅 ${formatShortDate(startT)} · 🕐 ${formatClock(startT)} · ⏱ ${formatTime(r.totalDuration)} · 💪 ${formatTime(r.workTime)}</div></div><div class="history-actions">${wExists ? `<button class="icon-btn" onclick="event.stopPropagation(); closeTopSheet(); repeatLastWorkout(${r.workoutId})" title="Повторить" aria-label="Повторить">▶</button>` : ''}<button class="icon-btn" onclick="event.stopPropagation(); shareResult(${r.id})" title="Поделиться" aria-label="Поделиться">📤</button></div></div>
                    ${r.workoutNote ? `<div style="background:var(--primary-soft); border-left:3px solid var(--primary); border-radius:10px; padding:8px 10px; font-size:0.82rem;">📝 ${escapeHtml(r.workoutNote)}</div>` : ''}
                </div>`;
            }).join('');
        }
        let planHtml = '';
        if (planStats.planned > 0) {
            const planColor = planStats.pct >= 100 ? 'var(--accent)' : planStats.pct >= 50 ? 'var(--warn)' : 'var(--danger)';
            const planLabel = isCurrent ? 'Выполнение плана (прошедшие дни)' : 'Выполнение плана';
            planHtml = `<div class="history-summary-card" style="margin-bottom:0; padding:14px;">
                <div class="history-summary-title">${planLabel}</div>
                <div class="history-summary-row" style="margin-top:0; padding-top:0; border-top:none;">
                    <div class="history-summary-item"><div class="val" style="color:var(--accent);">${planStats.done}</div><div class="lbl">✅ выполнено</div></div>
                    <div class="history-summary-item"><div class="val" style="color:var(--danger);">${planStats.planned - planStats.done}</div><div class="lbl">❌ пропущено</div></div>
                    <div class="history-summary-item"><div class="val" style="color:${planColor};">${planStats.pct}%</div><div class="lbl">процент</div></div>
                </div>
            </div>`;
        }
        const summaryHtml = `<div class="history-summary-card" style="margin-bottom:0; padding:14px;">
            <div class="history-summary-title">Итоги недели</div>
            <div class="history-summary-row" style="margin-top:0; padding-top:0; border-top:none;">
                <div class="history-summary-item"><div class="val">${records.length}</div><div class="lbl">🏋️ тренировок</div></div>
                <div class="history-summary-item"><div class="val">${formatTime(Math.floor(totalDuration))}</div><div class="lbl">⏱ общее</div></div>
                <div class="history-summary-item"><div class="val">${formatTime(Math.floor(totalWork))}</div><div class="lbl">💪 работа</div></div>
                ${totalWarmup > 0 ? `<div class="history-summary-item"><div class="val">${formatTime(Math.floor(totalWarmup))}</div><div class="lbl">🔥 разминка</div></div>` : ''}
            </div>
        </div>`;
        const ov = document.createElement('div');
        ov.className = 'notif-side-overlay';
        ov.innerHTML = `<div class="notif-side-sheet" style="max-height: 85vh;">
            <div class="notif-side-grabber"><div class="notif-side-grabber-bar"></div></div>
            <h2 class="sheet-title">${title}</h2>
            <div style="color:var(--muted); font-size:0.82rem; text-align:center; flex-shrink:0;">${formatShortDate(start)} – ${formatShortDate(end)}</div>
            <div class="sheet-scroll-area" style="flex:1; overflow-y:auto; display:flex; flex-direction:column; gap:8px; padding-right: 4px;">
                ${summaryHtml}
                ${planHtml}
                <div style="font-size:0.72rem; color:var(--muted); text-transform:uppercase; letter-spacing:1.5px; margin-top:4px;">Тренировки</div>
                ${rowsHtml}
            </div>
            <div class="sheet-fixed-bottom" style="flex-shrink: 0; display: flex; flex-direction: column; gap: 8px; padding-top: 4px;">
                <button class="btn sheet-btn-cancel" onclick="closeTopSheet()">Закрыть</button>
            </div>
        </div>`;
        document.body.appendChild(ov);
        setupSideSwipe(ov.querySelector('.notif-side-sheet'), ov);
        ov.addEventListener('click', (e) => { if (e.target === ov) ov.remove(); });
    } catch(e) { console.error('[showWeekActivityDetail]', e); }
}

let exitProtectionActive = false;
function enableExitProtection() { if (exitProtectionActive) return; exitProtectionActive = true; try { history.pushState({ ftProtected: true, ts: Date.now() }, '', location.href); } catch(e) {} }
function disableExitProtection() { exitProtectionActive = false; }
window.addEventListener('popstate', async () => {
    if (!exitProtectionActive) return;
    if (!runState || runState.phase === 'finish') { disableExitProtection(); return; }
    const exited = await confirmExit();
    if (!exited) { try { history.pushState({ ftProtected: true, ts: Date.now() }, '', location.href); } catch(err) {} }
});
window.addEventListener('beforeunload', (e) => {
    if (!exitProtectionActive) return;
    if (!runState || runState.phase === 'finish') return;
    e.preventDefault(); e.returnValue = 'Тренировка не завершена. Выйти?';
    return e.returnValue;
});

let audioCtx = null;
async function getAudioCtx() {
    try {
        if (!audioCtx || audioCtx.state === 'closed') audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === 'suspended' || audioCtx.state === 'interrupted') { try { await audioCtx.resume(); } catch(e) {} }
    } catch(e) {}
    return audioCtx;
}
async function unlockAudio() {
    try {
        if (audioCtx && audioCtx.state === 'closed') audioCtx = null;
        const ctx = await getAudioCtx();
        if (ctx && (ctx.state === 'suspended' || ctx.state === 'interrupted')) { try { await ctx.resume(); } catch(e) {} }
    } catch(e) {}
}
function applyVoiceToUtterance(u) {
    try {
        u.lang = 'ru-RU'; u.rate = getEffectiveSetting('voiceRate') || 1; u.volume = 1;
        const voiceURI = getEffectiveSetting('voiceURI');
        if (voiceURI) {
            const v = (availableVoices.length ? availableVoices : (speechSynthesis.getVoices() || [])).find(x => x.voiceURI === voiceURI);
            if (v) u.voice = v;
        }
    } catch(e) {}
}
function toggleTimerMute() {
    if (!runState) return;
    runState.isMuted = !runState.isMuted;
    const icon = document.getElementById('timer-mute-icon');
    const btn = document.getElementById('timer-mute-btn');
    if (runState.isMuted) {
        icon.innerText = '🔇'; btn.classList.add('muted');
        stopRestAlarm();
        stopExerciseAlarm();
        if ('speechSynthesis' in window) speechSynthesis.cancel();
        if (navigator.vibrate) navigator.vibrate(0);
    } else {
        icon.innerText = '🔊'; btn.classList.remove('muted');
        if (runState.phase === 'rest' && runState.restFinished && !runState.restBannerMode && getEffectiveSetting('continuousBeep')) startRestAlarm();
        if (runState.phase === 'work' && runState.timerFinished && getEffectiveSetting('continuousBeep')) startExerciseAlarm();
    }
    saveRunState();
}
function speak(text) { if (!isVoiceMode() || !('speechSynthesis' in window) || (runState && runState.isMuted)) return; try { const u = new SpeechSynthesisUtterance(text); applyVoiceToUtterance(u); speechSynthesis.cancel(); speechSynthesis.speak(u); } catch(e) {} }
function speakCritical(text) { if (!isVoiceMode() || !('speechSynthesis' in window) || (runState && runState.isMuted)) return; try { const u = new SpeechSynthesisUtterance(text); applyVoiceToUtterance(u); u.rate = (getEffectiveSetting('voiceRate') || 1) * 1.1; speechSynthesis.speak(u); } catch(e) {} }
function speakAtElementStart(text) { speak(text); }
function cleanButtonText(text) {
    if (!text) return '';
    return String(text).replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{2190}-\u{21FF}\u{2900}-\u{297F}]/gu, '').replace(/[^\p{L}\p{N}\s.,!?+\-]/gu, '').replace(/\s+/g, ' ').trim();
}
function speakButton(text) {
    if (!DB.settings.announceButtons || !isVoiceMode() || !('speechSynthesis' in window) || (runState && runState.isMuted)) return;
    const clean = cleanButtonText(text); if (!clean) return;
    try {
        speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(clean.substring(0, 50));
        applyVoiceToUtterance(u); u.rate = Math.min((DB.settings.voiceRate || 1) * 1.25, 2);
        speechSynthesis.speak(u);
    } catch(e) {}
}
document.addEventListener('click', (e) => {
    if (!DB.settings.announceButtons || !isVoiceMode()) return;
    if (!runState || runState.phase === 'finish') return;
    if (runState.isMuted) return;
    const runScreen = document.getElementById('screen-run');
    if (!runScreen || !runScreen.classList.contains('active')) return;
    try {
        const btn = e.target.closest('button, .menu-btn, .sound-option, .tab');
        if (!btn) return;
        if (!btn.closest('#screen-run')) return;
        if (btn.classList.contains('sheet-btn-cancel')) return;
        if (btn.classList.contains('icon-btn')) { const t = btn.getAttribute('title') || btn.getAttribute('aria-label') || ''; if (t) speakButton(t); return; }
        let txt = (btn.innerText || btn.textContent || '').trim();
        if (!txt) { const t = btn.getAttribute('title') || btn.getAttribute('aria-label') || ''; if (t) txt = t; }
        if (txt) speakButton(txt);
    } catch(err) {}
}, true);

async function playBeep(freq = 800, duration = 0.3) {
    if (!isBeepMode() || (runState && runState.isMuted)) return;
    try {
        const ctx = await getAudioCtx(); if (!ctx || ctx.state !== 'running') return;
        const osc = ctx.createOscillator(); const gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.3, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + duration);
        osc.start(); osc.stop(ctx.currentTime + duration);
    } catch(e) {}
}
async function playEndBeep() {
    if (!isBeepMode() || (runState && runState.isMuted)) return;
    try {
        const ctx = await getAudioCtx(); if (!ctx || ctx.state !== 'running') return;
        const sound = ALARM_SOUNDS[getEffectiveSetting('alarmSound')] || ALARM_SOUNDS.alarm;
        sound.playOnce(ctx);
    } catch(e) {}
}
function announcePause() { if (isBeepMode()) playBeep(400, 0.15); }
function announceResume() { if (isBeepMode()) playBeep(620, 0.15); }
function announceFinalCount(n) { if (runState && runState.isMuted) return; if (isVoiceMode()) speakCritical(String(n)); else playBeep(600, 0.1); }

const ALARM_SOUNDS = {
    classic: { name: 'Классический', desc: 'Один бип', playOnce: (ctx) => {
        const osc = ctx.createOscillator(); const gain = ctx.createGain();
        osc.type = 'sine'; osc.frequency.value = 880;
        gain.gain.setValueAtTime(0.3, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
        osc.connect(gain); gain.connect(ctx.destination); osc.start(); osc.stop(ctx.currentTime + 0.3);
    }, loopPattern: [{ type: 'beep', dur: 300, freq: 880, wave: 'sine' }, { type: 'silence', dur: 700 }] },
    alarm: { name: 'Будильник', desc: 'Бип-бип', playOnce: (ctx) => {
        [0, 0.2].forEach(o => {
            const osc = ctx.createOscillator(); const gain = ctx.createGain();
            osc.type = 'square'; osc.frequency.value = 650;
            gain.gain.setValueAtTime(0.15, ctx.currentTime + o);
            gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + o + 0.18);
            osc.connect(gain); gain.connect(ctx.destination);
            osc.start(ctx.currentTime + o); osc.stop(ctx.currentTime + o + 0.18);
        });
    }, loopPattern: [{ type: 'beep', dur: 180, freq: 650, wave: 'square' }, { type: 'silence', dur: 100 }, { type: 'beep', dur: 180, freq: 650, wave: 'square' }, { type: 'silence', dur: 600 }] },
    soft: { name: 'Мягкий', desc: 'Низкий тон', playOnce: (ctx) => {
        const osc = ctx.createOscillator(); const gain = ctx.createGain();
        osc.type = 'triangle'; osc.frequency.value = 440;
        gain.gain.setValueAtTime(0.25, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);
        osc.connect(gain); gain.connect(ctx.destination); osc.start(); osc.stop(ctx.currentTime + 0.5);
    }, loopPattern: [{ type: 'beep', dur: 400, freq: 440, wave: 'triangle' }, { type: 'silence', dur: 800 }] },
    siren: { name: 'Сирена', desc: 'Плавная', playOnce: (ctx) => {
        const osc = ctx.createOscillator(); const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(500, ctx.currentTime);
        osc.frequency.linearRampToValueAtTime(900, ctx.currentTime + 0.3);
        osc.frequency.linearRampToValueAtTime(500, ctx.currentTime + 0.6);
        gain.gain.setValueAtTime(0.25, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.6);
        osc.connect(gain); gain.connect(ctx.destination); osc.start(); osc.stop(ctx.currentTime + 0.6);
    }, loopPattern: [{ type: 'siren', dur: 600, freqStart: 500, freqEnd: 900 }, { type: 'silence', dur: 600 }] }
};
const MINUTE_BEEP_INTERVALS = [{ v: 60, t: 'Каждую минуту' }, { v: 120, t: 'Каждые 2 мин' }, { v: 300, t: 'Каждые 5 мин' }, { v: 600, t: 'Каждые 10 мин' }];
const COUNTDOWN_INTERVALS = [{ v: 3, t: '3 сек' }, { v: 5, t: '5 сек' }, { v: 15, t: '15 сек' }, { v: 20, t: '20 сек' }];

async function requestNotificationPermission() {
    if (!('Notification' in window)) return false;
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    if (!isStandalone) return false;
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied') return false;
    try { return (await Notification.requestPermission()) === 'granted'; } catch(e) { return false; }
}

const RUN_STATE_KEY = 'ft_run_state';
let saveCounter = 0;
let hiddenAt = 0;
let runStateSaveQuotaRetryDone = false;

function saveRunState() {
    if (!runState || runState.phase === 'finish') return;
    let savedAtTs = Date.now();
    if (document.visibilityState === 'hidden' && hiddenAt > 0) savedAtTs = hiddenAt;
    const snapshot = {
        workoutId: runState.workout.id, workoutName: runState.workout.name,
        index: runState.index, phase: runState.phase,
        currentSet: runState.currentSet || 1,
        restPhase: runState.restPhase || null,
        setResults: JSON.parse(JSON.stringify(runState.setResults || {})),
        setWeights: JSON.parse(JSON.stringify(runState.setWeights || {})),
        exerciseNotes: JSON.parse(JSON.stringify(runState.exerciseNotes || {})),
        workoutNoteDraft: runState.workoutNoteDraft || '',
        currentExerciseWorkTime: runState.currentExerciseWorkTime || 0,
        lastSetElapsed: runState.lastSetElapsed || 0,
        warmupFinished: !!runState.warmupFinished,
        warmupBeepPlayed: !!runState.warmupBeepPlayed,
        warmupMode: runState.warmupMode || 'timer',
        warmupSeconds: runState.warmupSeconds || 0,
        warmupDuration: runState.warmupDuration || 0,
        warmupElapsedBeforePause: getCurrentElapsed('warmup'),
        startTime: runState.startTime instanceof Date ? runState.startTime.getTime() : (runState.startTime || Date.now()),
        totalWorkTime: runState.totalWorkTime,
        exerciseTimes: [...(runState.exerciseTimes || [])],
        lastFinishedWorkElapsed: runState.lastFinishedWorkElapsed,
        workElapsedBeforePause: getCurrentElapsed('work'),
        restElapsedBeforePause: getCurrentElapsed('rest'),
        restDuration: runState.restDuration, restFinished: runState.restFinished,
        restBannerMode: !!runState.restBannerMode,
        timerFinished: !!runState.timerFinished,
        isMuted: runState.isMuted || false,
        isDeload: runState.isDeload || false,
        deloadPercent: runState.deloadPercent || 35,
        removedExercises: runState._removedExercises || [],
        isTemp: !!runState.isTemp,
        // Для быстрых стартов сохраняем полный объект тренировки (её нет в DB.workouts)
        workoutSnapshot: JSON.parse(JSON.stringify(runState.workout)),
        savedAt: savedAtTs
    };
    const serialized = JSON.stringify(snapshot);
    try { localStorage.setItem(RUN_STATE_KEY, serialized); runStateSaveQuotaRetryDone = false; return; } catch(e) {}
    if (!runStateSaveQuotaRetryDone) {
        runStateSaveQuotaRetryDone = true;
        try {
            // Аварийная обрезка истории, чтобы сохранить состояние текущей тренировки
            const steps = [1000, 500, 200, 50];
            for (const limit of steps) {
                const removed = pruneHistory(limit);
                if (removed > 0) {
                    Storage.set('ft_history', DB.history);
                    try { localStorage.setItem(RUN_STATE_KEY, serialized); return; } catch(e2) {}
                }
            }
        } catch(recoveryErr) {}
    }
}
function clearSavedRunState() { try { localStorage.removeItem(RUN_STATE_KEY); runStateSaveQuotaRetryDone = false; } catch(e) {} }
function loadSavedRunState() { try { const r = localStorage.getItem(RUN_STATE_KEY); return r ? JSON.parse(r) : null; } catch(e) { return null; } }

let notifGrabberBound = false;
function cleanupDismissedNotifications() {
    if (!DB.settings.dismissedUntil) return;
    const now = Date.now();
    let changed = false;
    Object.keys(DB.settings.dismissedUntil).forEach(k => {
        const v = DB.settings.dismissedUntil[k];
        if (typeof v !== 'number' || v < now) { delete DB.settings.dismissedUntil[k]; changed = true; }
    });
    if (changed) saveDB('settings');
}
function getActiveNotifications() {
    const list = [];
    const now = Date.now();
    const todayKey = formatDateKey(new Date());
    const dayKey = getTodayKey();
    const dismissed = DB.settings.dismissedUntil || {};
    if (DB.settings.streakGuard && !isQuietHours()) {
        const dates = getTrainingDates();
        const streak = calculateStreak(dates);
        if (streak >= 3 && !dates.has(todayKey)) {
            const hour = new Date().getHours();
            if (hour >= (DB.settings.streakGuardHour || 18)) {
                const key = `streak-guard-${todayKey}`;
                const isDismissed = !!(dismissed[key] && dismissed[key] > now);
                list.push({ type: 'streak', key, title: `Не потеряй стрик! ${streak} ${pluralDays(streak)} подряд`, dismissed: isDismissed, icon: '🔥' });
            }
        }
    }
    if (DB.settings.weeklyDigest && !isQuietHours()) {
        const nowD = new Date();
        // Воскресенье с 20:00 и весь понедельник (если пропустили)
        const day = nowD.getDay();
        const hour = nowD.getHours();
        const showDigest = (day === 0 && hour >= 20) || (day === 1);
        if (showDigest) {
            const weekStart = startOfWeekMonday(day === 1 ? addDays(nowD, -1) : nowD);
            const weekStartKey = formatDateKey(weekStart);
            const key = `digest-${weekStartKey}`;
            const weekEnd = addDays(weekStart, 7);
            const weekRecords = DB.history.filter(r => {
                try { const d = new Date(r.startTime); return d >= weekStart && d < weekEnd; } catch(e) { return false; }
            });
            if (weekRecords.length > 0) {
                const isDismissed = !!(dismissed[key] && dismissed[key] > now);
                list.push({ type: 'digest', key, weekStartKey, title: `Итоги недели: ${weekRecords.length} ${pluralWorkouts(weekRecords.length)}`, dismissed: isDismissed, icon: '📈' });
            }
        }
    }
    const saved = loadSavedRunState();
    if (saved && saved.workoutId && saved.phase && saved.phase !== 'finish') {
        const w = DB.workouts.find(x => x.id === saved.workoutId);
        const hasTemp = !!(saved.isTemp || saved.workoutSnapshot);
        if (w || hasTemp) {
            const isDismissed = !!(dismissed['resume'] && dismissed['resume'] > now);
            const title = saved.workoutName || (w && w.name) || (saved.workoutSnapshot && saved.workoutSnapshot.name) || 'Тренировка';
            list.push({ type: 'resume', key: 'resume', title: title, dismissed: isDismissed, isTemp: hasTemp });
        }
    }
    if (DB.settings.notifyScheduledWorkouts) {
        const todays = [];
        DB.programs.forEach(p => {
            const week = getActiveWeek(p, new Date());
            if (!week) return;
            const isDeloadDay = !!(week.deloadDays && week.deloadDays[dayKey]);
            (week.days[dayKey] || []).forEach(wid => {
                const w = DB.workouts.find(x => x.id === wid);
                if (w) todays.push({ workout: w, program: p, isDeload: isDeloadDay });
            });
        });
        const todayHistory = DB.history.filter(r => formatDateKey(new Date(r.startTime)) === todayKey);
        const completedCounts = {};
        todayHistory.forEach(r => { if (r.workoutId) completedCounts[r.workoutId] = (completedCounts[r.workoutId] || 0) + 1; });
        const tempCounts = { ...completedCounts };
        const pending = [];
        for (const t of todays) {
            const id = t.workout.id;
            if ((tempCounts[id] || 0) > 0) tempCounts[id]--;
            else pending.push(t);
        }
        const pendingCounts = {};
        pending.forEach(t => {
            const id = t.workout.id;
            const occurrence = pendingCounts[id] || 0;
            pendingCounts[id] = occurrence + 1;
            const key = `plan-${todayKey}-${id}-${occurrence}`;
            const isDismissed = !!(dismissed[key] && dismissed[key] > now);
            list.push({ type: 'plan', key, workout: t.workout, program: t.program, dismissed: isDismissed, isDeload: !!t.isDeload });
        });
    }
    return list;
}
function getVisibleNotifications() { return getActiveNotifications().filter(n => !n.dismissed); }
function updateNotifGrabber() {
    const grabber = document.getElementById('notif-grabber');
    if (!grabber) return;
    // Hide only while an overlay is open or on run/editor screens
    if (document.querySelector('.notif-side-overlay') || document.querySelector('.bottom-sheet-overlay') || document.querySelector('.multi-tab-warning')) {
        grabber.style.display = 'none';
        return;
    }
    const active = document.querySelector('.screen.active');
    const activeId = active ? active.id : '';
    if (typeof NO_NAV_SCREENS !== 'undefined' && NO_NAV_SCREENS.includes(activeId)) {
        grabber.style.display = 'none';
        return;
    }
    // Always show grabber on main screens (even if no notifications)
    grabber.style.display = 'flex';
    try { cleanupDismissedNotifications(); } catch(e) {}
    const visible = getVisibleNotifications();
    const badge = grabber.querySelector('.notif-grabber-badge');
    if (badge) {
        if (visible.length > 0) {
            badge.textContent = String(visible.length);
            badge.style.display = 'flex';
        } else {
            badge.style.display = 'none';
        }
    }
}
function initNotifGrabber() {
    if (notifGrabberBound) return;
    const grabberEl = document.getElementById('notif-grabber');
    if (!grabberEl) return;
    notifGrabberBound = true;
    let startX = 0, moved = false, active = false;
    grabberEl.addEventListener('pointerdown', (e) => { startX = e.clientX; moved = false; active = true; try { grabberEl.setPointerCapture(e.pointerId); } catch(err) {} });
    grabberEl.addEventListener('pointermove', (e) => {
        if (!active) return;
        const dx = startX - e.clientX;
        if (dx > 15) moved = true;
        if (dx > 60) { active = false; try { grabberEl.releasePointerCapture(e.pointerId); } catch(err) {} openNotifCenter(); }
    });
    const finish = (e) => { if (!active) return; active = false; try { grabberEl.releasePointerCapture(e.pointerId); } catch(err) {} if (!moved) openNotifCenter(); };
    grabberEl.addEventListener('pointerup', finish);
    grabberEl.addEventListener('pointercancel', () => { active = false; });
}
function openNotifCenter() {
    if (hasOpenOverlay()) return;
    cleanupDismissedNotifications();
    const all = getActiveNotifications();
    // Итоги недели после ✕ полностью скрываются (не показываются как «отключённые»),
    // поэтому для пустого состояния и кнопки «Включить все» учитываем только то,
    // что реально видно / можно снова включить: streak, resume, plan.
    const reenableable = all.filter(n => n.type !== 'digest');
    const visibleAll = all.filter(n => !n.dismissed);
    const hasNoNotifs = visibleAll.length === 0;
    const streaks = all.filter(n => n.type === 'streak');
    const digests = all.filter(n => n.type === 'digest');
    const resumes = all.filter(n => n.type === 'resume');
    const plans = all.filter(n => n.type === 'plan');
    let html = '';
    if (hasNoNotifs) { html = `<div style="text-align:center; color:var(--muted); padding:32px 16px; font-size:0.95rem; line-height:1.5;">Здесь будут напоминания о планах и незавершённых тренировках</div>`; }
    else {
        if (streaks.length > 0) {
            html += `<div class="notif-section-title">🔥 Стрик</div>`;
            streaks.forEach(r => {
                if (r.dismissed) {
                    html += `<div class="notif-item disabled"><div class="notif-status">🔥</div><div class="notif-body"><div class="notif-name">${escapeHtml(r.title)}</div><div class="notif-sub">🔕 Не напоминать</div></div><button class="icon-btn" onclick="enableNotification('${r.key}', this)" aria-label="Включить" style="background:var(--card-3); color:var(--text); width:38px; height:38px; border-radius:10px; font-weight:700;">🔔</button></div>`;
                } else {
                    html += `<div class="notif-item"><div class="notif-status">🔥</div><div class="notif-body"><div class="notif-name">${escapeHtml(r.title)}</div><div class="notif-sub">Вечернее напоминание</div></div><button class="icon-btn" onclick="dismissNotification('${r.key}', this)" aria-label="Скрыть" style="background:var(--card-3); color:var(--danger); width:38px; height:38px; border-radius:10px; font-weight:700; font-size:1rem;">✕</button></div>`;
                }
            });
        }
        // Итоги недели: скрытые (dismissed) НЕ показываем как «отключённые» —
        // крестик просто убирает уведомление до следующего окна показа
        const activeDigests = digests.filter(r => !r.dismissed);
        if (activeDigests.length > 0) {
            html += `<div class="notif-section-title">📈 Итоги</div>`;
            activeDigests.forEach(r => {
                const weekKey = r.weekStartKey || (r.key && r.key.indexOf('digest-') === 0 ? r.key.slice(7) : '');
                html += `<div class="notif-item"><div class="notif-status">📈</div><div class="notif-body"><div class="notif-name" style="cursor:pointer;" onclick="notifOpenDigest('${weekKey}')">${escapeHtml(r.title)}</div><div class="notif-sub">Нажмите, чтобы посмотреть</div></div><button class="icon-btn" onclick="dismissDigestNotification('${r.key}', this)" aria-label="Скрыть" style="background:var(--card-3); color:var(--danger); width:38px; height:38px; border-radius:10px; font-weight:700; font-size:1rem;">✕</button></div>`;
            });
        }
        if (resumes.length > 0) {
            html += `<div class="notif-section-title">⚠️ Незавершённая тренировка</div>`;
            resumes.forEach(r => {
                if (r.dismissed) {
                    html += `<div class="notif-item disabled"><div class="notif-status">⏰</div><div class="notif-body"><div class="notif-name">${escapeHtml(r.title)}</div><div class="notif-sub">🔕 Не напоминать</div></div><button class="icon-btn" onclick="enableNotification('${r.key}', this)" aria-label="Включить" style="background:var(--card-3); color:var(--text); width:38px; height:38px; border-radius:10px; font-weight:700;">🔔</button></div>`;
                } else {
                    html += `<div class="notif-item"><div class="notif-status">⏰</div><div class="notif-body"><div class="notif-name">${escapeHtml(r.title)}</div><div class="notif-sub">Не завершена</div></div><div style="display:flex; gap:6px;"><button class="icon-btn" onclick="notifOpenResume(this)" aria-label="Продолжить" style="background:var(--primary-soft); color:var(--primary); border:1px solid rgba(167,139,250,0.28); width:38px; height:38px; border-radius:12px; font-weight:700;">▶</button><button class="icon-btn" onclick="notifCancelResume(this)" aria-label="Отменить" style="background:rgba(248,113,113,0.12); color:var(--danger); border:1px solid rgba(248,113,113,0.26); width:38px; height:38px; border-radius:12px; font-weight:700;">✕</button></div></div>`;
                }
            });
        }
        if (plans.length > 0) {
            html += `<div class="notif-section-title">📅 Планы на сегодня</div>`;
            plans.forEach((p, idx) => {
                const deloadBadge = p.isDeload ? `<div style="margin-top:4px;"><span style="background:var(--warn); color:#0a0a10; font-size:0.65rem; font-weight:700; padding:2px 6px; border-radius:6px; display:inline-block;">РАЗГРУЗКА</span></div>` : '';
                if (p.dismissed) {
                    html += `<div class="notif-item disabled"><div class="notif-status" style="color:var(--muted); font-weight:700;">${idx + 1}.</div><div class="notif-body"><div class="notif-name">${escapeHtml(p.workout.name)}</div>${deloadBadge}<div class="notif-sub">🔕 Не напоминать</div></div><button class="icon-btn" onclick="enableNotification('${p.key}', this)" aria-label="Включить" style="background:var(--card-3); color:var(--text); width:38px; height:38px;border-radius:10px; font-weight:700;">🔔</button></div>`;
                } else {
                    html += `<div class="notif-item"><div class="notif-status" style="color:var(--primary); font-weight:700;">${idx + 1}.</div><div class="notif-body"><div class="notif-name">${escapeHtml(p.workout.name)}</div>${deloadBadge}<div class="notif-sub" style="margin-top:4px;">📅 ${escapeHtml(p.program.name)}</div></div><button class="icon-btn" onclick="notifStartPlan(${p.workout.id}, this, ${p.isDeload || false})" aria-label="Начать" style="background:var(--accent-soft); color:var(--accent); border:1px solid rgba(52,211,153,0.28); width:38px; height:38px; border-radius:12px; font-weight:700;">▶</button></div>`;
                }
            });
        }
    }
    // «Включить все» только для типов, которые реально показываются как отключённые.
    // Dismissed digest не должен заставлять пользователя «включать уведомления» снова.
    const hasDismissed = reenableable.some(n => n.dismissed);
    const hasVisible = visibleAll.length > 0;
    const hours = DB.settings.snoozeDuration || 2;
    const snoozeLabel = hours === 24 ? 'Позже (до завтра)' : `Позже (${hours} ч)`;
    // Кнопки: если есть активные — «Позже»; если все отложены/выключены — только «Включить все»
    let actionBtns = '';
    if (hasVisible) {
        actionBtns += `<button class="btn ghost" onclick="snoozeAllNotifications(this)">${snoozeLabel}</button>`;
        if (hasDismissed) {
            actionBtns += `<button class="btn ghost" onclick="enableAllNotifications(this)" style="color:var(--accent);">🔔 Включить все</button>`;
        }
    } else if (hasDismissed) {
        actionBtns += `<button class="btn ghost" onclick="enableAllNotifications(this)" style="color:var(--accent);">🔔 Включить все</button>`;
    }
    const ov = document.createElement('div');
    ov.className = 'notif-side-overlay';
    ov.innerHTML = `<div class="notif-side-sheet">
        <div class="notif-side-grabber" id="active-notif-grabber"><div class="notif-side-grabber-bar"></div></div>
        <div style="display: flex; justify-content: space-between; align-items: center; padding-bottom: 8px; flex-shrink: 0;">
            <div style="width: 36px;"></div>
            <h2 style="margin:0; font-size:1.2rem; font-weight:700; text-align:center; flex:1;">Уведомления</h2>
            <button class="icon-btn" style="background:var(--card-2); border:none; color:var(--text); width:36px; height:36px; border-radius:10px; font-size:1.2rem; cursor:pointer;" onclick="this.closest('.notif-side-overlay').remove(); updateNotifGrabber();">✕</button>
        </div>
        <div class="sheet-scroll-area" style="flex:1; overflow-y:auto; display:flex; flex-direction:column; gap:8px; padding-right: 4px;">${html}</div>
        <div class="sheet-fixed-bottom" style="flex-shrink: 0; display: flex; flex-direction: column; gap: 8px; padding-top: 4px;">
            ${actionBtns}
            <button class="btn ghost" onclick="openNotifSettings(this)" style="font-size:0.9rem;">⚙️ Настройки уведомлений</button>
        </div>
    </div>`;
    document.body.appendChild(ov);
    const grabber = document.getElementById('notif-grabber');
    if (grabber) grabber.style.display = 'none';
    setupSideSwipe(ov.querySelector('.notif-side-sheet'), ov);
    ov.addEventListener('click', (e) => { if (e.target === ov) { ov.remove(); updateNotifGrabber(); } });
}
function logNotifHistory(entry) {
    try {
        let hist = readStoredArray('ft_notif_history');
        hist.unshift({ ...entry, ts: Date.now() });
        const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
        hist = hist.filter(h => h.ts >= weekAgo).slice(0, 50);
        localStorage.setItem('ft_notif_history', JSON.stringify(hist));
    } catch(e) {}
}
function dismissNotification(key, btn) {
    DB.settings.dismissedUntil = DB.settings.dismissedUntil || {};
    DB.settings.dismissedUntil[key] = Date.now() + 7 * 24 * 60 * 60 * 1000;
    saveDB('settings');
    logNotifHistory({ type: 'dismiss', key, title: key.startsWith('streak') ? 'Стрик-гард' : key.startsWith('digest') ? 'Итоги недели' : 'Уведомление' });
    const ov = btn.closest('.notif-side-overlay');
    if (ov) { ov.remove(); updateNotifGrabber(); }
    showToast('🔕 Напомним через неделю');
}
function dismissDigestNotification(key, btn) {
    // Только скрыть «Итоги недели» до конца текущего окна показа (до вторника 00:00).
    // НЕ трогает DB.settings.weeklyDigest, notifyScheduledWorkouts и другие флаги.
    // В шторке уведомление не появляется как «отключённое» — просто исчезает до следующего воскресенья 20:00.
    if (!key) return;
    DB.settings.dismissedUntil = DB.settings.dismissedUntil || {};
    const nowD = new Date();
    const day = nowD.getDay(); // 0=вс, 1=пн
    // Окно показа: вс ≥20:00 и весь пн → скрываем до вторника 00:00
    let daysUntilTue = 2;
    if (day === 1) daysUntilTue = 1;
    else if (day === 0) daysUntilTue = 2;
    else {
        // На всякий случай вне окна — до следующего вторника
        daysUntilTue = ((2 - day + 7) % 7) || 7;
    }
    const until = new Date(nowD.getFullYear(), nowD.getMonth(), nowD.getDate() + daysUntilTue, 0, 0, 0, 0);
    DB.settings.dismissedUntil[key] = until.getTime();
    // Намеренно НЕ меняем weeklyDigest / notifyScheduledWorkouts — только скрываем карточку.
    saveDB('settings');
    logNotifHistory({ type: 'dismiss', key, title: 'Итоги недели' });
    const ov = btn && btn.closest ? btn.closest('.notif-side-overlay') : null;
    // Пересчитываем видимые ПОСЛЕ записи dismissed
    const still = getVisibleNotifications().filter(n => n.key !== key);
    if (ov) {
        ov.remove();
        updateNotifGrabber();
        if (still.length > 0) openNotifCenter();
    } else {
        updateNotifGrabber();
    }
    showToast('Итоги недели скрыты до следующей недели');
}
function enableNotification(key, btn) {
    if (!DB.settings.dismissedUntil) DB.settings.dismissedUntil = {};
    delete DB.settings.dismissedUntil[key];
    saveDB('settings');
    const ov = btn.closest('.notif-side-overlay');
    if (ov) { ov.remove(); updateNotifGrabber(); }
    showToast('🔔 Напоминание включено');
    openNotifCenter();
}
function notifOpenDigest(weekStartKey) {
    if (!weekStartKey) { showToast('Нет данных за неделю'); return; }
    // Закрываем центр уведомлений, затем открываем итоги
    document.querySelectorAll('.notif-side-overlay').forEach(ov => { try { ov.remove(); } catch(e) {} });
    updateNotifGrabber();
    try { showWeekActivityDetail(weekStartKey); } catch(e) { console.error(e); showToast('Не удалось открыть итоги'); }
}
function enableAllNotifications(btn) {
    DB.settings.dismissedUntil = {};
    saveDB('settings');
    const ov = btn.closest('.notif-side-overlay');
    if (ov) { ov.remove(); updateNotifGrabber(); }
    showToast('🔔 Все напоминания включены');
    openNotifCenter();
}
function notifStartPlan(workoutId, btn, isDeload) {
    const ov = btn.closest('.notif-side-overlay');
    if (ov) { ov.remove(); updateNotifGrabber(); }
    const w = DB.workouts.find(x => x.id === workoutId);
    if (!w) { showToast('⚠️ Тренировка удалена'); return; }
    startWorkout(workoutId, !!isDeload);
}
function notifOpenResume(btn) {
    const ov = btn.closest('.notif-side-overlay');
    if (ov) { ov.remove(); updateNotifGrabber(); }
    const saved = loadSavedRunState();
    if (!saved) return;
    if (!['ready','work','rest','countdown','warmup'].includes(saved.phase)) { showToast('Некорректное состояние'); clearSavedRunState(); return; }
    const w = DB.workouts.find(x => x.id === saved.workoutId);
    const hasTemp = !!(saved.isTemp || saved.workoutSnapshot);
    if (!w && !hasTemp) { showToast('Тренировка удалена'); clearSavedRunState(); return; }
    restoreRunState(saved);
}
function notifCancelResume(btn) {
    const ov = btn.closest('.notif-side-overlay');
    if (ov) { ov.remove(); updateNotifGrabber(); }
    clearSavedRunState();
    if (runState) { stopTickInterval(); stopRestAlarm(); stopExerciseAlarm(); releaseWakeLock(); runState = null; }
    disableExitProtection();
    showToast('❌ Тренировка отменена');
    // Возврат на главный — отмена из уведомлений не должна кидать в список тренировок
    showScreen('screen-home');
}
function snoozeAllNotifications(btn) {
    const list = getVisibleNotifications();
    DB.settings.dismissedUntil = DB.settings.dismissedUntil || {};
    const hours = DB.settings.snoozeDuration || 2;
    const until = Date.now() + hours * 60 * 60 * 1000;
    list.forEach(n => { DB.settings.dismissedUntil[n.key] = until; });
    DB.settings.lastNotifAutoShow = '';
    saveDB('settings');
    const ov = btn.closest('.notif-side-overlay');
    if (ov) { ov.remove(); updateNotifGrabber(); }
    showToast(hours === 24 ? 'Напомним завтра' : `Напомним через ${hours} ${hours === 1 ? 'час' : 'ч'}`);
}
function openNotifSettings(btn) {
    const ov = btn.closest('.notif-side-overlay');
    if (ov) { ov.remove(); updateNotifGrabber(); }
    showScreen('screen-settings');
    setTimeout(() => {
        const notifyGroup = document.querySelector('#screen-settings details[data-group="notify"]');
        if (notifyGroup) { notifyGroup.open = true; notifyGroup.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    }, 100);
}
function showNotifHistory() {
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const hist = readStoredArray('ft_notif_history').filter(h =>
        h && typeof h === 'object' && Number.isFinite(Number(h.ts)) && Number(h.ts) >= weekAgo
    );
    const ov = document.createElement('div');
    ov.className = 'notif-side-overlay';
    let listHtml = '';
    if (hist.length === 0) {
        listHtml = '<div style="text-align:center; color:var(--muted); padding:32px 16px;">История пуста</div>';
    } else {
        listHtml = hist.map(h => {
            const d = new Date(h.ts);
            const dateStr = d.toLocaleString('ru-RU', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' });
            const icon = h.key && h.key.startsWith('streak') ? '🔥' : (h.key && h.key.startsWith('digest') ? '📈' : '🔔');
            const action = h.type === 'dismiss' ? 'Закрыто' : (h.type === 'show' ? 'Показано' : 'Событие');
            return `<div class="notif-item" style="margin-bottom:6px;"><div class="notif-status">${icon}</div><div class="notif-body"><div class="notif-name">${escapeHtml(h.title || 'Уведомление')}</div><div class="notif-sub">${action} · ${dateStr}</div></div></div>`;
        }).join('');
    }
    ov.innerHTML = `<div class="notif-side-sheet" style="max-height:80vh;"><div class="notif-side-grabber"><div class="notif-side-grabber-bar"></div></div><h2 class="sheet-title">📋 История уведомлений</h2><div style="color:var(--muted); font-size:0.8rem; text-align:center; margin-bottom:8px;">Последние 7 дней</div><div class="sheet-scroll-area" style="flex:1; overflow-y:auto; display:flex; flex-direction:column; gap:4px;">${listHtml}</div><button class="btn danger" onclick="clearNotifHistory()">🗑 Очистить историю</button><button class="btn sheet-btn-cancel" onclick="closeTopSheet()">Закрыть</button></div>`;
    document.body.appendChild(ov);
    setupSideSwipe(ov.querySelector('.notif-side-sheet'), ov);
    ov.addEventListener('click', (e) => { if (e.target === ov) ov.remove(); });
}
async function clearNotifHistory() {
    const ok = await customConfirm('Удалить всю историю уведомлений?', { title: 'Очистить историю', okText: '🗑 Очистить', cancelText: 'Отмена', danger: true });
    if (!ok) return;
    try { localStorage.removeItem('ft_notif_history'); } catch(e) {}
    const overlays = document.querySelectorAll('.notif-side-overlay');
    const ov = overlays.length ? overlays[overlays.length - 1] : null;
    if (ov) ov.remove();
    updateNotifGrabber();
    showToast('🗑 История уведомлений очищена');
    showNotifHistory();
}

async function offerResumeSavedSession() {
    const saved = loadSavedRunState();
    if (!saved || !saved.workoutId || saved.phase === 'finish') { clearSavedRunState(); return; }
    if (!['ready','work','rest','countdown','warmup'].includes(saved.phase)) { clearSavedRunState(); return; }
    const workout = DB.workouts.find(w => w.id === saved.workoutId);
    const hasTemp = !!(saved.isTemp || saved.workoutSnapshot);
    if (!workout && !hasTemp) { clearSavedRunState(); return; }
    const name = saved.workoutName || (workout && workout.name) || (saved.workoutSnapshot && saved.workoutSnapshot.name) || 'Тренировка';
    const ageSec = saved.savedAt ? (Date.now() - saved.savedAt) / 1000 : 0;
    const age = saved.savedAt ? ` (${formatAge(ageSec)})` : '';
    const ok = await customConfirm(`Найдена незавершённая тренировка:\n«${name}»${age}\n\nПродолжить?`, {
        title: 'Продолжить тренировку?', okText: '▶ Продолжить', cancelText: '✕ Отменить', danger: false
    });
    if (ok === true) restoreRunState(saved);
    else if (ok === false) { clearSavedRunState(); showToast('❌ Тренировка отменена'); }
}
function restoreRunState(saved) {
    const source = saved.workoutSnapshot || DB.workouts.find(w => w.id === saved.workoutId);
    let workout = source ? JSON.parse(JSON.stringify(source)) : null;
    if (!workout) { clearSavedRunState(); return; }
    let restoredPhase = saved.phase, restoredWarmupFinished = false, restoredWarmupPaused = false;
    if (saved.phase === 'warmup') {
        if (saved.warmupFinished) { restoredPhase = 'warmup'; restoredWarmupFinished = true; }
        else { restoredPhase = 'warmup'; restoredWarmupFinished = false; restoredWarmupPaused = true; }
    } else if (saved.phase === 'countdown') { restoredPhase = 'ready'; }
    runState = {
        workout, index: saved.index || 0, phase: restoredPhase,
        currentSet: saved.currentSet || 1, restPhase: saved.restPhase || null,
        setResults: saved.setResults || {}, setWeights: saved.setWeights || {}, exerciseNotes: saved.exerciseNotes || {},
        workoutNoteDraft: saved.workoutNoteDraft || '',
        currentExerciseWorkTime: saved.currentExerciseWorkTime || 0,
        lastSetElapsed: saved.lastSetElapsed || 0,
        warmupFinished: restoredWarmupFinished, warmupBeepPlayed: !!saved.warmupBeepPlayed,
        warmupMode: saved.warmupMode || 'timer',
        warmupSeconds: saved.warmupSeconds || 0, warmupDuration: saved.warmupDuration || 0,
        warmupElapsedBeforePause: saved.warmupElapsedBeforePause || 0,
        warmupPaused: restoredWarmupPaused, warmupStartTime: null,
        countdownInterval: null, restOvertimeInterval: null, tickInterval: null,
        workStartTime: null, workDuration: workout.exercises[saved.index || 0]?.type === "timer" ? (workout.exercises[saved.index || 0].timerDuration || 60) : 0, workElapsedBeforePause: saved.workElapsedBeforePause || 0, workPaused: true,
        restStartTime: null, restElapsedBeforePause: saved.restElapsedBeforePause || 0, restPaused: true,
        restDuration: saved.restDuration || 0, restBeepPlayed: true,
        restFinished: !!saved.restFinished, restOvertime: 0,
        restBannerMode: !!saved.restBannerMode,
        timerFinished: !!saved.timerFinished,
        startTime: new Date(saved.startTime || Date.now()),
        totalWorkTime: saved.totalWorkTime || 0,
        lastFinishedWorkElapsed: saved.lastFinishedWorkElapsed || 0,
        exerciseTimes: saved.exerciseTimes ? [...saved.exerciseTimes] : [],
        lastBeepTargetTime: undefined, setFinishing: false, countdownValue: 3,
        workoutNameAnnounced: true, _flowStarting: false,
        isMuted: saved.isMuted || false,
        isDeload: saved.isDeload || false,
        deloadPercent: saved.deloadPercent || 35,
        _removedExercises: saved.removedExercises || [],
        isTemp: !!(saved.isTemp || !DB.workouts.some(w => w.id === saved.workoutId))
    };
    if (runState.countdownInterval) { try { clearInterval(runState.countdownInterval); } catch(e) {} runState.countdownInterval = null; }
    document.getElementById('run-title').innerText = workout.name;
    acquireWakeLock(); enableExitProtection();
    renderRun();
    if (runState.phase === 'rest' && !runState.restBannerMode) {
        const timerEl = document.getElementById('rest-timer');
        if (timerEl) { if (runState.restFinished) timerEl.innerText = formatTimeUpDisplay('rest'); else timerEl.innerText = formatTime(getRemainingTime('rest')); }
    } else if (runState.phase === 'work') {
        const timerEl = document.getElementById('work-timer');
        if (timerEl) timerEl.innerText = formatTime(getCurrentElapsed('work'));
    } else if (runState.phase === 'warmup' && !runState.warmupFinished) {
        const timerEl = document.getElementById('warmup-timer');
        if (timerEl) { if (runState.warmupMode === 'free') timerEl.innerText = formatTime(getCurrentElapsed('warmup')); else timerEl.innerText = formatTime(getRemainingTime('warmup')); }
    }
    runReturnScreen = runState.isTemp ? 'screen-home' : 'screen-workouts';
    showScreen('screen-run');
    ensureTicker();
    showToast('▶ Тренировка на паузе. Нажмите «Продолжить»', 4000);
}

const REST_PRESETS = [
    { v: 10, t: '10 сек' }, { v: 15, t: '15 сек' }, { v: 30, t: '30 сек' }, { v: 45, t: '45 сек' },
    { v: 60, t: '1 мин' }, { v: 90, t: '1 мин 30 сек' }, { v: 120, t: '2 мин' }, { v: 180, t: '3 мин' }, { v: 300, t: '5 мин' }
];

let liveEditor = null;
let editingId = null, editingIsTemplate = false, editorExercises = [];
let editorUsesPersonalSettings = false;
let editingProgramId = null, editorProgram = null;
let previewWorkoutId = null;
let restAlarmTimeout = null, restVoiceTimeout = null;
let exerciseAlarmTimeout = null, exerciseVoiceTimeout = null;
let previewCtx = null;
let collapsedWeeks = {};
let collapsedEditorElements = {};
let allEditorCollapsed = false;
let homeSelectedExerciseIndex = 0;
let programsCalendarMonth = new Date();
let historySelectionMode = false;
let historySelectedIds = new Set();
let historyGroupMode = DB.settings.historyGroupMode || 'week';
let historyGroupCollapsed = DB.settings.historyGroupCollapsed && typeof DB.settings.historyGroupCollapsed === 'object' ? DB.settings.historyGroupCollapsed : {};
let templatesSelectionMode = false;
let templatesSelectedIds = new Set();
let programsSelectionMode = false;
let programsSelectedIds = new Set();
let measurementsSelectionMode = false;
let measurementsSelectedIds = new Set();
let workoutsSelectionMode = false;
let workoutsSelectedIds = new Set();

let wakeLockSentinel = null;
async function acquireWakeLock() {
    if (!DB.settings.wakeLock) return;
    if (!('wakeLock' in navigator)) return;
    try { wakeLockSentinel = await navigator.wakeLock.request('screen'); wakeLockSentinel.addEventListener('release', () => { wakeLockSentinel = null; }); } catch(e) {}
}
function releaseWakeLock() { if (wakeLockSentinel) { try { wakeLockSentinel.release(); } catch(e) {} wakeLockSentinel = null; } }

function playPatternStep(ctx, step) {
    if (step.type === 'silence') return;
    if (runState && runState.isMuted) return;
    if (step.type === 'beep') {
        const osc = ctx.createOscillator(); const gain = ctx.createGain();
        osc.type = step.wave || 'sine'; osc.frequency.value = step.freq;
        const dur = step.dur / 1000;
        gain.gain.setValueAtTime(0.2, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + dur);
        osc.connect(gain); gain.connect(ctx.destination);
        osc.start(); osc.stop(ctx.currentTime + dur);
    } else if (step.type === 'siren') {
        const osc = ctx.createOscillator(); const gain = ctx.createGain();
        osc.type = 'sine';
        const dur = step.dur / 1000;
        osc.frequency.setValueAtTime(step.freqStart, ctx.currentTime);
        osc.frequency.linearRampToValueAtTime(step.freqEnd, ctx.currentTime + dur);
        gain.gain.setValueAtTime(0.2, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + dur);
        osc.connect(gain); gain.connect(ctx.destination);
        osc.start(); osc.stop(ctx.currentTime + dur);
    }
}
async function startRestAlarm() {
    if (runState && runState.isMuted) return;
    stopRestAlarm();
    if (isBeepMode()) {
        try {
            const ctx = await getAudioCtx();
            if (ctx && ctx.state === 'running') {
                const sound = ALARM_SOUNDS[getEffectiveSetting('alarmSound')] || ALARM_SOUNDS.alarm;
                let idx = 0;
                const next = () => { if (runState && runState.isMuted) return; const s = sound.loopPattern[idx % sound.loopPattern.length]; playPatternStep(ctx, s); restAlarmTimeout = setTimeout(next, s.dur); idx++; };
                next();
            }
        } catch(e) {}
    } else {
        try { if ('speechSynthesis' in window) speechSynthesis.cancel(); } catch(e) {}
        speakCritical('отдых закончен');
        let cnt = 0;
        const vn = () => { if (cnt >= 20) return; if (!runState || runState.isMuted || runState.phase !== 'rest' || !runState.restFinished) return; try { if ('speechSynthesis' in window) speechSynthesis.cancel(); } catch(e) {} speakCritical('время вышло'); cnt++; restVoiceTimeout = setTimeout(vn, 5000); };
        restVoiceTimeout = setTimeout(vn, 3500);
    }
    if (navigator.vibrate && !(runState && runState.isMuted)) { const vp = []; for (let i = 0; i < 30; i++) vp.push(150,100,150,600); navigator.vibrate(vp); }
}
function stopRestAlarm() {
    if (restAlarmTimeout) { clearTimeout(restAlarmTimeout); restAlarmTimeout = null; }
    if (restVoiceTimeout) { clearTimeout(restVoiceTimeout); restVoiceTimeout = null; }
    if (navigator.vibrate) navigator.vibrate(0);
}

async function startExerciseAlarm() {
    if (runState && runState.isMuted) return;
    stopExerciseAlarm();
    if (isBeepMode()) {
        try {
            const ctx = await getAudioCtx();
            if (ctx && ctx.state === 'running') {
                const sound = ALARM_SOUNDS[getEffectiveSetting('alarmSound')] || ALARM_SOUNDS.alarm;
                let idx = 0;
                const next = () => { if (runState && runState.isMuted) return; const s = sound.loopPattern[idx % sound.loopPattern.length]; playPatternStep(ctx, s); exerciseAlarmTimeout = setTimeout(next, s.dur); idx++; };
                next();
            }
        } catch(e) {}
    } else {
        try { if ('speechSynthesis' in window) speechSynthesis.cancel(); } catch(e) {}
        speakCritical('упражнение сделано');
        let cnt = 0;
        const vn = () => {
            if (cnt >= 20) return;
            if (!runState || runState.isMuted || runState.phase !== 'work' || !runState.timerFinished) return;
            try { if ('speechSynthesis' in window) speechSynthesis.cancel(); } catch(e) {}
            speakCritical('время вышло');
            cnt++;
            exerciseVoiceTimeout = setTimeout(vn, 5000);
        };
        exerciseVoiceTimeout = setTimeout(vn, 3500);
    }
    if (navigator.vibrate && !(runState && runState.isMuted)) { const vp = []; for (let i = 0; i < 30; i++) vp.push(150,100,150,600); navigator.vibrate(vp); }
}
function stopExerciseAlarm() {
    if (exerciseAlarmTimeout) { clearTimeout(exerciseAlarmTimeout); exerciseAlarmTimeout = null; }
    if (exerciseVoiceTimeout) { clearTimeout(exerciseVoiceTimeout); exerciseVoiceTimeout = null; }
    if (navigator.vibrate) navigator.vibrate(0);
}
function previewAlarmSound(key) {
    try {
        if (previewCtx) { try { previewCtx.close(); } catch(e) {} }
        previewCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (previewCtx.state === 'suspended') previewCtx.resume();
        const sound = ALARM_SOUNDS[key];
        if (DB.settings.continuousBeep) {
            let idx = 0, cyc = 0;
            const next = () => {
                if (cyc >= 2) { try { previewCtx.close(); } catch(e) {} return; }
                const s = sound.loopPattern[idx % sound.loopPattern.length];
                playPatternStep(previewCtx, s);
                setTimeout(() => { idx++; if (idx % sound.loopPattern.length === 0) cyc++; next(); }, s.dur);
            };
            next();
        } else sound.playOnce(previewCtx);
    } catch(e) {}
}

function resetWorkoutFilters() {
    const s = document.getElementById('workout-search'); const o = document.getElementById('workout-sort');
    if (s) s.value = ''; if (o) o.value = 'custom';
}
function resetHistoryFilters() {
    const s = document.getElementById('history-search'); const o = document.getElementById('history-period');
    if (s) s.value = ''; if (o) o.value = 'all';
}
const NO_NAV_SCREENS = ['screen-run', 'screen-editor', 'screen-program-editor', 'screen-preview'];

let settingsReturnScreen = 'screen-home';
function pauseRunForSettings() {
    if (!runState || runState.phase === 'finish' || runState._settingsPaused) return;
    const p = { pausedWork: false, pausedRest: false, pausedWarmup: false, pausedCountdown: false };
    if (runState.phase === 'work' && !runState.workPaused) { pauseTimer('work'); p.pausedWork = true; }
    if (runState.phase === 'rest' && !runState.restPaused) { pauseTimer('rest'); p.pausedRest = true; if (runState.restFinished) stopRestAlarm(); }
    if (runState.phase === 'warmup' && !runState.warmupPaused && !runState.warmupFinished) { pauseTimer('warmup'); p.pausedWarmup = true; }
    if (runState.phase === 'countdown') {
        // Зафиксировать оставшееся по wall-clock перед паузой
        if (runState.countdownEndsAt) {
            runState.countdownValue = Math.max(0, Math.ceil((runState.countdownEndsAt - nowMs()) / 1000));
        }
        clearInterval(runState.countdownInterval);
        runState.countdownInterval = null;
        p.pausedCountdown = true;
    }
    runState._settingsPaused = p;
    runState._menuOpen = true;
    saveRunState();
    renderRun();
}
function resumeRunAfterSettings() {
    if (!runState || !runState._settingsPaused) return;
    const p = runState._settingsPaused;
    runState._settingsPaused = null;
    runState._menuOpen = false;
    if (p.pausedWork && runState.phase === 'work') resumeTimer('work');
    if (p.pausedRest && runState.phase === 'rest') { resumeTimer('rest'); if (runState.restFinished) startRestAlarm(); }
    if (p.pausedWarmup && runState.phase === 'warmup') resumeTimer('warmup');
    if (p.pausedCountdown && runState.phase === 'countdown') {
        // Возобновляем отсчёт от оставшихся секунд (wall-clock)
        const left = Math.max(1, runState.countdownValue || 1);
        runState.countdownEndsAt = nowMs() + left * 1000;
        runState._countdownLastSpoken = left;
        clearInterval(runState.countdownInterval);
        const tickCountdown = () => {
            if (!runState || runState.phase !== 'countdown') { clearInterval(runState.countdownInterval); runState.countdownInterval = null; return; }
            if (runState._menuOpen) return;
            const leftMs = (runState.countdownEndsAt || 0) - nowMs();
            const cur = Math.max(0, Math.ceil(leftMs / 1000));
            if (cur !== runState.countdownValue) {
                runState.countdownValue = cur;
                if (cur > 0 && cur <= 3 && runState._countdownLastSpoken !== cur) {
                    runState._countdownLastSpoken = cur;
                    if (isVoiceMode() && !runState.isMuted) speakCritical(String(cur));
                    else if (!runState.isMuted) playBeep(600, 0.1);
                }
                renderRun();
            }
            if (leftMs <= 0) {
                clearInterval(runState.countdownInterval);
                runState.countdownInterval = null;
                if (isVoiceMode() && !runState.isMuted) setTimeout(() => startExerciseNow(), 500);
                else { if (!runState.isMuted) playBeep(900, 0.3); setTimeout(() => startExerciseNow(), 300); }
            }
        };
        runState.countdownInterval = setInterval(tickCountdown, 100);
    }
    saveRunState();
    renderRun();
}
function closeSettings() {
    const target = settingsReturnScreen || 'screen-home';
    settingsReturnScreen = 'screen-home';
    if (target === 'screen-run' && (!runState || runState.phase === 'finish')) {
        showScreen('screen-home');
        return;
    }
    showScreen(target);
    if (target === 'screen-run') resumeRunAfterSettings();
    if (target === "screen-editor" && !editorUsesPersonalSettings) initWorkoutSettingsFields(null);
}

function showScreen(id) {
    const targetScreen = document.getElementById(id);
    if (!targetScreen) { console.warn('[showScreen] not found:', id); return; }
    const prevActive = document.querySelector('.screen.active');
    const prevId = prevActive ? prevActive.id : null;
    if (prevId === 'screen-workouts' && id !== 'screen-workouts') { resetWorkoutFilters(); exitWorkoutsBulkMode(); }
    if (prevId === 'screen-history' && id !== 'screen-history') { resetHistoryFilters(); exitHistoryBulkMode(); }
    if (prevId === 'screen-templates' && id !== 'screen-templates') exitTemplatesBulkMode();
    if (prevId === 'screen-programs' && id !== 'screen-programs') exitProgramsBulkMode();
    if (prevId === 'screen-measurements' && id !== 'screen-measurements') exitMeasurementsBulkMode();
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    targetScreen.classList.add('active');
    document.querySelector('.app-container').scrollTop = 0;
    applyNavVisibility();
    if (id !== 'screen-settings' && previewCtx) { try { previewCtx.close(); } catch(e) {} previewCtx = null; }
    try { if (id === 'screen-home') { if (typeof ensureNoStuckRunState === 'function') ensureNoStuckRunState(); renderHomeTodayBanner(); renderStreakBanner(); applyHomeMenuVisibility(); if (typeof applyQuickStartCollapsed === 'function') applyQuickStartCollapsed(); updateFooter(); } } catch(e) { console.error('[showScreen home]', e); }
    try { if (id === 'screen-workouts') renderWorkoutsList(); } catch(e) { console.error('[showScreen workouts]', e); }
    try { if (id === 'screen-history') renderHistory(); } catch(e) { console.error('[showScreen history]', e); }
    try { if (id === 'screen-settings') { renderSettings(); const searchEl = document.getElementById('settings-search'); if (searchEl) { searchEl.value = ''; filterSettings(''); } } } catch(e) { console.error('[showScreen settings]', e); }
    try { if (id === 'screen-templates') renderTemplates(); } catch(e) { console.error('[showScreen templates]', e); }
    try { if (id === 'screen-programs') renderPrograms(); } catch(e) { console.error('[showScreen programs]', e); }
    try { if (id === 'screen-activity') renderActivity(); } catch(e) { console.error('[showScreen activity]', e); const c = document.getElementById('activity-content'); if (c) c.innerHTML = '<div class="empty-state"><span class="icon">⚠️</span><div class="title">Ошибка загрузки</div>Обновите страницу или проверьте консоль.</div>'; }
    try { if (id === 'screen-measurements') renderMeasurements(); } catch(e) { console.error('[showScreen measurements]', e); const c = document.getElementById('measurements-content'); if (c) c.innerHTML = '<div class="empty-state"><span class="icon">⚠️</span><div class="title">Ошибка загрузки</div>Обновите страницу.</div>'; }
    updateNotifGrabber();
}

document.addEventListener('touchstart', (e) => {
    document.querySelectorAll('.swipe-container .history-card').forEach(card => {
        if (card.style.transform && !card.contains(e.target)) { card.style.transition = 'transform 0.2s'; card.style.transform = ''; }
    });
}, { passive: true });

// Единый свайп удаления для всех карточек с уже существующим действием удаления.
// Свайп только открывает красную кнопку; удаление выполняется штатным обработчиком карточки.
const GENERIC_SWIPE_WIDTH = 112;
// Свайп удаления намеренно оставлен только в истории замеров.
// История тренировок использует отдельный механизм .swipe-container ниже.
const genericSwipeSelectors = '.measure-item';
let openedGenericSwipe = null;
const initializedGenericSwipe = new WeakSet();

function closeGenericSwipe(except) {
    if (!openedGenericSwipe || openedGenericSwipe === except) return;
    const old = openedGenericSwipe;
    openedGenericSwipe = null;
    const card = old.querySelector('.swipe-action-card');
    if (card) { card.style.transition = 'transform 180ms ease'; card.style.transform = ''; }
    old.classList.remove('swipe-action-open');
}

function initGenericSwipeDelete(item) {
    if (!item || initializedGenericSwipe.has(item) || item.closest('.swipe-container, .swipe-action-container')) return;
    const deleteButton = item.querySelector('.icon-btn.delete, .measure-item-actions button:last-child, .delete-btn');
    if (!deleteButton || deleteButton.disabled) return;
    // Не оборачиваем элементы в режиме массового выбора или элементы, которые сейчас перетаскиваются.
    if (item.classList.contains('dragging') || item.querySelector('.bulk-checkbox.checked')) return;

    const parent = item.parentNode;
    if (!parent) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'swipe-action-container';
    wrapper.setAttribute('data-swipe-delete', 'true');
    const computed = window.getComputedStyle(item);
    wrapper.style.margin = computed.margin;
    // Контейнер и красная кнопка повторяют радиус самой карточки,
    // чтобы при сдвиге не появлялись квадратные красные уголки.
    wrapper.style.borderRadius = computed.borderRadius || '12px';
    parent.insertBefore(wrapper, item);

    const reveal = document.createElement('button');
    reveal.type = 'button';
    reveal.className = 'swipe-action-reveal';
    reveal.setAttribute('aria-label', 'Удалить');
    reveal.innerHTML = '<span aria-hidden="true">🗑</span><span>Удалить</span>';
    reveal.style.borderRadius = 'inherit';
    wrapper.appendChild(reveal);
    wrapper.appendChild(item);
    item.classList.add('swipe-action-card');
    item.style.margin = '0';
    initializedGenericSwipe.add(item);

    let startX = null, startY = null, currentX = 0, tracking = false, axis = null, suppressClick = false;
    const close = () => {
        item.style.transition = 'transform 180ms ease';
        item.style.transform = '';
        wrapper.classList.remove('swipe-action-open', 'swipe-gesture-active');
        if (openedGenericSwipe === wrapper) openedGenericSwipe = null;
        currentX = 0;
    };

    item.addEventListener('touchstart', (e) => {
        if (!e.touches || e.touches.length !== 1) return;
        const target = e.target;
        if (target && target.closest && target.closest('button, input, textarea, select, a, .bulk-checkbox, [contenteditable="true"]')) return;
        closeGenericSwipe(wrapper);
        if (openedGenericSwipe && openedGenericSwipe !== wrapper) closeGenericSwipe();
        const touch = e.touches[0];
        startX = touch.clientX; startY = touch.clientY;
        tracking = true; axis = null;
        currentX = wrapper.classList.contains('swipe-action-open') ? -GENERIC_SWIPE_WIDTH : 0;
    }, { passive: true });

    item.addEventListener('touchmove', (e) => {
        if (!tracking || startX === null || !e.touches || e.touches.length !== 1) return;
        const touch = e.touches[0];
        const dx = touch.clientX - startX, dy = touch.clientY - startY;
        if (!axis) {
            if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
            axis = Math.abs(dx) > Math.abs(dy) * 1.2 ? 'x' : 'y';
            if (axis === 'y') { tracking = false; startX = null; startY = null; return; }
            item.style.transition = 'none';
            wrapper.classList.add('swipe-gesture-active');
        }
        if (axis !== 'x') return;
        e.preventDefault();
        const base = wrapper.classList.contains('swipe-action-open') ? -GENERIC_SWIPE_WIDTH : 0;
        currentX = Math.max(-GENERIC_SWIPE_WIDTH - 18, Math.min(0, base + dx));
        item.style.transform = `translate3d(${currentX}px,0,0)`;
    }, { passive: false });

    const finish = () => {
        if (!tracking || startX === null) return;
        tracking = false;
        const wasHorizontal = axis === 'x';
        startX = null; startY = null;
        if (!wasHorizontal) { axis = null; return; }
        item.style.transition = 'transform 180ms cubic-bezier(.2,.75,.25,1)';
        if (currentX <= -GENERIC_SWIPE_WIDTH * 0.38) {
            item.style.transform = `translate3d(-${GENERIC_SWIPE_WIDTH}px,0,0)`;
            wrapper.classList.add('swipe-action-open');
            openedGenericSwipe = wrapper;
            suppressClick = true;
            // Не даём свайпу активировать карточку (например, открыть редактор программы).
            setTimeout(() => { suppressClick = false; }, 450);
        } else {
            close();
        }
        wrapper.classList.remove('swipe-gesture-active');
        axis = null;
    };
    item.addEventListener('click', (e) => {
        if (!suppressClick) return;
        e.preventDefault(); e.stopPropagation();
        if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
    }, true);
    item.addEventListener('touchend', finish, { passive: true });
    item.addEventListener('touchcancel', () => { if (tracking && axis === 'x') close(); tracking = false; startX = null; startY = null; axis = null; wrapper.classList.remove('swipe-gesture-active'); }, { passive: true });

    reveal.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        close();
        // Повторно ищем штатную кнопку: список мог быть обновлён между свайпом и нажатием.
        const action = item.querySelector('.icon-btn.delete, .measure-item-actions button:last-child, .delete-btn');
        if (action && !action.disabled) action.click();
    });
}

function scanGenericSwipeDeletes(root = document) {
    if (!root || !root.querySelectorAll) return;
    if (root.matches && root.matches(genericSwipeSelectors)) initGenericSwipeDelete(root);
    root.querySelectorAll(genericSwipeSelectors).forEach(initGenericSwipeDelete);
}

// MutationObserver покрывает и повторно отрисованные списки, не вмешиваясь в их бизнес-логику.
const genericSwipeObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
        mutation.addedNodes.forEach((node) => { if (node.nodeType === 1) scanGenericSwipeDeletes(node); });
    }
});
if (document.body) {
    scanGenericSwipeDeletes();
    genericSwipeObserver.observe(document.body, { childList: true, subtree: true });
} else {
    document.addEventListener('DOMContentLoaded', () => {
        scanGenericSwipeDeletes();
        genericSwipeObserver.observe(document.body, { childList: true, subtree: true });
    }, { once: true });
}

document.addEventListener('touchstart', (e) => {
    const target = e.target;
    const wrapper = target && target.closest ? target.closest('.swipe-action-container') : null;
    if (!wrapper) closeGenericSwipe();
    document.querySelectorAll('.swipe-container .history-card').forEach(card => {
        if (card.style.transform && !card.contains(target)) { card.style.transition = 'transform 0.18s ease'; card.style.transform = ''; const wrap = card.closest('.swipe-container'); if (wrap) wrap.classList.remove('swipe-open', 'swipe-gesture-active'); }
    });
}, { passive: true });

function initSwipeDelete(container, onDelete) {
    const card = container.querySelector('.history-card');
    if (!card || card.dataset.swipeInitialized === 'true') return;
    const btn = container.querySelector('.swipe-delete-btn');
    if (!btn) return;
    card.dataset.swipeInitialized = 'true';
    const width = 112;
    let startX = null, startY = null, axis = null, baseOffset = 0, currentOffset = 0;
    const setOffset = (value) => { card.style.transform = value ? `translate3d(${value}px,0,0)` : ''; };
    card.addEventListener('touchstart', (e) => {
        if (!e.touches || e.touches.length !== 1) return;
        const target = e.target;
        if (target && target.closest && target.closest('button, a, input, textarea, select')) return;
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        axis = null;
        const isOpen = container.classList.contains('swipe-open');
        baseOffset = isOpen ? -width : 0;
        currentOffset = baseOffset;
        // Не трогаем transform/transition, пока не подтверждён горизонтальный жест.
    }, { passive: true });
    card.addEventListener('touchmove', (e) => {
        if (startX === null || !e.touches || e.touches.length !== 1) return;
        const dx = e.touches[0].clientX - startX;
        const dy = e.touches[0].clientY - startY;
        if (!axis) {
            if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
            axis = Math.abs(dx) > Math.abs(dy) * 1.2 ? 'x' : 'y';
            if (axis === 'y') { startX = null; startY = null; return; }
            card.style.transition = 'none';
            container.classList.add('swipe-gesture-active');
        }
        if (axis !== 'x') return;
        e.preventDefault();
        currentOffset = Math.max(-width, Math.min(0, baseOffset + dx));
        setOffset(currentOffset);
    }, { passive: false });
    const finish = (cancelled = false) => {
        if (startX === null) return;
        const wasHorizontal = axis === 'x';
        startX = null; startY = null;
        if (!wasHorizontal) { axis = null; return; }
        card.style.transition = 'transform 0.2s cubic-bezier(.2,.75,.25,1)';
        const open = !cancelled && currentOffset <= -width * 0.42;
        if (open) {
            currentOffset = -width;
            setOffset(-width);
            container.classList.add('swipe-open');
        } else {
            currentOffset = 0;
            setOffset(0);
            container.classList.remove('swipe-open');
        }
        container.classList.remove('swipe-gesture-active');
        axis = null;
    };
    card.addEventListener('touchend', () => finish(false), { passive: true });
    card.addEventListener('touchcancel', () => finish(true), { passive: true });
    if (btn) btn.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        card.style.transition = 'transform 0.18s ease';
        setOffset(0);
        container.classList.remove('swipe-open', 'swipe-gesture-active');
        onDelete();
    });
}

let draggedItem = null, dragPlaceholder = null, dragOffsetY = 0, longPressTimer = null;
let dragContext = null;
function initDragAndDrop(item, opts) {
    opts = opts || {};
    const containerSelector = opts.containerSelector || '#workouts-list';
    const itemSelector = opts.itemSelector || '.workout-item';
    const dbKey = opts.dbKey || 'workouts';
    item._dragOpts = { containerSelector, itemSelector, dbKey };
    item.setAttribute('draggable', 'true');
    item.addEventListener('dragstart', (e) => { draggedItem = item; dragContext = item._dragOpts; item.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
    item.addEventListener('dragend', () => { cleanupDrag(); });
    item.addEventListener('dragover', (e) => { e.preventDefault(); const c = document.querySelector(dragContext ? dragContext.containerSelector : containerSelector); if (c) updatePlaceholderPosition(getDragAfterElement(c, e.clientY)); });
    item.addEventListener('drop', (e) => { e.preventDefault(); finalizeDrop(); });
    item.addEventListener('touchstart', (e) => {
        if (e.target.closest('.icon-btn') || e.target.closest('.btn') || e.target.closest('button') || e.target.closest('input') || e.target.closest('select') || e.target.closest('textarea')) return;
        const t = e.touches[0];
        longPressTimer = setTimeout(() => { dragContext = item._dragOpts; startDragging(item, t.clientY); }, 350);
    }, { passive: true });
}
document.addEventListener('touchmove', handleGlobalTouchMove, { passive: false });
document.addEventListener('touchend', handleGlobalTouchEnd);
document.addEventListener('touchcancel', handleGlobalTouchEnd);
document.addEventListener('click', function(e) {
    if (!window.__programDragJustEnded) return;
    if (e.target.closest && e.target.closest('.program-draggable-card')) {
        e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    }
}, true);
function startDragging(item, cy) {
    if (!item._dragOpts) return;
    draggedItem = item; dragContext = item._dragOpts;
    dragPlaceholder = document.createElement('div'); dragPlaceholder.className = 'drag-placeholder';
    item.classList.add('dragging');
    dragPlaceholder.style.height = item.offsetHeight + 'px';
    item.parentNode.insertBefore(dragPlaceholder, item);
    const r = item.getBoundingClientRect();
    dragOffsetY = cy - r.top;
    item.style.top = (cy - dragOffsetY) + 'px';
    item.style.left = r.left + 'px';
    item.style.width = r.width + 'px';
    document.body.classList.add('no-scroll');
}
function handleGlobalTouchMove(e) {
    if (!draggedItem) { clearTimeout(longPressTimer); return; }
    e.preventDefault();
    const t = e.touches[0];
    const ny = t.clientY - dragOffsetY;
    draggedItem.style.top = ny + 'px';
    draggedItem.style.transform = 'none';
    const eb = document.elementFromPoint(t.clientX, t.clientY); if (!eb) return;
    const sel = (dragContext && dragContext.itemSelector) || '.workout-item';
    const contSel = (dragContext && dragContext.containerSelector) || '#workouts-list';
    const ti = eb.closest(sel);
    document.querySelectorAll('.drag-placeholder').forEach(p => p.classList.remove('active-drop'));
    if (ti && ti !== draggedItem) {
        const l = document.querySelector(contSel);
        if (!l || !l.contains(ti)) return;
        const b = ti.getBoundingClientRect();
        const o = t.clientY - b.top - (b.height / 2);
        if (o > 0) { if (ti.nextSibling && ti.nextSibling !== dragPlaceholder) l.insertBefore(dragPlaceholder, ti.nextSibling); else if (ti.nextSibling !== dragPlaceholder) l.appendChild(dragPlaceholder); }
        else if (ti !== dragPlaceholder) l.insertBefore(dragPlaceholder, ti);
        dragPlaceholder.classList.add('active-drop');
    }
}
function handleGlobalTouchEnd() { clearTimeout(longPressTimer); if (draggedItem) finalizeDrop(); }
function updatePlaceholderPosition(a) {
    if (!draggedItem) return;
    const l = document.querySelector(dragContext ? dragContext.containerSelector : '#workouts-list');
    if (!l) return;
    if (!dragPlaceholder) { dragPlaceholder = document.createElement('div'); dragPlaceholder.className = 'drag-placeholder'; dragPlaceholder.style.height = draggedItem.offsetHeight + 'px'; }
    if (a == null) l.appendChild(dragPlaceholder); else l.insertBefore(dragPlaceholder, a);
}
function finalizeDrop() {
    if (!draggedItem || !dragPlaceholder) return;
    const wasEditor = dragContext && dragContext.dbKey === 'editorExercises';
    if (dragPlaceholder.parentNode) dragPlaceholder.parentNode.insertBefore(draggedItem, dragPlaceholder);
    const wasProgram = dragContext && dragContext.dbKey === 'programs';
    saveNewOrder();
    if (wasProgram) {
        window.__programDragJustEnded = true;
        setTimeout(() => { window.__programDragJustEnded = false; }, 350);
    }
    cleanupDrag();
    if (wasEditor) {
        _editorDragJustEnded = true;
        setTimeout(() => { _editorDragJustEnded = false; }, 250);
    }
}
function cleanupDrag() {
    if (draggedItem) {
        draggedItem.classList.remove('dragging');
        draggedItem.style.top = '';
        draggedItem.style.left = '';
        draggedItem.style.width = '';
        draggedItem.style.transform = '';
        draggedItem = null;
    }
    if (dragPlaceholder) { dragPlaceholder.remove(); dragPlaceholder = null; }
    dragContext = null;
    document.body.classList.remove('no-scroll');
    document.querySelectorAll('.drag-placeholder').forEach(p => p.classList.remove('active-drop'));
}
function getDragAfterElement(c, y) {
    if (!c) return null;
    const sel = (dragContext && dragContext.itemSelector) || '.workout-item';
    const els = [...c.querySelectorAll(`${sel}:not(.dragging)`)];
    if (els.length === 0) return null;
    const result = els.reduce((cl, ch) => { const b = ch.getBoundingClientRect(); const o = y - b.top - b.height / 2; return (o < 0 && o > cl.offset) ? { offset: o, element: ch } : cl; }, { offset: Number.NEGATIVE_INFINITY });
    return result.element || null;
}
function saveNewOrder() {
    if (!dragContext) return;
    const container = document.querySelector(dragContext.containerSelector);
    if (!container) return;
    const sel = dragContext.itemSelector, dbKey = dragContext.dbKey;

    if (dbKey === 'activityOrder') {
        const els = Array.from(container.querySelectorAll(sel));
        const keys = els.map(el => el.dataset.cardKey).filter(Boolean);
        if (keys.length === 0) return;
        DB.settings.accordions = DB.settings.accordions || {};
        DB.settings.accordions.activityOrder = keys;
        Storage.set('ft_settings', DB.settings);
        try { renderActivity(); } catch(e) { console.warn('[saveNewOrder activity]', e); }
        return;
    }
    if (dbKey === 'measurementsOrder') {
        const els = Array.from(container.querySelectorAll(sel));
        const keys = els.map(el => el.dataset.measureSection).filter(Boolean);
        if (keys.length === 0) return;
        DB.settings.accordions = DB.settings.accordions || {};
        DB.settings.accordions.measurementsOrder = keys;
        try { saveDB('settings'); } catch(e) { Storage.set('ft_settings', DB.settings); }
        try { renderMeasurements(); } catch(e) { console.warn('[saveNewOrder measurements]', e); }
        return;
    }

    if (dbKey === 'editorExercises') {
        const els = Array.from(container.querySelectorAll(sel));
        const oldIdxs = els.map(el => parseInt(el.dataset.editorIndex)).filter(n => !isNaN(n));
        if (oldIdxs.length === 0 || oldIdxs.length !== editorExercises.length) return;
        const prevCollapsed = { ...collapsedEditorElements };
        const reordered = oldIdxs.map(i => editorExercises[i]).filter(Boolean);
        if (reordered.length !== editorExercises.length) return;
        if (liveEditor && reordered.slice(0, liveEditor.session.index + 1).some((el, i) => el !== editorExercises[i])) { renderEditorExercises(); showToast("Нельзя перемещать текущие и выполненные элементы"); return; }
        editorExercises = reordered;
        const nextCollapsed = {};
        oldIdxs.forEach((oldI, newI) => {
            if (prevCollapsed[oldI]) nextCollapsed[newI] = true;
        });
        collapsedEditorElements = nextCollapsed;
        allEditorCollapsed = editorExercises.length > 0 && editorExercises.every((_, i) => !!collapsedEditorElements[i]);
        try { updateCollapseAllBtn(); } catch(e) {}
        renderEditorExercises();
        return;
    }
    if (dbKey === 'runQueueOrder') {
        try { if (typeof window._runQueueOnReorder === 'function') window._runQueueOnReorder(); } catch(e) {}
        return;
    }

    const els = Array.from(container.querySelectorAll(sel));
    const ids = els.map(el => parseInt(el.dataset.id)).filter(n => !isNaN(n));
    const db = DB[dbKey]; if (!Array.isArray(db)) return;
    const ro = []; ids.forEach(id => { const w = db.find(x => x.id === id); if (w) ro.push(w); });
    db.forEach(w => { if (!ro.includes(w)) ro.push(w); });
    DB[dbKey] = ro; saveDB(dbKey);
}

function toggleHomeStreak() {
    DB.settings.homeStreakCollapsed = !DB.settings.homeStreakCollapsed;
    saveDB('settings');
    renderStreakBanner();
}
function toggleHomePlan() {
    DB.settings.homePlanCollapsed = !DB.settings.homePlanCollapsed;
    saveDB('settings');
    renderHomeTodayBanner();
}

function renderHomeTodayBanner() {
    const banner = document.getElementById('home-today-banner');
    if (!banner) return;
    try {
        const todayKey = getTodayKey(), todayDate = new Date(), todayDateKey = formatDateKey(todayDate);
        const todays = [];
        DB.programs.forEach(p => {
            const week = getActiveWeek(p, todayDate);
            if (!week) return;
            const isDeloadDay = !!(week.deloadDays && week.deloadDays[todayKey]);
            (week.days[todayKey] || []).forEach(wid => { const w = DB.workouts.find(x => x.id === wid); if (w) todays.push({ workout: w, program: p, isDeload: isDeloadDay }); });
        });
        if (todays.length === 0) { banner.style.display = 'none'; return; }
        const todayHistory = DB.history.filter(r => formatDateKey(new Date(r.startTime)) === todayDateKey);
        const completedCounts = {};
        todayHistory.forEach(r => { if (r.workoutId) completedCounts[r.workoutId] = (completedCounts[r.workoutId] || 0) + 1; });
        const tempCounts = { ...completedCounts };
        const pending = [];
        for (const t of todays) { const id = t.workout.id; if ((tempCounts[id] || 0) > 0) tempCounts[id]--; else pending.push(t); }
        if (pending.length === 0) {
            const isCollapsed = !!DB.settings.homePlanCollapsed;
            const icon = isCollapsed
                ? '<svg viewBox="0 0 24 24" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" style="stroke:var(--muted);"><polyline points="6 9 12 15 18 9"/></svg>'
                : '<svg viewBox="0 0 24 24" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" style="stroke:var(--muted);"><polyline points="18 15 12 9 6 15"/></svg>';
            banner.style.display = 'block';
            banner.innerHTML = `<div class="card" style="border:1px solid var(--accent); padding: 12px 16px; margin-bottom: 10px;">
                <div style="display:flex; justify-content:space-between; align-items:center; cursor:pointer;" onclick="toggleHomePlan()">
                    <div>
                        <div style="color:var(--accent); font-size:0.85rem; margin-bottom:4px; text-transform:uppercase; letter-spacing:1px; font-weight:600;">🎉 Всё по плану!</div>
                        <div style="color:var(--muted); font-size:0.85rem;">${todays.length} ${pluralWorkouts(todays.length)} выполнено</div>
                    </div>
                    <button class="icon-toggle-btn" style="width:32px; height:32px; border:none; background:transparent;">${icon}</button>
                </div>
            </div>`;
            return;
        }
        if (homeSelectedExerciseIndex >= pending.length) homeSelectedExerciseIndex = 0;
        if (homeSelectedExerciseIndex < 0) homeSelectedExerciseIndex = pending.length - 1;
        const current = pending[homeSelectedExerciseIndex];
        const currentWorkout = current.workout;
        const showArrows = pending.length > 1;
        const deloadBadge = current.isDeload ? `<div style="color:var(--warn); font-size:0.78rem; font-weight:700; text-align:center; margin-bottom:8px;">🏷 РАЗГРУЗОЧНЫЙ ДЕНЬ</div>` : '';
        const isCollapsed = !!DB.settings.homePlanCollapsed;
        const icon = isCollapsed
            ? '<svg viewBox="0 0 24 24" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" style="stroke:var(--text);"><polyline points="6 9 12 15 18 9"/></svg>'
            : '<svg viewBox="0 0 24 24" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" style="stroke:var(--text);"><polyline points="18 15 12 9 6 15"/></svg>';
        
        banner.style.display = 'block';
        banner.innerHTML = `<div class="home-hero" style="margin-top:0;">
            <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:8px;">
                <div class="subtitle" style="margin-bottom:0;">📅 ${DAY_NAMES_FULL[todayKey]} · Тренировка ${homeSelectedExerciseIndex + 1} из ${pending.length}</div>
                <button class="icon-toggle-btn" onclick="toggleHomePlan()" style="border:none; background:transparent; padding:0; width:auto; height:auto;">${icon}</button>
            </div>
            <div style="display: ${isCollapsed ? 'none' : 'block'};">
                ${deloadBadge}
                <div class="home-title-row" style="margin-top:10px;">
                    ${showArrows ? `<button class="home-nav-arrow" onclick="cycleHomeExercise(-1)" aria-label="Предыдущее упражнение">‹</button>` : `<div class="home-nav-spacer"></div>`}
                    <div class="title">${escapeHtml(currentWorkout.name)}</div>
                    ${showArrows ? `<button class="home-nav-arrow" onclick="cycleHomeExercise(1)" aria-label="Следующее упражнение">›</button>` : `<div class="home-nav-spacer"></div>`}
                </div>
                <button class="btn accent" onclick="startWorkout(${currentWorkout.id}, ${!!current.isDeload})" style="margin:0;">▶ Начать</button>
            </div>
        </div>`;
    } catch(e) { banner.style.display = 'none'; }
}
function cycleHomeExercise(dir) {
    try {
        const todayKey = getTodayKey(), todayDate = new Date(), todayDateKey = formatDateKey(todayDate);
        const todays = [];
        DB.programs.forEach(p => {
            const week = getActiveWeek(p, todayDate);
            if (!week) return;
            const isDeloadDay = !!(week.deloadDays && week.deloadDays[todayKey]);
            (week.days[todayKey] || []).forEach(wid => { const w = DB.workouts.find(x => x.id === wid); if (w) todays.push({ workout: w, program: p, isDeload: isDeloadDay }); });
        });
        const todayHistory = DB.history.filter(r => formatDateKey(new Date(r.startTime)) === todayDateKey);
        const completedCounts = {};
        todayHistory.forEach(r => { if (r.workoutId) completedCounts[r.workoutId] = (completedCounts[r.workoutId] || 0) + 1; });
        const tempCounts = { ...completedCounts };
        const pending = [];
        for (const t of todays) { const id = t.workout.id; if ((tempCounts[id] || 0) > 0) tempCounts[id]--; else pending.push(t); }
        if (pending.length <= 1) return;
        homeSelectedExerciseIndex = (homeSelectedExerciseIndex + dir + pending.length) % pending.length;
        renderHomeTodayBanner();
    } catch(e) {}
}
function getTrainingDates() { const s = new Set(); DB.history.forEach(r => { try { s.add(formatDateKey(new Date(r.startTime))); } catch(e) {} }); return s; }
function calculateStreak(dates) {
    if (dates.size === 0) return 0;
    const today = new Date(); today.setHours(0,0,0,0);
    const todayKey = formatDateKey(today), yKey = formatDateKey(addDays(today, -1));
    let start = null;
    if (dates.has(todayKey)) start = today;
    else if (dates.has(yKey)) start = addDays(today, -1);
    else return 0;
    let s = 0, cur = start;
    while (dates.has(formatDateKey(cur))) { s++; cur = addDays(cur, -1); }
    return s;
}
function calculateRecordStreak(dates) {
    if (dates.size === 0) return 0;
    const sorted = Array.from(dates).sort();
    let max = 0, cur = 0, prev = null;
    for (const k of sorted) {
        const dt = parseDateKey(k);
        if (prev && (dt - prev) / 86400000 === 1) cur++; else cur = 1;
        if (cur > max) max = cur;
        prev = dt;
    }
    return max;
}
function getDayWorkMinutes(dateKey) { return DB.history.filter(r => formatDateKey(new Date(r.startTime)) === dateKey).reduce((s, r) => s + (r.workTime || 0), 0) / 60; }
function dayLevel(dateKey) { const m = getDayWorkMinutes(dateKey); if (m <= 0) return 0; if (m < 10) return 1; if (m < 30) return 2; return 3; }
function buildLast30DaysGrid() {
    let html = '';
    const today = new Date(); today.setHours(0,0,0,0);
    for (let i = 29; i >= 0; i--) {
        const d = addDays(today, -i); const k = formatDateKey(d);
        const lv = dayLevel(k);
        const cls = `streak-cell${lv ? ' lv' + lv : ''}${k === formatDateKey(today) ? ' today' : ''}`;
        html += `<div class="${cls}"></div>`;
    }
    return html;
}

function renderStreakBanner() {
    const el = document.getElementById('streak-banner-home');
    if (!el) return;
    if (!DB.settings.showActivityCalendar) { el.innerHTML = ''; return; }
    try {
        const dates = getTrainingDates();
        if (dates.size === 0) { el.innerHTML = ''; return; }
        const s = calculateStreak(dates), r = calculateRecordStreak(dates);
        const isCollapsed = !!DB.settings.homeStreakCollapsed;
        const icon = isCollapsed
            ? '<svg viewBox="0 0 24 24" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" style="stroke:var(--text);"><polyline points="6 9 12 15 18 9"/></svg>'
            : '<svg viewBox="0 0 24 24" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" style="stroke:var(--text);"><polyline points="18 15 12 9 6 15"/></svg>';
        
        el.innerHTML = `<div class="streak-banner" onclick="showScreen('screen-activity')">
            <div class="streak-banner-top" style="margin-bottom:0;">
                <div class="streak-banner-title"><span class="fire">🔥</span> ${s} ${pluralDays(s)} подряд</div>
                <div style="display:flex; align-items:center; gap:8px;">
                    <div class="streak-banner-record">Рекорд: ${r}</div>
                    <button class="icon-toggle-btn" onclick="event.stopPropagation(); toggleHomeStreak();" style="border:none; background:transparent; padding:0; width:auto; height:auto;" aria-label="${isCollapsed ? 'Развернуть' : 'Свернуть'}">${icon}</button>
                </div>
            </div>
            <div class="streak-banner-grid" style="display: ${isCollapsed ? 'none' : 'grid'};">${buildLast30DaysGrid()}</div>
        </div>`;
    } catch(e) { el.innerHTML = ''; }
}
function buildHeatmap30() {
    try {
        let html = '';
        const today = new Date(); today.setHours(0,0,0,0);
        const todayKey = formatDateKey(today);
        for (let i = 29; i >= 0; i--) {
            const d = addDays(today, -i); const k = formatDateKey(d);
            const lv = dayLevel(k);
            const isToday = k === todayKey;
            const cls = `heatmap-cell${lv ? ' lv' + lv : ''}${isToday ? ' today' : ''}`;
            html += `<div class="${cls}" onclick="showDayActivityDetail('${k}')" role="button" aria-label="${k}"></div>`;
        }
        return html;
    } catch(e) { console.error('[buildHeatmap30]', e); return ''; }
}
function buildWeekGraph() {
    try {
        let html = '';
        const today = new Date(); today.setHours(0,0,0,0);
        const monday = startOfWeekMonday(today);
        const todayKey = formatDateKey(today);
        const days = [];
        for (let i = 0; i < 7; i++) { const d = addDays(monday, i); const k = formatDateKey(d); const m = getDayWorkMinutes(k); days.push({ d, k, m: isFinite(m) ? m : 0 }); }
        const maxM = Math.max(1, ...days.map(x => x.m).filter(x => isFinite(x)));
        days.forEach(({ d, k, m }, i) => {
            const pct = Math.min(100, Math.round((m / maxM) * 100));
            const isToday = k === todayKey;
            html += `<div class="week-graph-day ${isToday ? 'today' : ''}" onclick="showDayActivityDetail('${k}')" role="button" aria-label="${k}" tabindex="0" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();showDayActivityDetail('${k}');}">
                <div class="week-graph-bar"><div class="week-graph-fill${m <= 0 ? ' empty' : ''}" style="height: ${m > 0 ? Math.max(10, pct) : 0}%;"></div></div>
                <div class="week-graph-label">${DAY_NAMES_SHORT[['mon','tue','wed','thu','fri','sat','sun'][i]]}</div>
            </div>`;
        });
        return html;
    } catch(e) { console.error('[buildWeekGraph]', e); return ''; }
}
function buildTimeOfDayHeatmap() {
    try {
        const buckets = {morning: 0, afternoon: 0, evening: 0, night: 0};
        DB.history.forEach(r => {
            try {
                const h = new Date(r.startTime).getHours();
                if (isNaN(h)) return;
                if (h >= 6 && h < 12) buckets.morning++;
                else if (h >= 12 && h < 18) buckets.afternoon++;
                else if (h >= 18 && h < 24) buckets.evening++;
                else buckets.night++;
            } catch(e) {}
        });
        return `<div class="time-map-grid">
            <div class="time-map-block"><div class="tm-icon">🌅</div><div class="tm-count">${buckets.morning}</div><div class="tm-label">Утро</div></div>
            <div class="time-map-block"><div class="tm-icon">☀️</div><div class="tm-count">${buckets.afternoon}</div><div class="tm-label">День</div></div>
            <div class="time-map-block"><div class="tm-icon">🌆</div><div class="tm-count">${buckets.evening}</div><div class="tm-label">Вечер</div></div>
            <div class="time-map-block"><div class="tm-icon">🌙</div><div class="tm-count">${buckets.night}</div><div class="tm-label">Ночь</div></div>
        </div>`;
    } catch(e) { console.error('[buildTimeOfDayHeatmap]', e); return ''; }
}
function getBestHours() {
    try {
        const hourBuckets = new Array(24).fill(0);
        DB.history.forEach(r => { try { const h = new Date(r.startTime).getHours(); if (isNaN(h)) return; hourBuckets[h] += r.workTime || 0; } catch(e) {} });
        let maxH = -1, maxV = 0;
        hourBuckets.forEach((v, h) => { if (v > maxV) { maxV = v; maxH = h; } });
        return maxH;
    } catch(e) { return -1; }
}

function renderActivity() {
    const c = document.getElementById('activity-content');
    if (!c) return;
    try {
        const dates = getTrainingDates();
        const streak = calculateStreak(dates), record = calculateRecordStreak(dates);
        const totalTime = DB.history.reduce((s, r) => s + (r.totalDuration || 0), 0);
        const planStats = computePlanStats(30);
        const bestHour = getBestHours();

        const weekGraphBody = `<div class="week-graph">${buildWeekGraph()}</div><div style="color:var(--muted); font-size:0.75rem; text-align:center; margin-top:8px;">минут работы по дням</div>`;
        const heatmapBody = `<div class="heatmap-grid">${buildHeatmap30()}</div><div class="heatmap-legend"><span>меньше</span><div class="heatmap-legend-box" style="background:var(--card-2);"></div><div class="heatmap-legend-box" style="background:rgba(167,139,250,0.25);"></div><div class="heatmap-legend-box" style="background:rgba(167,139,250,0.5);"></div><div class="heatmap-legend-box" style="background:var(--primary);"></div><span>больше</span></div>`;
        const timeOfDayBody = buildTimeOfDayHeatmap();
        const weeksBody = buildWeekWorkChart();

        let bestHourBody = '';
        if (bestHour >= 0) {
            const period = bestHour < 6 ? 'ночь' : bestHour < 12 ? 'утро' : bestHour < 18 ? 'день' : 'вечер';
            bestHourBody = `<div style="color:var(--muted); font-size:0.85rem;">Вы продуктивнее всего в ${period} около ${String(bestHour).padStart(2,'0')}:00</div>`;
        }

        let planBody = '';
        if (planStats.missedCount > 0) {
            const missedList = planStats.missedDays.map(d => `<div style="padding:5px 0; font-size:0.85rem;"><span style="color:var(--muted);">• ${escapeHtml(d.dateStr)}</span> · <span style="color:var(--danger);">${escapeHtml((d.names || []).join(', '))}</span></div>`).join('');
            planBody = `<div class="history-summary-row" style="margin-top:0; padding-top:0; border-top:none;"><div class="history-summary-item"><div class="val" style="color:var(--accent);">${planStats.doneCount}</div><div class="lbl">✅ выполнено</div></div><div class="history-summary-item"><div class="val" style="color:var(--danger);">${planStats.missedCount}</div><div class="lbl">❌ пропущено</div></div>${planStats.total > 0 ? `<div class="history-summary-item"><div class="val">${planStats.pct}%</div><div class="lbl">процент</div></div>` : ''}</div><div style="margin-top:12px; padding-top:12px; border-top:1px solid var(--border-soft);"><div style="font-size:0.72rem; color:var(--muted); text-transform:uppercase; letter-spacing:1px; margin-bottom:6px;">Пропущено</div>${missedList}</div>`;
        }

        const totalBody = `<div class="stat-row"><div class="stat-label">🏆 Всего тренировок</div><div class="stat-value highlight">${DB.history.length}</div></div><div class="stat-row"><div class="stat-label">⏱ Общее время</div><div class="stat-value">${formatTime(Math.floor(totalTime))}</div></div>`;

        const order = getActivityOrder();
        const bodies = {
            week: weekGraphBody,
            heatmap: heatmapBody,
            timeofday: timeOfDayBody,
            weeks: weeksBody,
            besthour: bestHourBody,
            'exercise-progress': renderActivityExerciseChart(),
            plan: planBody,
            total: totalBody
        };
        let cardsHtml = '';
        order.forEach(key => {
            if (key === 'besthour' && bestHour < 0) return;
            if (key === 'plan' && planStats.missedCount === 0) return;
            const bodyHtml = bodies[key];
            if (!bodyHtml) return;
            cardsHtml += wrapActivityCard(key, bodyHtml);
        });

        c.innerHTML = `<div class="card" style="text-align:center; border:1px solid var(--fire);">
            <div style="font-size:3rem;">🔥</div>
            <div style="font-size:2rem; font-weight:800; margin:8px 0 4px; color:var(--fire);">${streak} ${pluralDays(streak)}</div>
            <div style="color:var(--muted); font-size:0.9rem;">подряд · рекорд ${record}</div>
        </div>` + cardsHtml;

        c.querySelectorAll('.activity-card').forEach(el => {
            initDragAndDrop(el, {
                containerSelector: '#activity-content',
                itemSelector: '.activity-card',
                dbKey: 'activityOrder'
            });
        });
        // Interactive points on exercise progress chart (same UX as measurements)
        c.querySelectorAll('.weight-chart-svg .dot[data-ex-value]').forEach(dot => {
            const showPoint = () => {
                const svg = dot.closest('.weight-chart-svg');
                if (!svg) return;
                const wrap = svg.parentElement;
                if (!wrap) return;
                let tip = wrap.querySelector('.measure-chart-point-tip');
                if (!tip) {
                    tip = document.createElement('div');
                    tip.className = 'measure-chart-point-tip';
                    wrap.appendChild(tip);
                }
                const rawVal = Number(dot.dataset.exValue);
                const type = dot.dataset.exType || 'reps';
                let unit = 'повт.';
                let mainVal = rawVal;
                if (type === 'weight') {
                    unit = 'кг';
                    mainVal = (Math.round(rawVal * 10) / 10).toString().replace(/\.0$/, '');
                } else if (type === 'time') {
                    unit = '';
                    mainVal = (typeof formatTime === 'function') ? formatTime(rawVal) : rawVal + ' сек';
                }
                let dateLabel = '';
                try {
                    const d = new Date(dot.dataset.exDate);
                    if (!isNaN(d.getTime())) {
                        dateLabel = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
                    }
                } catch (err) {}
                tip.textContent = unit
                    ? `${mainVal} ${unit} · ${dateLabel}`
                    : `${mainVal} · ${dateLabel}`;
            };
            dot.addEventListener('click', showPoint);
            dot.addEventListener('keydown', e => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    showPoint();
                }
            });
        });
    } catch(e) {
        console.error('[renderActivity error]', e);
        c.innerHTML = '<div class="empty-state"><span class="icon">⚠️</span><div class="title">Ошибка загрузки</div>' + escapeHtml(String(e.message || e)) + '</div>';
    }
}
function getActivityCardsOnScreen() {
    return Array.from(document.querySelectorAll('#activity-content .activity-card'));
}
function getActivityBulkToggleLabel() {
    const cards = getActivityCardsOnScreen();
    return cards.some(card => !card.classList.contains('collapsed')) ? 'Свернуть все карточки' : 'Развернуть все карточки';
}
function toggleAllActivityCards() {
    const cards = getActivityCardsOnScreen();
    if (!cards.length) { showToast('Нет карточек для изменения'); return; }
    const collapse = cards.some(card => !card.classList.contains('collapsed'));
    const state = getActivityCollapsed();
    cards.forEach(card => {
        const key = card.dataset.cardKey;
        if (!key) return;
        state[key] = collapse;
    });
    Storage.set('ft_settings', DB.settings);
    renderActivity();
    showToast(collapse ? 'Все карточки свёрнуты' : 'Все карточки развёрнуты');
}
async function resetActivityOrder() {
    const ok = await customConfirm('Вернуть стандартный порядок карточек активности?\n\nВаши тренировки и статистика не изменятся.', {
        title: 'Вернуть исходный порядок', okText: 'Вернуть порядок', cancelText: 'Отмена', danger: false
    });
    if (!ok) return;
    DB.settings.accordions = DB.settings.accordions || {};
    DB.settings.accordions.activityOrder = [...ACTIVITY_CARDS_DEFAULT];
    Storage.set('ft_settings', DB.settings);
    renderActivity();
    showToast('↩ Исходный порядок восстановлен');
}
function refreshActivity() {
    invalidateActivityCache();
    renderActivity();
    showToast('Активность обновлена');
}

function decorateActionMenu(overlay, sectionName) {
    try {
        const sheet = overlay && overlay.querySelector('.notif-side-sheet');
        if (!sheet) return;
        const title = sheet.querySelector('.sheet-title');
        if (title) title.textContent = `${sectionName} · ДЕЙСТВИЯ`;
        const descriptions = [
            [/создать тренировку/i, 'Открыть редактор и собрать новую тренировку.'],
            [/создать шаблон/i, 'Создать шаблон, который можно использовать повторно.'],
            [/создать программу/i, 'Составить план тренировок и расписание.'],
            [/добавить замер/i, 'Записать новые показатели и отслеживать изменения.'],
            [/выбрать/i, 'Отметить несколько элементов для группового действия.'],
            [/обновить статистику/i, 'Пересчитать и обновить данные на экране.'],
            [/обновить/i, 'Обновить список и показать актуальные данные.'],
            [/вернуть исходный порядок/i, 'Восстановить стандартный порядок карточек.'],
            [/свернуть|развернуть/i, 'Изменить отображение всех разделов сразу.'],
            [/сбросить поиск/i, 'Очистить поисковый запрос и вернуть полный список.'],
            [/сделать бэкап/i, 'Создать зашифрованную резервную копию данных приложения. Для восстановления понадобится пароль.'],
            [/сбросить настройки/i, 'Вернуть параметры приложения к исходным значениям. Тренировки, программы и история сохранятся.'],
            [/удалить все мои шаблоны/i, 'Удалить пользовательские шаблоны. Это действие потребует подтверждения.'],
            [/восстановить скрытые/i, 'Вернуть в список ранее скрытые встроенные шаблоны.'],
            [/удалить все/i, 'Удалить все элементы этого раздела. Перед удалением будет запрос подтверждения.'],
            [/удалить всю историю/i, 'Очистить записи истории тренировок. Перед удалением будет запрос подтверждения.'],
            [/изменить порядок/i, 'Переставить упражнения в текущей тренировке.'],
            [/общие настройки/i, 'Открыть общие настройки приложения.'],
            [/завершить сейчас/i, 'Завершить текущую тренировку и сохранить результат.'],
            [/отменить тренировку/i, 'Прервать тренировку без сохранения результата.'],
            [/поделиться результатом/i, 'Поделиться итогами завершённой тренировки.'],
            [/сохранить как шаблон/i, 'Сохранить эту тренировку как шаблон для будущего использования.'],
            [/повторить тренировку/i, 'Запустить эту тренировку ещё раз.'],
            [/на главную/i, 'Вернуться на главный экран приложения.'],
            [/назад/i, 'Вернуться к предыдущему экрану.'],
        ];
        Array.from(sheet.children).forEach((child) => {
            if (!child.matches('button.btn') || child.classList.contains('sheet-btn-cancel')) return;
            if (child.parentElement && child.parentElement.classList.contains('action-menu-item')) return;
            const label = (child.textContent || '').replace(/\s+/g, ' ').trim();
            const match = descriptions.find(([pattern]) => pattern.test(label));
            const desc = match ? match[1] : 'Выполнить действие в текущем разделе.';
            const wrapper = document.createElement('div');
            wrapper.className = 'action-menu-item';
            child.parentNode.insertBefore(wrapper, child);
            wrapper.appendChild(child);
            const existingCaption = wrapper.nextElementSibling;
            if (existingCaption && existingCaption.tagName === 'DIV' && !existingCaption.classList.contains('notif-side-grabber') && !existingCaption.classList.contains('action-menu-item')) {
                existingCaption.classList.add('action-menu-description');
                wrapper.appendChild(existingCaption);
            } else {
                const caption = document.createElement('div');
                caption.className = 'action-menu-description';
                caption.textContent = desc;
                wrapper.appendChild(caption);
            }
        });
    } catch (e) { console.warn('[decorateActionMenu]', e); }
}

function openActivityMenu() {
    if (hasOpenOverlay()) return;
    const ov = document.createElement('div');
    ov.className = 'notif-side-overlay action-menu-overlay';
    ov.innerHTML = `<div class="notif-side-sheet">
        <div class="notif-side-grabber"><div class="notif-side-grabber-bar"></div></div>
        <h2 class="sheet-title">Активность</h2>
        <button class="btn ghost" onclick="closeTopSheet(); toggleAllActivityCards();">${getActivityBulkToggleLabel()}</button>
        <button class="btn ghost" onclick="closeTopSheet(); resetActivityOrder();">↩ Вернуть исходный порядок</button>
        <button class="btn ghost" onclick="closeTopSheet(); refreshActivity();">Обновить статистику</button>
        <button class="btn ghost" onclick="openGlobalSettingsFrom('screen-activity')">⚙️ Общие настройки</button>
        <button class="btn sheet-btn-cancel" onclick="closeTopSheet()">Закрыть</button>
    </div>`;
    decorateActionMenu(ov, 'Активность');
    document.body.appendChild(ov);
    setupSideSwipe(ov.querySelector('.notif-side-sheet'), ov);
    ov.addEventListener('click', (e) => { if (e.target === ov) closeTopSheet(); });
}

function showDayActivityDetail(key) {
    const date = parseDateKey(key);
    const records = DB.history.filter(r => formatDateKey(new Date(r.startTime)) === key);
    const months = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
    const dateStr = `${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()}`;
    if (records.length === 0) { showToast(`${dateStr} · нет тренировок`); return; }
    const sorted = [...records].sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
    const totalWorkTime = sorted.reduce((s, r) => s + (r.workTime || 0), 0);
    const totalDuration = sorted.reduce((s, r) => s + (r.totalDuration || 0), 0);
    let listHtml = '';
    sorted.forEach(r => {
        const wExists = r.workoutId && DB.workouts.find(w => w.id === r.workoutId);
        const startT = new Date(r.startTime);
        const endT = r.endTime ? new Date(r.endTime) : new Date(startT.getTime() + (r.totalDuration || 0) * 1000);
        listHtml += `<div class="history-card" style="margin:0; cursor:pointer;" onclick="openHistoryItemDetail(${r.id})">
            <div class="history-top"><div class="history-info"><div class="name">${escapeHtml(r.workoutName || 'Тренировка')}${r.isDeload ? ' 🏷' : ''}</div><div class="stats">🕐 ${formatClock(startT)} → ${formatClock(endT)} · ⏱ ${formatTime(r.totalDuration)} · 💪 ${formatTime(r.workTime)}</div></div><div class="history-actions">${wExists ? `<button class="icon-btn" onclick="event.stopPropagation(); closeTopSheet(); repeatLastWorkout(${r.workoutId})" title="Повторить" aria-label="Повторить">▶</button>` : ''}<button class="icon-btn" onclick="event.stopPropagation(); shareResult(${r.id})" title="Поделиться" aria-label="Поделиться">📤</button></div></div>
            ${r.workoutNote ? `<div style="background:var(--primary-soft); border-left:3px solid var(--primary); border-radius:10px; padding:10px 12px; font-size:0.85rem;">📝 ${escapeHtml(r.workoutNote)}</div>` : ''}
        </div>`;
    });
    const ov = document.createElement('div');
    ov.className = 'notif-side-overlay';
    ov.innerHTML = `<div class="notif-side-sheet" style="max-height: 85vh;"><div class="notif-side-grabber"><div class="notif-side-grabber-bar"></div></div><h2 class="sheet-title">${dateStr}</h2><div style="color:var(--muted); font-size:0.85rem; text-align:center; flex-shrink:0;">${sorted.length} тренировок · ${formatTime(Math.floor(totalDuration))} всего</div><div class="sheet-scroll-area" style="flex:1; overflow-y:auto; display:flex; flex-direction:column; gap:8px; padding-right: 4px;">${listHtml}</div><div class="sheet-fixed-bottom" style="flex-shrink: 0; display: flex; flex-direction: column; gap: 8px; padding-top: 4px;"><button class="btn sheet-btn-cancel" onclick="closeTopSheet()">Закрыть</button></div></div>`;
    document.body.appendChild(ov);
    setupSideSwipe(ov.querySelector('.notif-side-sheet'), ov);
    ov.addEventListener('click', (e) => { if (e.target === ov) ov.remove(); });
}
function closeTopSheet() {
    const o = document.querySelectorAll('.notif-side-overlay');
    if (o.length) {
        const last = o[o.length - 1];
        try { if (typeof last._ftOnDismiss === 'function') { last._ftOnDismiss(); return; } } catch(e) {}
        try { last.remove(); } catch(e) {}
    }
    updateNotifGrabber();
}

function getPlanStatus(workoutId, date, occurrenceIndex = 0) {
    try {
        const dateKey = formatDateKey(date);
        const todayKey = formatDateKey(new Date());
        const records = DB.history
            .filter(r => r.workoutId === workoutId && formatDateKey(new Date(r.startTime)) === dateKey)
            .sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
        if (occurrenceIndex < records.length) return { status: 'done', time: formatClock(new Date(records[occurrenceIndex].startTime)), recordId: records[occurrenceIndex].id };
        if (dateKey < todayKey) return { status: 'missed' };
        if (dateKey === todayKey) return { status: 'pending' };
        return { status: 'future' };
    } catch(e) { return { status: 'future' }; }
}
function computePlanStats(daysCount) {
    const today = new Date(); today.setHours(0,0,0,0);
    const todayKey = formatDateKey(today);
    const cutoff = addDays(today, -daysCount + 1);
    let doneCount = 0, missedCount = 0;
    const missedByDay = new Map();
    const occMapByDay = new Map();
    DB.programs.forEach(p => {
        (p.weeks || []).forEach(w => {
            if (!w || !w.days || !w.startDate) return;
            DAY_KEYS.forEach((dk, dayIdx) => {
                const ids = w.days[dk] || [];
                if (ids.length === 0) return;
                const date = addDays(parseDateKey(w.startDate), dayIdx);
                const dateKey = formatDateKey(date);
                if (dateKey >= todayKey) return;
                if (date < cutoff) return;
                if (!occMapByDay.has(dateKey)) occMapByDay.set(dateKey, {});
                const occMap = occMapByDay.get(dateKey);
                ids.forEach(wid => {
                    const occIdx = occMap[wid] || 0;
                    occMap[wid] = occIdx + 1;
                    const w2 = DB.workouts.find(x => x.id === wid);
                    const name = w2 ? w2.name : '(удалено)';
                    const st = getPlanStatus(wid, date, occIdx);
                    if (st.status === 'done') doneCount++;
                    else if (st.status === 'missed') { missedCount++; if (!missedByDay.has(dateKey)) missedByDay.set(dateKey, { date, names: [] }); missedByDay.get(dateKey).names.push(name); }
                });
            });
        });
    });
    const missedDays = [...missedByDay.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([dateKey, d]) => {
        const date = d.date;
        const dayIdx = (date.getDay() + 6) % 7;
        const dayName = DAY_NAMES_SHORT[DAY_KEYS[dayIdx]];
        const dd = String(date.getDate()).padStart(2, '0');
        const mm = String(date.getMonth() + 1).padStart(2, '0');
        return { dateKey, dateStr: `${dayName} ${dd}.${mm}`, names: d.names };
    });
    const total = doneCount + missedCount;
    const pct = total > 0 ? Math.round(doneCount / total * 100) : 0;
    return { doneCount, missedCount, total, pct, missedDays };
}

const MEASURE_METRICS = [
    { key: 'weight', label: 'Вес', unit: 'кг', step: 0.001, max: 500 },
    { key: 'chest', label: 'Грудь', unit: 'см', step: 0.5, max: 300 },
    { key: 'waist', label: 'Талия', unit: 'см', step: 0.5, max: 300 },
    { key: 'hips', label: 'Бёдра', unit: 'см', step: 0.5, max: 300 },
    { key: 'neck', label: 'Шея', unit: 'см', step: 0.5, max: 100 },
    { key: 'shoulders', label: 'Плечи', unit: 'см', step: 0.5, max: 300 },
    { key: 'biceps', label: 'Бицепс', unit: 'см', step: 0.5, max: 100 },
    { key: 'forearm', label: 'Предплечье', unit: 'см', step: 0.5, max: 80 },
    { key: 'thigh', label: 'Бедро', unit: 'см', step: 0.5, max: 150 },
    { key: 'calf', label: 'Голень', unit: 'см', step: 0.5, max: 80 }
];
let measurementsActiveMetric = 'weight';
let measurementsRange = 'all';
let measurementHistoryGroupMode = 'week';

function getMeasureMetric(key) {
    return MEASURE_METRICS.find(m => m.key === key) || MEASURE_METRICS[0];
}
function setMeasurementsMetric(key) {
    if (!MEASURE_METRICS.some(m => m.key === key)) return;
    measurementsActiveMetric = key;
    renderMeasurements();
    // Прокрутить активную вкладку в видимую область
    try {
        const tab = document.querySelector('#measure-metric-tabs .tab.active');
        if (tab) tab.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
    } catch (e) {}
}
function shiftMeasurementsMetric(dir) {
    const idx = MEASURE_METRICS.findIndex(m => m.key === measurementsActiveMetric);
    const base = idx < 0 ? 0 : idx;
    const next = (base + (dir < 0 ? -1 : 1) + MEASURE_METRICS.length) % MEASURE_METRICS.length;
    setMeasurementsMetric(MEASURE_METRICS[next].key);
}
function metricSeries(sortedAsc, key) {
    return sortedAsc.filter(m => typeof m[key] === 'number' && m[key] > 0);
}
function latestMetricValue(sortedDesc, key) {
    for (const m of sortedDesc) {
        if (typeof m[key] === 'number' && m[key] > 0) return { value: m[key], date: m.date, id: m.id };
    }
    return null;
}
function firstMetricValue(sortedAsc, key) {
    for (const m of sortedAsc) {
        if (typeof m[key] === 'number' && m[key] > 0) return { value: m[key], date: m.date, id: m.id };
    }
    return null;
}
function formatMetricNum(v, key) {
    const n = Number(v) || 0;
    if (key === 'weight') {
        // Без суффикса «кг» — тот же формат, что formatWeightVal
        return formatWeightVal(n).replace(/\s*кг\s*$/i, '');
    }
    return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
function formatMetricDelta(v, key) {
    const n = Number(v);
    if (!Number.isFinite(n)) return '0';
    if (key === 'weight') {
        const abs = Math.abs(n);
        const formatted = isWeightRounded()
            ? (Math.abs(abs - Math.round(abs)) < 1e-9 ? String(Math.round(abs)) : abs.toFixed(1))
            : abs.toFixed(3);
        return (n > 0 ? '+' : n < 0 ? '−' : '') + formatted;
    }
    const abs = Math.abs(n);
    return (n > 0 ? '+' : n < 0 ? '−' : '') + (Number.isInteger(abs) ? String(abs) : abs.toFixed(1));
}
function measurementRangeStart(range, now = new Date()) {
    const d = new Date(now); d.setHours(0, 0, 0, 0);
    if (range === 'week') return startOfWeekMonday(d);
    if (range === 'month') return new Date(d.getFullYear(), d.getMonth(), 1);
    if (range === '3m') return new Date(d.getFullYear(), d.getMonth() - 2, 1);
    if (range === '6m') return new Date(d.getFullYear(), d.getMonth() - 5, 1);
    if (range === 'year') return new Date(d.getFullYear(), 0, 1);
    return null;
}
function setMeasurementsRange(range) {
    if (!['week', 'month', '3m', '6m', 'year', 'all'].includes(range)) return;
    measurementsRange = range;
    renderMeasurements();
}
function setMeasurementHistoryGroupMode(mode) {
    if (!['day', 'week', 'month'].includes(mode)) return;
    measurementHistoryGroupMode = mode;
    renderMeasurements();
}
function toggleMeasurementHistoryGroup(groupKey) {
    if (!DB.settings.measurementHistoryCollapsed || typeof DB.settings.measurementHistoryCollapsed !== 'object') DB.settings.measurementHistoryCollapsed = {};
    DB.settings.measurementHistoryCollapsed[groupKey] = !DB.settings.measurementHistoryCollapsed[groupKey];
    saveDB('settings');
    renderMeasurements();
}
function toggleMeasurementsHistory() {
    DB.settings.measurementsHistoryCollapsed = !DB.settings.measurementsHistoryCollapsed;
    saveDB('settings');
    renderMeasurements();
}
function buildMetricChartSvg(data, key, goalValue) {
    if (!data || data.length < 2) return '';
    const meta = getMeasureMetric(key);
    const w = 340, h = 168, pad = 22;
    const vals = data.map(m => m[key]);
    let minV = Math.min(...vals);
    let maxV = Math.max(...vals);
    if (typeof goalValue === 'number' && Number.isFinite(goalValue)) {
        minV = Math.min(minV, goalValue);
        maxV = Math.max(maxV, goalValue);
    }
    const span = (maxV - minV) || 1;
    // Extra headroom so goal line never sits flush on data when values are close
    const padExtra = key === 'weight'
        ? Math.max(1.2, span * 0.22)
        : Math.max(0.8, span * 0.22);
    minV -= padExtra;
    maxV += padExtra;
    const range = maxV - minV || 1;
    const stepX = (w - pad * 2) / (data.length - 1);
    const points = data.map((m, i) => {
        const x = pad + i * stepX;
        const y = pad + (1 - (m[key] - minV) / range) * (h - pad * 2);
        return { x, y, m };
    });
    const pathD = points.map((p, i) => (i === 0 ? 'M' : 'L') + p.x.toFixed(1) + ',' + p.y.toFixed(1)).join(' ');
    const areaD = pathD + ` L${points[points.length - 1].x.toFixed(1)},${(h - pad).toFixed(1)} L${points[0].x.toFixed(1)},${(h - pad).toFixed(1)} Z`;
    const gridLines = [0, 0.5, 1].map(frac => {
        const y = pad + frac * (h - pad * 2);
        return `<line class="grid-line" x1="${pad}" y1="${y}" x2="${w - pad}" y2="${y}"/>`;
    }).join('');
    let goalLine = '';
    if (typeof goalValue === 'number' && Number.isFinite(goalValue) && goalValue >= minV && goalValue <= maxV) {
        const goalY = pad + (1 - (goalValue - minV) / range) * (h - pad * 2);
        // Prefer label above the line; if too close to top, put below
        const labelAbove = goalY > pad + 14;
        const labelY = labelAbove ? (goalY - 6) : (goalY + 12);
        goalLine = `<line class="goal-line" x1="${pad}" y1="${goalY.toFixed(1)}" x2="${w - pad}" y2="${goalY.toFixed(1)}"/>`
            + `<text class="goal-label" x="${w - pad - 2}" y="${labelY.toFixed(1)}" text-anchor="end">Цель ${formatMetricNum(goalValue, key)}</text>`;
    }
    const dots = points.map(p => `<circle class="dot" tabindex="0" role="button" aria-label="${formatMetricNum(p.m[key], key)} ${meta.unit}, ${formatShortDate(parseDateKey(p.m.date))}" data-measure-value="${p.m[key]}" data-measure-date="${p.m.date}" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="6"><title>${formatMetricNum(p.m[key], key)} ${meta.unit} · ${formatShortDate(parseDateKey(p.m.date))}</title></circle>`).join('');
    const labels = points.map((p, i) => {
        if (i !== 0 && i !== points.length - 1 && i !== Math.floor(points.length / 2)) return '';
        return `<text class="label" x="${p.x.toFixed(1)}" y="${h - 4}" text-anchor="middle">${formatShortDate(parseDateKey(p.m.date))}</text>`;
    }).join('');
    // Order: grid → area → line → goal (on top) → dots → labels
    return `<svg class="weight-chart-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${gridLines}<path class="area" d="${areaD}"/><path class="line" d="${pathD}"/>${goalLine}${dots}${labels}</svg>`;
}

function renderMeasurements() {
    const c = document.getElementById('measurements-content');
    if (!c) return;
    try {
        const sorted = [...(Array.isArray(DB.measurements) ? DB.measurements : [])].filter(m => m && m.date)
            .sort((a, b) => {
                const da = parseDateKey(a.date).getTime(), db = parseDateKey(b.date).getTime();
                return db !== da ? db - da : (Number(b.id) || 0) - (Number(a.id) || 0);
            });
        const sortedAsc = [...sorted].reverse();
        const active = getMeasureMetric(measurementsActiveMetric);
        const key = active.key;
        const rangeStart = measurementRangeStart(measurementsRange);
        const periodRecords = rangeStart ? sorted.filter(m => parseDateKey(m.date) >= rangeStart) : sorted;
        const periodAsc = [...periodRecords].reverse();
        const rangeLabels = { week: 'Неделя', month: 'Месяц', '3m': '3 месяца', '6m': '6 месяцев', year: 'Год', all: 'Всё время' };
        const rangeControls = `<div class="measure-range-control" aria-label="Период динамики">${[['week','Неделя'],['month','Месяц'],['3m','3 мес.'],['6m','6 мес.'],['year','Год'],['all','Всё']].map(([v,l]) => `<button type="button" class="measure-range-btn ${measurementsRange === v ? 'active' : ''}" onclick="setMeasurementsRange('${v}')">${l}</button>`).join('')}</div>`;
        const tabsHtml = `<div class="tabs measure-metric-tabs" id="measure-metric-tabs">${MEASURE_METRICS.map(m => `<div class="tab ${m.key === key ? 'active' : ''}" onclick="setMeasurementsMetric('${m.key}')">${m.label}</div>`).join('')}</div>`;
        const chevron = collapsed => collapsed
            ? '<svg viewBox="0 0 24 24" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>'
            : '<svg viewBox="0 0 24 24" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>';

        const latest = latestMetricValue(periodRecords, key);
        const first = firstMetricValue(periodAsc, key);
        let currentMain = '';
        if (latest) {
            let deltaHtml = '<div class="measure-delta same">Нет изменений</div>';
            if (first) {
                const delta = latest.value - first.value;
                const cls = delta < 0 ? 'down' : delta > 0 ? 'up' : 'same';
                const trend = delta < 0 ? 'Снижение' : delta > 0 ? 'Рост' : 'Без изменений';
                deltaHtml = `<div class="measure-delta ${cls}">${trend}: ${formatMetricDelta(delta, key)} ${active.unit} <span>за ${rangeLabels[measurementsRange].toLowerCase()}</span></div>`;
            }
            currentMain = `<div class="measure-current-card" style="margin:0;"><div class="measure-current-label">${key === 'weight' ? 'Текущий вес' : 'Текущее значение · ' + active.label}</div><div class="measure-current-value">${formatMetricNum(latest.value, key)}</div><div class="measure-current-unit">${active.unit} · ${formatShortDate(parseDateKey(latest.date))}</div>${deltaHtml}<div class="measure-period-caption">${rangeLabels[measurementsRange]} · ${periodRecords.length} ${pluralMeasurements(periodRecords.length)}</div></div>`;
        } else {
            currentMain = `<div class="measure-current-card measure-current-empty" style="margin:0;"><div class="measure-current-label">${active.label} · ${rangeLabels[measurementsRange].toLowerCase()}</div><div class="measure-current-value" style="font-size:1.4rem;">нет данных</div><div class="measure-current-unit">В выбранном периоде пока нет замеров</div></div>`;
        }
        const series = metricSeries(periodAsc, key);
        const goals = (DB.settings && DB.settings.measurementGoals && typeof DB.settings.measurementGoals === 'object') ? DB.settings.measurementGoals : {};
        const goalValue = typeof goals[key] === 'number' ? goals[key] : null;
        const goalLatest = latestMetricValue(sorted, key);
        const goalFirst = firstMetricValue(sortedAsc, key);
        const goalCollapsed = !!(DB.settings && DB.settings.measurementGoalCollapsed);
        let goalPanel = '';
        if (goalLatest && key) {
            if (goalValue !== null) {
                const remaining = goalValue - goalLatest.value;
                const goalReached = Math.abs(remaining) < 0.0005;
                const startValue = goalFirst ? goalFirst.value : goalLatest.value;
                const denominator = goalValue - startValue;
                const achieved = Math.abs(denominator) < 0.000001 ? (goalReached ? 100 : 0)
                    : Math.max(0, Math.min(100, ((goalLatest.value-startValue)/denominator)*100));
                const direction = goalReached ? 'Цель достигнута' : (key === 'weight' ? (remaining < 0 ? 'Нужно снизить' : 'Нужно набрать') : (remaining < 0 ? 'Нужно уменьшить' : 'Нужно увеличить'));
                const distance = Math.abs(remaining);
                goalPanel = `<section class="measure-goal-card ${goalCollapsed ? 'collapsed' : ''}">
                    <button type="button" class="measure-goal-heading" onclick="toggleMeasurementGoalPanel()"><span><span class="measure-goal-kicker">Ваша цель</span><strong>${formatMetricNum(goalValue,key)} ${active.unit}</strong></span><span class="measure-goal-chevron">${goalCollapsed ? '＋' : '−'}</span></button>
                    <div class="measure-goal-body" style="${goalCollapsed ? 'display:none;' : ''}">
                        <div class="measure-goal-summary"><span>${formatMetricNum(goalLatest.value,key)} ${active.unit} сейчас</span><strong>${goalReached ? '100%' : Math.round(achieved)+'%'}</strong></div>
                        <div class="measure-goal-track"><span style="width:${goalReached ? 100 : Math.round(achieved)}%"></span></div>
                        <div class="measure-goal-foot"><span>${direction}</span><strong>${goalReached ? 'Отличный результат!' : formatMetricNum(distance,key)+' '+active.unit+' до цели'}</strong></div>
                        <div class="measure-goal-actions"><button type="button" class="btn small secondary" onclick="openMeasurementGoalEditor('${key}')">Изменить цель</button><button type="button" class="btn small ghost" onclick="removeMeasurementGoal('${key}')">Убрать</button></div>
                    </div></section>`;
            } else {
                goalPanel = `<section class="measure-goal-card measure-goal-empty"><div><strong>Цель ${active.label.toLowerCase()}</strong><span>Отслеживайте путь к желаемому результату</span></div><button type="button" class="btn small accent" onclick="openMeasurementGoalEditor('${key}')">＋ Задать</button></section>`;
            }
        }
        const chartInner = series.length >= 2 ? buildMetricChartSvg(series, key, goalValue)
            : `<div class="measure-chart-empty">${series.length === 1 ? 'Для графика нужно минимум 2 замера за выбранный период.' : 'Нет данных по выбранному периоду.'}</div>`;
        const currentBody = `${rangeControls}${currentMain}${goalPanel}<div class="measure-chart-under-current"><div class="measure-chart-title">Динамика · ${active.label}</div>${chartInner}</div>`;

        const bodyChips = MEASURE_METRICS.map(m => {
            const lv = latestMetricValue(periodRecords, m.key), fv = firstMetricValue(periodAsc, m.key);
            let delta = '<div class="delta same">—</div>';
            if (lv && fv) {
                const d = lv.value - fv.value, cls = d < 0 ? 'down' : d > 0 ? 'up' : 'same';
                delta = `<div class="delta ${cls}">${formatMetricDelta(d, m.key)} ${m.unit}</div>`;
            }
            return `<div class="measure-body-chip ${m.key === key ? 'active' : ''}" onclick="setMeasurementsMetric('${m.key}')"><div class="lbl">${m.label}</div><div class="val">${lv ? formatMetricNum(lv.value, m.key) + ' ' + m.unit : '—'}</div>${delta}</div>`;
        }).join('');
        const bodyBody = `<div class="measure-body-grid">${bodyChips}</div>`;
        const sectionDefs = {
            current: { title: '📈 Динамика · ' + active.label, collapsedKey: 'measurementsCurrentCollapsed', body: currentBody },
            body: { title: '📈 Общие показатели', collapsedKey: 'measurementsBodyCollapsed', body: bodyBody }
        };
        let order = (DB.settings.accordions && Array.isArray(DB.settings.accordions.measurementsOrder))
            ? DB.settings.accordions.measurementsOrder.filter(k => sectionDefs[k]) : ['current', 'body'];
        order = order.filter(k => k !== 'chart');
        ['current', 'body'].forEach(k => { if (!order.includes(k)) order.push(k); });
        const sectionsHtml = order.map(secKey => {
            const def = sectionDefs[secKey], collapsed = !!DB.settings[def.collapsedKey];
            return `<div class="card activity-card measure-section-card${collapsed ? ' collapsed' : ''}" data-measure-section="${secKey}"><div class="activity-card-header" onclick="toggleMeasureSection('${secKey}')"><div class="activity-card-title">${def.title}</div><button type="button" class="icon-toggle-btn" aria-label="${collapsed ? 'Развернуть' : 'Свернуть'}" onclick="event.stopPropagation(); toggleMeasureSection('${secKey}')">${chevron(collapsed)}</button></div><div class="activity-card-body" style="${collapsed ? 'display:none;' : ''}">${def.body}</div></div>`;
        }).join('');

        let listHtml = '';
        if (!sorted.length) {
            listHtml = `<div class="empty-state"><span class="icon">📏</span><div class="title">Пока нет замеров</div><div style="margin-bottom:14px;">Добавьте вес или обхваты — появится динамика.</div><button class="btn accent" onclick="openMeasurementForm()" style="max-width:280px;margin:0 auto;">+ Добавить замер</button></div>`;
        } else {
            const groupsMap = new Map();
            sorted.forEach(m => {
                const d = parseDateKey(m.date);
                let groupKey, label;
                if (measurementHistoryGroupMode === 'day') {
                    const dayKey = formatDateKey(d);
                    groupKey = 'day:' + dayKey;
                    label = d.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
                    label = label.charAt(0).toUpperCase() + label.slice(1);
                } else if (measurementHistoryGroupMode === 'month') {
                    groupKey = 'month:' + m.date.slice(0, 7);
                    label = d.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });
                    label = label.charAt(0).toUpperCase() + label.slice(1);
                } else {
                    const mondayKey = formatDateKey(startOfWeekMonday(d));
                    groupKey = 'week:' + mondayKey;
                    label = 'Неделя · ' + formatWeekRange(mondayKey);
                }
                if (!groupsMap.has(groupKey)) groupsMap.set(groupKey, { key: groupKey, label, records: [] });
                groupsMap.get(groupKey).records.push(m);
            });
            const collapsedMap = DB.settings.measurementHistoryCollapsed && typeof DB.settings.measurementHistoryCollapsed === 'object' ? DB.settings.measurementHistoryCollapsed : {};
            const historyCollapsed = !!DB.settings.measurementsHistoryCollapsed;
            const groupModeLabel = measurementHistoryGroupMode === 'day' ? 'дням' : (measurementHistoryGroupMode === 'week' ? 'неделям' : 'месяцам');
            listHtml = `<section class="measure-history-section"><div class="measure-history-toolbar"><div class="measure-history-title-wrap"><div class="measure-history-heading">История <span>${sorted.length}</span></div><div class="measure-history-subtitle">Группировка по ${groupModeLabel}</div></div><div class="measure-history-controls"><div class="measure-history-switch" role="group" aria-label="Группировка истории"><button type="button" class="${measurementHistoryGroupMode === 'day' ? 'active' : ''}" aria-pressed="${measurementHistoryGroupMode === 'day'}" onclick="setMeasurementHistoryGroupMode('day')">Дни</button><button type="button" class="${measurementHistoryGroupMode === 'week' ? 'active' : ''}" aria-pressed="${measurementHistoryGroupMode === 'week'}" onclick="setMeasurementHistoryGroupMode('week')">Недели</button><button type="button" class="${measurementHistoryGroupMode === 'month' ? 'active' : ''}" aria-pressed="${measurementHistoryGroupMode === 'month'}" onclick="setMeasurementHistoryGroupMode('month')">Месяцы</button></div></div></div><div class="measure-history-content" style="${historyCollapsed ? 'display:none;' : ''}">`;
            listHtml += [...groupsMap.values()].map(g => {
                // Newest first within group (by date desc, then id desc) — same order as overall list and as history
                g.records.sort((a, b) => {
                    const da = parseDateKey(a.date).getTime(), db = parseDateKey(b.date).getTime();
                    return db !== da ? db - da : (Number(b.id) || 0) - (Number(a.id) || 0);
                });
                const collapsed = !!collapsedMap[g.key];
                const rows = g.records.map((m, idx) => {
                    const extras = [];
                    MEASURE_METRICS.forEach(meta => { if (meta.key !== 'weight' && typeof m[meta.key] === 'number' && m[meta.key] > 0) extras.push(`${meta.label}: ${formatMetricNum(m[meta.key], meta.key)}`); });
                    const activeVal = typeof m[key] === 'number' && m[key] > 0 ? m[key] : null;
                    const prefix = g.records.length > 1 ? `<span class="measure-item-index">${idx + 1}.</span>` : '';
                    const valueText = activeVal !== null
                        ? `${formatMetricNum(activeVal, key)} ${active.unit}${key !== 'weight' && typeof m.weight === 'number' ? ` · ${formatMetricNum(m.weight, 'weight')} кг` : ''}`
                        : (typeof m.weight === 'number' ? `${formatMetricNum(m.weight, 'weight')} кг` : (extras.length ? extras[0] : 'замер'));
                    const mainHtml = `<div class="measure-item-main">${prefix}${valueText}</div>`;
                    const extraLine = extras.filter((_, i) => !(activeVal !== null && key !== 'weight' && i === 0 && extras[0].startsWith(active.label))).join(' · ');
                    const isChecked = measurementsSelectedIds.has(m.id);
                    if (measurementsSelectionMode) return `<div class="measure-item" onclick="toggleMeasurementSelection(${m.id})" style="cursor:pointer;"><div class="bulk-checkbox ${isChecked ? 'checked' : ''}" style="margin-right:8px;"></div><div class="measure-item-info">${mainHtml}${extraLine || m.notes ? `<div class="measure-item-extra">${extraLine}${extraLine && m.notes ? ' · ' : ''}${m.notes ? escapeHtml(m.notes) : ''}</div>` : ''}</div></div>`;
                    return `<div class="measure-item"><div class="measure-item-info" style="cursor:pointer;" onclick="openMeasurementForm(${m.id})">${mainHtml}<div class="measure-item-date">${parseDateKey(m.date).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' })}</div>${extraLine || m.notes ? `<div class="measure-item-extra">${extraLine}${extraLine && m.notes ? ' · ' : ''}${m.notes ? escapeHtml(m.notes) : ''}</div>` : ''}</div><div class="measure-item-actions"><button class="icon-btn" onclick="event.stopPropagation(); openMeasurementForm(${m.id})" aria-label="Изменить">✏️</button><button class="icon-btn" onclick="event.stopPropagation(); deleteMeasurement(${m.id})" aria-label="Удалить">🗑</button></div></div>`;
                }).join('');
                return `<section class="measure-history-group ${collapsed ? 'collapsed' : ''}"><button type="button" class="measure-history-group-header" onclick="toggleMeasurementHistoryGroup('${g.key}')"><span class="measure-history-group-title">${g.label}</span><span class="measure-history-group-meta">${g.records.length} ${pluralMeasurements(g.records.length)}</span></button><div class="measure-history-group-body" style="${collapsed ? 'display:none;' : ''}">${rows}</div></section>`;
            }).join('') + '</div></section>';
        }
        c.innerHTML = `${measurementsSelectionMode || !sorted.length ? '' : '<button class="btn accent" onclick="openMeasurementForm()" style="margin-top:0;margin-bottom:12px;">+ Добавить замер</button>'}${tabsHtml}<div id="measurements-sections">${sectionsHtml}</div>${listHtml}`;
        try {
            c.querySelectorAll('#measurements-sections .measure-section-card').forEach(el => initDragAndDrop(el, { containerSelector: '#measurements-sections', itemSelector: '.measure-section-card', dbKey: 'measurementsOrder' }));
        } catch (e) { console.warn('[measure drag]', e); }
        c.querySelectorAll('.weight-chart-svg .dot').forEach(dot => {
            const showPoint = () => {
                const svg = dot.closest('.weight-chart-svg');
                if (!svg) return;
                let tip = svg.parentElement.querySelector('.measure-chart-point-tip');
                if (!tip) { tip = document.createElement('div'); tip.className = 'measure-chart-point-tip'; svg.parentElement.appendChild(tip); }
                const meta = getMeasureMetric(key);
                tip.textContent = `${formatMetricNum(Number(dot.dataset.measureValue), key)} ${meta.unit} · ${parseDateKey(dot.dataset.measureDate).toLocaleDateString('ru-RU', {day:'numeric', month:'long', year:'numeric'})}`;
            };
            dot.addEventListener('click', showPoint);
            dot.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showPoint(); } });
        });
        const existingBar = document.getElementById('measurements-bulk-bar');
        if (existingBar) existingBar.remove();
        if (measurementsSelectionMode && measurementsSelectedIds.size > 0) {
            const bar = document.createElement('div'); bar.className = 'bulk-action-bar'; bar.id = 'measurements-bulk-bar';
            bar.innerHTML = `<button class="btn danger small" onclick="deleteSelectedMeasurements()" style="width:100%;">Удалить ${measurementsSelectedIds.size}</button>`;
            document.body.appendChild(bar);
        }
    } catch(e) {
        console.error('[renderMeasurements]', e);
        c.innerHTML = '<div class="empty-state"><span class="icon">⚠️</span><div class="title">Ошибка</div>' + escapeHtml(String(e.message || e)) + '</div>';
    }
}

let editingMeasurementId = null;

function openMeasurementGoalEditor(metricKey) {
    const meta = getMeasureMetric(metricKey);
    if (!meta) return;
    const goals = (DB.settings.measurementGoals && typeof DB.settings.measurementGoals === 'object') ? DB.settings.measurementGoals : {};
    const current = typeof goals[metricKey] === 'number' ? goals[metricKey] : '';
    document.getElementById('measurement-goal-editor-overlay')?.remove();
    const ov = document.createElement('div');
    ov.className = 'notif-side-overlay';
    ov.id = 'measurement-goal-editor-overlay';
    ov.innerHTML = `<div class="notif-side-sheet" role="dialog" aria-modal="true" aria-labelledby="measure-goal-editor-title">
        <div class="notif-side-grabber"><div class="notif-side-grabber-bar"></div></div>
        <h2 class="sheet-title" id="measure-goal-editor-title">Цель: ${meta.label.toLowerCase()}</h2>
        <div class="measure-goal-editor-hint">Укажите желаемое значение в ${meta.unit}</div>
        <input type="number" id="measurement-goal-input" class="input" inputmode="decimal" step="${meta.step}" min="0" max="${meta.max}" placeholder="Например, ${metricKey === 'weight' ? '72' : '90'}" value="${current}">
        <div class="measure-goal-editor-actions"><button type="button" class="btn secondary" id="measure-goal-cancel">Отмена</button><button type="button" class="btn accent" id="measure-goal-save">Сохранить</button></div>
        ${current !== '' ? `<button type="button" class="measure-goal-remove" id="measure-goal-remove">Убрать цель</button>` : ''}
    </div>`;
    document.body.appendChild(ov);
    const finish = () => {
        const s = ov.querySelector('.notif-side-sheet');
        if (s) s.style.transform = 'translateX(100%)';
        ov.style.opacity = '0';
        setTimeout(() => { try { ov.remove(); } catch(e) {} }, 200);
    };
    ov._ftCloseGoal = finish;
    const cancelBtn = ov.querySelector('#measure-goal-cancel');
    const saveBtn = ov.querySelector('#measure-goal-save');
    const removeBtn = ov.querySelector('#measure-goal-remove');
    if (cancelBtn) cancelBtn.onclick = (e) => { e.preventDefault(); finish(); };
    if (saveBtn) saveBtn.onclick = (e) => { e.preventDefault(); saveMeasurementGoalValue(metricKey); };
    if (removeBtn) removeBtn.onclick = (e) => { e.preventDefault(); removeMeasurementGoal(metricKey); finish(); };
    ov.addEventListener('click', e => { if (e.target === ov) finish(); });
    setupSideSwipe(ov.querySelector('.notif-side-sheet'), ov, finish);
    setTimeout(() => { const input = document.getElementById('measurement-goal-input'); if (input) input.focus(); }, 80);
}
function closeMeasurementGoalEditor() {
    const ov = document.getElementById('measurement-goal-editor-overlay');
    if (!ov) return;
    if (typeof ov._ftCloseGoal === 'function') {
        ov._ftCloseGoal();
    } else {
        ov.remove();
    }
}
function saveMeasurementGoalValue(metricKey) {
    const meta = getMeasureMetric(metricKey);
    const input = document.getElementById('measurement-goal-input');
    const value = Number(String(input ? input.value : '').replace(',', '.'));
    if (!Number.isFinite(value) || value <= 0 || value > meta.max) { showToast('Введите корректное значение цели'); return; }
    DB.settings.measurementGoals = { ...(DB.settings.measurementGoals || {}), [metricKey]: value };
    saveDB('settings');
    closeMeasurementGoalEditor();
    renderMeasurements();
    showToast('Цель сохранена');
}
function removeMeasurementGoal(metricKey) {
    if (!DB.settings.measurementGoals) return;
    delete DB.settings.measurementGoals[metricKey];
    saveDB('settings');
    renderMeasurements();
    showToast('Цель убрана');
}
function toggleMeasurementGoalPanel() {
    DB.settings.measurementGoalCollapsed = !DB.settings.measurementGoalCollapsed;
    saveDB('settings');
    renderMeasurements();
}

function openMeasurementForm(editId) {
    editingMeasurementId = (editId !== undefined && editId !== null) ? editId : null;
    const existing = editingMeasurementId ? DB.measurements.find(m => m.id === editingMeasurementId) : null;
    const today = new Date();
    const dateStr = existing ? (existing.date || formatDateKey(today)) : formatDateKey(today);
    const nVal = existing && existing.notes ? escapeHtml(existing.notes) : '';

    const wMeta = getMeasureMetric('weight');
    const wVal = existing && typeof existing.weight === 'number' ? existing.weight : '';
    const body = MEASURE_METRICS.filter(m => m.key !== 'weight');
    let filledBody = 0;
    body.forEach(m => {
        if (existing && typeof existing[m.key] === 'number' && existing[m.key] > 0) filledBody++;
    });
    // Размеры тела: раскрыты, если уже есть значения или выбран не вес
    const openBody = filledBody > 0 || (measurementsActiveMetric && measurementsActiveMetric !== 'weight');

    let bodyRows = '';
    for (let i = 0; i < body.length; i += 2) {
        const a = body[i];
        const b = body[i + 1];
        const aVal = existing && typeof existing[a.key] === 'number' ? existing[a.key] : '';
        const aHtml = `<div class="form-col"><label>${a.label} (${a.unit})</label><input type="number" id="m-${a.key}" class="input" inputmode="decimal" step="${a.step}" min="0" max="${a.max}" placeholder="—" value="${aVal}"></div>`;
        let bHtml = '';
        if (b) {
            const bVal = existing && typeof existing[b.key] === 'number' ? existing[b.key] : '';
            bHtml = `<div class="form-col"><label>${b.label} (${b.unit})</label><input type="number" id="m-${b.key}" class="input" inputmode="decimal" step="${b.step}" min="0" max="${b.max}" placeholder="—" value="${bVal}"></div>`;
        }
        bodyRows += `<div class="form-row">${aHtml}${bHtml}</div>`;
    }

    const ov = document.createElement('div');
    ov.className = 'notif-side-overlay';
    ov.id = 'measurement-form-overlay';
    ov.innerHTML = `
    <div class="notif-side-sheet measure-form-sheet">
        <div class="notif-side-grabber"><div class="notif-side-grabber-bar"></div></div>
        <h2 class="sheet-title">${existing ? 'Редактировать замер' : 'Новый замер'}</h2>
        <div class="measure-form-scroll">
            <label class="measure-form-label">Дата</label>
            <input type="date" id="m-date" class="input" value="${dateStr}">

            <label class="measure-form-label">Вес (${wMeta.unit})</label>
            <input type="number" id="m-weight" class="input" inputmode="decimal" step="${(DB.settings && DB.settings.roundWeight) ? '0.1' : '0.001'}" min="0" max="${wMeta.max}" placeholder="Например: 72.150" value="${wVal}">
            ${(Array.isArray(DB.measurements) && DB.measurements.length) ? '<div class="measure-repeat-row"><span class="measure-repeat-hint">Быстрый ввод</span><button type="button" class="measure-repeat-btn" id="m-fill-prev-btn" onclick="fillPreviousMeasurements()"><span class="measure-repeat-icon">↶</span><span>Подставить предыдущие значения</span></button></div>' : ''}

            <details class="measure-body-details" id="m-body-details" ${openBody ? 'open' : ''}>
                <summary class="measure-body-summary">
                    <span>📏 Размеры тела</span>
                    <span class="measure-body-summary-meta" id="m-body-count">${filledBody > 0 ? filledBody + ' заполнено' : 'по желанию'}</span>
                </summary>
                <div class="measure-body-fields">
                    ${bodyRows}
                </div>
            </details>

            <label class="measure-form-label">Заметка</label>
            <textarea id="m-notes" class="input" placeholder="Как самочувствие?" style="min-height:56px;">${nVal}</textarea>
        </div>
        <div class="measure-form-actions">
            <button class="btn accent" onclick="saveMeasurement()" style="margin-top:0;">💾 Сохранить</button>
            <button class="btn ghost" onclick="closeMeasurementForm(); notifyCancelled();" style="margin-top:0;">Отмена</button>
        </div>
    </div>`;
    document.body.appendChild(ov);
    setupSideSwipe(ov.querySelector('.notif-side-sheet'), ov);
    ov.addEventListener('click', (e) => { if (e.target === ov) closeMeasurementForm(); });

    // Обновление счётчика заполненных размеров
    const updateBodyCount = () => {
        let n = 0;
        body.forEach(m => {
            const el = document.getElementById('m-' + m.key);
            const v = el ? parseFloat(el.value) : NaN;
            if (!isNaN(v) && v > 0) n++;
        });
        const meta = document.getElementById('m-body-count');
        if (meta) meta.textContent = n > 0 ? (n + ' заполнено') : 'по желанию';
    };
    body.forEach(m => {
        const el = document.getElementById('m-' + m.key);
        if (el) el.addEventListener('input', updateBodyCount);
    });

    // Фокус: вес или раскрытый размер
    try {
        const wantBody = measurementsActiveMetric && measurementsActiveMetric !== 'weight';
        if (wantBody) {
            const details = document.getElementById('m-body-details');
            if (details) details.open = true;
        }
        const focusId = wantBody ? ('m-' + measurementsActiveMetric) : 'm-weight';
        const el = document.getElementById(focusId);
        if (el) setTimeout(() => {
            try {
                el.focus();
                // Прокрутить к полю внутри scroll-области
                el.scrollIntoView({ block: 'center', behavior: 'smooth' });
            } catch(e) {}
        }, 250);
    } catch(e) {}
}
function closeMeasurementForm() { editingMeasurementId = null; const ov = document.getElementById('measurement-form-overlay'); if (ov) ov.remove(); }
/** Подставить последние известные вес и обхваты в форму замера. */
function fillPreviousMeasurements() {
    if (!Array.isArray(DB.measurements) || !DB.measurements.length) {
        showToast('Пока нет прошлых замеров');
        return;
    }
    const sorted = [...DB.measurements].sort((a, b) => {
        const da = parseDateKey(a.date).getTime();
        const db = parseDateKey(b.date).getTime();
        if (da !== db) return db - da;
        return (b.id || 0) - (a.id || 0);
    });
    // Для каждого поля — последнее ненулевое значение (можно из разных дней)
    let filled = 0;
    MEASURE_METRICS.forEach(meta => {
        const el = document.getElementById('m-' + meta.key);
        if (!el) return;
        if (el.value && parseFloat(el.value) > 0) return; // не затираем уже введённое
        for (const m of sorted) {
            if (typeof m[meta.key] === 'number' && m[meta.key] > 0) {
                el.value = String(m[meta.key]);
                filled++;
                break;
            }
        }
    });
    // Открыть блок размеров, если что-то подставили
    const details = document.getElementById('m-body-details');
    if (details && filled > 0) details.open = true;
    // Обновить счётчик
    try {
        let n = 0;
        MEASURE_METRICS.filter(m => m.key !== 'weight').forEach(meta => {
            const el = document.getElementById('m-' + meta.key);
            const v = el ? parseFloat(el.value) : NaN;
            if (!isNaN(v) && v > 0) n++;
        });
        const metaEl = document.getElementById('m-body-count');
        if (metaEl) metaEl.textContent = n > 0 ? (n + ' заполнено') : 'по желанию';
    } catch (e) {}
    showToast(filled > 0 ? (`↩ Подставлено полей: ${filled}`) : 'Нечего подставлять — поля уже заполнены');
}
function saveMeasurement() {
    const dateVal = document.getElementById('m-date').value;
    const notesVal = (document.getElementById('m-notes') && document.getElementById('m-notes').value.trim()) || '';
    if (!dateVal) { showToast('Укажите дату'); return; }
    const fields = { date: dateVal };
    let anyValue = !!notesVal;
    MEASURE_METRICS.forEach(meta => {
        const el = document.getElementById('m-' + meta.key);
        const raw = el ? parseFloat(el.value) : NaN;
        if (!isNaN(raw) && raw > 0) {
            fields[meta.key] = raw;
            anyValue = true;
        } else {
            fields[meta.key] = undefined;
        }
    });
    if (!anyValue) { showToast('Укажите хотя бы одно значение'); return; }
    if (notesVal) fields.notes = notesVal; else fields.notes = undefined;
    if (editingMeasurementId) {
        const rec = DB.measurements.find(m => m.id === editingMeasurementId);
        if (!rec) { showToast('Запись не найдена'); closeMeasurementForm(); return; }
        Object.keys(fields).forEach(k => {
            if (fields[k] === undefined) delete rec[k];
            else rec[k] = fields[k];
        });
        // Удалить устаревшие числовые поля метрик, если очищены
        MEASURE_METRICS.forEach(meta => {
            if (fields[meta.key] === undefined) delete rec[meta.key];
        });
        saveDB('measurements');
        closeMeasurementForm();
        renderMeasurements();
        showToast('✅ Замер обновлён');
    } else {
        const rec = { id: Date.now(), date: dateVal };
        MEASURE_METRICS.forEach(meta => {
            if (typeof fields[meta.key] === 'number' && fields[meta.key] > 0) rec[meta.key] = fields[meta.key];
        });
        if (notesVal) rec.notes = notesVal;
        DB.measurements.push(rec);
        saveDB('measurements');
        closeMeasurementForm();
        renderMeasurements();
        showToast('✅ Замер сохранён');
    }
}
async function deleteMeasurement(id) {
    if (!await customConfirm('Удалить этот замер?', { danger: true, okText: '🗑 Удалить' })) return;
    const idx = DB.measurements.findIndex(m => m.id === id);
    if (idx < 0) return;
    const removed = DB.measurements[idx];
    DB.measurements.splice(idx, 1);
    saveDB('measurements');
    renderMeasurements();
    showUndoToast('Замер удалён', () => { DB.measurements.splice(idx, 0, removed); saveDB('measurements'); renderMeasurements(); showToast('Восстановлено'); });
}

function renderWorkoutsList() {
    const c = document.getElementById('workouts-list');
    if (!c) return;
    const searchEl = document.getElementById('workout-search');
    const sortEl = document.getElementById('workout-sort');
    const q = searchEl ? searchEl.value.toLowerCase().trim() : '';
    const sortBy = sortEl ? sortEl.value : 'custom';
    let workouts = [...DB.workouts];
    if (q) { workouts = workouts.filter(w => { if ((w.name || '').toLowerCase().includes(q)) return true; if (Array.isArray(w.exercises)) { return w.exercises.some(e => e && e.kind === 'exercise' && (e.name || '').toLowerCase().includes(q)); } return false; }); }
    if (sortBy === 'name') workouts.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ru'));
    else if (sortBy === 'duration') workouts.sort((a, b) => estimateWorkoutDuration(b) - estimateWorkoutDuration(a));
    else if (sortBy === 'exercises') workouts.sort((a, b) => getTotalExerciseCount(b.exercises) - getTotalExerciseCount(a.exercises));
    // Нижние «Создать / Импорт» — только если есть хотя бы одна тренировка
    const bottomActions = document.getElementById('workouts-bottom-actions');
    if (bottomActions) bottomActions.style.display = DB.workouts.length > 0 ? '' : 'none';

    if (workouts.length === 0) {
        c.innerHTML = DB.workouts.length === 0
            ? `<div class="empty-state"><span class="icon">🏋️</span><div class="title">Пока нет тренировок</div>
                <div style="margin-bottom:14px;">Создайте первую или возьмите готовый шаблон.</div>
                <button class="btn accent" onclick="openEditor(null, false)" style="max-width:280px;margin:0 auto 8px;">+ Создать тренировку</button>
                <button class="btn ghost" onclick="showScreen('screen-templates')" style="max-width:280px;margin:0 auto;">📋 Открыть шаблоны</button>
            </div>`
            : '<div class="empty-state"><span class="icon">🔍</span><div class="title">Ничего не найдено</div>Попробуйте изменить запрос.</div>';
        const existingBar = document.getElementById('workouts-bulk-bar');
        if (existingBar) existingBar.remove();
        return;
    }
    c.innerHTML = workouts.map(w => {
        const exCount = getTotalExerciseCount(w.exercises);
        const totalSec = estimateWorkoutDuration(w);
        const totalMin = Math.round(totalSec / 60);
        const isChecked = workoutsSelectedIds.has(w.id);
        if (workoutsSelectionMode) {
            return `<div class="workout-item" data-id="${w.id}" onclick="toggleWorkoutSelection(${w.id})" style="cursor:pointer;"><div style="display:flex; align-items:center; gap:10px;"><div class="bulk-checkbox ${isChecked ? 'checked' : ''}"></div><div style="flex:1; min-width:0;"><div class="workout-name">${escapeHtml(w.name || 'Без названия')}</div><div class="workout-meta">${exCount} упр. · ~${totalMin} мин всего</div></div></div></div>`;
        }
        return `<div class="workout-item" data-id="${w.id}">
            <div class="workout-name">${escapeHtml(w.name || 'Без названия')}</div>
            <div class="workout-meta-row"><div class="workout-meta">${exCount} упр. · ~${totalMin} мин всего</div><div class="workout-actions"><button class="icon-btn" onclick="showPreview(${w.id})" title="Просмотр" aria-label="Просмотр">👁</button><button class="icon-btn" onclick="duplicateWorkout(${w.id})" title="Копия" aria-label="Дублировать">📋</button><button class="icon-btn" onclick="openEditor(${w.id}, false)" title="Редактировать" aria-label="Редактировать">✏️</button><button class="icon-btn delete" onclick="deleteWorkoutById(${w.id})" title="Удалить" aria-label="Удалить">🗑</button></div></div>
            <button class="btn accent btn-start-workout" onclick="startWorkout(${w.id}, false)">▶ Начать тренировку</button>
        </div>`;
    }).join('');
    const allowDrag = (sortBy === 'custom' && !q && !workoutsSelectionMode);
    c.querySelectorAll('.workout-item').forEach(el => { if (allowDrag) initDragAndDrop(el); else el.setAttribute('draggable', 'false'); });
    const existingBar = document.getElementById('workouts-bulk-bar');
    if (existingBar) existingBar.remove();
    if (workoutsSelectionMode && workoutsSelectedIds.size > 0) {
        const bar = document.createElement('div');
        bar.className = 'bulk-action-bar';
        bar.id = 'workouts-bulk-bar';
        bar.innerHTML = `<button class="btn danger small" onclick="deleteSelectedWorkouts()" style="width:100%;">Удалить ${workoutsSelectedIds.size}</button>`;
        document.body.appendChild(bar);
    }
}
function duplicateWorkout(id) {
    const w = DB.workouts.find(x => x.id === id);
    if (!w) return;
    const copy = JSON.parse(JSON.stringify(w));
    copy.id = Date.now(); copy.name = w.name + ' (копия)';
    DB.workouts.push(copy); saveDB('workouts'); renderWorkoutsList();
    showToast('📋 Тренировка скопирована');
}
async function deleteWorkoutById(id) {
    if (!await customConfirm('Удалить тренировку?', { danger: true, okText: '🗑 Удалить' })) return;
    const idx = DB.workouts.findIndex(w => w.id === id);
    if (idx < 0) return;
    const removed = DB.workouts[idx];
    DB.workouts.splice(idx, 1);
    saveDB('workouts'); renderWorkoutsList();
    showUndoToast('Тренировка удалена', () => { DB.workouts.splice(idx, 0, removed); saveDB('workouts'); renderWorkoutsList(); showToast('Восстановлено'); });
}

function openGlobalSettingsFrom(screenId) {
    try { closeTopSheet(); } catch(e) {}
    settingsReturnScreen = screenId || 'screen-home';
    showScreen('screen-settings');
}
function openWorkoutsActions() {
    const ov = document.createElement('div');
    ov.className = 'notif-side-overlay action-menu-overlay';
    ov.innerHTML = `<div class="notif-side-sheet"><div class="notif-side-grabber"><div class="notif-side-grabber-bar"></div></div><h2 class="sheet-title">Действия</h2><button class="btn accent" onclick="closeTopSheet(); if(workoutsSelectionMode) exitWorkoutsBulkMode(); openEditor(null, false);">+ Создать тренировку</button><button class="btn ghost" onclick="closeTopSheet(); ${workoutsSelectionMode ? 'exitWorkoutsBulkMode()' : 'enterWorkoutsBulkMode()'};">${workoutsSelectionMode ? 'Отменить выбор' : 'Выбрать'}</button><button class="btn ghost" onclick="closeTopSheet(); renderWorkoutsList(); showToast('Обновлено');">Обновить</button><button class="btn ghost" onclick="openGlobalSettingsFrom('screen-workouts')">⚙️ Общие настройки</button>${DB.workouts.length > 0 ? `<button class="btn danger" onclick="closeTopSheet(); deleteAllWorkouts();">Удалить все (${DB.workouts.length})</button>` : ''}<button class="btn sheet-btn-cancel" onclick="closeTopSheetCancel()">Отмена</button></div>`;
    decorateActionMenu(ov, 'Тренировки');
    document.body.appendChild(ov);
    setupSideSwipe(ov.querySelector('.notif-side-sheet'), ov);
    ov.addEventListener('click', (e) => { if (e.target === ov) ov.remove(); });
}
function enterWorkoutsBulkMode() { workoutsSelectionMode = true; workoutsSelectedIds = new Set(); renderWorkoutsList(); }
function exitWorkoutsBulkMode() { workoutsSelectionMode = false; workoutsSelectedIds = new Set(); const bar = document.getElementById('workouts-bulk-bar'); if (bar) bar.remove(); renderWorkoutsList(); }
function toggleWorkoutSelection(id) { if (workoutsSelectedIds.has(id)) workoutsSelectedIds.delete(id); else workoutsSelectedIds.add(id); renderWorkoutsList(); }
async function deleteSelectedWorkouts() {
    const ids = [...workoutsSelectedIds];
    if (ids.length === 0) return;
    if (!await customConfirm(`Удалить ${ids.length} тренировок?`, { danger: true, okText: 'Удалить' })) return;
    const removed = [];
    DB.workouts = DB.workouts.filter(w => { if (workoutsSelectedIds.has(w.id)) { removed.push(w); return false; } return true; });
    saveDB('workouts');
    workoutsSelectionMode = false; workoutsSelectedIds = new Set();
    renderWorkoutsList();
    showUndoToast(`Удалено ${removed.length} тренировок`, () => { DB.workouts.push(...removed); saveDB('workouts'); renderWorkoutsList(); showToast('Восстановлено'); });
}
async function deleteAllWorkouts() {
    if (DB.workouts.length === 0) { showToast('Нет тренировок'); return; }
    if (!await customConfirm(`Удалить все ${DB.workouts.length} тренировок?`, { danger: true, okText: 'Удалить всё' })) return;
    const backup = [...DB.workouts];
    DB.workouts = [];
    saveDB('workouts'); renderWorkoutsList();
    showUndoToast(`Удалено ${backup.length} тренировок`, () => { DB.workouts = backup; saveDB('workouts'); renderWorkoutsList(); showToast('Восстановлено'); });
}

function openTemplatesActions() {
    const hiddenCount = DB.settings.hiddenBuiltins.length;
    const userCount = DB.templates.length;
    const ov = document.createElement('div');
    ov.className = 'notif-side-overlay action-menu-overlay';
    ov.innerHTML = `<div class="notif-side-sheet"><div class="notif-side-grabber"><div class="notif-side-grabber-bar"></div></div><h2 class="sheet-title">Действия</h2><button class="btn accent" onclick="closeTopSheet(); if(templatesSelectionMode) exitTemplatesBulkMode(); openEditor(null, true);">+ Создать шаблон</button><button class="btn ghost" onclick="closeTopSheet(); ${templatesSelectionMode ? 'exitTemplatesBulkMode()' : 'enterTemplatesBulkMode()'};">${templatesSelectionMode ? 'Отменить выбор' : 'Выбрать'}</button><button class="btn ghost" onclick="closeTopSheet(); renderTemplates(); showToast('Обновлено');">Обновить</button><button class="btn ghost" onclick="openGlobalSettingsFrom('screen-templates')">⚙️ Общие настройки</button>${userCount > 0 ? `<button class="btn danger" onclick="closeTopSheet(); deleteAllTemplates();">Удалить все мои шаблоны (${userCount})</button>` : ''}${hiddenCount > 0 ? `<button class="btn ghost" onclick="closeTopSheet(); restoreBuiltins();">🔄 Восстановить скрытые (${hiddenCount})</button>` : ''}<button class="btn sheet-btn-cancel" onclick="closeTopSheetCancel()">Отмена</button></div>`;
    decorateActionMenu(ov, 'Шаблоны');
    document.body.appendChild(ov);
    setupSideSwipe(ov.querySelector('.notif-side-sheet'), ov);
    ov.addEventListener('click', (e) => { if (e.target === ov) ov.remove(); });
}
function enterTemplatesBulkMode() { templatesSelectionMode = true; templatesSelectedIds = new Set(); renderTemplates(); }
function exitTemplatesBulkMode() { templatesSelectionMode = false; templatesSelectedIds = new Set(); const bar = document.getElementById('templates-bulk-bar'); if (bar) bar.remove(); renderTemplates(); }
function toggleTemplateSelection(id) { if (templatesSelectedIds.has(id)) templatesSelectedIds.delete(id); else templatesSelectedIds.add(id); renderTemplates(); }
async function deleteSelectedTemplates() {
    const ids = [...templatesSelectedIds];
    if (ids.length === 0) return;
    if (!await customConfirm(`Удалить ${ids.length} шаблонов?`, { danger: true, okText: 'Удалить' })) return;
    const removed = [];
    DB.templates = DB.templates.filter(t => { if (templatesSelectedIds.has(t.id)) { removed.push(t); return false; } return true; });
    saveDB('templates');
    templatesSelectionMode = false; templatesSelectedIds = new Set();
    renderTemplates();
    showUndoToast(`Удалено ${removed.length} шаблонов`, () => { DB.templates.push(...removed); saveDB('templates'); renderTemplates(); showToast('Восстановлено'); });
}
async function deleteAllTemplates() {
    if (DB.templates.length === 0) return;
    if (!await customConfirm(`Удалить все ${DB.templates.length} моих шаблонов?`, { danger: true, okText: 'Удалить всё' })) return;
    const backup = [...DB.templates];
    DB.templates = [];
    saveDB('templates'); renderTemplates();
    showUndoToast(`Удалено ${backup.length} шаблонов`, () => { DB.templates = backup; saveDB('templates'); renderTemplates(); showToast('Восстановлено'); });
}

function openProgramsActions() {
    const ov = document.createElement('div');
    ov.className = 'notif-side-overlay action-menu-overlay';
    ov.innerHTML = `<div class="notif-side-sheet"><div class="notif-side-grabber"><div class="notif-side-grabber-bar"></div></div><h2 class="sheet-title">Действия</h2><button class="btn accent" onclick="closeTopSheet(); if(programsSelectionMode) exitProgramsBulkMode(); openProgramEditor(null);">+ Создать программу</button><button class="btn ghost" onclick="closeTopSheet(); ${programsSelectionMode ? 'exitProgramsBulkMode()' : 'enterProgramsBulkMode()'};">${programsSelectionMode ? 'Отменить выбор' : 'Выбрать'}</button><button class="btn ghost" onclick="closeTopSheet(); renderPrograms(); showToast('Обновлено');">Обновить</button><button class="btn ghost" onclick="openGlobalSettingsFrom('screen-programs')">⚙️ Общие настройки</button>${DB.programs.length > 0 ? `<button class="btn danger" onclick="closeTopSheet(); deleteAllPrograms();">Удалить все (${DB.programs.length})</button>` : ''}<button class="btn sheet-btn-cancel" onclick="closeTopSheetCancel()">Отмена</button></div>`;
    decorateActionMenu(ov, 'Программы');
    document.body.appendChild(ov);
    setupSideSwipe(ov.querySelector('.notif-side-sheet'), ov);
    ov.addEventListener('click', (e) => { if (e.target === ov) ov.remove(); });
}
function enterProgramsBulkMode() { programsSelectionMode = true; programsSelectedIds = new Set(); renderPrograms(); }
function exitProgramsBulkMode() { programsSelectionMode = false; programsSelectedIds = new Set(); const bar = document.getElementById('programs-bulk-bar'); if (bar) bar.remove(); renderPrograms(); }
function toggleProgramSelection(id) { if (programsSelectedIds.has(id)) programsSelectedIds.delete(id); else programsSelectedIds.add(id); renderPrograms(); }
async function deleteSelectedPrograms() {
    const ids = [...programsSelectedIds];
    if (ids.length === 0) return;
    if (!await customConfirm(`Удалить ${ids.length} программ?`, { danger: true, okText: 'Удалить' })) return;
    const removed = [];
    DB.programs = DB.programs.filter(p => { if (programsSelectedIds.has(p.id)) { removed.push(p); return false; } return true; });
    saveDB('programs');
    programsSelectionMode = false; programsSelectedIds = new Set();
    renderPrograms();
    showUndoToast(`Удалено ${removed.length} программ`, () => { DB.programs.push(...removed); saveDB('programs'); renderPrograms(); showToast('Восстановлено'); });
}
async function deleteAllPrograms() {
    if (DB.programs.length === 0) return;
    if (!await customConfirm(`Удалить все ${DB.programs.length} программ?`, { danger: true, okText: 'Удалить всё' })) return;
    const backup = [...DB.programs];
    DB.programs = [];
    saveDB('programs'); renderPrograms();
    showUndoToast(`Удалено ${backup.length} программ`, () => { DB.programs = backup; saveDB('programs'); renderPrograms(); showToast('Восстановлено'); });
}

function toggleMeasureSection(secKey) {
    const map = {
        current: 'measurementsCurrentCollapsed',
        body: 'measurementsBodyCollapsed',
        chart: 'measurementsChartCollapsed'
    };
    const sk = map[secKey];
    if (!sk) return;
    DB.settings[sk] = !DB.settings[sk];
    saveDB('settings');
    renderMeasurements();
}
function getMeasurementsCardsOnScreen() {
    return Array.from(document.querySelectorAll('#measurements-sections .measure-section-card'));
}
function getMeasurementsBulkToggleLabel() {
    const anyOpen = !DB.settings.measurementsCurrentCollapsed || !DB.settings.measurementsBodyCollapsed || !DB.settings.measurementsHistoryCollapsed;
    return anyOpen ? 'Свернуть все разделы' : 'Развернуть все разделы';
}
function toggleAllMeasurementsCards() {
    const anyOpen = !DB.settings.measurementsCurrentCollapsed || !DB.settings.measurementsBodyCollapsed || !DB.settings.measurementsHistoryCollapsed;
    const collapse = anyOpen;
    DB.settings.measurementsCurrentCollapsed = collapse;
    DB.settings.measurementsBodyCollapsed = collapse;
    DB.settings.measurementsHistoryCollapsed = collapse;
    saveDB('settings');
    renderMeasurements();
    showToast(collapse ? 'Все разделы свёрнуты' : 'Все разделы развёрнуты');
}
function openMeasurementsActions() {
    const ov = document.createElement('div');
    ov.className = 'notif-side-overlay action-menu-overlay';
    const metricKey = measurementsActiveMetric || 'weight';
    const goals = (DB.settings && DB.settings.measurementGoals && typeof DB.settings.measurementGoals === 'object') ? DB.settings.measurementGoals : {};
    const hasGoal = typeof goals[metricKey] === 'number';
    const goalBtnLabel = hasGoal ? '🎯 Изменить цель' : '🎯 Задать цель';
    ov.innerHTML = `<div class="notif-side-sheet"><div class="notif-side-grabber"><div class="notif-side-grabber-bar"></div></div><h2 class="sheet-title">Действия</h2>
        <button class="btn accent" onclick="closeTopSheet(); if(measurementsSelectionMode) exitMeasurementsBulkMode(); openMeasurementForm();">+ Добавить замер</button>
        <button class="btn ghost" onclick="closeTopSheet(); openMeasurementGoalEditor('${metricKey}');">${goalBtnLabel}</button>
        <button class="btn ghost" onclick="closeTopSheet(); toggleAllMeasurementsCards();">${getMeasurementsBulkToggleLabel()}</button>
        <button class="btn ghost" onclick="closeTopSheet(); ${measurementsSelectionMode ? 'exitMeasurementsBulkMode()' : 'enterMeasurementsBulkMode()'};">${measurementsSelectionMode ? 'Отменить выбор' : 'Выбрать'}</button>
        <button class="btn ghost" onclick="closeTopSheet(); renderMeasurements(); showToast('Обновлено');">Обновить</button>
        <button class="btn ghost" onclick="openGlobalSettingsFrom('screen-measurements')">⚙️ Общие настройки</button>
        ${DB.measurements.length > 0 ? `<button class="btn danger" onclick="closeTopSheet(); deleteAllMeasurements();">Удалить все (${DB.measurements.length})</button>` : ''}
        <button class="btn sheet-btn-cancel" onclick="closeTopSheetCancel()">Отмена</button></div>`;
    decorateActionMenu(ov, 'Замеры');
    document.body.appendChild(ov);
    setupSideSwipe(ov.querySelector('.notif-side-sheet'), ov);
    ov.addEventListener('click', (e) => { if (e.target === ov) ov.remove(); });
}
function enterMeasurementsBulkMode() { measurementsSelectionMode = true; measurementsSelectedIds = new Set(); renderMeasurements(); }
function exitMeasurementsBulkMode() { measurementsSelectionMode = false; measurementsSelectedIds = new Set(); const bar = document.getElementById('measurements-bulk-bar'); if (bar) bar.remove(); renderMeasurements(); }
function toggleMeasurementSelection(id) { if (measurementsSelectedIds.has(id)) measurementsSelectedIds.delete(id); else measurementsSelectedIds.add(id); renderMeasurements(); }
async function deleteSelectedMeasurements() {
    const ids = [...measurementsSelectedIds];
    if (ids.length === 0) return;
    if (!await customConfirm(`Удалить ${ids.length} замеров?`, { danger: true, okText: 'Удалить' })) return;
    const removed = [];
    DB.measurements = DB.measurements.filter(m => { if (measurementsSelectedIds.has(m.id)) { removed.push(m); return false; } return true; });
    saveDB('measurements');
    measurementsSelectionMode = false; measurementsSelectedIds = new Set();
    renderMeasurements();
    showUndoToast(`Удалено ${removed.length} замеров`, () => { DB.measurements.push(...removed); saveDB('measurements'); renderMeasurements(); showToast('Восстановлено'); });
}
async function deleteAllMeasurements() {
    if (DB.measurements.length === 0) return;
    if (!await customConfirm(`Удалить все ${DB.measurements.length} замеров?`, { danger: true, okText: 'Удалить всё' })) return;
    const backup = [...DB.measurements];
    DB.measurements = [];
    saveDB('measurements'); renderMeasurements();
    showUndoToast(`Удалено ${backup.length} замеров`, () => { DB.measurements = backup; saveDB('measurements'); renderMeasurements(); showToast('Восстановлено'); });
}

function getActiveWeek(program, date) {
    if (!program.weeks || program.weeks.length === 0) return null;
    const d = new Date(date); d.setHours(0,0,0,0);
    let found = null;
    for (const w of program.weeks) {
        if (!w || !w.days || !w.startDate) continue;
        const s = parseDateKey(w.startDate), e = addDays(s, 6);
        if (d >= s && d <= e) found = w;
    }
    return found;
}
function toggleProgramsCalendar() { DB.settings.programsCalendarCollapsed = !DB.settings.programsCalendarCollapsed; saveDB('settings'); renderPrograms(); }
function updateProgramsCalendarBtn() {
    const btn = document.getElementById('toggle-calendar-btn');
    if (!btn) return;
    const collapsed = !!DB.settings.programsCalendarCollapsed;
    btn.innerHTML = collapsed ? '<svg viewBox="0 0 24 24" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>' : '<svg viewBox="0 0 24 24" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>';
    btn.setAttribute('aria-label', collapsed ? 'Развернуть календарь' : 'Свернуть календарь');
}
function renderPrograms() {
    const calEl = document.getElementById('programs-calendar');
    const listEl = document.getElementById('programs-list');
    if (calEl) { calEl.style.display = DB.settings.programsCalendarCollapsed ? 'none' : 'block'; }
    updateProgramsCalendarBtn();
    try { if (!DB.settings.programsCalendarCollapsed) renderProgramsCalendar(); } catch(e) { console.error('[renderPrograms calendar]', e); }
    if (!listEl) return;
    // Кнопка «Создать программу» сверху — только если уже есть хотя бы одна программа
    const progActions = document.getElementById('programs-bottom-actions');
    if (progActions) progActions.style.display = DB.programs.length > 0 ? '' : 'none';
    try {
        if (DB.programs.length === 0) {
            listEl.innerHTML = `<div class="empty-state"><span class="icon">📅</span><div class="title">Пока нет программ</div>
                <div style="margin-bottom:14px;">Составьте план по неделям — приложение напомнит о тренировках.</div>
                <button class="btn accent" onclick="openProgramEditor(null)" style="max-width:280px;margin:0 auto;">+ Создать программу</button>
            </div>`;
            const existingBar = document.getElementById('programs-bulk-bar'); if (existingBar) existingBar.remove(); return;
        }
        const today = new Date(), todayKey = getTodayKey();
        listEl.innerHTML = DB.programs.map(p => {
            const week = getActiveWeek(p, today);
            let todayInfo = 'сегодня вне программы';
            if (week) {
                const ids = (week.days && week.days[todayKey]) || [];
                const isDeloadDay = !!(week.deloadDays && week.deloadDays[todayKey]);
                if (ids.length > 0) todayInfo = `Сегодня: ${ids.map(id => (DB.workouts.find(x => x.id === id) || {}).name || '?').join(' → ')}${isDeloadDay ? ' 🏷' : ''}`;
                else todayInfo = 'Сегодня отдых';
            }
            // Статистика считается из существующего расписания и истории, схема данных не меняется.
            let planned = 0, done = 0, missed = 0, upcoming = 0;
            const occurrenceByDate = {};
            (p.weeks || []).forEach(pw => {
                if (!pw || !pw.days || !pw.startDate) return;
                DAY_KEYS.forEach((dk, di) => {
                    const date = addDays(parseDateKey(pw.startDate), di);
                    const dateKey = formatDateKey(date);
                    (pw.days[dk] || []).forEach(wid => {
                        const occKey = dateKey + ':' + wid;
                        const occIdx = occurrenceByDate[occKey] || 0;
                        occurrenceByDate[occKey] = occIdx + 1;
                        planned++;
                        const status = getPlanStatus(wid, date, occIdx).status;
                        if (status === 'done') done++;
                        else if (status === 'missed') missed++;
                        else if (status === 'pending' || status === 'future') upcoming++;
                    });
                });
            });
            const progress = planned ? Math.round(done / planned * 100) : 0;
            const isChecked = programsSelectedIds.has(p.id);
            if (programsSelectionMode) {
                return `<div class="card" style="cursor:pointer;" onclick="toggleProgramSelection(${p.id})"><div style="display:flex; align-items:center; gap:10px;"><div class="bulk-checkbox ${isChecked ? 'checked' : ''}"></div><div style="flex:1; min-width:0;"><div style="font-weight:700; font-size:1.05rem;">📅 ${escapeHtml(p.name)}</div><div style="color:var(--muted); font-size:0.82rem; margin-top:4px;">${(p.weeks||[]).length} ${pluralWeeks((p.weeks||[]).length)}</div></div></div></div>`;
            }
            return `<div class="card program-overview-card program-draggable-card" data-id="${p.id}" style="cursor:pointer;" onclick="openProgramEditor(${p.id})"><div class="program-overview-top"><div style="flex:1;min-width:0;"><div style="font-weight:750;font-size:1.05rem;">📅 ${escapeHtml(p.name)}</div><div class="program-overview-sub">${(p.weeks||[]).length} ${pluralWeeks((p.weeks||[]).length)} · ${planned} ${planned === 1 ? 'тренировка' : 'тренировок'} в плане</div></div><button type="button" class="icon-btn delete" onclick="event.preventDefault(); event.stopPropagation(); deleteProgramById(${p.id})" aria-label="Удалить" style="background:var(--card-2); border:none; color:var(--danger); width:36px; height:36px; border-radius:10px; font-size:1rem; cursor:pointer; flex-shrink:0; z-index:2; position:relative;">🗑</button></div><div class="program-overview-progress"><div class="program-overview-progress-head"><span>Выполнение</span><strong>${progress}%</strong></div><div class="program-overview-track"><span style="width:${progress}%"></span></div><div class="program-overview-stats"><span>✅ ${done} выполнено</span><span>❌ ${missed} пропущено</span><span>⏳ ${upcoming} впереди</span></div></div><div class="program-overview-today">${escapeHtml(todayInfo)}</div></div>`;
        }).join('');
        if (!programsSelectionMode) {
            listEl.querySelectorAll('.program-draggable-card').forEach(el => {
                initDragAndDrop(el, { containerSelector: '#programs-list', itemSelector: '.program-draggable-card', dbKey: 'programs' });
            });
        }
        const existingBar = document.getElementById('programs-bulk-bar');
        if (existingBar) existingBar.remove();
        if (programsSelectionMode && programsSelectedIds.size > 0) {
            const bar = document.createElement('div');
            bar.className = 'bulk-action-bar';
            bar.id = 'programs-bulk-bar';
            bar.innerHTML = `<button class="btn danger small" onclick="deleteSelectedPrograms()" style="width:100%;">Удалить ${programsSelectedIds.size}</button>`;
            document.body.appendChild(bar);
        }
    } catch(e) { console.error('[renderPrograms list]', e); }
}
function renderProgramsCalendar() {
    const c = document.getElementById('programs-calendar');
    if (!c) return;
    try {
        const today = new Date(); today.setHours(0,0,0,0);
        const monthStart = new Date(programsCalendarMonth.getFullYear(), programsCalendarMonth.getMonth(), 1);
        const monthEnd = new Date(programsCalendarMonth.getFullYear(), programsCalendarMonth.getMonth() + 1, 0);
        const firstDow = (monthStart.getDay() + 6) % 7;
        const daysInMonth = monthEnd.getDate();
        const monthNames = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
        const planByDay = {};
        DB.programs.forEach(p => {
            try {
                (p.weeks || []).forEach(w => {
                    if (!w || !w.days || !w.startDate) return;
                    DAY_KEYS.forEach((dk, dayIdx) => {
                        const date = addDays(parseDateKey(w.startDate), dayIdx);
                        const dateKey = formatDateKey(date);
                        if (!planByDay[dateKey]) planByDay[dateKey] = [];
                        const isDeloadDay = !!(w.deloadDays && w.deloadDays[dk]);
                        (w.days[dk] || []).forEach(wid => {
                            const occIdx = planByDay[dateKey].filter(x => x.wid === wid).length;
                            planByDay[dateKey].push({ wid, programId: p.id, programName: p.name, occIdx, isDeload: isDeloadDay });
                        });
                    });
                });
            } catch(e) { console.warn('[calendar program skip]', e); }
        });
        const cells = [];
        for (let i = 0; i < firstDow; i++) cells.push({ type: 'empty' });
        for (let d = 1; d <= daysInMonth; d++) {
            const date = new Date(programsCalendarMonth.getFullYear(), programsCalendarMonth.getMonth(), d);
            const dateKey = formatDateKey(date);
            const isToday = date.getTime() === today.getTime();
            const plan = planByDay[dateKey] || [];
            let doneCount = 0;
            try { doneCount = plan.filter(x => { try { return getPlanStatus(x.wid, date, x.occIdx).status === 'done'; } catch(e) { return false; } }).length; } catch(e) { doneCount = 0; }
            const hasWorkouts = plan.length > 0;
            const hasDeload = plan.some(x => x.isDeload);
            const hasDone = doneCount > 0 && doneCount === plan.length;
            const dots = plan.slice(0, 4).map(x => { try { const st = getPlanStatus(x.wid, date, x.occIdx); return `<div class="day-dot ${st.status === 'done' ? 'done' : ''}${x.isDeload ? ' deload' : ''}"></div>`; } catch(e) { return `<div class="day-dot"></div>`; } }).join('');
            const cls = ['prog-calendar-day'];
            if (isToday) cls.push('today');
            if (hasWorkouts) cls.push('has-workouts');
            if (hasDone) cls.push('has-done');
            if (hasDeload) cls.push('has-deload');
            cells.push({ type: 'day', day: d, date, dateKey, cls: cls.join(' '), dots, count: plan.length });
        }
        const monthName = monthNames[programsCalendarMonth.getMonth()] || '';
        const year = programsCalendarMonth.getFullYear();
        c.innerHTML = `<div class="prog-calendar"><div class="prog-calendar-header"><div class="prog-calendar-title">${monthName} ${year}</div><div class="prog-calendar-nav"><button onclick="changeCalendarMonth(-1)" aria-label="Назад">‹</button><button onclick="changeCalendarMonth(1)" aria-label="Вперёд">›</button></div></div><div class="prog-calendar-grid">${['Пн','Вт','Ср','Чт','Пт','Сб','Вс'].map(d => `<div class="prog-calendar-dow">${d}</div>`).join('')}${cells.map(cell => { if (cell.type === 'empty') return '<div></div>'; return `<div class="${cell.cls}" onclick="showCalendarDay(${cell.date.getFullYear()}, ${cell.date.getMonth()}, ${cell.date.getDate()})"><div class="day-num">${cell.day}</div>${cell.dots ? `<div class="day-dots">${cell.dots}</div>` : ''}</div>`; }).join('')}</div></div>`;
    } catch(e) { console.error('[renderProgramsCalendar error]', e); c.innerHTML = '<div class="empty-state"><span class="icon">⚠️</span><div class="title">Ошибка календаря</div>' + escapeHtml(String(e.message || e)) + '</div>'; }
}
function changeCalendarMonth(delta) { try { programsCalendarMonth = new Date(programsCalendarMonth.getFullYear(), programsCalendarMonth.getMonth() + delta, 1); renderProgramsCalendar(); } catch(e) { console.error('[changeCalendarMonth]', e); } }
function showCalendarDay(year, month, day) {
    try {
        const date = new Date(year, month, day);
        const dateKey = formatDateKey(date);
        const entries = [];
        const occMap = {};
        DB.programs.forEach(p => {
            (p.weeks || []).forEach(w => {
                if (!w || !w.days || !w.startDate) return;
                DAY_KEYS.forEach((dk, dayIdx) => {
                    const d = addDays(parseDateKey(w.startDate), dayIdx);
                    if (formatDateKey(d) === dateKey) {
                        const isDeloadDay = !!(w.deloadDays && w.deloadDays[dk]);
                        (w.days[dk] || []).forEach(wid => {
                            const occIdx = occMap[wid] || 0;
                            occMap[wid] = occIdx + 1;
                            const wObj = DB.workouts.find(x => x.id === wid);
                            entries.push({ wid, wName: wObj ? wObj.name : '(удалено)', program: p, occIdx, status: getPlanStatus(wid, date, occIdx), isDeload: isDeloadDay });
                        });
                    }
                });
            });
        });
        const months = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
        const title = `${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()}`;
        if (entries.length === 0) { showToast(`${title} · нет планов`); return; }
        const ov = document.createElement('div');
        ov.className = 'notif-side-overlay';
        ov.innerHTML = `<div class="notif-side-sheet"><div class="notif-side-grabber"><div class="notif-side-grabber-bar"></div></div><h2 class="sheet-title">${title}</h2><div style="flex:1; overflow-y:auto; display:flex; flex-direction:column; gap:8px;">${entries.map(e => { 
            const icon = e.status.status === 'done' ? '✅' : e.status.status === 'missed' ? '❌' : '⏳'; 
            const deloadBadge = e.isDeload ? ` <span style="background:var(--warn); color:#0a0a10; font-size:0.65rem; font-weight:700; padding:2px 6px; border-radius:6px;">РАЗГРУЗКА</span>` : ''; 
            const isDone = e.status.status === 'done';
            const recordId = e.status.recordId;
            let action = '';
            if (isDone && recordId) {
                action = `openHistoryItemDetail(${recordId})`;
            } else {
                action = `closeTopSheet(); startWorkout(${e.wid}, ${!!e.isDeload})`;
            }
            return `<div class="notif-item" style="cursor:pointer;" onclick="${action}"><div class="notif-status">${icon}</div><div class="notif-body"><div class="notif-name">${escapeHtml(e.wName)}${deloadBadge}</div><div class="notif-sub">📅 ${escapeHtml(e.program.name)}</div></div><div style="font-size:1.2rem; color:var(--muted);">›</div></div>`; }).join('')}</div><button class="btn sheet-btn-cancel" onclick="closeTopSheet()">Закрыть</button></div>`;
        document.body.appendChild(ov);
        setupSideSwipe(ov.querySelector('.notif-side-sheet'), ov);
        ov.addEventListener('click', (e) => { if (e.target === ov) ov.remove(); });
    } catch(e) { console.error('[showCalendarDay]', e); }
}
function openProgramEditor(id) {
    editingProgramId = id;
    if (id === null) {
        const monday = startOfWeekMonday(new Date());
        editorProgram = { name: '', weeks: [{ startDate: formatDateKey(monday), days: { mon:[], tue:[], wed:[], thu:[], fri:[], sat:[], sun:[] }, deloadDays: { mon:false, tue:false, wed:false, thu:false, fri:false, sat:false, sun:false } }] };
        document.getElementById('program-name').value = '';
        document.getElementById('program-editor-title').innerText = 'Новая программа';
        document.getElementById('program-delete-btn').style.display = 'none';
    } else {
        const p = DB.programs.find(x => x.id === id);
        if (!p) return;
        editorProgram = JSON.parse(JSON.stringify(p));
        if (!editorProgram.weeks || editorProgram.weeks.length === 0) { const monday = startOfWeekMonday(new Date()); editorProgram.weeks = [{ startDate: formatDateKey(monday), days: { mon:[], tue:[], wed:[], thu:[], fri:[], sat:[], sun:[] }, deloadDays: { mon:false, tue:false, wed:false, thu:false, fri:false, sat:false, sun:false } }]; }
        editorProgram.weeks.forEach(w => {
            if (!w.days) w.days = {};
            if (!w.deloadDays || typeof w.deloadDays !== 'object') w.deloadDays = {};
            DAY_KEYS.forEach(k => {
                if (!Array.isArray(w.days[k])) w.days[k] = w.days[k] ? [w.days[k]] : [];
                if (typeof w.deloadDays[k] !== 'boolean') w.deloadDays[k] = false;
            });
        });
        document.getElementById('program-name').value = p.name || '';
        document.getElementById('program-editor-title').innerText = 'Редактирование';
        document.getElementById('program-delete-btn').style.display = 'block';
    }
    renderProgramWeeksList();
    showScreen('screen-program-editor');
}
function cancelProgramEditor() { showScreen('screen-programs'); notifyCancelled(); }
function renderProgramWeeksList() {
    const c = document.getElementById('program-weeks-list');
    if (!c) return;
    const todayKey = formatDateKey(new Date());
    c.innerHTML = editorProgram.weeks.map((w, idx) => {
        const isCollapsed = collapsedWeeks[w.startDate];
        const s = parseDateKey(w.startDate), e = addDays(s, 6);
        const t = parseDateKey(todayKey);
        const isCurrent = t >= s && t <= e;
        let daysHtml = '';
        DAY_KEYS.forEach((dk, dayIdx) => {
            const ids = w.days[dk] || [];
            const isDeload = !!(w.deloadDays && w.deloadDays[dk]);
            const dk_date = addDays(parseDateKey(w.startDate), dayIdx);
            const dk_dateKey = formatDateKey(dk_date);
            const isToday = dk_dateKey === todayKey;
            const isPast = dk_dateKey < todayKey;
            if (isPast) {
                let itemsHtml; let doneCount = 0;
                const occMap = {};
                if (ids.length === 0) itemsHtml = '—';
                else {
                    itemsHtml = ids.map(id => {
                        const occIdx = occMap[id] || 0;
                        occMap[id] = occIdx + 1;
                        const wo = DB.workouts.find(x => x.id === id);
                        const name = wo ? wo.name : '(удалено)';
                        const st = getPlanStatus(id, dk_date, occIdx);
                        if (st.status === 'done') { doneCount++; return `<span style="color:var(--accent);">✅ ${escapeHtml(name)}</span>`; }
                        return `<span style="color:var(--danger);">❌ ${escapeHtml(name)}</span>`;
                    }).join(' ');
                }
                const counter = ids.length > 0 ? `<span class="day-count" style="background:${doneCount === ids.length ? 'var(--accent)' : 'var(--danger)'};">${doneCount} из ${ids.length}</span>` : '';
                daysHtml += `<div class="week-day-row ${isToday ? 'today' : ''}${isDeload ? ' deload-day' : ''}" onclick="showToast('Прошедший день нельзя менять')"><span class="day-name">${DAY_NAMES_SHORT[dk]}</span><span class="day-workouts">${itemsHtml}</span>${isDeload ? '<span class="day-deload-badge">🏷</span>' : ''}${counter}</div>`;
            } else {
                const names = ids.map(id => (DB.workouts.find(x => x.id === id) || {}).name || '(удалено)');
                daysHtml += `<div class="week-day-row ${isToday ? 'today' : ''}${isDeload ? ' deload-day' : ''}" onclick="openDayEditor(${idx}, '${dk}')"><span class="day-name">${DAY_NAMES_SHORT[dk]}</span><span class="day-workouts">${names.length ? escapeHtml(names.join(' → ')) : '—'}</span>${isDeload ? '<span class="day-deload-badge">🏷</span>' : ''}${ids.length ? `<span class="day-count">${ids.length}</span>` : ''}</div>`;
            }
        });
        return `<div class="week-block"><div class="week-header" onclick="toggleWeekCollapse('${w.startDate}')"><div><div class="week-title">${isCurrent ? '📅 ' : ''}Неделя ${idx + 1}${isCurrent ? ' (текущая)' : ''}</div><div class="week-subtitle">${formatWeekRange(w.startDate)}</div></div><div style="color:var(--muted); font-size:1.2rem;">${isCollapsed ? '▸' : '▾'}</div></div>${isCollapsed ? '' : `<div class="week-days">${daysHtml}</div><div class="week-actions"><button type="button" class="btn ghost small" onclick="event.preventDefault(); event.stopPropagation(); copyWeek(${idx})" style="flex:1;">📋 Скопировать неделю</button><button type="button" class="btn ghost small" onclick="event.preventDefault(); event.stopPropagation(); deleteWeek(${idx})" style="color:var(--danger); min-width:44px;" aria-label="Удалить неделю">🗑 Удалить неделю</button></div>`}</div>`;
    }).join('');
}
function toggleWeekCollapse(key) { collapsedWeeks[key] = !collapsedWeeks[key]; renderProgramWeeksList(); }
function addWeekToEditor() {
    const last = editorProgram.weeks[editorProgram.weeks.length - 1];
    const start = last ? formatDateKey(addDays(parseDateKey(last.startDate), 7)) : formatDateKey(startOfWeekMonday(new Date()));
    editorProgram.weeks.push({ startDate: start, days: { mon:[], tue:[], wed:[], thu:[], fri:[], sat:[], sun:[] }, deloadDays: { mon:false, tue:false, wed:false, thu:false, fri:false, sat:false, sun:false } });
    renderProgramWeeksList();
}
function isProgramWeekEmpty(w) {
    if (!w || !w.days) return true;
    return DAY_KEYS.every(k => !((w.days[k] || []).length));
}
function programWeekHasContent(w) {
    if (!w) return false;
    if (!isProgramWeekEmpty(w)) return true;
    // Делоад-метки без тренировок не считаем «данными»
    return false;
}
async function deleteWeek(idx) {
    try {
        if (!editorProgram || !Array.isArray(editorProgram.weeks)) return;
        if (idx < 0 || idx >= editorProgram.weeks.length) return;
        if (editorProgram.weeks.length <= 1) {
            showToast('Должна остаться хотя бы одна неделя');
            return;
        }
        const w = editorProgram.weeks[idx];
        const hasData = programWeekHasContent(w);
        if (hasData) {
            const ok = await customConfirm(
                'В этой неделе есть запланированные тренировки.\n\nВсе данные этой недели будут удалены безвозвратно.',
                { title: 'Удалить неделю?', danger: true, okText: '🗑 Удалить', cancelText: 'Отмена' }
            );
            if (!ok) return;
        }
        try { if (w && w.startDate && collapsedWeeks) delete collapsedWeeks[w.startDate]; } catch(e) {}
        editorProgram.weeks.splice(idx, 1);
        renderProgramWeeksList();
        showToast(hasData ? 'Неделя удалена' : 'Пустая неделя удалена');
    } catch (e) {
        console.error('[deleteWeek]', e);
        showToast('Не удалось удалить неделю');
    }
}
window.deleteWeek = deleteWeek;
function copyWeek(idx) {
    const src = editorProgram.weeks[idx];
    if (!src) return;
    const newStart = formatDateKey(addDays(parseDateKey(src.startDate), 7));
    const newWeek = { startDate: newStart, days: {}, deloadDays: {} };
    DAY_KEYS.forEach(k => {
        newWeek.days[k] = [...(src.days[k] || [])];
        newWeek.deloadDays[k] = !!(src.deloadDays && src.deloadDays[k]);
    });
    editorProgram.weeks.splice(idx + 1, 0, newWeek);
    renderProgramWeeksList();
    showToast(`📋 Скопировано на ${formatWeekRange(newStart)}`);
}
function renderDaySelected(weekIdx, dayKey) {
    const w = editorProgram.weeks[weekIdx];
    const ids = (w && w.days[dayKey]) || [];
    if (ids.length === 0) return '<div style="color:var(--muted); font-size:0.85rem; padding:12px; text-align:center;">Ничего не выбрано</div>';
    return ids.map((wid, idx) => {
        const wo = DB.workouts.find(x => x.id === wid);
        const name = wo ? wo.name : '(удалено)';
        const btnStyle = 'width:32px;height:32px;background:var(--card);border:1px solid var(--border-soft);border-radius:8px;color:var(--text);cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;';
        return `<div class="sound-option selected" style="cursor:default; padding:8px 10px; gap:6px;"><div class="sound-info"><div class="sound-name" style="font-size:0.9rem;">${idx + 1}. ${escapeHtml(name)}</div></div><button class="icon-btn" onclick="event.stopPropagation(); moveDayWorkout(${weekIdx}, '${dayKey}', ${idx}, -1)" ${idx === 0 ? 'disabled' : ''} aria-label="Выше" style="${btnStyle}${idx === 0 ? 'opacity:0.4;' : ''}">↑</button><button class="icon-btn" onclick="event.stopPropagation(); moveDayWorkout(${weekIdx}, '${dayKey}', ${idx}, 1)" ${idx === ids.length - 1 ? 'disabled' : ''} aria-label="Ниже" style="${btnStyle}${idx === ids.length - 1 ? 'opacity:0.4;' : ''}">↓</button><button class="icon-btn" onclick="event.stopPropagation(); removeDayWorkout(${weekIdx}, '${dayKey}', ${idx})" aria-label="Убрать" style="${btnStyle}color:var(--danger);">✕</button></div>`;
    }).join('');
}
function renderDayAvailable(weekIdx, dayKey) {
    if (DB.workouts.length === 0) return '<div style="color:var(--muted); font-size:0.85rem; padding:12px; text-align:center;">Нет тренировок</div>';
    return DB.workouts.map(wo => `<div class="sound-option" onclick="addDayWorkout(${weekIdx}, '${dayKey}', ${wo.id})" style="cursor:pointer;"><div class="radio"></div><div class="sound-info"><div class="sound-name" style="font-size:0.9rem;">${escapeHtml(wo.name)}</div></div><span style="color:var(--accent); font-size:1.3rem; font-weight:700; flex-shrink:0;">+</span></div>`).join('');
}
function refreshDayEditor(weekIdx, dayKey) {
    const ov = document.getElementById('day-editor-overlay');
    if (!ov) return;
    const selectedEl = ov.querySelector('#day-selected-list');
    const availableEl = ov.querySelector('#day-available-list');
    const countEl = ov.querySelector('#day-count-label');
    const w = editorProgram.weeks[weekIdx];
    const cur = (w && w.days[dayKey]) || [];
    if (selectedEl) selectedEl.innerHTML = renderDaySelected(weekIdx, dayKey);
    if (availableEl) availableEl.innerHTML = renderDayAvailable(weekIdx, dayKey);
    if (countEl) countEl.textContent = `${cur.length} выбрано`;
}
function openDayEditor(weekIdx, dayKey) {
    const week = editorProgram.weeks[weekIdx];
    if (!week) return;
    const currentIds = week.days[dayKey] || [];
    const isDeload = !!(week.deloadDays && week.deloadDays[dayKey]);
    const d = addDays(parseDateKey(week.startDate), DAY_KEYS.indexOf(dayKey));
    const months = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
    const title = `${DAY_NAMES_FULL[dayKey]}, ${d.getDate()} ${months[d.getMonth()]}`;
    const ov = document.createElement('div');
    ov.className = 'notif-side-overlay';
    ov.id = 'day-editor-overlay';
    ov.innerHTML = `<div class="notif-side-sheet" style="max-height: 85vh;"><div class="notif-side-grabber"><div class="notif-side-grabber-bar"></div></div><h2 class="sheet-title">${title}</h2><div style="color:var(--muted); font-size:0.85rem; text-align:center; flex-shrink:0;" id="day-count-label">${currentIds.length} выбрано</div><div class="sheet-scroll-area" style="flex:1; overflow-y:auto; display:flex; flex-direction:column; gap:8px; padding-right: 4px;"><div class="deload-day-toggle"><input type="checkbox" id="day-deload-checkbox" ${isDeload ? 'checked' : ''} onchange="toggleDayDeload(${weekIdx}, '${dayKey}', this.checked)"><label for="day-deload-checkbox" style="cursor:pointer; flex:1; font-size:0.85rem;">🏷 Разгрузочный день (снизить нагрузку на 35%)</label></div><div style="font-size:0.75rem; color:var(--muted); text-transform:uppercase; letter-spacing:1px;">Выбрано (в порядке выполнения)</div><div style="display:flex; flex-direction:column; gap:6px;" id="day-selected-list">${renderDaySelected(weekIdx, dayKey)}</div><div style="font-size:0.75rem; color:var(--muted); text-transform:uppercase; letter-spacing:1px; margin-top:6px;">Доступные</div><div style="display:flex; flex-direction:column; gap:6px;" id="day-available-list">${renderDayAvailable(weekIdx, dayKey)}</div></div><div class="sheet-fixed-bottom" style="flex-shrink: 0; display: flex; flex-direction: column; gap: 8px; padding-top: 4px;"><button class="btn accent" onclick="closeDayEditor()">Готово</button></div></div>`;
    document.body.appendChild(ov);
    setupSideSwipe(ov.querySelector('.notif-side-sheet'), ov);
    ov.addEventListener('click', (e) => { if (e.target === ov) closeDayEditor(); });
}
function toggleDayDeload(weekIdx, dayKey, checked) {
    const w = editorProgram.weeks[weekIdx];
    if (!w) return;
    if (!w.deloadDays) w.deloadDays = {};
    w.deloadDays[dayKey] = !!checked;
}
function addDayWorkout(weekIdx, dayKey, workoutId) { const w = editorProgram.weeks[weekIdx]; if (!w) return; if (!w.days[dayKey]) w.days[dayKey] = []; w.days[dayKey].push(workoutId); refreshDayEditor(weekIdx, dayKey); }
function removeDayWorkout(weekIdx, dayKey, idx) { const w = editorProgram.weeks[weekIdx]; if (!w || !w.days[dayKey]) return; w.days[dayKey].splice(idx, 1); if (w.days[dayKey].length === 0 && w.deloadDays && w.deloadDays[dayKey]) { w.deloadDays[dayKey] = false; } refreshDayEditor(weekIdx, dayKey); }
function moveDayWorkout(weekIdx, dayKey, idx, dir) { const w = editorProgram.weeks[weekIdx]; if (!w || !w.days[dayKey]) return; const arr = w.days[dayKey]; const j = idx + dir; if (j < 0 || j >= arr.length) return; [arr[idx], arr[j]] = [arr[j], arr[idx]]; refreshDayEditor(weekIdx, dayKey); }
function closeDayEditor() { const o = document.getElementById('day-editor-overlay'); if (o) o.remove(); renderProgramWeeksList(); }
function saveProgram() {
    const name = document.getElementById('program-name').value.trim();
    if (!name) { showToast('Введи название'); return; }
    editorProgram.weeks.sort((a, b) => a.startDate.localeCompare(b.startDate));
    const wasNew = editingProgramId === null;
    if (wasNew) DB.programs.push({ id: Date.now(), name, weeks: editorProgram.weeks });
    else { const p = DB.programs.find(x => x.id === editingProgramId); if (p) Object.assign(p, { name, weeks: editorProgram.weeks }); }
    saveDB('programs');
    showScreen('screen-programs');
    notifySaved(wasNew ? '✅ Программа создана' : '✅ Программа сохранена');
}
async function deleteProgram() {
    try {
        if (editingProgramId == null) {
            showToast('Сначала сохраните программу');
            return;
        }
        const ok = await customConfirm(
            'Удалить программу?\n\nИстория выполнения по ней тоже пропадёт.',
            { title: 'Удалить программу', danger: true, okText: '🗑 Удалить', cancelText: 'Отмена' }
        );
        if (!ok) return;
        const idx = DB.programs.findIndex(x => x.id === editingProgramId);
        if (idx < 0) {
            showToast('Программа не найдена');
            return;
        }
        const removed = DB.programs[idx];
        DB.programs.splice(idx, 1);
        saveDB('programs');
        showScreen('screen-programs');
        showUndoToast('Программа удалена', () => {
            DB.programs.splice(idx, 0, removed);
            saveDB('programs');
            renderPrograms();
            showToast('Восстановлено');
        });
    } catch (e) {
        console.error('[deleteProgram]', e);
        showToast('Не удалось удалить программу');
    }
}
async function deleteProgramById(id) {
    try {
        const pid = Number(id);
        if (!pid) return;
        const ok = await customConfirm(
            'Удалить программу?\n\nИстория выполнения по ней тоже пропадёт.',
            { title: 'Удалить программу', danger: true, okText: '🗑 Удалить', cancelText: 'Отмена' }
        );
        if (!ok) return;
        const idx = DB.programs.findIndex(x => x.id === pid);
        if (idx < 0) {
            showToast('Программа не найдена');
            return;
        }
        const removed = DB.programs[idx];
        DB.programs.splice(idx, 1);
        saveDB('programs');
        renderPrograms();
        showUndoToast('Программа удалена', () => {
            DB.programs.splice(idx, 0, removed);
            saveDB('programs');
            renderPrograms();
            showToast('Восстановлено');
        });
    } catch (e) {
        console.error('[deleteProgramById]', e);
        showToast('Не удалось удалить программу');
    }
}
window.deleteProgram = deleteProgram;
window.deleteProgramById = deleteProgramById;

function toggleBuiltinTemplates() {
    DB.settings.builtinTemplatesCollapsed = !DB.settings.builtinTemplatesCollapsed;
    saveDB('settings');
    renderTemplates();
}
function updateBuiltinToggleBtn() {
    const btn = document.getElementById('toggle-builtin-btn');
    if (!btn) return;
    const collapsed = !!DB.settings.builtinTemplatesCollapsed;
    btn.innerHTML = collapsed ? '<svg viewBox="0 0 24 24" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>' : '<svg viewBox="0 0 24 24" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>';
    btn.setAttribute('aria-label', collapsed ? 'Развернуть готовые шаблоны' : 'Свернуть готовые шаблоны');
}
function renderTemplates() {
    const userList = document.getElementById('user-templates-list');
    const builtinList = document.getElementById('builtin-templates-list');
    const userTitle = document.getElementById('user-templates-title');
    const builtinTitle = document.getElementById('builtin-templates-title');
    const builtinTitleRow = document.getElementById('builtin-templates-title-row');
    const toggleBtn = document.getElementById('toggle-builtin-btn');
    const emptyEl = document.getElementById('templates-empty');
    if (!userList || !builtinList) return;
    if (DB.templates.length > 0) {
        userTitle.style.display = 'block'; userList.style.display = 'block';
        userList.innerHTML = DB.templates.map(t => {
            const isChecked = templatesSelectedIds.has(t.id);
            if (templatesSelectionMode) {
                return `<div class="template-card" data-id="${t.id}" onclick="toggleTemplateSelection(${t.id})" style="cursor:pointer;"><div class="template-card-meta-row" style="align-items:center;"><div class="bulk-checkbox ${isChecked ? 'checked' : ''}"></div><div style="flex:1; min-width:0; margin-left:8px;"><div class="template-card-name" style="cursor:pointer;">${escapeHtml(t.name)}</div><div class="template-card-meta">${getTotalExerciseCount(t.exercises)} упр. · ${t.autoStart ? 'автозапуск' : 'ручной'}</div></div></div></div>`;
            }
            return `<div class="template-card" data-id="${t.id}"><div class="template-card-name" onclick="showTemplatePreview(${t.id}, false)">${escapeHtml(t.name)}</div><div class="template-card-meta-row"><div class="template-card-meta">${getTotalExerciseCount(t.exercises)} упр. · ${t.autoStart ? 'автозапуск' : 'ручной'}</div><div class="template-card-actions"><button class="icon-btn add" onclick="createFromTemplate(${t.id}, false)" title="Добавить" aria-label="Добавить в тренировки">+</button><button class="icon-btn" onclick="showTemplatePreview(${t.id}, false)" title="Просмотр" aria-label="Просмотр">👁</button><button class="icon-btn" onclick="openEditor(${t.id}, true)" title="Редактировать" aria-label="Редактировать">✏️</button><button class="icon-btn delete" onclick="deleteTemplate(${t.id})" title="Удалить" aria-label="Удалить">🗑</button></div></div></div>`;
        }).join('');
        if (!templatesSelectionMode) { userList.querySelectorAll('.template-card').forEach(el => { initDragAndDrop(el, { containerSelector: '#user-templates-list', itemSelector: '.template-card', dbKey: 'templates' }); }); }
    } else { userTitle.style.display = 'none'; userList.style.display = 'none'; userList.innerHTML = ''; }
    const visible = BUILTIN_TEMPLATES.filter(t => !DB.settings.hiddenBuiltins.includes(t.id));
    if (visible.length > 0) {
        builtinTitle.style.display = 'block';
        if (toggleBtn) toggleBtn.style.display = 'flex';
        if (builtinTitleRow) builtinTitleRow.style.display = 'flex';
        builtinList.style.display = DB.settings.builtinTemplatesCollapsed ? 'none' : 'block';
        updateBuiltinToggleBtn();
        if (!DB.settings.builtinTemplatesCollapsed) {
            builtinList.innerHTML = visible.map(t => `<div class="template-card"><div class="template-card-name" onclick="showTemplatePreview('${t.id}', true)">${escapeHtml(t.name)}</div><div class="template-card-meta-row"><div class="template-card-meta">${getTotalExerciseCount(t.exercises)} упр.</div><div class="template-card-actions"><button class="icon-btn add" onclick="createFromTemplate('${t.id}', true)" title="Добавить" aria-label="Добавить в тренировки">+</button><button class="icon-btn" onclick="showTemplatePreview('${t.id}', true)" title="Просмотр" aria-label="Просмотр">👁</button><button class="icon-btn" onclick="editBuiltinTemplate('${t.id}')" title="Редактировать" aria-label="Редактировать">✏️</button><button class="icon-btn delete" onclick="hideBuiltinTemplate('${t.id}')" title="Удалить" aria-label="Удалить">🗑</button></div></div></div>`).join('');
        } else {
            builtinList.innerHTML = '';
        }
    } else {
        builtinTitle.style.display = 'none';
        if (toggleBtn) toggleBtn.style.display = 'none';
        if (builtinTitleRow) builtinTitleRow.style.display = 'none';
        builtinList.style.display = 'none';
        builtinList.innerHTML = '';
    }
    emptyEl.style.display = (DB.templates.length === 0 && visible.length === 0) ? 'block' : 'none';
    const existingBar = document.getElementById('templates-bulk-bar');
    if (existingBar) existingBar.remove();
    if (templatesSelectionMode && templatesSelectedIds.size > 0) {
        const bar = document.createElement('div');
        bar.className = 'bulk-action-bar';
        bar.id = 'templates-bulk-bar';
        bar.innerHTML = `<button class="btn danger small" onclick="deleteSelectedTemplates()" style="width:100%;">Удалить ${templatesSelectedIds.size}</button>`;
        document.body.appendChild(bar);
    }
}
function createFromTemplate(id, isBuiltin) {
    const t = isBuiltin ? BUILTIN_TEMPLATES.find(x => x.id === id) : DB.templates.find(x => x.id === id);
    if (!t) return;
    const nw = JSON.parse(JSON.stringify(t));
    delete nw.builtin;
    nw.id = Date.now();
    DB.workouts.push(nw); saveDB('workouts');
    showToast('Добавлено в тренировки');
    showScreen('screen-workouts');
}
async function deleteTemplate(id) {
    if (!await customConfirm('Удалить шаблон?', { danger: true, okText: '🗑 Удалить' })) return;
    const idx = DB.templates.findIndex(t => t.id === id);
    if (idx < 0) return;
    const removed = DB.templates[idx];
    DB.templates.splice(idx, 1);
    saveDB('templates'); renderTemplates();
    showUndoToast('Шаблон удалён', () => { DB.templates.splice(idx, 0, removed); saveDB('templates'); renderTemplates(); showToast('Восстановлено'); });
}
async function hideBuiltinTemplate(id) {
    if (!await customConfirm('Скрыть шаблон?', { danger: true, okText: '👁‍🗨 Скрыть' })) return;
    if (!DB.settings.hiddenBuiltins.includes(id)) DB.settings.hiddenBuiltins.push(id);
    saveDB('settings'); renderTemplates();
    showUndoToast('Шаблон скрыт', () => { DB.settings.hiddenBuiltins = DB.settings.hiddenBuiltins.filter(x => x !== id); saveDB('settings'); renderTemplates(); showToast('Восстановлено'); });
}
function editBuiltinTemplate(id) {
    const t = BUILTIN_TEMPLATES.find(x => x.id === id);
    if (!t) return;
    const c = JSON.parse(JSON.stringify(t));
    delete c.builtin;
    c.id = Date.now(); c.name = t.name + ' (моя версия)';
    DB.templates.push(c); saveDB('templates'); openEditor(c.id, true);
}
async function restoreBuiltins() {
    if (DB.settings.hiddenBuiltins.length === 0) { showToast('Все шаблоны на месте'); return; }
    if (!await customConfirm(`Восстановить ${DB.settings.hiddenBuiltins.length} шаблонов?`, { danger: false, okText: '🔄 Восстановить' })) return;
    const backup = [...DB.settings.hiddenBuiltins];
    DB.settings.hiddenBuiltins = []; saveDB('settings');
    renderTemplates();
    renderSettings();
    showUndoToast('Шаблоны восстановлены', () => { DB.settings.hiddenBuiltins = backup; saveDB('settings'); renderTemplates(); renderSettings(); showToast('Отменено'); });
}
function showTemplatePreview(id, isBuiltin) {
    const t = isBuiltin ? BUILTIN_TEMPLATES.find(x => x.id === id) : DB.templates.find(x => x.id === id);
    if (!t) return;
    previewWorkoutId = null;
    document.getElementById('preview-title').innerText = t.name;
    document.getElementById('preview-back-btn').onclick = () => showScreen('screen-templates');
    document.getElementById('preview-content').innerHTML = `<div class="card"><div style="color:var(--muted); font-size:0.9rem;">${getTotalExerciseCount(t.exercises)} упр. · ~${Math.round(getTotalRestTime(t.exercises)/60)} мин отдыха</div></div>${renderPreviewElements(t.exercises)}`;
    document.getElementById('preview-actions').innerHTML = `<button class="btn accent" onclick="createFromTemplate('${id}', ${isBuiltin})">+ В тренировки</button>`;
    showScreen('screen-preview');
}
function renderPreviewElements(exercises) {
    return exercises.map((e, i) => {
        if (!e) return '';
        if (e.kind === 'warmup') { const mode = e.mode === 'free' ? 'free' : 'timer'; const durText = mode === 'timer' ? formatTime(e.duration || 180) : 'свободно'; return `<div class="preview-exercise warmup"><div class="num">🔥</div><div class="info"><div class="name">Разминка${mode === 'free' ? ' (свободно)' : ''}</div><div class="rest-info">${durText}</div></div></div>`; }
        if (e.kind === 'rest') { const isWater = e.restType === 'water'; const num = isWater ? '💧' : '🛌'; const dur = e.duration === null ? 'без таймера' : formatTime(e.duration || 0); const name = isWater ? 'Необходимо попить воды' : 'Отдых'; return `<div class="preview-exercise ${isWater ? 'water' : 'rest'}"><div class="num">${num}</div><div class="info"><div class="name">${escapeHtml(name)}</div><div class="rest-info">${dur}</div></div></div>`; }
        const exNum = getExerciseNumber(exercises, i);
        let info = '';
        if (e.type === 'sets') { const sets = e.setsCount || 3; const perSet = e.setMode === 'reps' ? (e.targetReps || 10) + ' повторений' : formatTime(e.setDuration || 45); info = `${sets}×${perSet}`; if (e.restBetweenSets) info += ` · отдых ${formatTime(e.restBetweenSets)}`; }
        else if (e.type === 'reps') info = `${e.targetReps || 10} ${pluralReps(e.targetReps || 10)}`;
        else if (e.type === 'timer') info = `⏳ ${formatTime(e.timerDuration || 60)}`;
        else info = 'по времени';
        const icon = e.type === 'sets' ? ' 🔁' : e.type === 'reps' ? ' 🔢' : e.type === 'timer' ? ' ⏳' : '';
       return `<div class="preview-exercise"><div class="num">${exNum}</div><div class="info" style="flex:1; min-width:0;"><div class="name" style="word-break:break-word;">${escapeHtml(e.name || 'Упражнение')}${icon}</div><div class="rest-info" style="word-break:break-word;">${info}${e.notes ? ' · ' + escapeHtml(e.notes) : ''}</div></div></div>`;
	   }).join('');
}

function updateEditorSettingVisibility() {
    const cdEl = document.getElementById('workout-countdown');
    const cdRow = document.getElementById('workout-countdown-interval-row');
    if (cdEl && cdRow) cdRow.style.display = cdEl.checked ? 'flex' : 'none';
    const mbEl = document.getElementById('workout-minute-beep');
    const mbRow = document.getElementById('workout-minute-beep-interval-row');
    if (mbEl && mbRow) mbRow.style.display = mbEl.checked ? 'flex' : 'none';
    const fwEl = document.getElementById('workout-final-warn');
    const fwRow = document.getElementById('workout-final-warn-row');
    if (fwEl && fwRow) fwRow.style.display = fwEl.checked ? 'flex' : 'none';
}
function bindEditorSettingToggles() {
    const cdEl = document.getElementById('workout-countdown');
    if (cdEl && !cdEl._bound) { cdEl._bound = true; cdEl.addEventListener('change', updateEditorSettingVisibility); }
    const mbEl = document.getElementById('workout-minute-beep');
    if (mbEl && !mbEl._bound) { mbEl._bound = true; mbEl.addEventListener('change', updateEditorSettingVisibility); }
    const fwEl = document.getElementById('workout-final-warn');
    if (fwEl && !fwEl._bound) { fwEl._bound = true; fwEl.addEventListener('change', updateEditorSettingVisibility); }
}
function updateEditorWorkoutSettingsMode() {
    const locked = !editorUsesPersonalSettings;
    document.getElementById("editor-personal-fields").hidden = locked;
    document.getElementById("editor-settings-group").open = true;
    const autoStartEl = document.getElementById('auto-start');
    if (autoStartEl) {
        autoStartEl.disabled = locked;
        if (locked) autoStartEl.checked = !!DB.settings.defaultAutoStart;
    }
    const ids = ['workout-countdown','workout-countdown-duration','workout-minute-beep','workout-minute-beep-interval',
        'workout-sound-mode',
        'workout-announce-numbers','workout-announce-workout-name','workout-announce-exercise-name','workout-announce-exercise-goal','workout-announce-rest-name','workout-continuous-beep',
        'workout-overtime-stopwatch','workout-final-warn','workout-final-warn-seconds',
        'workout-ask-reps','workout-ask-weight','workout-show-last-exercise','workout-auto-fill-weight','workout-auto-fill-reps','workout-track-prs',
        'workout-show-volume-stats','workout-large-run-controls','workout-confirm-skip',
        'workout-skip-warmup','workout-show-start-time'];
    ids.forEach(id => { const el = document.getElementById(id); if (el) el.disabled = locked; });
    try { updateWorkoutAnnounceHint(); } catch(e) {}
    const note = document.getElementById('workout-settings-global-note');
    if (note) note.style.display = locked ? 'block' : 'none';
    const pnote = document.getElementById('workout-settings-personal-note');
    if (pnote) pnote.style.display = locked ? 'none' : 'block';
    const resetBtn = document.getElementById('editor-reset-to-global-btn');
    if (resetBtn) resetBtn.style.display = locked ? 'none' : '';
    document.querySelectorAll('#editor-settings-group .editor-settings-card').forEach(card => {
        card.classList.toggle('workout-settings-global-mode', locked);
    });
}
function initWorkoutSettingsFields(w) {
    const ws = (w && workoutUsesPersonalSettings(w) && w.settings) ? w.settings : {};
    const countdown = ws.countdown !== undefined ? ws.countdown : DB.settings.countdown;
    const countdownDur = ws.countdownDuration !== undefined ? ws.countdownDuration : DB.settings.countdownDuration;
    const minuteBeep = ws.minuteBeep !== undefined ? ws.minuteBeep : DB.settings.minuteBeep;
    const minuteBeepInt = ws.minuteBeepInterval !== undefined ? ws.minuteBeepInterval : DB.settings.minuteBeepInterval;
    const soundMode = (ws.soundMode === 'voice' || ws.soundMode === 'beep') ? ws.soundMode : (DB.settings.soundMode === 'voice' ? 'voice' : 'beep');
    const announceNumbers = ws.announceNumbers !== undefined ? ws.announceNumbers : DB.settings.announceNumbers;
    const announceWorkoutName = ws.announceWorkoutName !== undefined ? ws.announceWorkoutName : DB.settings.announceWorkoutName;
    const announceExerciseName = ws.announceExerciseName !== undefined ? ws.announceExerciseName : DB.settings.announceExerciseName;
    const announceExerciseGoal = ws.announceExerciseGoal !== undefined ? ws.announceExerciseGoal : DB.settings.announceExerciseGoal;
    const announceRestName = ws.announceRestName !== undefined ? ws.announceRestName : DB.settings.announceRestName;
    const continuousBeep = ws.continuousBeep !== undefined ? ws.continuousBeep : DB.settings.continuousBeep;
    const overtimeStopwatch = ws.overtimeStopwatch !== undefined ? ws.overtimeStopwatch : DB.settings.overtimeStopwatch;
    const finalWarnSeconds = ws.finalWarnSeconds !== undefined ? ws.finalWarnSeconds : DB.settings.finalWarnSeconds;
    const askReps = ws.askReps !== undefined ? ws.askReps : DB.settings.askReps;
    const askWeight = ws.askWeight !== undefined ? ws.askWeight : DB.settings.askWeight;
    const skipWarmup = ws.skipWarmup !== undefined ? ws.skipWarmup : false;
    const showStartTime = ws.showStartTime !== undefined ? ws.showStartTime : DB.settings.showStartTime;
    const cdEl = document.getElementById('workout-countdown'); const cdDurEl = document.getElementById('workout-countdown-duration');
    const mbEl = document.getElementById('workout-minute-beep'); const mbIntEl = document.getElementById('workout-minute-beep-interval');
    const smEl = document.getElementById('workout-sound-mode');
    const anEl = document.getElementById('workout-announce-numbers'); const awnEl = document.getElementById('workout-announce-workout-name');
    const aenEl = document.getElementById('workout-announce-exercise-name'); const aegEl = document.getElementById('workout-announce-exercise-goal'); const arnEl = document.getElementById('workout-announce-rest-name');
    const cbEl = document.getElementById('workout-continuous-beep'); const otsEl = document.getElementById('workout-overtime-stopwatch'); const arEl = document.getElementById('workout-ask-reps'); const awEl = document.getElementById('workout-ask-weight'); const swEl = document.getElementById('workout-skip-warmup');
    const sstEl = document.getElementById('workout-show-start-time');
    if (cdEl) cdEl.checked = !!countdown; if (cdDurEl) cdDurEl.value = String(countdownDur || 3);
    if (mbEl) mbEl.checked = !!minuteBeep; if (mbIntEl) mbIntEl.value = String(minuteBeepInt || 60);
    if (smEl) {
        smEl.value = soundMode;
        if (!smEl._boundAnnounceHint) {
            smEl._boundAnnounceHint = true;
            smEl.addEventListener('change', () => { try { updateWorkoutAnnounceHint(); } catch(e) {} });
        }
    }
    if (anEl) anEl.checked = !!announceNumbers; if (awnEl) awnEl.checked = announceWorkoutName !== false;
    if (aenEl) aenEl.checked = announceExerciseName !== false; if (aegEl) aegEl.checked = announceExerciseGoal !== false; if (arnEl) arnEl.checked = announceRestName !== false;
    if (cbEl) cbEl.checked = !!continuousBeep; if (otsEl) otsEl.checked = !!overtimeStopwatch; if (arEl) arEl.checked = askReps !== false; if (awEl) awEl.checked = !!askWeight; if (swEl) swEl.checked = !!skipWarmup;
    if (sstEl) sstEl.checked = !!showStartTime;
    const fwEl = document.getElementById('workout-final-warn');
    const fwsEl = document.getElementById('workout-final-warn-seconds');
    const fwsVal = [5,10,15,20,30].includes(Number(finalWarnSeconds)) ? Number(finalWarnSeconds) : (Number(finalWarnSeconds) === 0 ? 5 : 5);
    if (fwEl) fwEl.checked = Number(finalWarnSeconds) > 0;
    if (fwsEl) fwsEl.value = String(fwsVal);
    try { updateEditorSettingVisibility(); } catch(e) {}
    const sleEl = document.getElementById('workout-show-last-exercise');
    const afwEl = document.getElementById('workout-auto-fill-weight');
    const afrEl = document.getElementById('workout-auto-fill-reps');
    const tprEl = document.getElementById('workout-track-prs');
    const svsEl = document.getElementById('workout-show-volume-stats');
    const lrcEl = document.getElementById('workout-large-run-controls');
    const cskEl = document.getElementById('workout-confirm-skip');
    const showLastExercise = ws.showLastExercise !== undefined ? ws.showLastExercise : DB.settings.showLastExercise;
    const autoFillWeight = ws.autoFillWeight !== undefined ? ws.autoFillWeight : DB.settings.autoFillWeight;
    const autoFillReps = ws.autoFillReps !== undefined ? ws.autoFillReps : DB.settings.autoFillReps;
    const trackPRs = ws.trackPRs !== undefined ? ws.trackPRs : DB.settings.trackPRs;
    const showVolumeStats = ws.showVolumeStats !== undefined ? ws.showVolumeStats : DB.settings.showVolumeStats;
    const largeRunControls = ws.largeRunControls !== undefined ? ws.largeRunControls : DB.settings.largeRunControls;
    const confirmSkipExercise = ws.confirmSkipExercise !== undefined ? ws.confirmSkipExercise : DB.settings.confirmSkipExercise;
    if (sleEl) sleEl.checked = showLastExercise !== false;
    if (afwEl) afwEl.checked = autoFillWeight !== false;
    if (afrEl) afrEl.checked = autoFillReps !== false;
    if (tprEl) tprEl.checked = trackPRs !== false;
    if (svsEl) svsEl.checked = showVolumeStats !== false;
    if (lrcEl) lrcEl.checked = !!largeRunControls;
    if (cskEl) cskEl.checked = !!confirmSkipExercise;
    try { updateWorkoutAnnounceHint(); } catch(e) {}
    bindEditorSettingToggles();
    updateEditorSettingVisibility();
    updateEditorWorkoutSettingsMode();
}
function initEditorSettingsAccordion() {
    const group = document.getElementById('editor-settings-group');
    if (!group) return;
    if (DB.settings.accordions && DB.settings.accordions.editorSettings !== undefined) group.open = DB.settings.accordions.editorSettings;
    if (group.dataset.accBound !== '1') { group.dataset.accBound = '1'; group.addEventListener('toggle', () => { DB.settings.accordions = DB.settings.accordions || {}; DB.settings.accordions.editorSettings = group.open; Storage.set('ft_settings', DB.settings); }); }
}
async function resetWorkoutSettingsToGlobal() {
    const ok = await customConfirm('Убрать персональные параметры этой тренировки и снова использовать общие настройки приложения?', {
        title: 'Общие параметры',
        okText: 'Использовать общие',
        cancelText: 'Отмена',
        danger: false
    });
    if (!ok) return;
    editorUsesPersonalSettings = false;
    initWorkoutSettingsFields(null);
    updateEditorWorkoutSettingsMode();
    showToast('✓ Общие параметры');
}
function openEditor(id, isTemplate, liveWorkout = null) {
    if (!liveWorkout) liveEditor = null;
    document.getElementById("live-editor-note").style.display = liveWorkout ? "block" : "none";
    editingId = id; editingIsTemplate = isTemplate;
    allEditorCollapsed = false; collapsedEditorElements = {};
    updateCollapseAllBtn(); initEditorSettingsAccordion();
    if (id === null && !liveWorkout) {
        editorExercises = [];
        document.getElementById('workout-name').value = '';
        editorUsesPersonalSettings = false;
        document.getElementById('auto-start').checked = DB.settings.defaultAutoStart;
        document.getElementById('editor-title').innerText = isTemplate ? 'Новый шаблон' : 'Новая тренировка';
        document.getElementById('delete-btn').style.display = 'none';
        document.getElementById('export-btn').style.display = 'none';
    } else {
        const src = isTemplate ? DB.templates : DB.workouts;
        const w = liveWorkout || src.find(x => x.id === id);
        if (!w) return;
        if (!Array.isArray(w.exercises)) { showToast('⚠️ Тренировка повреждена'); return; }
        editorExercises = JSON.parse(JSON.stringify(w.exercises));
        editorExercises.forEach(ex => {
            if (ex.kind === 'rest' && ex.duration !== null && ex.duration !== undefined && !REST_PRESETS.some(p => p.v === ex.duration)) ex.customDuration = true;
            if (ex.kind === 'warmup' && ex.mode !== 'free' && ex.duration !== null && ex.duration !== undefined && !REST_PRESETS.some(p => p.v === ex.duration)) ex.customDuration = true;
            if (ex.kind === 'exercise' && ex.type === 'timer' && ex.timerDuration !== null && ex.timerDuration !== undefined && !REST_PRESETS.some(p => p.v === ex.timerDuration)) ex.customTimerDuration = true;
        });
        document.getElementById('workout-name').value = w.name;
        editorUsesPersonalSettings = workoutUsesPersonalSettings(w);
        document.getElementById('auto-start').checked = editorUsesPersonalSettings
            ? (w.autoStart !== undefined ? !!w.autoStart : !!DB.settings.defaultAutoStart)
            : !!DB.settings.defaultAutoStart;
        document.getElementById('editor-title').innerText = isTemplate ? 'Редактирование шаблона' : 'Редактирование';
        document.getElementById('delete-btn').style.display = 'block';
        document.getElementById('export-btn').style.display = 'block';
    }
    renderEditorExercises();
    initWorkoutSettingsFields(liveWorkout || (id === null ? null : (editingIsTemplate ? DB.templates.find(x => x.id === id) : DB.workouts.find(x => x.id === id))));
    updateEditorWorkoutSettingsMode();
    showScreen('screen-editor');
}
function openLiveEditor() {
    if (!runState || runState.phase === 'finish' || liveEditor || runState.setFinishing) return;
    pauseRunForSettings();
    const session = runState;
    liveEditor = { session, original: JSON.parse(JSON.stringify(session.workout.exercises)), refs: null };
    const draft = JSON.parse(JSON.stringify(session.workout));
    if (session.isTemp && draft.usePersonalSettings === undefined) draft.usePersonalSettings = true;
    openEditor(draft.id, false, draft);
    liveEditor.refs = editorExercises.slice();
    document.getElementById('editor-title').innerText = 'Редактирование тренировки';
    document.getElementById('delete-btn').style.display = 'none';
    document.getElementById('export-btn').style.display = 'none';
    document.getElementById('live-editor-note').textContent = 'Тренировка на паузе. Выполненные элементы и порядок до текущего защищены. Тип начатого упражнения менять нельзя. ' + (session.isDeload || session.isTemp ? 'Изменения только в текущем занятии.' : 'Изменения сохраняются также в списке тренировок.');
}
function closeLiveEditor() {
    const ctx = liveEditor;
    liveEditor = null;
    if (!ctx || runState !== ctx.session) { showScreen('screen-workouts'); return; }
    showScreen('screen-run');
    resumeRunAfterSettings();
    if (runState.phase === 'ready' && runState.workout.autoStart) beginCurrentElementFlow(true);
}
function applyLiveEditor(data) {
    const ctx = liveEditor;
    if (!ctx || runState !== ctx.session) { showToast('Тренировка уже недоступна'); return; }
    const r = runState, i = r.index, old = ctx.original[i], next = data.exercises[i];
    for (let k = 0; k <= i; k++) {
        if (editorExercises[k] !== ctx.refs[k]) { showToast('Нельзя удалять или перемещать текущие и выполненные элементы'); return; }
        if (k < i) data.exercises[k] = JSON.parse(JSON.stringify(ctx.original[k]));
    }
    if (r.phase !== 'ready' && (old.kind !== next.kind || old.type !== next.type || old.setMode !== next.setMode || old.mode !== next.mode || (old.kind === "rest" && !old.duration !== !next.duration))) { showToast('Нельзя менять тип или режим уже начатого элемента'); return; }
    if (next.type === 'sets' && (next.setsCount || 3) < r.currentSet) { showToast('Количество подходов не может быть меньше текущего'); return; }
    const clean = JSON.parse(JSON.stringify(data));
    Object.assign(r.workout, clean);
    if (r.phase === 'work' && next.type === 'timer' && old.timerDuration !== next.timerDuration) { r.workDuration = next.timerDuration; r.timerFinished = false; r.timerBeepPlayed = false; stopExerciseAlarm(); }
    if (r.phase === 'warmup' && !r.warmupFinished && next.mode !== 'free') r.warmupDuration = next.duration;
    if (r.phase === 'rest' && !r.restBannerMode) {
        const duration = r.restPhase === 'between-sets' ? (next.restBetweenSets || 60) : next.duration;
        if (duration !== r.restDuration) { r.restDuration = duration; r.restFinished = false; r.restBeepPlayed = false; stopRestAlarm(); }
    }
    r.lastBeepTargetTime = undefined;
    if (!r.isTemp && !r.isDeload) {
        const stored = DB.workouts.find(w => w.id === r.workout.id);
        if (stored) { Object.assign(stored, JSON.parse(JSON.stringify(clean))); saveDB('workouts'); }
    }
    document.getElementById('run-title').innerText = r.workout.name + (r.isDeload ? ' 🏷' : '');
    saveRunState(); closeLiveEditor(); notifySaved('✅ Тренировка обновлена');
}

function cancelEditor() { if (liveEditor) { closeLiveEditor(); notifyCancelled(); return; } showScreen(editingIsTemplate ? 'screen-templates' : 'screen-workouts'); notifyCancelled(); }
function updateCollapseAllBtn() {
    const btn = document.getElementById('collapse-all-btn');
    if (!btn) return;
    btn.innerHTML = allEditorCollapsed ? '<svg viewBox="0 0 24 24" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>' : '<svg viewBox="0 0 24 24" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>';
    btn.setAttribute('aria-label', allEditorCollapsed ? 'Развернуть все' : 'Свернуть все');
}
function toggleAllExercisesCollapsed() {
    allEditorCollapsed = !allEditorCollapsed;
    if (!allEditorCollapsed) collapsedEditorElements = {};
    else { editorExercises.forEach((_, i) => { collapsedEditorElements[i] = true; }); }
    updateCollapseAllBtn();
    renderEditorExercises();
}
function duplicateEditorElement(i) {
    if (!editorExercises[i]) return;
    const copy = JSON.parse(JSON.stringify(editorExercises[i]));
    editorExercises.splice(i + 1, 0, copy);
    renderEditorExercises();
    showToast('📋 Элемент скопирован');
}
let _editorDragJustEnded = false;
function onExerciseBlockClick(e, i) {
    if (_editorDragJustEnded) return;
    const header = e.target.closest('.exercise-header');
    if (!header) return;
    if (e.target.closest('button, input, select, textarea, .exercise-controls')) return;
    collapsedEditorElements[i] = !collapsedEditorElements[i];
    if (!collapsedEditorElements[i]) delete collapsedEditorElements[i];
    allEditorCollapsed = editorExercises.length > 0 && editorExercises.every((_, idx) => !!collapsedEditorElements[idx]);
    try { updateCollapseAllBtn(); } catch (err) {}
    renderEditorExercises();
}
function renderDurationRow(i, el, presets, label, allowNone = true) {
    const isPreset = !el.customDuration && presets.some(p => p.v === el.duration);
    let html = `<div class="rest-row"><label>${label}</label><select class="select" onchange="handleDurationSelect(${i}, this.value)" style="flex:1; margin:0;">`;
    presets.forEach(p => { html += `<option value="${p.v}" ${isPreset && p.v === el.duration ? 'selected' : ''}>${p.t}</option>`; });
    html += `<option value="custom" ${(!isPreset && el.duration !== null) ? 'selected' : ''}>Другое...</option>`;
    if (allowNone) html += `<option value="none" ${el.duration === null ? 'selected' : ''}>Без таймера</option>`;
    html += `</select>`;
    if (!isPreset && el.duration !== null) { html += `<input type="number" value="${el.duration}" min="0" step="5" onchange="updateElement(${i}, 'duration', parseInt(this.value)||0); renderEditorExercises();" style="width:70px; margin:0; padding:8px;"><span style="color:var(--muted); font-size:0.85rem;">сек</span>`; }
    html += `</div>`;
    return html;
}
function handleDurationSelect(i, value) {
    const el = editorExercises[i];
    if (!el) return;
    if (value === 'custom') { el.customDuration = true; if (el.duration === null || el.duration === undefined) el.duration = 20; }
    else if (value === 'none') { el.customDuration = false; el.duration = null; }
    else { el.customDuration = false; el.duration = parseInt(value); }
    renderEditorExercises();
}

function renderTimerDurationRow(i, el) {
    const presets = REST_PRESETS;
    const cur = (typeof el.timerDuration === 'number' && el.timerDuration > 0) ? el.timerDuration : 60;
    const isPreset = presets.some(p => p.v === cur);
    let html = `<div class="rest-row"><label>Длительность:</label><select class="select" onchange="handleTimerDurationSelect(${i}, this.value)" style="flex:1; margin:0;">`;
    presets.forEach(p => { html += `<option value="${p.v}" ${isPreset && p.v === cur ? 'selected' : ''}>${p.t}</option>`; });
    html += `<option value="custom" ${!isPreset ? 'selected' : ''}>Другое...</option>`;
    html += `</select>`;
    if (!isPreset) { html += `<input type="number" value="${cur}" min="5" step="5" onchange="updateElement(${i}, 'timerDuration', Math.max(5, parseInt(this.value)||60)); renderEditorExercises();" style="width:70px; margin:0; padding:8px;"><span style="color:var(--muted); font-size:0.85rem;">сек</span>`; }
    html += `</div>`;
    return html;
}
function handleTimerDurationSelect(i, value) {
    const el = editorExercises[i];
    if (!el) return;
    if (value === 'custom') {
        if (typeof el.timerDuration !== 'number' || el.timerDuration < 5) el.timerDuration = 60;
    } else {
        el.timerDuration = parseInt(value);
    }
    renderEditorExercises();
}

function renderEditorExercises() {
    const c = document.getElementById('exercises-list');
    if (editorExercises.length === 0) { c.innerHTML = '<div class="empty-state">Добавьте упражнения или отдых</div>'; return; }
    c.innerHTML = editorExercises.map((el, i) => {
        const isCollapsed = !!collapsedEditorElements[i];
        const dupBtn = `<button class="icon-btn dup-btn" onclick="event.stopPropagation(); duplicateEditorElement(${i})" aria-label="Дублировать">📋</button>`;
        let header = '', body = '', extraClass = '';
        if (el.kind === 'warmup') {
            extraClass = 'warmup-block';
            const mode = el.mode === 'free' ? 'free' : 'timer';
            header = `<div class="exercise-header"><div class="exercise-number">🔥</div><input type="text" class="exercise-name-input" value="Разминка" disabled><div class="exercise-controls"><button class="icon-btn" onclick="moveElement(${i},-1)" ${i===0?'disabled':''} aria-label="Вверх"><svg viewBox="0 0 24 24" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 15l-6-6-6 6"/></svg></button><button class="icon-btn" onclick="moveElement(${i},1)" ${i===editorExercises.length-1?'disabled':''} aria-label="Вниз"><svg viewBox="0 0 24 24" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></button>${dupBtn}<button class="icon-btn delete-btn" onclick="removeElement(${i})" aria-label="Удалить"><svg viewBox="0 0 24 24" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg></button></div></div>`;
            body = `<div class="exercise-body"><div class="type-row"><label>Режим:</label><select class="select" onchange="updateElement(${i}, 'mode', this.value); renderEditorExercises();" style="flex:1;"><option value="timer" ${mode === 'timer' ? 'selected' : ''}>⏱ По таймеру</option><option value="free" ${mode === 'free' ? 'selected' : ''}>🕐 Свободно</option></select></div>${mode === 'timer' ? renderDurationRow(i, el, REST_PRESETS, 'Длительность:', false) : ''}</div>`;
        } else if (el.kind === 'rest') {
            const isWater = el.restType === 'water';
            extraClass = 'rest-block' + (isWater ? ' water-type' : '');
            header = `<div class="exercise-header"><div class="exercise-number">${isWater ? '💧' : '🛌'}</div><input type="text" class="exercise-name-input" value="${escapeHtml(isWater ? 'Необходимо попить воды' : 'Отдых')}" onchange="updateElement(${i}, 'name', this.value)" placeholder="Название"><div class="exercise-controls"><button class="icon-btn" onclick="moveElement(${i},-1)" ${i===0?'disabled':''} aria-label="Вверх"><svg viewBox="0 0 24 24" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 15l-6-6-6 6"/></svg></button><button class="icon-btn" onclick="moveElement(${i},1)" ${i===editorExercises.length-1?'disabled':''} aria-label="Вниз"><svg viewBox="0 0 24 24" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></button>${dupBtn}<button class="icon-btn delete-btn" onclick="removeElement(${i})" aria-label="Удалить"><svg viewBox="0 0 24 24" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg></button></div></div>`;
            body = `<div class="exercise-body"><div class="type-row"><label>Тип:</label><select class="select" onchange="updateElement(${i}, 'restType', this.value); renderEditorExercises();"><option value="rest" ${!isWater ? 'selected' : ''}>🛌 Обычный отдых</option><option value="water" ${isWater ? 'selected' : ''}>💧 Необходимо попить воды</option></select></div>${renderDurationRow(i, el, REST_PRESETS, 'Длительность:')}</div>`;
        } else {
            const num = getExerciseNumber(editorExercises, i);
            const exType = el.type || 'time';
            header = `<div class="exercise-header"><div class="exercise-number">${num}</div><input type="text" class="exercise-name-input" value="${escapeHtml(el.name)}" onchange="updateElement(${i}, 'name', this.value)" placeholder="Название"><div class="exercise-controls"><button class="icon-btn" onclick="moveElement(${i},-1)" ${i===0?'disabled':''} aria-label="Вверх"><svg viewBox="0 0 24 24" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 15l-6-6-6 6"/></svg></button><button class="icon-btn" onclick="moveElement(${i},1)" ${i===editorExercises.length-1?'disabled':''} aria-label="Вниз"><svg viewBox="0 0 24 24" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></button>${dupBtn}<button class="icon-btn delete-btn" onclick="removeElement(${i})" aria-label="Удалить"><svg viewBox="0 0 24 24" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg></button></div></div>`;
            body = `<div class="type-row"><label>Тип:</label><select class="select" onchange="updateElement(${i}, 'type', this.value); renderEditorExercises();"><option value="time" ${exType === 'time' ? 'selected' : ''}>⏱ Секундомер</option><option value="timer" ${exType === 'timer' ? 'selected' : ''}>⏳ Таймер</option><option value="reps" ${exType === 'reps' ? 'selected' : ''}>🔢 Повторы</option><option value="sets" ${exType === 'sets' ? 'selected' : ''}>🔁 Подходы</option></select>${exType === 'reps' ? `<input type="number" value="${el.targetReps || 10}" min="1" step="1" onchange="updateElement(${i}, 'targetReps', parseInt(this.value)||10);"><span style="color:var(--muted); font-size:0.85rem;">повт.</span>` : ''}${exType === 'sets' ? `<label style="margin-left:6px;">Подходов:</label><input type="number" value="${el.setsCount || 3}" min="1" step="1" onchange="updateElement(${i}, 'setsCount', Math.max(1, parseInt(this.value)||3)); renderEditorExercises();">` : ''}</div>`;
            if (exType === 'timer') { body += renderTimerDurationRow(i, el); }
            if (exType === 'sets') {
                body += `<div class="type-row"><label>В подходе:</label><select class="select" onchange="updateElement(${i}, 'setMode', this.value); renderEditorExercises();" style="flex:1;"><option value="reps" ${(el.setMode||'reps') === 'reps' ? 'selected' : ''}>🔢 Повторы</option><option value="time" ${el.setMode === 'time' ? 'selected' : ''}>⏱ Время</option></select>${(el.setMode||'reps') === 'reps' ? `<input type="number" value="${el.targetReps || 10}" min="1" step="1" onchange="updateElement(${i}, 'targetReps', parseInt(this.value)||10);"><span style="color:var(--muted); font-size:0.85rem;">повт.</span>` : `<input type="number" value="${el.setDuration || 45}" min="5" step="5" onchange="updateElement(${i}, 'setDuration', Math.max(5, parseInt(this.value)||45));"><span style="color:var(--muted); font-size:0.85rem;">сек</span>`}</div><div class="rest-row"><label>Отдых между:</label><input type="number" value="${el.restBetweenSets || 60}" min="0" step="5" onchange="updateElement(${i}, 'restBetweenSets', parseInt(this.value)||0);" style="width:70px; margin:0; padding:8px;"><span style="color:var(--muted); font-size:0.85rem;">сек</span></div>`;
            }
            body += `<div class="notes-row"><label>📝</label><textarea class="input" placeholder="Постоянная заметка" onchange="updateElement(${i}, 'notes', this.value)" style="margin:0;">${escapeHtml(el.notes || '')}</textarea></div>`;
        }
        return `<div class="exercise-block ${extraClass} ${isCollapsed ? 'collapsed' : ''}" onclick="onExerciseBlockClick(event, ${i})" data-editor-index="${i}">${header}<div class="exercise-body">${body}</div></div>`;
    }).join('');
    if (liveEditor) {
        c.querySelectorAll(".exercise-block").forEach((item, i) => {
            if (i < liveEditor.session.index) item.querySelectorAll("input,select,textarea,button").forEach(el => el.disabled = true);
        });
    }
    // Перетаскивание карточек (упражнения / отдых / разминка), в т.ч. свёрнутых
    try {
        c.querySelectorAll('.exercise-block').forEach(item => {
            initDragAndDrop(item, {
                containerSelector: '#exercises-list',
                itemSelector: '.exercise-block',
                dbKey: 'editorExercises'
            });
        });
    } catch (e) { console.warn('[editor drag init]', e); }
}
function addExercise() { editorExercises.push({ kind: 'exercise', name: '', type: 'time', notes: '', targetReps: 10, setsCount: 3, setMode: 'reps', setDuration: 45, restBetweenSets: 60, timerDuration: 60 }); renderEditorExercises(); }
function addWarmup() { editorExercises.push({ kind: 'warmup', name: 'Разминка', duration: 180, mode: 'timer' }); renderEditorExercises(); }
function addRest() { editorExercises.push({ kind: 'rest', restType: 'rest', duration: 60, notes: '' }); renderEditorExercises(); }
function updateElement(i, f, v) {
    if (!editorExercises[i]) return;
    editorExercises[i][f] = v;
    if (f === 'type') {
        const ex = editorExercises[i];
        if (v === 'sets') {
            if (ex.setsCount === undefined || ex.setsCount === null) ex.setsCount = 3;
            if (ex.setMode === undefined) ex.setMode = 'reps';
            if (ex.targetReps === undefined || ex.targetReps === null) ex.targetReps = 10;
            if (ex.setDuration === undefined || ex.setDuration === null) ex.setDuration = 45;
            if (ex.restBetweenSets === undefined || ex.restBetweenSets === null) ex.restBetweenSets = 60;
        } else if (v === 'reps') { if (ex.targetReps === undefined || ex.targetReps === null) ex.targetReps = 10; }
        else if (v === 'timer') { if (typeof ex.timerDuration !== 'number' || ex.timerDuration < 5) ex.timerDuration = 60; }
    }
    if (f === 'mode' && editorExercises[i].kind === 'warmup') {
        if (v === 'free') editorExercises[i].duration = null;
        else if (typeof editorExercises[i].duration !== 'number' || editorExercises[i].duration < 5) editorExercises[i].duration = 180;
    }
}
function removeElement(i) { if (liveEditor && i <= liveEditor.session.index) { showToast("Нельзя удалить текущий или выполненный элемент"); return; } editorExercises.splice(i, 1); collapsedEditorElements = {}; allEditorCollapsed = false; updateCollapseAllBtn(); renderEditorExercises(); }
function moveElement(i, d) {
    const j = i + d;
    if (j < 0 || j >= editorExercises.length) return;
    if (liveEditor && Math.min(i,j) <= liveEditor.session.index) { showToast("Нельзя перемещать текущие и выполненные элементы"); return; }
    [editorExercises[i], editorExercises[j]] = [editorExercises[j], editorExercises[i]];
    collapsedEditorElements = {}; allEditorCollapsed = false; updateCollapseAllBtn();
    renderEditorExercises();
}
let saveWorkoutInProgress = false;
async function saveWorkout() {
    if (saveWorkoutInProgress) return;
    saveWorkoutInProgress = true;
    try {
        const name = document.getElementById('workout-name').value.trim();
        if (!name) { showToast('Введи название'); return; }
        if (editorExercises.length === 0) { showToast('Добавь элементы'); return; }
        const hasExercise = editorExercises.some(e => e.kind === 'exercise');
        if (!hasExercise) { showToast('Добавь хотя бы одно упражнение'); return; }
        const emptyNames = editorExercises.filter(e => e.kind === 'exercise' && !String(e.name || "").trim());
        if (emptyNames.length > 0) {
            const ok = await customConfirm(`У ${emptyNames.length} упражнений не указано название. Установить «Упражнение»?`, { danger: false, okText: 'Продолжить' });
            if (!ok) return;
            editorExercises.forEach(e => { if (e.kind === 'exercise' && !String(e.name || '').trim()) e.name = 'Упражнение'; });
        }
        editorExercises.forEach(ex => {
            if (ex.kind === 'exercise' && ex.type === 'sets') {
                if (ex.setsCount === undefined || ex.setsCount === null) ex.setsCount = 3;
                if (ex.setMode === undefined) ex.setMode = 'reps';
                if (ex.setMode === 'reps' && (ex.targetReps === undefined || ex.targetReps === null)) ex.targetReps = 10;
                if (ex.setMode === 'time' && (ex.setDuration === undefined || ex.setDuration === null)) ex.setDuration = 45;
                if (ex.restBetweenSets === undefined || ex.restBetweenSets === null) ex.restBetweenSets = 60;
            }
            if (ex.kind === 'exercise' && ex.type === 'reps') { if (ex.targetReps === undefined || ex.targetReps === null) ex.targetReps = 10; }
            if (ex.kind === 'exercise' && ex.type === 'timer') { if (typeof ex.timerDuration !== 'number' || ex.timerDuration < 5) ex.timerDuration = 60; }
            if (ex.kind === 'warmup') {
                ex.name = 'Разминка';
                if (ex.mode === 'free') ex.duration = null;
                else { ex.mode = 'timer'; if (typeof ex.duration !== 'number' || ex.duration <= 0) ex.duration = 180; if (ex.duration < 5) ex.duration = 5; }
            }
            if (ex.customDuration !== undefined) delete ex.customDuration;
            if (ex.customTimerDuration !== undefined) delete ex.customTimerDuration;
        });
        const existingForAutoStart = editingId !== null
            ? (editingIsTemplate ? DB.templates : DB.workouts).find(x => x.id === editingId)
            : null;
        let autoStart = !!DB.settings.defaultAutoStart;
        let settings = {};
        if (editorUsesPersonalSettings) {
            autoStart = !!document.getElementById('auto-start').checked;
            settings = {
                countdown: document.getElementById('workout-countdown').checked,
                countdownDuration: parseInt(document.getElementById('workout-countdown-duration').value) || 3,
                minuteBeep: document.getElementById('workout-minute-beep').checked,
                minuteBeepInterval: parseInt(document.getElementById('workout-minute-beep-interval').value) || 60,
                soundMode: (document.getElementById('workout-sound-mode') && document.getElementById('workout-sound-mode').value === 'voice') ? 'voice' : 'beep',
                announceNumbers: document.getElementById('workout-announce-numbers').checked,
                announceWorkoutName: document.getElementById('workout-announce-workout-name').checked,
                announceExerciseName: document.getElementById('workout-announce-exercise-name') ? document.getElementById('workout-announce-exercise-name').checked : true,
                announceExerciseGoal: document.getElementById('workout-announce-exercise-goal') ? document.getElementById('workout-announce-exercise-goal').checked : true,
                announceRestName: document.getElementById('workout-announce-rest-name') ? document.getElementById('workout-announce-rest-name').checked : true,
                continuousBeep: document.getElementById('workout-continuous-beep').checked,
                overtimeStopwatch: document.getElementById('workout-overtime-stopwatch') ? document.getElementById('workout-overtime-stopwatch').checked : !!DB.settings.overtimeStopwatch,
                finalWarnSeconds: (function(){
                    const en = document.getElementById('workout-final-warn');
                    if (en && !en.checked) return 0;
                    const el = document.getElementById('workout-final-warn-seconds');
                    const n = el ? parseInt(el.value, 10) : 5;
                    return [5,10,15,20,30].includes(n) ? n : 5;
                })(),
                askReps: document.getElementById('workout-ask-reps').checked,
                askWeight: document.getElementById('workout-ask-weight') ? document.getElementById('workout-ask-weight').checked : false,
                showLastExercise: document.getElementById('workout-show-last-exercise') ? document.getElementById('workout-show-last-exercise').checked : (DB.settings.showLastExercise !== false),
                autoFillWeight: document.getElementById('workout-auto-fill-weight') ? document.getElementById('workout-auto-fill-weight').checked : (DB.settings.autoFillWeight !== false),
                autoFillReps: document.getElementById('workout-auto-fill-reps') ? document.getElementById('workout-auto-fill-reps').checked : (DB.settings.autoFillReps !== false),
                trackPRs: document.getElementById('workout-track-prs') ? document.getElementById('workout-track-prs').checked : (DB.settings.trackPRs !== false),
                                showVolumeStats: document.getElementById('workout-show-volume-stats') ? document.getElementById('workout-show-volume-stats').checked : (DB.settings.showVolumeStats !== false),
                largeRunControls: document.getElementById('workout-large-run-controls') ? document.getElementById('workout-large-run-controls').checked : !!DB.settings.largeRunControls,
                confirmSkipExercise: document.getElementById('workout-confirm-skip') ? document.getElementById('workout-confirm-skip').checked : !!DB.settings.confirmSkipExercise,
                skipWarmup: document.getElementById('workout-skip-warmup').checked,
                showStartTime: document.getElementById('workout-show-start-time') ? document.getElementById('workout-show-start-time').checked : !!DB.settings.showStartTime
            };
        }
        const data = { name, autoStart, exercises: editorExercises, usePersonalSettings: !!editorUsesPersonalSettings, settings };
        if (liveEditor) { applyLiveEditor(data); return; }
        const wasNew = editingId === null;
        if (editingIsTemplate) {
            if (editingId === null) DB.templates.push({ id: Date.now(), ...data });
            else Object.assign(DB.templates.find(x => x.id === editingId), data);
            saveDB('templates'); showScreen('screen-templates');
            notifySaved(wasNew ? '✅ Шаблон создан' : '✅ Шаблон сохранён');
        } else {
            if (editingId === null) DB.workouts.push({ id: Date.now(), ...data });
            else Object.assign(DB.workouts.find(x => x.id === editingId), data);
            saveDB('workouts'); showScreen('screen-workouts');
            notifySaved(wasNew ? '✅ Тренировка создана' : '✅ Тренировка сохранена');
        }
    } finally { saveWorkoutInProgress = false; }
}
async function deleteWorkout() {
    if (!await customConfirm('Удалить?', { danger: true, okText: '🗑 Удалить' })) return;
    if (editingIsTemplate) {
        const idx = DB.templates.findIndex(w => w.id === editingId); if (idx < 0) return;
        const removed = DB.templates[idx];
        DB.templates.splice(idx, 1); saveDB('templates');
        showScreen('screen-templates');
        showUndoToast('Шаблон удалён', () => { DB.templates.splice(idx, 0, removed); saveDB('templates'); renderTemplates(); showToast('Восстановлено'); });
    } else {
        const idx = DB.workouts.findIndex(w => w.id === editingId); if (idx < 0) return;
        const removed = DB.workouts[idx];
        DB.workouts.splice(idx, 1); saveDB('workouts');
        showScreen('screen-workouts');
        showUndoToast('Тренировка удалена', () => { DB.workouts.splice(idx, 0, removed); saveDB('workouts'); renderWorkoutsList(); showToast('Восстановлено'); });
    }
}
function exportCurrentWorkout() {
    if (editingId === null) { showToast('Сначала сохрани'); return; }
    const src = editingIsTemplate ? DB.templates : DB.workouts;
    const w = src.find(x => x.id === editingId); if (!w) return;
    const data = { type: 'fit-trainer-workout', version: 3, exportedAt: new Date().toISOString(), workout: { name: w.name, autoStart: w.autoStart, exercises: w.exercises, settings: w.settings || {} } };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url;
    a.download = `fit-trainer-${w.name.replace(/[^a-zа-яё0-9]/gi, '_')}.json`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    notifySaved('✅ Файл экспортирован');
}
function importWorkout(event) {
    const file = event.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
        try {
            const data = JSON.parse(e.target.result);
            if (data.type !== 'fit-trainer-workout' || !data.workout) { showToast('Не файл тренировки'); return; }
            const w = data.workout;
            if (!w.name || !w.exercises || !Array.isArray(w.exercises)) { showToast('Неверный формат'); return; }
            const nw = { id: Date.now(), name: w.name + ' (импорт)', autoStart: w.autoStart || false, exercises: w.exercises, settings: w.settings || null };
            DB.workouts.push(nw); saveDB('workouts');
            showToast(`Импортировано: ${nw.name}`);
            showScreen('screen-workouts');
        } catch(err) { showToast('Ошибка: ' + err.message); }
    };
    reader.readAsText(file);
    event.target.value = '';
}
function showPreview(id) {
    const w = DB.workouts.find(x => x.id === id); if (!w) return;
    previewWorkoutId = id;
    document.getElementById('preview-title').innerText = w.name;
    document.getElementById('preview-back-btn').onclick = () => showScreen('screen-workouts');
    document.getElementById('preview-content').innerHTML = `<div class="card"><div style="color:var(--muted); font-size:0.9rem;">${getTotalExerciseCount(w.exercises)} упражнений · ~${Math.round(estimateWorkoutDuration(w)/60)} мин всего</div></div>${renderPreviewElements(w.exercises)}`;
    document.getElementById('preview-actions').innerHTML = `<button class="btn accent" onclick="startFromPreview()">▶ Начать</button><button class="btn ghost" onclick="saveAsTemplate(${id})" style="margin-top:8px;">💾 Сохранить как шаблон</button>`;
    showScreen('screen-preview');
}
function startFromPreview() { if (previewWorkoutId) startWorkout(previewWorkoutId, false); }
function saveAsTemplate(id) {
    const w = DB.workouts.find(x => x.id === id); if (!w) return;
    const copy = JSON.parse(JSON.stringify(w));
    copy.id = Date.now(); copy.name = w.name + ' (шаблон)';
    DB.templates.push(copy); saveDB('templates'); showToast('💾 Сохранено в шаблоны');
}
function saveCurrentRunAsTemplate() {
    if (!runState || !runState.workout) return;
    const w = runState.workout;
    const copy = JSON.parse(JSON.stringify(w));
    copy.id = Date.now(); copy.name = w.name + ' (шаблон)';
    DB.templates.push(copy); saveDB('templates'); showToast('💾 Сохранено в шаблоны');
}

let runState = null;
let runReturnScreen = 'screen-home';
const RING_CIRCUMFERENCE = 2 * Math.PI * 54;
/** Монотонные часы: Date.now() для длительностей (не копятся секунды с setInterval). */
function nowMs() { return Date.now(); }
function ensureTicker() {
    if (!runState) return;
    if (runState.tickInterval) return;
    // 250ms на экране — плавнее; в фоне браузер сам урежет интервал,
    // но elapsed всегда считается от wall-clock, поэтому не «спешит» и не «отстаёт».
    const ms = (typeof document !== 'undefined' && document.visibilityState === 'hidden') ? 1000 : 250;
    runState.tickInterval = setInterval(updateTimersUI, ms);
}
function restartTicker() {
    stopTickInterval();
    ensureTicker();
    try { updateTimersUI(); } catch (e) {}
}
function stopTickInterval() { if (runState && runState.tickInterval) { clearInterval(runState.tickInterval); runState.tickInterval = null; } }
// После фона / блокировки экрана сразу догоняем UI по реальному времени
if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
        if (!runState || runState.phase === 'finish') return;
        if (document.visibilityState === 'visible') {
            restartTicker();
            try { renderRun(); } catch (e) { try { updateTimersUI(); } catch (e2) {} }
        } else {
            // Реже тикаем в фоне, но не останавливаем — нужен onRestFinished / onWarmupFinished
            restartTicker();
            try { saveRunState(); } catch (e) {}
        }
    });
    window.addEventListener('pageshow', () => {
        if (!runState || runState.phase === 'finish') return;
        restartTicker();
    });
    window.addEventListener('focus', () => {
        if (!runState || runState.phase === 'finish') return;
        restartTicker();
    });
}
function setRingProgress(ringId, pct, cls) {
    const ring = document.getElementById(ringId); if (!ring) return;
    pct = Math.max(0, Math.min(1, pct));
    ring.style.strokeDasharray = RING_CIRCUMFERENCE;
    ring.style.strokeDashoffset = RING_CIRCUMFERENCE * (1 - pct);
    if (cls !== undefined) { try { ring.setAttribute('class', 'timer-ring-fg ' + cls); } catch(e) {} }
}
/* === СЕКУНДОМЕР-ТОЧКА === */
const RING_RADIUS = 54;
function setRingDot(dotId, ringId, elapsedSec, cls) {
    const dot = document.getElementById(dotId);
    const ring = document.getElementById(ringId);
    if (!dot || !ring) return;
    ring.style.display = 'none';
    dot.style.display = 'block';
    const seconds = Math.max(0, Math.floor(elapsedSec || 0));
    const angle = (seconds * 6) + 90;
    dot.style.transform = `rotate(${angle}deg)`;
    if (cls !== undefined) { try { dot.setAttribute('class', 'timer-ring-dot ' + cls); } catch(e) {} }
    if (!dot._animReady) {
        dot.classList.add('no-anim');
        dot.getBoundingClientRect();
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                dot.classList.remove('no-anim');
                dot._animReady = true;
            });
        });
    }
}
function hideRingDot(dotId, ringId) {
    const dot = document.getElementById(dotId);
    const ring = document.getElementById(ringId);
    if (dot) { dot.style.display = 'none'; dot._animReady = false; dot.classList.remove('no-anim'); }
    if (ring) ring.style.display = '';
}
function startTimer(type, duration) {
    if (!runState) return;
    runState[`${type}StartTime`] = nowMs();
    runState[`${type}ElapsedBeforePause`] = 0;
    runState[`${type}Paused`] = false;
    runState[`${type}Duration`] = duration || 0;
    runState[`${type}BeepPlayed`] = false;
    runState.lastBeepTargetTime = undefined;
    ensureTicker(); updateTimersUI();
}
function pauseTimer(type) {
    const e = getCurrentElapsed(type);
    runState[`${type}ElapsedBeforePause`] = e;
    runState[`${type}StartTime`] = null;
    runState[`${type}Paused`] = true;
}
function resumeTimer(type) {
    runState[`${type}StartTime`] = nowMs();
    runState[`${type}Paused`] = false;
    ensureTicker();
}
function stopTimer(type) {
    runState[`${type}StartTime`] = null;
    runState[`${type}ElapsedBeforePause`] = 0;
    runState[`${type}Paused`] = false;
    runState[`${type}Duration`] = 0;
    runState[`${type}BeepPlayed`] = false;
    runState.lastBeepTargetTime = undefined;
}
function getCurrentElapsed(type) {
    const s = runState; if (!s) return 0;
    if (s[`${type}Paused`]) return Math.max(0, Math.floor(s[`${type}ElapsedBeforePause`] || 0));
    const st = s[`${type}StartTime`];
    const bp = s[`${type}ElapsedBeforePause`] || 0;
    if (!st) return Math.max(0, Math.floor(bp));
    // Wall-clock: не зависит от частоты setInterval и троттлинга вкладки
    const delta = nowMs() - st;
    if (!Number.isFinite(delta) || delta < 0) return Math.max(0, Math.floor(bp));
    return Math.max(0, Math.floor(bp + delta / 1000));
}
function getRemainingTime(type) { return Math.max(0, (runState[`${type}Duration`] || 0) - getCurrentElapsed(type)); }
function getOvertime(type) { return Math.max(0, getCurrentElapsed(type) - (runState[`${type}Duration`] || 0)); }
/** Отображение после «время вышло»: секундомер (счёт вверх) или статически 0:00 */
function formatTimeUpDisplay(type) {
    if (getEffectiveSetting('overtimeStopwatch')) return formatTime(getOvertime(type));
    return formatTime(0);
}
/** За сколько секунд до конца подсвечивать таймер и подавать сигнал (0 = выкл) */
function getFinalWarnSeconds() {
    const v = getEffectiveSetting('finalWarnSeconds');
    const n = Number(v);
    if (n === 0) return 0;
    if ([5, 10, 15, 20, 30].includes(n)) return n;
    return 5;
}
function calcProgress() {
    const elements = runState.workout.exercises;
    const totalEx = getTotalExerciseCount(elements);
    if (totalEx === 0) return 0;
    const doneEx = runState.exerciseTimes.length;
    let partial = 0;
    const inActive = runState.phase === 'work' || runState.phase === 'countdown';
    const inBetween = runState.phase === 'rest' && runState.restPhase === 'between-sets';
    if (inActive || inBetween) {
        const el = elements[runState.index];
        if (el && el.kind === 'exercise' && el.type === 'sets') {
            const setsCount = el.setsCount || 3;
            if (inActive) partial = runState.currentSet / setsCount;
            else partial = (runState.currentSet - 1) / setsCount;
        }
    }
    return Math.min(100, ((doneEx + partial) / totalEx) * 100);
}
let startWorkoutInProgress = false;
async function startWorkout(id, isDeload) {
    if (startWorkoutInProgress) return;
    // Clear stuck finish / orphan state (same reliability as 1.2.1)
    if (typeof ensureNoStuckRunState === 'function') ensureNoStuckRunState();
    if (runState && runState.phase === 'finish') { runState = null; clearSavedRunState(); }
    if (runState && runState.phase && !['ready','work','rest','countdown','warmup','finish'].includes(runState.phase)) {
        forceClearRunState();
    }
    if (runState && runState.phase !== 'finish' && runState.phase) {
        showToast('⚠️ Тренировка уже запущена');
        return;
    }
    if (runState) { runState = null; }
    startWorkoutInProgress = true;
    try {
        _restoreRunHeaderForNewWorkout();
        isDeload = (isDeload === true);

        const saved = loadSavedRunState();
        if (saved && saved.workoutId && saved.phase && saved.phase !== 'finish') {
            const sw = DB.workouts.find(x => x.id === saved.workoutId);
            const hasTemp = !!(saved.isTemp || saved.workoutSnapshot);
            if (['ready','work','rest','countdown','warmup'].includes(saved.phase) && (sw || hasTemp)) {
                const ageSec = saved.savedAt ? (Date.now() - saved.savedAt) / 1000 : 0;
                const age = saved.savedAt ? ` (${formatAge(ageSec)})` : '';
                const choice = await showStartNewConfirm(saved, age);
                if (choice === 'resume') { restoreRunState(saved); return; }
                else if (choice === 'new') {
                    if (runState) { stopTickInterval(); stopRestAlarm(); stopExerciseAlarm(); releaseWakeLock(); runState = null; }
                    clearSavedRunState(); disableExitProtection();
                    showToast('▶ Новая тренировка');
                }
                else if (choice === 'cancel') { clearSavedRunState(); if (runState) { stopTickInterval(); stopRestAlarm(); stopExerciseAlarm(); releaseWakeLock(); runState = null; } disableExitProtection(); showToast('❌ Тренировка отменена'); return; }
                else { return; }
            } else clearSavedRunState();
        }
        const w = DB.workouts.find(x => x.id === id);
        if (!w) { showToast('⚠️ Тренировка не найдена'); return; }
        try { await requestNotificationPermission(); } catch(e) {}
        // Resolve auto-start once at launch: global priority uses the app setting,
        // per-workout priority uses the saved workout value. Never mutate DB.workouts.
        let workoutForRun = JSON.parse(JSON.stringify(w));
        workoutForRun.autoStart = workoutUsesPersonalSettings(workoutForRun)
            ? (workoutForRun.autoStart !== undefined ? !!workoutForRun.autoStart : !!DB.settings.defaultAutoStart)
            : !!DB.settings.defaultAutoStart;
        let deloadPercent = isDeload ? 35 : 0;
        if (isDeload) {
            const ok = await customConfirm('🏷 Разгрузочный день.\n\nСнизить целевые показатели на 35%?\n\n(подходы и повторения будут уменьшены, тренировка не попадёт в рекорды)', { title: 'Разгрузка', okText: '✅ Снизить на 35%', cancelText: 'Тренироваться обычно', danger: false });
            if (ok) {
                workoutForRun.exercises = workoutForRun.exercises.map(el => {
                    if (el.kind !== 'exercise') return el;
                    const copy = Object.assign({}, el);
                    if (copy.type === 'reps') copy.targetReps = Math.max(1, Math.round((copy.targetReps || 10) * 0.65));
                    if (copy.type === 'sets') {
                        if (copy.setMode === 'reps') copy.targetReps = Math.max(1, Math.round((copy.targetReps || 10) * 0.65));
                        if (copy.setMode === 'time') copy.setDuration = Math.max(5, Math.round((copy.setDuration || 45) * 0.65));
                    }
                    if (copy.type === 'timer') copy.timerDuration = Math.max(5, Math.round((copy.timerDuration || 60) * 0.65));
                    return copy;
                });
            } else {
                deloadPercent = 0;
            }
        }
        runState = {
            workout: workoutForRun, index: 0, phase: 'ready',
            currentSet: 1, restPhase: null,
            setResults: {}, setWeights: {}, exerciseNotes: {}, workoutNoteDraft: '',
            currentExerciseWorkTime: 0, lastSetElapsed: 0,
            warmupFinished: false, warmupBeepPlayed: false, warmupMode: 'timer',
            warmupSeconds: 0, warmupDuration: 0, warmupElapsedBeforePause: 0,
            warmupStartTime: null, warmupPaused: false,
            countdownInterval: null, restOvertimeInterval: null, tickInterval: null,
            workStartTime: null, workElapsedBeforePause: 0, workPaused: false,
            restStartTime: null, restElapsedBeforePause: 0, restPaused: false,
            restDuration: 0, restBeepPlayed: false,
            restFinished: false, restOvertime: 0, restBannerMode: false,
            timerFinished: false,
            startTime: new Date(), totalWorkTime: 0, lastFinishedWorkElapsed: 0,
            exerciseTimes: [], lastBeepTargetTime: undefined, setFinishing: false, countdownValue: 3,
            workoutNameAnnounced: false, _flowStarting: false, isMuted: false,
            timerBeepPlayed: false,
            isDeload: deloadPercent > 0,
            deloadPercent: deloadPercent,
            _removedExercises: []
        };
        document.getElementById('run-title').innerText = w.name + (deloadPercent > 0 ? ' 🏷' : '');
        runReturnScreen = 'screen-workouts';
        acquireWakeLock(); enableExitProtection();
        renderRun(); showScreen('screen-run'); saveRunState();
        if (workoutForRun.autoStart) setTimeout(() => {
            if (runState && runState.phase === 'ready' && !runState.workoutNameAnnounced && !runState._flowStarting) { beginCurrentElementFlow(true); }
        }, 400);
    } finally { startWorkoutInProgress = false; }
}

function _restoreRunHeaderForNewWorkout() {
    const runMenuBtn = document.querySelector('#screen-run .top-bar .back-btn[onclick="openRunMenu()"]');
    if (runMenuBtn) {
        runMenuBtn.style.display = '';
        runMenuBtn.style.visibility = '';
        runMenuBtn.style.pointerEvents = '';
    }
    const runTitle = document.getElementById('run-title');
    if (runTitle) {
        runTitle.style.flex = '1';
        runTitle.style.textAlign = 'center';
        runTitle.style.margin = '0';
        runTitle.style.padding = '0 4px';
    }
}

function showStartNewConfirm(saved, age) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'notif-side-overlay';
        overlay.innerHTML = `<div class="notif-side-sheet">
            <div class="notif-side-grabber"><div class="notif-side-grabber-bar"></div></div>
            <h2 class="sheet-title">Продолжить тренировку?</h2>
            <div style="text-align:center; white-space:pre-line; padding: 4px 8px; line-height: 1.5; color: var(--text); flex: 1; overflow-y: auto;">Найдена незавершённая тренировка:\n«${escapeHtml(saved.workoutName)}»${escapeHtml(age)}\n\nПродолжить?</div>
            <button class="btn accent" id="sn-resume">▶ Продолжить</button>
            <button class="btn ghost" id="sn-new">Начать новую</button>
            <button class="btn danger" id="sn-cancel">✕ Отменить</button>
        </div>`;
        document.body.appendChild(overlay);
        let resolved = false;
        const finish = (val) => {
            if (resolved) return;
            resolved = true;
            const s = overlay.querySelector('.notif-side-sheet');
            if (s) s.style.transform = 'translateX(100%)';
            overlay.style.opacity = '0';
            setTimeout(() => { try { overlay.remove(); } catch(e) {} resolve(val); }, 200);
        };
        overlay.querySelector('#sn-resume').onclick = () => finish('resume');
        overlay.querySelector('#sn-new').onclick = () => finish('new');
        overlay.querySelector('#sn-cancel').onclick = () => finish('cancel');
        overlay.addEventListener('click', (e) => { if (e.target === overlay) finish('cancel'); });
        setupSideSwipe(overlay.querySelector('.notif-side-sheet'), overlay, () => finish('cancel'));
    });
}
function beginCurrentElementFlow(fromAuto = false) {
    if (!runState) return;
    if (runState.phase !== 'ready') return;
    if (runState._flowStarting) return;
    if (runState._queueEditing || runState._menuOpen) return;
    unlockAudio(); saveRunState();
    if (!runState.workoutNameAnnounced) {
        runState.workoutNameAnnounced = true;
        const announceName = getEffectiveSetting('announceWorkoutName');
        const wName = String(runState.workout.name || '').trim();
        if (announceName && wName && isVoiceMode() && ('speechSynthesis' in window) && !runState.isMuted) {
            runState._flowStarting = true;
            const readyEl = document.getElementById('phase-ready');
            if (readyEl) { const btn = readyEl.querySelector('button.btn.accent'); if (btn) { btn.disabled = true; btn.innerText = '🔊 ...'; } }
            try {
                speechSynthesis.cancel();
                const u = new SpeechSynthesisUtterance(wName);
                applyVoiceToUtterance(u);
                let proceeded = false;
                const proceed = () => { if (proceeded) return; proceeded = true; if (!runState) return; runState._flowStarting = false; proceedWithElement(fromAuto); };
                u.onend = proceed; u.onerror = proceed; setTimeout(proceed, 4000);
                speechSynthesis.speak(u);
                return;
            } catch(e) { runState._flowStarting = false; }
        }
    }
    proceedWithElement(fromAuto);
}
function proceedWithElement(fromAuto) {
    if (!runState || runState._menuOpen || runState._queueEditing) return;
    if (runState.phase !== 'ready') return;
    const el = runState.workout.exercises[runState.index];
    if (!el) { showFinishScreen(); return; }
    if (el.kind === 'warmup') {
        if (fromAuto && getEffectiveSetting('skipWarmup')) { runState.index++; runState.phase = 'ready'; if (runState.index >= runState.workout.exercises.length) { showFinishScreen(); return; } renderRun(); if (runState.workout.autoStart) setTimeout(() => beginCurrentElementFlow(true), 300); return; }
        beginWarmupPhase(el);
    } else if (el.kind === 'rest') { beginRestPhase(el); }
    else { if (getEffectiveSetting('countdown')) startCountdown(); else startExerciseNow(); }
}
function beginWarmupPhase(warmupEl) {
    runState.phase = 'warmup';
    runState.warmupFinished = false;
    runState.warmupBeepPlayed = false;
    runState.warmupMode = warmupEl.mode === 'free' ? 'free' : 'timer';
    if (runState.warmupMode === 'free') { runState.warmupDuration = 0; startTimer('warmup', 0); }
    else { const dur = (typeof warmupEl.duration === 'number' && warmupEl.duration > 0) ? warmupEl.duration : 180; runState.warmupDuration = dur; startTimer('warmup', dur); }
    speakAtElementStart('Разминка');
    saveRunState(); renderRun();
}
function toggleWarmupPause() {
    if (!runState || runState.phase !== 'warmup') return;
    if (runState.warmupFinished) return;
    if (runState.warmupPaused) { unlockAudio(); resumeTimer('warmup'); announceResume(); }
    else { pauseTimer('warmup'); announcePause(); }
    saveRunState(); renderRun();
}
function onWarmupFinished() {
    if (!runState || runState.warmupFinished) return;
    runState.warmupFinished = true;
    const elapsed = getCurrentElapsed('warmup');
    const dur = runState.warmupDuration || elapsed;
    runState.warmupSeconds = (runState.warmupSeconds || 0) + Math.min(elapsed, dur);
    if (isVoiceMode()) { try { speechSynthesis.cancel(); } catch(e) {} speakCritical('разминка завершена'); }
    else playBeep(620, 0.2);
    if (navigator.vibrate && !(runState && runState.isMuted)) navigator.vibrate([200]);
    setRingProgress('ring-warmup', 1, 'danger');
    renderRun(); saveRunState();
}
function finishWarmupEarly() {
    if (!runState || runState.phase !== 'warmup') return;
    if (runState.warmupFinished) return;
    const elapsed = getCurrentElapsed('warmup');
    const dur = runState.warmupDuration || elapsed;
    runState.warmupSeconds = (runState.warmupSeconds || 0) + Math.min(elapsed, dur);
    stopTimer('warmup');
    runState.index++; runState.phase = 'ready';
    saveRunState();
    if (runState.index >= runState.workout.exercises.length) { showFinishScreen(); return; }
    renderRun();
    if (runState.workout.autoStart) setTimeout(() => beginCurrentElementFlow(true), getAutoAdvanceDelay());
}
async function skipWarmupElement() {
    if (!runState) return;
    const el = runState.workout.exercises[runState.index];
    if (!el || el.kind !== 'warmup') return;
    if (runState.phase === 'warmup' && !runState.warmupFinished) {
        const ok = await customConfirm('Пропустить разминку?', { title: 'Пропустить разминку', okText: '→ Пропустить', cancelText: 'Отмена', danger: true });
        if (!ok) return;
    }
    if (runState.phase === 'warmup') stopTimer('warmup');
    runState.warmupFinished = false;
    runState.index++; runState.phase = 'ready';
    saveRunState();
    if (runState.index >= runState.workout.exercises.length) { showFinishScreen(); return; }
    renderRun();
    if (runState.workout.autoStart) setTimeout(() => beginCurrentElementFlow(true), getAutoAdvanceDelay());
}
function confirmWarmupFinished() {
    if (!runState || runState.phase !== 'warmup') return;
    if (runState.warmupMode === 'free') { const elapsed = getCurrentElapsed('warmup'); runState.warmupSeconds = (runState.warmupSeconds || 0) + elapsed; }
    stopTimer('warmup');
    runState.warmupFinished = false;
    runState.index++; runState.phase = 'ready';
    saveRunState();
    if (runState.index >= runState.workout.exercises.length) { showFinishScreen(); return; }
    renderRun();
    if (runState.workout.autoStart) setTimeout(() => beginCurrentElementFlow(true), getAutoAdvanceDelay());
}
function startCountdown() {
    runState.phase = 'countdown';
    const total = getEffectiveSetting('countdownDuration') || 3;
    runState.countdownValue = total;
    // Дедлайн по wall-clock — не плывёт из‑за setInterval / фона
    runState.countdownEndsAt = nowMs() + total * 1000;
    runState._countdownLastSpoken = total;
    saveRunState(); renderRun();
    if (isVoiceMode() && !runState.isMuted) speakCritical(total <= 3 ? String(total) : 'внимание');
    else if (!runState.isMuted && total <= 3) playBeep(600, 0.1);
    clearInterval(runState.countdownInterval);
    const tickCountdown = () => {
        if (!runState || runState.phase !== 'countdown') {
            clearInterval(runState.countdownInterval);
            runState.countdownInterval = null;
            return;
        }
        if (runState._menuOpen) return;
        const leftMs = (runState.countdownEndsAt || 0) - nowMs();
        const left = Math.max(0, Math.ceil(leftMs / 1000));
        if (left !== runState.countdownValue) {
            runState.countdownValue = left;
            if (left > 0 && left <= 3 && runState._countdownLastSpoken !== left) {
                runState._countdownLastSpoken = left;
                if (isVoiceMode() && !runState.isMuted) speakCritical(String(left));
                else if (!runState.isMuted) playBeep(600, 0.1);
            }
            renderRun();
        }
        if (leftMs <= 0) {
            clearInterval(runState.countdownInterval);
            runState.countdownInterval = null;
            if (isVoiceMode() && !runState.isMuted) setTimeout(() => startExerciseNow(), 500);
            else { if (!runState.isMuted) playBeep(900, 0.3); setTimeout(() => startExerciseNow(), 300); }
        }
    };
    runState.countdownInterval = setInterval(tickCountdown, 100);
}

function speakTimerDuration(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    if (sec === 0) { speakCritical('ноль минут'); return; }
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const parts = [];
    if (h > 0) parts.push(h + ' ' + (h === 1 ? 'час' : (h < 5 ? 'часа' : 'часов')));
    if (m > 0) parts.push(m + ' ' + pluralMinutes(m));
    if (h === 0 && s > 0) parts.push(s + ' ' + (s === 1 ? 'секунда' : (s < 5 ? 'секунды' : 'секунд')));
    speakCritical(parts.join(' ') || 'ноль минут');
}
function startExerciseNow() {
    if (!runState || runState._menuOpen || runState._queueEditing || !["ready", "countdown"].includes(runState.phase)) return;
    runState.phase = 'work';
    runState.workPaused = false;
    runState.currentExerciseWorkTime = 0;
    runState.timerBeepPlayed = false;
    runState.timerFinished = false;
    const el = runState.workout.exercises[runState.index];
    const n = getExerciseNumber(runState.workout.exercises, runState.index);
    const doNum = getEffectiveSetting('announceNumbers');
    const doName = getEffectiveSetting('announceExerciseName') !== false;
    const doGoal = getEffectiveSetting('announceExerciseGoal') !== false;
    let namePart = '';
    if (doNum && doName) namePart = n + '. ' + (el.name || 'Упражнение');
    else if (doNum) namePart = String(n);
    else if (doName) namePart = (el.name || 'Упражнение');
    let goalPart = '';
    if (doGoal) {
        if (el.type === 'reps') {
            const reps = el.targetReps || 10;
            goalPart = `цель ${reps} ${pluralReps(reps)}`;
        } else if (el.type === 'timer') {
            goalPart = '';
        } else if (el.type === 'sets') {
            const sets = el.setsCount || 3;
            if (el.setMode === 'time') {
                const dur = el.setDuration || 45;
                goalPart = `${sets} ${pluralApproaches(sets)} по ${dur} секунд`;
            } else {
                const reps = el.targetReps || 10;
                goalPart = `${sets} ${pluralApproaches(sets)} по ${reps} ${pluralReps(reps)}`;
            }
        }
    }
    if (el.type === 'timer') {
        const dur = el.timerDuration || 60;
        if (isVoiceMode() && !runState.isMuted) {
            const head = [namePart, goalPart].filter(Boolean).join(', ');
            if (head) speakAtElementStart(head);
            if (doGoal) speakTimerDuration(dur);
        }
        startTimer('work', dur);
    } else {
        const speech = [namePart, goalPart].filter(Boolean).join(', ');
        if (speech) speakAtElementStart(speech);
        startTimer('work', 0);
    }
    saveRunState(); renderRun();
}
function beginRestPhase(restEl) {
    runState.phase = 'rest';
    runState.restFinished = false;
    runState.restBeepPlayed = false;
    runState.restPhase = 'normal';
    if (restEl.duration === null || restEl.duration === 0) { runState.restBannerMode = true; stopTimer('rest'); stopTickInterval(); }
    else { runState.restBannerMode = false; startTimer('rest', restEl.duration); }
    const ta = document.getElementById('rest-note-textarea');
    const btn = document.getElementById('rest-note-toggle');
    if (ta) { ta.style.display = 'none'; ta.value = ''; }
    if (btn) btn.innerText = '📝 Добавить заметку';
    const isWater = restEl.restType === 'water';
    const next = findNextElement(runState.workout.exercises, runState.index);
    const doRestName = getEffectiveSetting('announceRestName') !== false;
    const doNum = getEffectiveSetting('announceNumbers');
    const doExName = getEffectiveSetting('announceExerciseName') !== false;
    let speech = '';
    if (doRestName) speech = isWater ? 'Необходимо попить воды' : 'Отдых';
    if (next) {
        const nx = next.el;
        if (nx.kind === 'exercise') {
            const num = getExerciseNumber(runState.workout.exercises, next.idx);
            let nextPart = '';
            if (doNum && doExName) nextPart = num + '. ' + (nx.name || '');
            else if (doNum) nextPart = String(num);
            else if (doExName) nextPart = (nx.name || '');
            if (nextPart) speech = speech ? (speech + '. Следующее ' + nextPart) : ('Следующее ' + nextPart);
        }
    }
    if (speech) speakAtElementStart(speech);
    saveRunState(); renderRun();
    if (runState.restBannerMode) saveRunState();
}
function toggleWorkPause() {
    if (runState.workPaused) { unlockAudio(); resumeTimer('work'); announceResume(); if (runState.timerFinished && getEffectiveSetting('continuousBeep')) startExerciseAlarm(); }
    else { pauseTimer('work'); announcePause(); stopExerciseAlarm(); }
    saveRunState(); renderRun();
}
let finishExerciseInProgress = false;
async function finishExercise() {
    // Защита от «залипшего» флага после свайпа диалога: если промис уже не ждётся — сбрасываем
    if (finishExerciseInProgress) {
        const askOpen = !!document.querySelector('.notif-side-overlay[data-ft-ask-dialog="1"]');
        if (askOpen || askRepsBusy) return;
        finishExerciseInProgress = false;
    }
    if (!runState) return;
    const el = runState.workout.exercises[runState.index];
    if (!el || el.kind !== 'exercise') return;
    finishExerciseInProgress = true;
    try {
        stopExerciseAlarm();
        const canAskReps = ((el.type === 'sets' && el.setMode === 'reps') || el.type === 'reps') && getEffectiveSetting('askReps');
        const canAskWeight = ((el.type === 'sets') || el.type === 'reps') && getEffectiveSetting('askWeight');
        const needAsk = canAskReps || canAskWeight;
        let asked = null;
        const wasPausedBefore = runState.workPaused;
        if (needAsk) {
            if (!wasPausedBefore) pauseTimer('work');
            renderRun();
            const setNo = runState.currentSet || 1;
            let lastW = 0;
            if (canAskWeight && getEffectiveSetting('autoFillWeight')) {
                lastW = getSuggestedWeight(el.name, setNo) || 0;
            } else if (runState.setWeights && runState.setWeights[runState.index] && runState.setWeights[runState.index].length) {
                lastW = Number(runState.setWeights[runState.index][runState.setWeights[runState.index].length - 1]) || 0;
            }
            let defaultRepsVal = el.targetReps || 0;
            if (canAskReps && getEffectiveSetting('autoFillReps')) {
                defaultRepsVal = getSuggestedReps(el.name, setNo, el.targetReps || 0);
            }
            asked = await askSetResult({
                askReps: canAskReps,
                askWeight: canAskWeight,
                defaultReps: defaultRepsVal,
                defaultWeight: lastW || 0
            });
            if (asked === null) {
                if (!wasPausedBefore && !runState.timerFinished) resumeTimer('work');
                renderRun();
                return;
            }
        }
        const elapsed = getCurrentElapsed('work');
        stopTimer('work'); runState.workPaused = false;
        runState.timerFinished = false;
        runState.totalWorkTime += elapsed;
        runState.currentExerciseWorkTime = (runState.currentExerciseWorkTime || 0) + elapsed;
        runState.lastSetElapsed = elapsed;
        if (!runState.setWeights) runState.setWeights = {};
        if (el.type === 'sets') {
            if (!runState.setResults[runState.index]) runState.setResults[runState.index] = [];
            if (!runState.setWeights[runState.index]) runState.setWeights[runState.index] = [];
            let val = (asked && asked.reps != null) ? asked.reps : (el.setMode === 'time' ? Math.min(elapsed, el.setDuration || elapsed) : (el.targetReps || 0));
            runState.setResults[runState.index].push(val);
            if (canAskWeight) runState.setWeights[runState.index].push(asked && asked.weight != null ? asked.weight : 0);
            const totalSets = el.setsCount || 3;
            const isLastSet = runState.currentSet >= totalSets;
            if (!isLastSet) {
                runState.currentSet++;
                runState.phase = 'rest'; runState.restPhase = 'between-sets';
                runState.restFinished = false; runState.restBeepPlayed = false; runState.restBannerMode = false;
                startTimer('rest', el.restBetweenSets || 60);
                saveRunState(); renderRun();
                if (getEffectiveSetting('announceRestName')) speak('Отдых');
                return;
            }
            runState.exerciseTimes.push(runState.currentExerciseWorkTime);
            runState.lastFinishedWorkElapsed = runState.currentExerciseWorkTime;
            runState.currentExerciseWorkTime = 0; runState.currentSet = 1; runState.restPhase = null;
            advanceAfterExercise();
        } else if (el.type === 'reps') {
            const val = (asked && asked.reps != null) ? asked.reps : (el.targetReps || 0);
            runState.setResults[runState.index] = [val];
            if (canAskWeight) runState.setWeights[runState.index] = [asked && asked.weight != null ? asked.weight : 0];
            runState.exerciseTimes.push(elapsed);
            runState.lastFinishedWorkElapsed = elapsed;
            runState.currentExerciseWorkTime = 0;
            advanceAfterExercise();
        } else {
            runState.exerciseTimes.push(elapsed);
            runState.lastFinishedWorkElapsed = elapsed;
            runState.currentExerciseWorkTime = 0;
            advanceAfterExercise();
        }
    } finally { finishExerciseInProgress = false; }
}
function advanceAfterExercise() {
    runState.index++; runState.phase = 'ready';
    runState.restFinished = false; runState.restOvertime = 0;
    runState.timerFinished = false;
    saveRunState();
    if (runState.index >= runState.workout.exercises.length) { showFinishScreen(); return; }
    renderRun();
    if (runState.workout.autoStart) setTimeout(() => beginCurrentElementFlow(true), getAutoAdvanceDelay());
}
let skipExerciseInProgress = false;
async function skipExercise() {
    if (skipExerciseInProgress) return;
    if (!runState) return;
    const el = runState.workout.exercises[runState.index];
    if (!el || el.kind !== 'exercise') return;
    skipExerciseInProgress = true;
    try {
        const inWork = runState.phase === 'work' || runState.phase === 'countdown';
        const isMid = el.type === 'sets' && runState.currentSet > 1;
        const alwaysConfirm = getEffectiveSetting('confirmSkipExercise') === true;
        if (alwaysConfirm || inWork || isMid) {
            const ok = await customConfirm('Пропустить упражнение?\nОно не будет засчитано в статистике.', { title: 'Пропустить упражнение', okText: '→ Пропустить', cancelText: 'Отмена', danger: true });
            if (!ok) return;
        }
        const savedIdx = runState.index;
        const savedExerciseTimes = [...runState.exerciseTimes];
        const savedSetResults = JSON.parse(JSON.stringify(runState.setResults));
        const savedSetWeights = JSON.parse(JSON.stringify(runState.setWeights || {}));
        const savedCurrentSet = runState.currentSet;
        stopTimer('work'); stopTimer('rest'); stopRestAlarm(); stopExerciseAlarm();
        runState.workPaused = false;
        runState.timerFinished = false;
        runState.setResults[runState.index] = 'skipped';
        if (runState.setWeights) delete runState.setWeights[runState.index];
        runState.exerciseTimes.push(-1);
        runState.currentSet = 1; runState.restPhase = null;
        runState.restFinished = false; runState.restOvertime = 0; runState.restBannerMode = false;
        runState.currentExerciseWorkTime = 0; runState.lastSetElapsed = 0;
        runState.index++; runState.phase = 'ready';
        saveRunState();
        if (runState.index >= runState.workout.exercises.length) { showFinishScreen(); return; }
        renderRun();
        if (runState.workout.autoStart) setTimeout(() => beginCurrentElementFlow(true), getAutoAdvanceDelay());
        showUndoToast('Упражнение пропущено', () => {
            if (!runState) { showToast('Тренировка уже завершена'); return; }
            if (runState.index !== savedIdx + 1) { showToast('Уже перешли дальше'); return; }
            runState.index = savedIdx; runState.phase = 'ready';
            runState.exerciseTimes = savedExerciseTimes;
            runState.setResults = savedSetResults;
            runState.setWeights = savedSetWeights;
            runState.currentSet = savedCurrentSet;
            saveRunState(); renderRun(); showToast('↩ Восстановлено');
        });
    } finally { skipExerciseInProgress = false; }
}
function toggleRestPause() {
    if (runState.restBannerMode) return;
    if (runState.restPaused) { unlockAudio(); resumeTimer('rest'); announceResume(); }
    else { pauseTimer('rest'); announcePause(); }
    saveRunState(); renderRun();
}
function adjustRest(d) {
    if (runState.restBannerMode) return;
    if (runState.restFinished) {
        if (d < 0) return;
        const elapsed = getCurrentElapsed('rest');
        let newDur = runState.restDuration + d;
        if (newDur <= elapsed) newDur = elapsed + d;
        runState.restDuration = newDur; runState.restFinished = false;
        runState.restOvertime = 0; runState.restBeepPlayed = false;
        stopRestAlarm();
    } else {
        runState.restDuration = Math.max(0, runState.restDuration + d);
        if (runState.restDuration <= getCurrentElapsed('rest')) { runState.restElapsedBeforePause = 0; runState.restStartTime = Date.now(); runState.restDuration = 0; onRestFinished(); }
    }
    updateTimersUI(); renderRun(); saveRunState();
}
function skipRest() {
    stopRestAlarm();
    if (runState.restPhase === 'between-sets') { stopTimer('rest'); saveRunState(); beginBetweenSets(); return; }
    stopTimer('rest');
    runState.index++; runState.phase = 'ready';
    runState.restPhase = null; runState.restFinished = false; runState.restOvertime = 0;
    saveRunState();
    if (runState.index >= runState.workout.exercises.length) { showFinishScreen(); return; }
    renderRun();
    if (runState.workout.autoStart) setTimeout(() => beginCurrentElementFlow(true), getAutoAdvanceDelay());
}
function beginBetweenSets() {
    runState.phase = 'work'; runState.workPaused = false;
    runState.restPhase = null; runState.restFinished = false; runState.restOvertime = 0;
    speak(`Подход ${runState.currentSet}`);
    startTimer('work', 0); saveRunState(); renderRun();
}
function confirmRestFinished() {
    stopRestAlarm(); stopTimer('rest');
    if (runState.restPhase === 'between-sets') { saveRunState(); beginBetweenSets(); return; }
    runState.index++; runState.phase = 'ready';
    runState.restPhase = null; runState.restFinished = false; runState.restOvertime = 0;
    saveRunState();
    if (runState.index >= runState.workout.exercises.length) { showFinishScreen(); return; }
    renderRun();
    if (runState.workout.autoStart) setTimeout(() => beginCurrentElementFlow(true), getAutoAdvanceDelay());
}
function confirmBanner() { confirmRestFinished(); }
function onRestFinished() {
    if (runState.restFinished) return;
    if (getEffectiveSetting('continuousBeep')) {
        runState.restFinished = true; runState.restOvertime = 0;
        startRestAlarm(); updateTimersUI();
        setRingProgress('ring-rest', 1, 'danger');
        renderRun();
    } else {
        playEndBeep();
        if (isVoiceMode()) { try { speechSynthesis.cancel(); } catch(e) {} speakCritical('отдых закончен'); }
        if (navigator.vibrate && !(runState && runState.isMuted)) navigator.vibrate([200, 100, 200]);
        confirmRestFinished();
    }
}
function toggleRestNote() {
    const ta = document.getElementById('rest-note-textarea');
    const btn = document.getElementById('rest-note-toggle');
    if (!ta || !btn) return;
    const prevIdx = findPrevExerciseIndex(runState.workout.exercises, runState.index);
    if (prevIdx < 0) { showToast('Нет предыдущего упражнения'); return; }
    if (ta.style.display === 'none' || ta.style.display === '') {
        ta.style.display = 'block';
        ta.value = runState.exerciseNotes[prevIdx] || '';
        ta.focus();
        btn.innerText = '✅ Сохранить заметку';
    } else {
        ta.style.display = 'none';
        runState.exerciseNotes[prevIdx] = ta.value;
        saveRunState();
        btn.innerText = runState.exerciseNotes[prevIdx] ? '📝 Редактировать заметку' : '📝 Добавить заметку';
        showToast('📝 Заметка сохранена');
    }
}
function undoLastElement() {
    stopRestAlarm(); stopExerciseAlarm();
    if (runState.restPhase === 'between-sets') {
        stopTimer('rest');
        const el = runState.workout.exercises[runState.index];
        if (!el) return;
        if (runState.setResults[runState.index] && runState.setResults[runState.index].length > 0) runState.setResults[runState.index].pop();
        if (runState.setWeights && runState.setWeights[runState.index] && runState.setWeights[runState.index].length > 0) runState.setWeights[runState.index].pop();
        runState.currentSet = Math.max(1, runState.currentSet - 1);
        runState.totalWorkTime = Math.max(0, runState.totalWorkTime - (runState.lastSetElapsed || 0));
        runState.currentExerciseWorkTime = Math.max(0, (runState.currentExerciseWorkTime || 0) - (runState.lastSetElapsed || 0));
        runState.lastSetElapsed = 0;
        runState.phase = 'work'; runState.workPaused = false;
        runState.restPhase = null; runState.restFinished = false; runState.restOvertime = 0;
        startTimer('work', 0);
        if (isVoiceMode()) speak(`Подход ${runState.currentSet}`);
        saveRunState(); renderRun();
        return;
    }
    const prev = findPrevExerciseIndex(runState.workout.exercises, runState.index);
    if (prev < 0) { showToast('Нечего отменять'); return; }
    stopTimer('rest');
    const elapsed = runState.lastFinishedWorkElapsed || 0;
    runState.totalWorkTime = Math.max(0, runState.totalWorkTime - elapsed);
    if (runState.exerciseTimes.length > 0) runState.exerciseTimes.pop();
    runState.setResults[prev] = [];
    if (runState.setWeights) runState.setWeights[prev] = [];
    runState.currentExerciseWorkTime = 0; runState.lastSetElapsed = 0;
    runState.index = prev; runState.currentSet = 1;
    runState.restFinished = false; runState.restOvertime = 0; runState.restPhase = null;
    runState.timerFinished = false;
    runState.phase = 'ready';
    saveRunState(); renderRun();
    const targetIndex = prev;
    setTimeout(() => { if (runState && runState.phase === 'ready' && runState.index === targetIndex) { unlockAudio(); proceedWithElement(false); } }, 100);
}

function _updateWorkTimerRing(el, t) {
    const elapsed = getCurrentElapsed('work');
    const dur = el.timerDuration || 60;
    const remaining = Math.max(0, dur - elapsed);
    if (runState.timerFinished) {
        if (t) t.innerText = formatTimeUpDisplay('work');
    } else {
        if (t) t.innerText = formatTime(remaining);
    }
    if (runState._menuOpen || runState.workPaused) {
        if (t) t.style.color = 'var(--warn)';
        const pct = dur > 0 ? remaining / dur : 0;
        setRingProgress('ring-work', pct, 'paused');
    } else if (runState.timerFinished) {
        setRingProgress('ring-work', 1, 'danger');
        if (t) t.style.color = 'var(--danger)';
    } else {
        const pct = dur > 0 ? remaining / dur : 0;
        const warnAt = getFinalWarnSeconds();
        const isDanger = warnAt > 0 && remaining > 0 && remaining <= warnAt;
        if (t) t.style.color = isDanger ? 'var(--danger)' : '';
        setRingProgress('ring-work', pct, isDanger ? 'danger' : 'work');
    }
    const warnAtWork = getFinalWarnSeconds();
    if (warnAtWork > 0 && remaining > 0 && remaining <= warnAtWork && !runState.timerBeepPlayed && !runState.workPaused && !runState._menuOpen) {
        runState.timerBeepPlayed = true;
        announceFinalCount(Math.ceil(remaining));
    }
    if (remaining <= 0 && !runState.timerFinished && !runState.workPaused && !runState._menuOpen && !finishExerciseInProgress) {
        onExerciseTimerFinished();
    }
}
function _updateSetTimeRing(el, t) {
    const elapsed = getCurrentElapsed('work');
    const dur = el.setDuration || 45;
    const remaining = Math.max(0, dur - elapsed);
    if (t) t.innerText = formatTime(remaining);
    const pct = dur > 0 ? remaining / dur : 0;
    if (runState._menuOpen || runState.workPaused) {
        if (t) t.style.color = 'var(--warn)';
        setRingProgress('ring-work', pct, 'paused');
    } else {
        const warnAt = getFinalWarnSeconds();
        const isDanger = warnAt > 0 && remaining > 0 && remaining <= warnAt;
        if (t) t.style.color = isDanger ? 'var(--danger)' : '';
        setRingProgress('ring-work', pct, isDanger ? 'danger' : 'work');
    }
    if (remaining <= 0 && !runState.setFinishing && !runState.workPaused && !runState._menuOpen && !finishExerciseInProgress) {
        runState.setFinishing = true;
        const session = runState;
        Promise.resolve(finishExercise()).finally(() => { if (runState === session) session.setFinishing = false; });
    }
}
function _updateRestRing() {
    const rem = getRemainingTime('rest');
    const el = document.getElementById('rest-timer');
    if (el) { if (runState.restFinished) el.innerText = formatTimeUpDisplay('rest'); else el.innerText = formatTime(rem); }
    if (runState._menuOpen || runState.restPaused) {
        if (el) el.style.color = 'var(--warn)';
        const dur = runState.restDuration || 1;
        setRingProgress('ring-rest', rem / dur, 'paused');
    } else if (runState.restFinished) {
        setRingProgress('ring-rest', 1, 'danger');
        if (el) el.style.color = 'var(--danger)';
    } else {
        const dur = runState.restDuration || 1;
        const warnAt = getFinalWarnSeconds();
        const isDanger = warnAt > 0 && rem > 0 && rem <= warnAt;
        if (el) el.style.color = isDanger ? 'var(--danger)' : '';
        setRingProgress('ring-rest', rem / dur, isDanger ? 'danger' : 'rest');
    }
    const warnAtRest = getFinalWarnSeconds();
    if (warnAtRest > 0 && rem > 0 && rem <= warnAtRest && !runState.restBeepPlayed && !runState.restPaused && !runState.restFinished && !runState._menuOpen) {
        runState.restBeepPlayed = true;
        announceFinalCount(Math.ceil(rem));
    }
    if (rem === 0 && !runState.restFinished && !runState.restPaused && !runState._menuOpen) onRestFinished();
}

function updateTimersUI() {
    if (!runState) return;
    const { phase } = runState;
    const workEl = runState.workout.exercises[runState.index];
    const isWorkTimer = (phase === 'work' && workEl && workEl.type === 'timer');
    if (getEffectiveSetting('minuteBeep') && (phase === 'work' || (phase === 'rest' && !runState.restBannerMode) || phase === 'warmup')) {
        const paused = runState[`${phase}Paused`];
        if (!paused && !(phase === 'warmup' && runState.warmupFinished)) {
            const interval = getEffectiveSetting('minuteBeepInterval') || 60;
            const isCountdown = (phase === 'rest') || (phase === 'warmup' && runState.warmupMode === 'timer') || isWorkTimer;
            const tt = (phase === 'rest') ? getRemainingTime('rest') : (phase === 'warmup' ? (runState.warmupMode === 'timer' ? getRemainingTime('warmup') : getCurrentElapsed('warmup')) : (isWorkTimer ? getRemainingTime('work') : getCurrentElapsed('work')));
            if (runState.lastBeepTargetTime === undefined) runState.lastBeepTargetTime = tt;
            let trigger = false;
            if (isCountdown) { const prevBucket = Math.ceil(runState.lastBeepTargetTime / interval); const currBucket = Math.ceil(tt / interval); if (currBucket < prevBucket && tt > 0) trigger = true; }
            else { const prevBucket = Math.floor(runState.lastBeepTargetTime / interval); const currBucket = Math.floor(tt / interval); if (currBucket > prevBucket && tt > 0) trigger = true; }
            if (trigger) {
                if (isVoiceMode() && !runState.isMuted) {
                    if (isWorkTimer) {
                        const rem = Math.max(1, Math.ceil(tt / 60));
                        speakCritical('осталось ' + rem + ' ' + pluralMinutes(rem));
                    } else if (isCountdown) {
                        const m = Math.max(1, Math.round(tt / 60));
                        speakCritical('осталось ' + remainingMinutesText(m));
                    } else {
                        const m = Math.max(1, Math.round(tt / 60));
                        speakCritical(elapsedMinutesText(m));
                    }
                } else if (!runState.isMuted) playBeep(1000, 0.15);
            }
            runState.lastBeepTargetTime = tt;
        }
    }
    if (phase === 'work') {
        const el = runState.workout.exercises[runState.index];
        if (!el) return;
        const t = document.getElementById('work-timer');
        if (el.type === 'timer') {
            _updateWorkTimerRing(el, t);
            hideRingDot('dot-work', 'ring-work');
        } else if (el.type === 'sets' && el.setMode === 'time') {
            _updateSetTimeRing(el, t);
            hideRingDot('dot-work', 'ring-work');
        } else {
            const elapsed = getCurrentElapsed('work');
            if (t) t.innerText = formatTime(elapsed);
            const paused = runState.workPaused || runState._menuOpen;
            const dotCls = paused ? 'paused' : 'work';
            setRingDot('dot-work', 'ring-work', elapsed, dotCls);
            if (t) t.style.color = paused ? 'var(--warn)' : '';
        }
    } else if (phase === 'warmup' && !runState.warmupFinished) {
        const el = document.getElementById('warmup-timer');
        if (runState.warmupMode === 'free') {
            const elapsed = getCurrentElapsed('warmup');
            if (el) el.innerText = formatTime(elapsed);
            const paused = runState.warmupPaused || runState._menuOpen;
            const dotCls = paused ? 'paused' : 'warmup';
            setRingDot('dot-warmup', 'ring-warmup', elapsed, dotCls);
            if (el) el.style.color = paused ? 'var(--warn)' : '';
        } else {
            const rem = getRemainingTime('warmup');
            if (el) el.innerText = formatTime(rem);
            const dur = runState.warmupDuration || 1;
            if (runState._menuOpen) { if (el) el.style.color = 'var(--warn)'; setRingProgress('ring-warmup', rem/dur, 'paused'); }
            else { if (el) el.style.color = ''; setRingProgress('ring-warmup', rem / dur, runState.warmupPaused ? 'paused' : 'warmup'); }
            const warnAtWarm = getFinalWarnSeconds();
            if (warnAtWarm > 0 && rem > 0 && rem <= warnAtWarm && !runState.warmupBeepPlayed && !runState.warmupPaused && !runState._menuOpen) { runState.warmupBeepPlayed = true; announceFinalCount(Math.ceil(rem)); }
            if (rem === 0 && !runState.warmupFinished && !runState._menuOpen) onWarmupFinished();
            hideRingDot('dot-warmup', 'ring-warmup');
        }
    } else if (phase === 'rest' && !runState.restBannerMode) {
        _updateRestRing();
    }
    if (document.visibilityState === 'hidden') return;
    saveCounter++;
    if (saveCounter % 20 === 0) {
        const phaseKey = phase === 'warmup' ? 'warmupPaused' : phase === 'work' ? 'workPaused' : phase === 'rest' ? 'restPaused' : null;
        const isPaused = phaseKey ? !!runState[phaseKey] : false;
        if (!isPaused) saveRunState();
    }
}

function onExerciseTimerFinished() {
    if (!runState || runState.timerFinished) return;
    if (getEffectiveSetting('continuousBeep')) {
        runState.timerFinished = true;
        startExerciseAlarm();
        if (isVoiceMode()) { try { if ('speechSynthesis' in window) speechSynthesis.cancel(); } catch(e) {} speakCritical('упражнение сделано'); }
        updateTimersUI();
        setRingProgress('ring-work', 1, 'danger');
        renderRun();
    } else {
        runState.timerFinished = true;
        playEndBeep();
        if (isVoiceMode()) { try { if ('speechSynthesis' in window) speechSynthesis.cancel(); } catch(e) {} speakCritical('упражнение сделано'); }
        if (navigator.vibrate && !runState.isMuted) navigator.vibrate([200, 100, 200]);
        setTimeout(() => {
            if (runState && runState.phase === 'work' && runState.timerFinished && !finishExerciseInProgress) {
                Promise.resolve(finishExercise()).finally(() => { if (runState) runState.timerFinished = false; });
            }
        }, 1200);
    }
}
function elapsedMinutesText(n) { if (n === 1) return 'минута'; return n + ' ' + pluralMinutes(n); }
function remainingMinutesText(n) { if (n === 1) return 'одна минута'; return n + ' ' + pluralMinutes(n); }

function renderRun() {
    if (!runState) return;
    try { applyLargeRunControls(); } catch(e) {}
    const { workout, index, phase } = runState;
    const elements = workout.exercises;
    if (index >= elements.length) { showFinishScreen(); return; }
    const el = elements[index];
    const phaseLabel = document.getElementById('phase-label');
    const phaseHeaderEl = document.getElementById('phase-header-el');
    const currentExEl = document.getElementById('current-exercise');
    const startDisplay = document.getElementById('start-time-display');
    const startValue = document.getElementById('start-time-value');
    const setBadge = document.getElementById('set-badge');
    const muteIcon = document.getElementById('timer-mute-icon');
    const muteBtn = document.getElementById('timer-mute-btn');
    if (muteIcon && muteBtn) {
        if (runState.isMuted) { muteIcon.innerText = '🔇'; muteBtn.classList.add('muted'); }
        else { muteIcon.innerText = '🔊'; muteBtn.classList.remove('muted'); }
        muteBtn.style.display = '';
    }
    if (phaseHeaderEl) phaseHeaderEl.style.display = 'flex';
    if (currentExEl) currentExEl.style.display = 'flex';
    document.getElementById('progress-fill').style.width = calcProgress() + '%';
    hideAllPhases();
    setBadge.style.display = 'none';
    currentExEl.style.color = '';
    currentExEl.classList.remove('long', 'very-long');
    phaseLabel.className = 'phase-label';
    if (getEffectiveSetting('showStartTime') && runState.startTime) { startDisplay.style.display = 'block'; startValue.innerText = formatClock(runState.startTime); }
    else startDisplay.style.display = 'none';
    phaseLabel.style.display = 'block';
    const nameLen = (el.kind === 'exercise' ? (el.name || '').length : 0);
    if (nameLen > 22) currentExEl.classList.add('very-long');
    else if (nameLen > 14) currentExEl.classList.add('long');
    if (el.kind === 'exercise' && el.type === 'sets' && (phase === 'work' || phase === 'countdown' || phase === 'ready')) {
        setBadge.style.display = 'block';
        setBadge.innerHTML = `Подход <span class="set-num">${runState.currentSet}</span> из ${el.setsCount || 3}`;
    }
    if (phase === 'ready') {
        if (el.kind === 'warmup') {
            currentExEl.innerText = 'Разминка';
            phaseLabel.innerText = 'РАЗМИНКА';
            const mode = el.mode === 'free' ? 'free' : 'timer';
            const infoText = mode === 'timer' ? `⏱ ${formatTime(el.duration || 180)}` : `🕐 Свободно`;
            document.getElementById('phase-ready').innerHTML = `<p style="text-align:center; color:var(--warn); font-size:1.15rem; font-weight:700; margin-bottom:10px;">${infoText}</p><p style="text-align:center; color:var(--muted);">Готов?</p><button class="btn accent" onclick="beginCurrentElementFlow()">▶ Начать</button><button class="btn ghost" onclick="skipWarmupElement()" style="color:var(--muted); margin-top:8px;">→ Пропустить разминку</button>`;
            document.getElementById('phase-ready').style.display = 'block';
        } else if (el.kind === 'rest') {
            const prevIdx = findPrevExerciseIndex(elements, index);
            const prevEx = prevIdx >= 0 ? elements[prevIdx] : null;
            currentExEl.innerText = prevEx ? (prevEx.name || 'Упражнение') : 'Отдых';
            const isWater = el.restType === 'water';
            phaseLabel.innerText = isWater ? 'НЕОБХОДИМО ПОПИТЬ ВОДЫ' : 'ОТДЫХ';
            let info = el.duration === null || el.duration === 0 ? `<p style="text-align:center; color:var(--accent); font-size:1.15rem; font-weight:700; margin-bottom:10px;">Без таймера</p>` : `<p style="text-align:center; color:var(--accent); font-size:1.15rem; font-weight:700; margin-bottom:10px;">${formatTime(el.duration)}</p>`;
            const canUndo = runState.exerciseTimes.length > 0;
            const undoBtn = canUndo ? `<button class="btn blue" onclick="undoLastElement()" style="margin-top:8px;">↩ Восстановить</button>` : '';
            document.getElementById('phase-ready').innerHTML = `${info}<p style="text-align:center; color:var(--muted);">Готов? Нажми чтобы начать.</p><button class="btn accent" onclick="beginCurrentElementFlow()">▶ Начать</button>${undoBtn}`;
            document.getElementById('phase-ready').style.display = 'block';
        } else {
            currentExEl.innerText = el.name || 'Упражнение';
            const exNum = getExerciseNumber(elements, index);
            const totalEx = getTotalExerciseCount(elements);
            phaseLabel.innerText = `УПРАЖНЕНИЕ ${exNum} / ${totalEx}`;
            let info = '';
            if (el.type === 'reps') info = `<p style="text-align:center; color:var(--accent); font-size:1.15rem; font-weight:700; margin-bottom:10px;">🔢 ${el.targetReps || 10} ${pluralReps(el.targetReps || 10)}</p>`;
            else if (el.type === 'timer') info = `<p style="text-align:center; color:var(--accent); font-size:1.15rem; font-weight:700; margin-bottom:10px;">⏳ ${formatTime(el.timerDuration || 60)}</p>`;
            else if (el.type === 'sets') info = `<p style="text-align:center; color:var(--accent); font-size:1.15rem; font-weight:700; margin-bottom:10px;">🔁 ${el.setsCount || 3}× ${el.setMode === 'reps' ? (el.targetReps || 10) + ' повт.' : (el.setDuration || 45) + ' сек'}</p>`;
            const canUndo = runState.exerciseTimes.length > 0;
            const undoBtn = canUndo ? `<button class="btn blue" onclick="undoLastElement()" style="margin-top:8px;">↩ Восстановить</button>` : '';
            document.getElementById('phase-ready').innerHTML = `${el.notes ? `<p style="text-align:center; color:var(--muted); font-size:0.9rem; margin-bottom:10px;">📝 ${escapeHtml(el.notes)}</p>` : ''}${info}<p style="text-align:center; color:var(--muted);">Готов? Нажми чтобы начать.</p><button class="btn accent" onclick="beginCurrentElementFlow()">▶ Начать</button><button class="btn ghost" onclick="skipExercise()" style="color:var(--muted); margin-top:8px;">→ Пропустить</button>${undoBtn}`;
            document.getElementById('phase-ready').style.display = 'block';
        }
    } else if (phase === 'countdown') {
        currentExEl.innerText = el.name || 'Упражнение';
        const exNum = getExerciseNumber(elements, index);
        const totalEx = getTotalExerciseCount(elements);
        phaseLabel.innerText = `УПРАЖНЕНИЕ ${exNum} / ${totalEx}`;
        document.getElementById('countdown-timer').innerText = runState.countdownValue;
        document.getElementById('phase-countdown').style.display = 'block';
    } else if (phase === 'warmup') {
        currentExEl.innerText = 'Разминка';
        const timer = document.getElementById('warmup-timer');
        const pauseBtn = document.getElementById('warmup-pause-btn');
        const finishEarlyBtn = document.getElementById('warmup-finish-early-btn');
        const skipBtn = document.getElementById('warmup-skip-btn');
        const confirmBtn = document.getElementById('warmup-confirm-btn');
        if (runState.warmupMode === 'free') {
            phaseLabel.innerText = runState.warmupPaused ? '⏸ ПАУЗА' : 'РАЗМИНКА (СВОБОДНО)';
            currentExEl.style.color = '';
            if (timer) { timer.classList.remove('done', 'overtime'); timer.classList.toggle('paused', !!runState.warmupPaused); }
            pauseBtn.style.display = 'block'; pauseBtn.innerText = runState.warmupPaused ? '▶ Продолжить' : '❚❚ Пауза';
            finishEarlyBtn.style.display = 'none'; skipBtn.style.display = 'none';
            confirmBtn.style.display = 'block'; confirmBtn.innerText = '✓ Завершить разминку';
        } else if (runState.warmupFinished) {
            phaseLabel.innerText = '✅ Разминка завершена';
            currentExEl.style.color = 'var(--accent)';
            if (timer) { timer.classList.remove('overtime', 'paused'); timer.classList.add('done'); timer.innerText = formatTime(0); }
            pauseBtn.style.display = 'none'; finishEarlyBtn.style.display = 'none'; skipBtn.style.display = 'none';
            confirmBtn.style.display = 'block'; confirmBtn.innerText = '▶ К упражнению';
            setRingProgress('ring-warmup', 1, 'danger');
            hideRingDot('dot-warmup', 'ring-warmup');
        } else {
            phaseLabel.innerText = runState.warmupPaused ? '⏸ ПАУЗА' : 'РАЗМИНКА';
            currentExEl.style.color = '';
            if (timer) { timer.classList.remove('overtime', 'done'); timer.classList.toggle('paused', !!runState.warmupPaused); }
            pauseBtn.style.display = 'block'; pauseBtn.innerText = runState.warmupPaused ? '▶ Продолжить' : '❚❚ Пауза';
            finishEarlyBtn.style.display = 'block'; skipBtn.style.display = 'block'; confirmBtn.style.display = 'none';
            if (runState.warmupPaused) setRingProgress('ring-warmup', 1, 'paused');
            hideRingDot('dot-warmup', 'ring-warmup');
        }
        document.getElementById('phase-warmup').style.display = 'block';
    } else if (phase === 'work') {
        currentExEl.innerText = el.name || 'Упражнение';
        const exNum = getExerciseNumber(elements, index);
        const totalEx = getTotalExerciseCount(elements);
        phaseLabel.innerText = `УПРАЖНЕНИЕ ${exNum} / ${totalEx}`;
        const workTimer = document.getElementById('work-timer');
        const pauseBtn = document.getElementById('work-pause-btn');
        const finishBtn = document.getElementById('work-finish-btn');
        const skipBtn = document.getElementById('work-skip-btn');
        const repsInfo = document.getElementById('work-reps-info');
        const repsTarget = document.getElementById('work-reps-target');
        const timelineEl = document.getElementById('work-set-timeline');
        let showReps = false, targetText = '', finishText = '✓ Завершить упражнение';
        if (el.type === 'reps') { showReps = true; targetText = el.targetReps || 10; }
        else if (el.type === 'sets') {
            if (el.setMode === 'reps') { showReps = true; targetText = el.targetReps || 10; }
            if (el.setMode === 'time') finishText = '✓ Завершить подход';
            else finishText = `✓ Подход ${runState.currentSet} сделан`;
            if (runState.currentSet === (el.setsCount || 3) && el.setMode === 'reps') finishText = '✓ Последний подход';
        } else if (el.type === 'timer') {
            finishText = '✓ Завершить упражнение';
            if (runState.timerFinished) { phaseLabel.innerText = '⏰ ВРЕМЯ ВЫШЛО'; phaseLabel.className = 'phase-label finished'; }
        }
        // **Убираем кнопку паузы, если тип таймер и время вышло**
        if (el.type === 'timer' && runState.timerFinished) {
            pauseBtn.style.display = 'none';
        } else {
            pauseBtn.style.display = 'block';
        }
        if (skipBtn) skipBtn.style.display = 'block';
        repsInfo.style.display = showReps ? 'block' : 'none';
        if (showReps) { const nReps = parseInt(targetText, 10) || 0; repsTarget.innerText = targetText + ' ' + pluralReps(nReps); }
        finishBtn.innerText = finishText;
        if (timelineEl) {
            if (el.type === 'sets' && (el.setsCount || 1) > 1) {
                const total = el.setsCount || 3;
                let dots = '';
                for (let s = 1; s <= total; s++) { const cls = s === runState.currentSet ? 'active' : (s < runState.currentSet ? 'done' : ''); dots += `<div class="set-dot ${cls}"></div>`; }
                timelineEl.innerHTML = dots; timelineEl.style.display = 'flex';
            } else { timelineEl.style.display = 'none'; }
        }
        workTimer.classList.add('work-active');
        workTimer.classList.toggle('paused', !!runState.workPaused || !!runState._menuOpen);
        workTimer.classList.toggle('overtime', !!(el.type === 'timer' && runState.timerFinished && !runState._menuOpen));
        if (runState._menuOpen) {
            workTimer.style.color = 'var(--warn)';
        } else if (el.type === 'timer' && runState.timerFinished) {
            workTimer.style.color = 'var(--danger)';
            currentExEl.style.color = 'var(--danger)';
        } else {
            workTimer.style.color = '';
            currentExEl.style.color = '';
        }
        if (runState.workPaused) { pauseBtn.innerText = '▶ Продолжить'; if (el.type === 'timer' && runState.timerFinished) phaseLabel.innerText = '⏸ ПАУЗА (ВРЕМЯ ВЫШЛО)'; else phaseLabel.innerText = '⏸ ПАУЗА'; }
        else { pauseBtn.innerText = '❚❚ Пауза'; }
        document.getElementById('phase-work').style.display = 'block';
        try { updateWorkLastPerfUI(); } catch(e) {}
    } else if (phase === 'rest') { renderRestElement(el); }
    else {
        const lp = document.getElementById('work-last-perf');
        if (lp) lp.style.display = 'none';
    }
}

function renderRestElement(el) {
    const phaseLabel = document.getElementById('phase-label');
    const isBetween = runState.restPhase === 'between-sets';
    const isWater = el.restType === 'water';
    const isBanner = runState.restBannerMode;
    const currentExerciseEl = document.getElementById('current-exercise');
    currentExerciseEl.style.display = 'none';
    currentExerciseEl.innerText = '';
    if (runState.restFinished) { phaseLabel.innerText = '⏰ ВРЕМЯ ВЫШЛО'; phaseLabel.className = 'phase-label finished'; }
    else if (isBetween) { phaseLabel.innerText = 'ОТДЫХ МЕЖДУ ПОДХОДАМИ'; phaseLabel.className = 'phase-label'; }
    else if (isWater) { phaseLabel.innerText = 'НЕОБХОДИМО ПОПИТЬ ВОДЫ'; phaseLabel.className = 'phase-label'; }
    else { phaseLabel.innerText = 'ОТДЫХ'; phaseLabel.className = 'phase-label'; }
    const middleIcon = document.getElementById('rest-middle-icon');
    const ringWrap = document.getElementById('rest-ring-wrap');
    if (isBanner && isWater) {
        if (ringWrap) ringWrap.style.display = 'none';
        middleIcon.style.display = 'flex';
        middleIcon.style.fontSize = '8rem'; middleIcon.style.height = 'auto'; middleIcon.style.margin = '20px 0 30px';
    } else {
        if (ringWrap) ringWrap.style.display = '';
        middleIcon.style.fontSize = ''; middleIcon.style.height = ''; middleIcon.style.margin = '10px 0 20px';
        if (isWater && !runState.restFinished) middleIcon.style.display = 'flex';
        else middleIcon.style.display = 'none';
    }
    if (!isBanner) {
        if (runState._menuOpen) setRingProgress('ring-rest', 1, 'paused');
        else if (runState.restFinished) setRingProgress('ring-rest', 1, 'danger');
        else { const rem = getRemainingTime('rest'); const dur = runState.restDuration || 1; setRingProgress('ring-rest', rem / dur, runState.restPaused ? 'paused' : 'rest'); }
    }
    const timerEl = document.getElementById('rest-timer');
    if (isBanner) timerEl.style.display = 'none';
    else {
        timerEl.style.display = 'flex';
        if (runState._menuOpen) { timerEl.className = 'big-timer paused'; timerEl.style.color = 'var(--warn)'; }
        else { timerEl.style.color = ''; if (runState.restFinished) { timerEl.className = 'big-timer overtime'; } else { timerEl.className = 'big-timer rest-active' + (runState.restPaused ? ' paused' : ''); } }
    }
    const nextBlock = document.getElementById('next-exercise-block');
    if (runState.restFinished) nextBlock.style.display = 'none';
    else {
        nextBlock.style.display = 'block';
        nextBlock.classList.remove('water');
        const nameEl = document.getElementById('next-exercise-name');
        const labelEl = document.getElementById('next-exercise-label');
        nameEl.classList.remove('water', 'finish');
        if (isBetween) { labelEl.innerText = 'Следующий подход'; nameEl.innerText = `Подход ${runState.currentSet} из ${el.setsCount || 3}`; }
        else {
            const next = findNextElement(runState.workout.exercises, runState.index);
            if (!next) { labelEl.innerText = 'Далее'; nameEl.innerText = isWater ? 'Это последнее действие' : 'Это последнее упражнение'; }
            else {
                const nx = next.el;
                labelEl.innerText = 'Далее';
                if (nx.kind === 'exercise') {
                    const num = getExerciseNumber(runState.workout.exercises, next.idx);
                    const info = nx.type === 'sets' ? ` (${nx.setsCount || 3}×)` : nx.type === 'reps' ? ` (${nx.targetReps||10})` : nx.type === 'timer' ? ` (${formatTime(nx.timerDuration || 60)})` : '';
                    nameEl.innerText = (getEffectiveSetting('announceNumbers') ? `${num}. ` : '') + (nx.name || 'Упражнение') + info;
                } else if (nx.kind === 'warmup') { nameEl.innerText = '🔥 Разминка'; }
                else { const isW = nx.restType === 'water'; nameEl.innerText = isW ? '💧 Необходимо попить воды' : '🛌 Отдых'; if (isW) nameEl.classList.add('water'); }
            }
        }
    }
    const noteBlock = document.getElementById('rest-note-block');
    if (runState.restFinished || isBetween) noteBlock.style.display = 'none';
    else {
        noteBlock.style.display = 'block';
        const toggle = document.getElementById('rest-note-toggle');
        const prevIdx = findPrevExerciseIndex(runState.workout.exercises, runState.index);
        const existing = prevIdx >= 0 ? runState.exerciseNotes[prevIdx] : '';
        if (document.getElementById('rest-note-textarea').style.display === 'none') toggle.innerText = existing ? '📝 Редактировать заметку' : '📝 Добавить заметку';
    }
    const pauseBtn = document.getElementById('rest-pause-btn');
    const confirmBtn = document.getElementById('rest-confirm-btn');
    const skipBtn = document.getElementById('rest-skip-btn');
    const undoBtn = document.getElementById('rest-undo-btn');
    const adjustDiv = document.getElementById('rest-adjust');
    const bannerBtn = document.getElementById('rest-banner-btn');
    if (undoBtn) undoBtn.innerText = isBetween ? '↩ Предыдущий подход' : '↩ Предыдущее упражнение';
    if (isBanner) {
        pauseBtn.style.display = 'none'; skipBtn.style.display = 'none';
        undoBtn.style.display = (isBetween || findPrevExerciseIndex(runState.workout.exercises, runState.index) >= 0) ? 'block' : 'none';
        confirmBtn.style.display = 'none'; bannerBtn.style.display = 'block'; adjustDiv.style.display = 'none';
    } else if (runState.restFinished) {
        pauseBtn.style.display = 'none'; skipBtn.style.display = 'none';
        undoBtn.style.display = (isBetween || findPrevExerciseIndex(runState.workout.exercises, runState.index) >= 0) ? 'block' : 'none';
        confirmBtn.style.display = 'block'; bannerBtn.style.display = 'none'; adjustDiv.style.display = 'none';
    } else {
        pauseBtn.style.display = 'block';
        pauseBtn.innerText = runState.restPaused ? '▶ Продолжить' : '❚❚ Пауза';
        undoBtn.style.display = (isBetween || findPrevExerciseIndex(runState.workout.exercises, runState.index) >= 0) ? 'block' : 'none';
        skipBtn.style.display = 'block'; confirmBtn.style.display = 'none'; bannerBtn.style.display = 'none'; adjustDiv.style.display = 'flex';
    }
    document.getElementById('phase-rest').style.display = 'block';
}

function hideAllPhases() {
    ['phase-ready','phase-countdown','phase-work','phase-rest','phase-warmup','phase-finish'].forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
}
async function confirmExit() {
    if (!runState || runState.phase === 'finish') { goAfterRunEnd(); return true; }
    // Pause timers while confirmation dialog is open (same behaviour as run menu / three-dots)
    let pausedWork = false, pausedRest = false, pausedWarmup = false, pausedCountdown = false;
    if (runState.phase === 'work' && !runState.workPaused) { pauseTimer('work'); pausedWork = true; }
    if (runState.phase === 'rest' && !runState.restPaused && !runState.restBannerMode) { pauseTimer('rest'); pausedRest = true; }
    if (runState.phase === 'warmup' && !runState.warmupPaused && !runState.warmupFinished) { pauseTimer('warmup'); pausedWarmup = true; }
    if (runState.phase === 'countdown' && runState.countdownInterval) {
        try { clearInterval(runState.countdownInterval); } catch(e) {}
        runState.countdownInterval = null;
        pausedCountdown = true;
    }
    if (pausedWork || pausedRest || pausedWarmup || pausedCountdown) {
        runState._exitConfirmPaused = { pausedWork, pausedRest, pausedWarmup, pausedCountdown };
        runState._menuOpen = true; // визуально «на паузе»
        renderRun();
    }
    const ok = await customConfirm('Выйти из тренировки?\n\nПрогресс сохранится.', { title: 'Выйти из тренировки?', okText: '← Выйти', cancelText: 'Остаться', danger: true });
    // Resume if user chose to stay
    if (!ok) {
        if (runState && runState._exitConfirmPaused) {
            const p = runState._exitConfirmPaused;
            runState._exitConfirmPaused = null;
            runState._menuOpen = false;
            if (p.pausedWork && runState.phase === 'work') resumeTimer('work');
            if (p.pausedRest && runState.phase === 'rest') resumeTimer('rest');
            if (p.pausedWarmup && runState.phase === 'warmup') resumeTimer('warmup');
            if (p.pausedCountdown && runState.phase === 'countdown') {
                // возобновляем countdown с текущего значения
                clearInterval(runState.countdownInterval);
                runState.countdownInterval = setInterval(() => {
                    if (!runState || runState.phase !== 'countdown') { clearInterval(runState.countdownInterval); return; }
                    if (runState._menuOpen) return;
                    runState.countdownValue--;
                    if (runState.countdownValue > 0) {
                        if (isVoiceMode() && !runState.isMuted) { if (runState.countdownValue <= 3) speakCritical(String(runState.countdownValue)); }
                        else if (!runState.isMuted) playBeep(600, 0.1);
                        renderRun();
                    } else {
                        clearInterval(runState.countdownInterval);
                        runState.countdownInterval = null;
                        if (isVoiceMode() && !runState.isMuted) setTimeout(() => startExerciseNow(), 500);
                        else { if (!runState.isMuted) playBeep(900, 0.3); setTimeout(() => startExerciseNow(), 300); }
                    }
                }, 1000);
            }
            saveRunState();
            renderRun();
        }
        return false;
    }
    // User confirmed exit
    if (runState) { runState._exitConfirmPaused = null; runState._menuOpen = false; }
    stopTickInterval();
    if (runState && runState.countdownInterval) clearInterval(runState.countdownInterval);
    stopRestAlarm(); stopExerciseAlarm(); releaseWakeLock();
    saveRunState(); disableExitProtection();
    runState = null;
    goAfterRunEnd();
    return true;
}
function fireConfetti() {
    try {
        const colors = ['#a78bfa', '#34d399', '#fbbf24', '#f87171', '#60a5fa'];
        for (let i = 0; i < 24; i++) {
            const p = document.createElement('div');
            p.className = 'confetti-piece';
            p.style.left = (10 + Math.random() * 80) + 'vw';
            p.style.top = '-20px';
            p.style.background = colors[Math.floor(Math.random() * colors.length)];
            p.style.animationDelay = (Math.random() * 0.4) + 's';
            p.style.animationDuration = (1.6 + Math.random() * 0.8) + 's';
            document.body.appendChild(p);
            setTimeout(() => { try { p.remove(); } catch(e) {} }, 3000);
        }
    } catch(e) {}
}

// === Quick Start Presets (v1.3) ===
function isWorkoutActive() {
    // Active only if runState exists AND phase is a real running phase
    if (!runState || !runState.phase) return false;
    return ['ready','work','rest','countdown','warmup'].includes(runState.phase);
}
function forceClearRunState() {
    try {
        stopTickInterval();
        stopRestAlarm();
        stopExerciseAlarm();
        releaseWakeLock();
        disableExitProtection();
    } catch(e) {}
    // Сброс флагов, которые могут «залипнуть» после свайпа диалога повторов/веса
    try { finishExerciseInProgress = false; } catch(e) {}
    try { skipExerciseInProgress = false; } catch(e) {}
    try {
        askRepsBusy = false;
        while (askRepsQueue.length) {
            const q = askRepsQueue.shift();
            try { if (q && typeof q.resolve === 'function') q.resolve(null); } catch(err) {}
        }
        document.querySelectorAll('.notif-side-overlay[data-ft-ask-dialog="1"]').forEach(ov => {
            try { if (typeof ov._ftOnDismiss === 'function') ov._ftOnDismiss(); else ov.remove(); } catch(err) {}
        });
    } catch(e) {}
    runState = null;
    clearSavedRunState();
}
function ensureNoStuckRunState() {
    // 1) If phase is finish and we are not on run screen — clear
    if (runState && runState.phase === 'finish') {
        const onRun = document.getElementById('screen-run') && document.getElementById('screen-run').classList.contains('active');
        if (!onRun) forceClearRunState();
        return;
    }
    // 2) If runState claims to be active but user is on home/workouts and there is no open run UI — clear
    if (runState && isWorkoutActive()) {
        if (liveEditor || runState._settingsPaused) return;
        const onRun = document.getElementById('screen-run') && document.getElementById('screen-run').classList.contains('active');
        if (!onRun) {
            // Stale in-memory state (common after incomplete quick-start / navigation)
            forceClearRunState();
        }
    }
}

function _quickStartToggleIcon(collapsed) {
    return collapsed
        ? '<svg viewBox="0 0 24 24" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>'
        : '<svg viewBox="0 0 24 24" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>';
}
function toggleQuickStart() {
    const body = document.getElementById('quick-start-body');
    const btn = document.getElementById('quick-start-toggle-btn');
    if (!body) return;
    const collapsed = body.style.display === 'none';
    const nextCollapsed = !collapsed;
    body.style.display = nextCollapsed ? 'none' : 'grid';
    if (btn) {
        btn.innerHTML = _quickStartToggleIcon(nextCollapsed);
        btn.setAttribute('aria-label', nextCollapsed ? 'Развернуть' : 'Свернуть');
    }
    try {
        DB.settings.quickStartCollapsed = nextCollapsed;
        saveDB('settings');
    } catch(e) {}
}
function applyQuickStartCollapsed() {
    const body = document.getElementById('quick-start-body');
    const btn = document.getElementById('quick-start-toggle-btn');
    if (!body) return;
    const collapsed = !!(DB.settings && DB.settings.quickStartCollapsed);
    body.style.display = collapsed ? 'none' : 'grid';
    if (btn) {
        btn.innerHTML = _quickStartToggleIcon(collapsed);
        btn.setAttribute('aria-label', collapsed ? 'Развернуть' : 'Свернуть');
    }
}

// Независимые параметры раздела «Быстрый старт».
function getQuickStartSettings() {
    if (!DB.settings.quickStartPrefs || typeof DB.settings.quickStartPrefs !== 'object') {
        DB.settings.quickStartPrefs = {
            profile: 'standard', autoStart: true, countdown: !!DB.settings.countdown,
            countdownDuration: DB.settings.countdownDuration || 3,
            soundMode: DB.settings.soundMode || 'beep', voiceRate: DB.settings.voiceRate || 1,
            voiceURI: DB.settings.voiceURI || null, alarmSound: DB.settings.alarmSound || 'alarm',
            announceNumbers: DB.settings.announceNumbers !== false,
            announceWorkoutName: DB.settings.announceWorkoutName !== false,
            continuousBeep: false, overtimeStopwatch: false, finalWarnSeconds: 5, minuteBeep: false,
            minuteBeepInterval: DB.settings.minuteBeepInterval || 60,
            showStartTime: !!DB.settings.showStartTime
        };
        saveDB('settings');
    }
    const q = DB.settings.quickStartPrefs;
    const defaults = { profile:'standard', autoStart:true, countdown:false, countdownDuration:3, soundMode:'beep', voiceRate:1, voiceURI:null, alarmSound:'alarm', announceNumbers:true, announceWorkoutName:true, announceExerciseName:true, announceExerciseGoal:true, announceRestName:true, askReps:true, askWeight:false, continuousBeep:false, overtimeStopwatch:false, finalWarnSeconds:5, minuteBeep:false, minuteBeepInterval:60, showStartTime:false };
    Object.keys(defaults).forEach(k => { if (q[k] === undefined) q[k] = defaults[k]; });
    if (![0,5,10,15,20,30].includes(Number(q.finalWarnSeconds))) q.finalWarnSeconds = 5;
    return q;
}
function saveQuickStartSettings() { saveDB('settings'); }
function setQuickStartProfile(profile) {
    const q = getQuickStartSettings();
    const presets = {
        standard: { autoStart:true, countdown:false, countdownDuration:3, soundMode:'beep', announceNumbers:true, announceWorkoutName:true, announceExerciseName:true, announceExerciseGoal:true, announceRestName:true, askReps:true, askWeight:false, continuousBeep:false, overtimeStopwatch:false, finalWarnSeconds:5, minuteBeep:false, minuteBeepInterval:60, showStartTime:false },
        automatic: { autoStart:true, countdown:true, countdownDuration:3, soundMode:'voice', announceNumbers:true, announceWorkoutName:true, announceExerciseName:true, announceExerciseGoal:true, announceRestName:true, askReps:true, askWeight:false, continuousBeep:true, overtimeStopwatch:true, finalWarnSeconds:5, minuteBeep:true, minuteBeepInterval:60, showStartTime:true }
    };
    q.profile = profile;
    if (presets[profile]) Object.assign(q, presets[profile]);
    saveQuickStartSettings(); renderQuickStartSettingsSheet();
}
function updateQuickStartSetting(key, value) {
    const q = getQuickStartSettings();
    if (key === 'finalWarnEnabled') {
        if (value) {
            if (![5,10,15,20,30].includes(Number(q.finalWarnSeconds))) q.finalWarnSeconds = 5;
        } else {
            q.finalWarnSeconds = 0;
        }
    } else {
        q[key] = value;
    }
    q.profile = 'custom';
    saveQuickStartSettings();
    const badge = document.getElementById('quick-start-profile-current');
    if (badge) badge.textContent = 'Свой';
    ['standard','automatic','custom'].forEach(id => { const b = document.getElementById('quick-start-profile-' + id); if (b) b.style.border = id === 'custom' ? '2px solid var(--primary)' : '1px solid var(--border)'; });
    updateQuickStartDependentRows();
    // Перерисовать лист, чтобы чекбокс finalWarnEnabled и select синхронизировались
    if (key === 'finalWarnEnabled') try { renderQuickStartSettingsSheet(); } catch(e) {}
}

function updateQuickStartDependentRows() {
    const q = getQuickStartSettings();
    const countdownRow = document.getElementById('quick-start-countdown-duration');
    const minuteBeepRow = document.getElementById('quick-start-minute-beep-interval');
    const finalWarnRow = document.getElementById('quick-start-final-warn-seconds');
    if (countdownRow) countdownRow.hidden = !q.countdown;
    if (minuteBeepRow) minuteBeepRow.hidden = !q.minuteBeep;
    if (finalWarnRow) finalWarnRow.hidden = !(Number(q.finalWarnSeconds) > 0);
}
function openQuickStartSettingsSheet() {
    if (hasOpenOverlay()) return;
    const ov = document.createElement('div'); ov.className = 'notif-side-overlay'; ov.id = 'quick-start-settings-overlay';
    ov.classList.add('quick-start-settings-overlay');
    ov.innerHTML = '<div class="notif-side-sheet quick-start-settings-sheet" role="dialog" aria-modal="true" aria-label="Настройки быстрого старта"><div id="quick-start-settings-content"></div><button class="btn sheet-btn-cancel" onclick="closeTopSheet(); notifySaved(&quot;✅ Настройки быстрого старта&quot;);">Готово</button></div>';
    document.body.appendChild(ov); setupSideSwipe(ov.querySelector('.notif-side-sheet'), ov);
    ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); });
    renderQuickStartSettingsSheet();
}
function renderQuickStartSettingsSheet() {
    const root = document.getElementById('quick-start-settings-content'); if (!root) return;
    const q = getQuickStartSettings();
    const check = (key, title, desc='') => `<label style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 0;border-bottom:1px solid var(--border-soft);"><span style="min-width:0"><strong style="display:block;font-size:.92rem;font-weight:600">${title}</strong>${desc ? `<small style="color:var(--muted)">${desc}</small>` : ''}</span><input type="checkbox" ${q[key] ? 'checked' : ''} onchange="updateQuickStartSetting('${key}',this.checked)" style="width:22px;height:22px;accent-color:var(--primary);flex:0 0 auto"></label>`;
    root.innerHTML = `<h2 class="sheet-title quick-start-settings-title"><span>Настройки быстрого старта</span></h2>
      <p style="color:var(--muted);font-size:.84rem;margin:-4px 0 14px">Эти параметры хранятся отдельно и не меняют настройки обычных тренировок.</p>
      <div style="font-weight:700;margin:8px 0">Профиль</div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin-bottom:16px">
        <button id="quick-start-profile-standard" class="menu-btn" style="padding:10px 5px;min-height:62px;border:${q.profile==='standard'?'2px solid var(--primary)':'1px solid var(--border)'}" onclick="setQuickStartProfile('standard')"><span>⚡</span><small>Стандартный</small></button>
        <button id="quick-start-profile-automatic" class="menu-btn" style="padding:10px 5px;min-height:62px;border:${q.profile==='automatic'?'2px solid var(--primary)':'1px solid var(--border)'}" onclick="setQuickStartProfile('automatic')"><span>🤖</span><small>Авто</small></button>
        <button id="quick-start-profile-custom" class="menu-btn" style="padding:10px 5px;min-height:62px;border:${q.profile==='custom'?'2px solid var(--primary)':'1px solid var(--border)'}" onclick="setQuickStartProfile('custom')"><span>🎛️</span><small>Свой</small></button>
      </div>
      <div style="font-weight:700;margin:8px 0">Запуск и отсчёт</div>
      ${check('autoStart','Автоматически запускать первый интервал','Не нужно нажимать «Старт» после открытия экрана')}
      ${check('countdown','Обратный отсчёт перед упражнением')}
      <div id="quick-start-countdown-duration" class="quick-start-dependent-setting" ${q.countdown ? '' : 'hidden'}><div style="padding:10px 0 14px"><label style="font-size:.88rem;color:var(--muted)">Длительность отсчёта</label><select class="input" style="margin-top:6px" onchange="updateQuickStartSetting('countdownDuration',parseInt(this.value))"><option value="3" ${q.countdownDuration===3?'selected':''}>3 секунды</option><option value="5" ${q.countdownDuration===5?'selected':''}>5 секунд</option><option value="10" ${q.countdownDuration===10?'selected':''}>10 секунд</option></select></div></div>
      <div style="font-weight:700;margin:8px 0">Звук и озвучивание</div>
      <div style="padding:8px 0 12px"><label style="font-size:.88rem;color:var(--muted)">Режим оповещений</label><select class="input" style="margin-top:6px" onchange="updateQuickStartSetting('soundMode',this.value)"><option value="beep" ${q.soundMode==='beep'?'selected':''}>🔔 Звуковые сигналы</option><option value="voice" ${q.soundMode==='voice'?'selected':''}>🗣 Голосовое озвучивание</option></select></div>
      ${check('announceWorkoutName','Озвучивать название тренировки')}
      ${check('announceNumbers','Озвучивать номера упражнений и подходов')}
      ${check('announceExerciseName','Озвучивать название упражнения')}
      ${check('announceExerciseGoal','Озвучивать цель и время упражнения')}
      ${check('announceRestName','Озвучивать название отдыха')}
      ${check('askReps','Спрашивать количество повторов')}
      ${check('askWeight','Спрашивать вес')}
      ${check('minuteBeep','Периодический сигнал во время упражнения')}
      <div id="quick-start-minute-beep-interval" class="quick-start-dependent-setting" ${q.minuteBeep ? '' : 'hidden'}><div style="padding:10px 0 14px"><label style="font-size:.88rem;color:var(--muted)">Интервал сигнала</label><select class="input" style="margin-top:6px" onchange="updateQuickStartSetting('minuteBeepInterval',parseInt(this.value))"><option value="30" ${q.minuteBeepInterval===30?'selected':''}>Каждые 30 секунд</option><option value="60" ${q.minuteBeepInterval===60?'selected':''}>Каждую минуту</option><option value="120" ${q.minuteBeepInterval===120?'selected':''}>Каждые 2 минуты</option></select></div></div>
      ${check('continuousBeep','Повторять сигнал, когда время вышло','Сигнал продолжается до перехода дальше')}
      <div style="font-weight:700;margin:8px 0">Таймеры</div>
      ${check('overtimeStopwatch','Секундомер после «время вышло»','Если выкл — на экране 0:00; если вкл — счёт вверх')}
      <label style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 0;border-bottom:1px solid var(--border-soft);"><span style="min-width:0"><strong style="display:block;font-size:.92rem;font-weight:600">Предупреждение до конца</strong><small style="color:var(--muted)">Подсветка таймера и сигнал за несколько секунд до окончания</small></span><input type="checkbox" ${Number(q.finalWarnSeconds)>0 ? 'checked' : ''} onchange="updateQuickStartSetting('finalWarnEnabled',this.checked)" style="width:22px;height:22px;accent-color:var(--primary);flex:0 0 auto"></label>
      <div id="quick-start-final-warn-seconds" class="quick-start-dependent-setting" ${Number(q.finalWarnSeconds)>0 ? '' : 'hidden'}><div style="padding:10px 0 14px"><label style="font-size:.88rem;color:var(--muted)">За сколько секунд</label><select class="input" style="margin-top:6px" onchange="updateQuickStartSetting('finalWarnSeconds',parseInt(this.value))"><option value="5" ${Number(q.finalWarnSeconds)===5||Number(q.finalWarnSeconds)===0?'selected':''}>5 сек</option><option value="10" ${Number(q.finalWarnSeconds)===10?'selected':''}>10 сек</option><option value="15" ${Number(q.finalWarnSeconds)===15?'selected':''}>15 сек</option><option value="20" ${Number(q.finalWarnSeconds)===20?'selected':''}>20 сек</option><option value="30" ${Number(q.finalWarnSeconds)===30?'selected':''}>30 сек</option></select></div></div>
      <div style="font-weight:700;margin:8px 0">Отображение</div>
      ${check('showStartTime','Показывать время начала тренировки')}
      <p style="font-size:.78rem;color:var(--muted);margin:12px 0 0">Активный профиль: <strong id="quick-start-profile-current">${q.profile==='custom'?'Свой':q.profile==='automatic'?'Автоматический':'Стандартный'}</strong>. Изменение любого параметра автоматически переключает профиль на «Свой».</p>`;
}
function getQuickStartWorkoutSettings() {
    const q = getQuickStartSettings();
    return { countdown:q.countdown, countdownDuration:q.countdownDuration, soundMode:q.soundMode,
        voiceRate:q.voiceRate, voiceURI:q.voiceURI, alarmSound:q.alarmSound,
        announceNumbers:q.announceNumbers, announceWorkoutName:q.announceWorkoutName,
        announceExerciseName: q.announceExerciseName !== false, announceExerciseGoal: q.announceExerciseGoal !== false, announceRestName: q.announceRestName !== false,
        askReps: q.askReps !== false, askWeight: !!q.askWeight,
        continuousBeep:q.continuousBeep, overtimeStopwatch:!!q.overtimeStopwatch,
        finalWarnSeconds: [0,5,10,15,20,30].includes(Number(q.finalWarnSeconds)) ? Number(q.finalWarnSeconds) : 5,
        minuteBeep:q.minuteBeep, minuteBeepInterval:q.minuteBeepInterval, showStartTime:q.showStartTime };
}

async function quickStartPreset(type) {
    ensureNoStuckRunState();
    if (isWorkoutActive()) {
        showToast('⚠️ Тренировка уже запущена');
        return;
    }
    if (runState) forceClearRunState();

    // Если есть сохранённая незавершённая (в т.ч. быстрый старт) — спросить как в обычных
    const saved = loadSavedRunState();
    if (saved && saved.workoutId && saved.phase && saved.phase !== 'finish' &&
        ['ready','work','rest','countdown','warmup'].includes(saved.phase)) {
        const ageSec = saved.savedAt ? (Date.now() - saved.savedAt) / 1000 : 0;
        const age = saved.savedAt ? ` (${formatAge(ageSec)})` : '';
        const choice = await showStartNewConfirm(saved, age);
        if (choice === 'resume') { restoreRunState(saved); return; }
        if (choice === 'new') { clearSavedRunState(); disableExitProtection(); showToast('▶ Новая тренировка'); }
        else if (choice === 'cancel') {
            clearSavedRunState();
            if (runState) { try { stopTickInterval(); stopRestAlarm(); stopExerciseAlarm(); releaseWakeLock(); } catch(e) {} runState = null; }
            disableExitProtection();
            showToast('❌ Тренировка отменена');
            return;
        } else { return; }
    }

    const quickPrefs = getQuickStartSettings();
    let workout = null;
    if (type === 'tabata') {
        workout = { id: Date.now(), name: 'Tabata ⚡', autoStart: quickPrefs.autoStart, exercises: [] };
        for (let i = 0; i < 8; i++) {
            workout.exercises.push({ kind: 'exercise', name: 'Раунд ' + (i+1), type: 'timer', timerDuration: 20 });
            if (i < 7) workout.exercises.push({ kind: 'rest', restType: 'rest', duration: 10 });
        }
    } else if (type === 'emom') {
        workout = { id: Date.now(), name: 'EMOM 10 мин', autoStart: quickPrefs.autoStart, exercises: [] };
        for (let i = 0; i < 10; i++) {
            workout.exercises.push({ kind: 'exercise', name: 'Минута ' + (i+1), type: 'timer', timerDuration: 50 });
            if (i < 9) workout.exercises.push({ kind: 'rest', restType: 'rest', duration: 10 });
        }
    } else if (type === 'hiit4020') {
        workout = { id: Date.now(), name: 'HIIT 40/20', autoStart: quickPrefs.autoStart, exercises: [] };
        for (let i = 0; i < 8; i++) {
            workout.exercises.push({ kind: 'exercise', name: 'Работа ' + (i+1), type: 'timer', timerDuration: 40 });
            if (i < 7) workout.exercises.push({ kind: 'rest', restType: 'rest', duration: 20 });
        }
    } else if (type === 'custom') {
        openQuickTimerSheet();
        return;
    }
    if (workout) {
        // Быстрые интервалы должны переходить дальше без режима «время вышло».
        workout.settings = { ...(workout.settings || {}), ...getQuickStartWorkoutSettings() };
        startTempWorkout(workout);
    }
}

function startTempWorkout(workout) {
    ensureNoStuckRunState();
    if (isWorkoutActive()) {
        showToast('⚠️ Тренировка уже запущена');
        return;
    }
    if (runState) forceClearRunState();
    clearSavedRunState();

    // FULL runState object — same shape as startWorkout (critical for renderRun / timers)
    runState = {
        workout: workout,
        index: 0,
        phase: 'ready',
        currentSet: 1,
        restPhase: null,
        setResults: {},
        setWeights: {},
        exerciseNotes: {},
        workoutNoteDraft: '',
        currentExerciseWorkTime: 0,
        lastSetElapsed: 0,
        warmupFinished: false,
        warmupBeepPlayed: false,
        warmupMode: 'timer',
        warmupSeconds: 0,
        warmupDuration: 0,
        warmupElapsedBeforePause: 0,
        warmupStartTime: null,
        warmupPaused: false,
        countdownInterval: null,
        restOvertimeInterval: null,
        tickInterval: null,
        workStartTime: null,
        workElapsedBeforePause: 0,
        workPaused: false,
        restStartTime: null,
        restElapsedBeforePause: 0,
        restPaused: false,
        restDuration: 0,
        restBeepPlayed: false,
        restFinished: false,
        restOvertime: 0,
        restBannerMode: false,
        timerFinished: false,
        startTime: new Date(),
        totalWorkTime: 0,
        lastFinishedWorkElapsed: 0,
        exerciseTimes: [],
        lastBeepTargetTime: undefined,
        setFinishing: false,
        countdownValue: 3,
        workoutNameAnnounced: false,
        _flowStarting: false,
        isMuted: false,
        timerBeepPlayed: false,
        isDeload: false,
        deloadPercent: 0,
        _removedExercises: [],
        isTemp: true
    };

    try {
        const titleEl = document.getElementById('run-title');
        if (titleEl) titleEl.innerText = workout.name || 'Быстрый старт';
    } catch(e) {}

    runReturnScreen = 'screen-home'; // быстрый старт всегда с главного
    if (DB.settings && DB.settings.wakeLock) acquireWakeLock();
    enableExitProtection();
    try { _restoreRunHeaderForNewWorkout(); } catch(e) {}
    renderRun();
    showScreen('screen-run');
    saveRunState();
    if (workout.autoStart) {
        setTimeout(function() {
            if (runState && runState.phase === 'ready' && !runState._flowStarting) {
                beginCurrentElementFlow(true);
            }
        }, 400);
    }
}

function openQuickTimerSheet() {
    if (hasOpenOverlay()) return;
    const ov = document.createElement('div');
    ov.className = 'notif-side-overlay';
    ov.innerHTML = `<div class="notif-side-sheet">
        <div class="notif-side-grabber"><div class="notif-side-grabber-bar"></div></div>
        <h2 class="sheet-title">🎯 Быстрый таймер</h2>
        <div style="display:flex; flex-direction:column; gap:10px;">
            <div>
                <label style="color:var(--muted); font-size:0.85rem;">Работа (сек)</label>
                <input type="number" id="qt-work" class="input" value="40" min="5" max="600" style="margin:4px 0 0;">
            </div>
            <div>
                <label style="color:var(--muted); font-size:0.85rem;">Отдых (сек)</label>
                <input type="number" id="qt-rest" class="input" value="20" min="0" max="300" style="margin:4px 0 0;">
            </div>
            <div>
                <label style="color:var(--muted); font-size:0.85rem;">Раундов</label>
                <input type="number" id="qt-rounds" class="input" value="8" min="1" max="50" style="margin:4px 0 0;">
            </div>
            <div>
                <label style="color:var(--muted); font-size:0.85rem;">Название (необяз.)</label>
                <input type="text" id="qt-name" class="input" placeholder="Мой интервал" style="margin:4px 0 0;">
            </div>
        </div>
        <button class="btn accent" onclick="startCustomQuickTimer()">▶ Старт</button>
        <button class="btn sheet-btn-cancel" onclick="closeTopSheetCancel()">Отмена</button>
    </div>`;
    document.body.appendChild(ov);
    setupSideSwipe(ov.querySelector('.notif-side-sheet'), ov);
    ov.addEventListener('click', (e) => { if (e.target === ov) ov.remove(); });
}

function startCustomQuickTimer() {
    const workValue = parseInt(document.getElementById('qt-work')?.value, 10);
    const restValue = parseInt(document.getElementById('qt-rest')?.value, 10);
    const roundsValue = parseInt(document.getElementById('qt-rounds')?.value, 10);
    const work = Math.min(600, Math.max(5, Number.isFinite(workValue) ? workValue : 40));
    // Ноль — допустимая длительность отдыха: не подменяем его значением по умолчанию.
    const rest = Math.min(300, Math.max(0, Number.isFinite(restValue) ? restValue : 20));
    const rounds = Math.max(1, Math.min(50, Number.isFinite(roundsValue) ? roundsValue : 8));
    const name = (document.getElementById('qt-name')?.value || '').trim() || `Интервал ${work}/${rest}`;
    closeTopSheet();
    const workout = {
        id: Date.now(),
        name: name,
        autoStart: getQuickStartSettings().autoStart,
        settings: getQuickStartWorkoutSettings(),
        exercises: []
    };
    for (let i = 0; i < rounds; i++) {
        workout.exercises.push({ kind: 'exercise', name: `Раунд ${i+1}`, type: 'timer', timerDuration: work });
        if (i < rounds - 1 && rest > 0) {
            workout.exercises.push({ kind: 'rest', restType: 'rest', duration: rest });
        }
    }
    startTempWorkout(workout);
}

function showFinishScreen() {
    if (!runState) return;
    if (runState) runState.phase = 'finish';
    stopTickInterval();
    if (runState && runState.countdownInterval) clearInterval(runState.countdownInterval);
    stopRestAlarm(); stopExerciseAlarm();
    if (runState) stopTimer('warmup');
    clearSavedRunState(); disableExitProtection();

    const muteBtnEl = document.getElementById('timer-mute-btn');
    if (muteBtnEl) muteBtnEl.style.display = 'none';

       const runMenuBtn = document.querySelector('#screen-run .top-bar .back-btn[onclick="openRunMenu()"]');
    if (runMenuBtn) {
        runMenuBtn.style.display = '';
        runMenuBtn.style.visibility = 'visible';
        runMenuBtn.style.pointerEvents = 'auto';
        runMenuBtn.innerText = '⋮';
        runMenuBtn.setAttribute('aria-label', 'Действия'); 
    }
    const runTitle = document.getElementById('run-title');
    if (runTitle) {
        runTitle.style.flex = '1';
        runTitle.style.textAlign = 'center';
        runTitle.style.margin = '0';
        runTitle.style.padding = '0 4px';
    }

    const endTime = new Date();
    const totalDuration = Math.floor((endTime - runState.startTime) / 1000);

    document.getElementById('phase-label').style.display = 'none';
    const phaseHeaderEl = document.getElementById('phase-header-el');
    if (phaseHeaderEl) phaseHeaderEl.style.display = 'none';
    const currentExEl = document.getElementById('current-exercise');
    currentExEl.innerText = '';
    currentExEl.style.display = 'none';
    document.getElementById('start-time-display').style.display = 'none';
    const sb = document.getElementById('set-badge');
    if (sb) sb.style.display = 'none';

    hideAllPhases();
    playBeep(1000, 0.8);
    if (navigator.vibrate && !(runState && runState.isMuted)) navigator.vibrate([300, 100, 300, 100, 300]);
    speak('Тренировка завершена. Отличная работа!');
    fireConfetti();

    const exerciseOriginalIndices = [];
    const exerciseTypes = [];
    runState.workout.exercises.forEach((el, i) => {
        if (el.kind === 'exercise') {
            exerciseOriginalIndices.push(i);
            exerciseTypes.push(el.type === 'timer' ? 'time' : (el.type === 'sets' && el.setMode === 'time' ? 'time' : 'reps'));
        }
    });

    const sessionVol = calcSessionVolume(runState.setResults, runState.setWeights);
    const record = {
        id: Date.now(), workoutId: runState.workout.id, workoutName: runState.workout.name,
        startTime: runState.startTime.toISOString(), endTime: endTime.toISOString(),
        totalDuration, workTime: runState.totalWorkTime,
        warmupSeconds: runState.warmupSeconds || 0,
        exercisesCount: getTotalExerciseCount(runState.workout.exercises),
        exerciseTimes: [...runState.exerciseTimes],
        exerciseNames: runState.workout.exercises.filter(e => e.kind === 'exercise').map(e => e.name || ''),
        exerciseOriginalIndices,
        exerciseTypes,
        exerciseNotes: JSON.parse(JSON.stringify(runState.exerciseNotes || {})),
        workoutNote: runState.workoutNoteDraft || '',
        setResults: JSON.parse(JSON.stringify(runState.setResults || {})),
        setWeights: JSON.parse(JSON.stringify(runState.setWeights || {})),
        totalVolume: sessionVol > 0 ? sessionVol : 0,
        isDeload: !!runState.isDeload
    };
    DB.history.push(record);
    runState.finishRecordId = record.id;
    try {
        _lastFinishedWorkoutSnapshot = JSON.parse(JSON.stringify(runState.workout));
    } catch(e) { _lastFinishedWorkoutSnapshot = null; }
    invalidateActivityCache();
    const removed = pruneHistory(HISTORY_PRUNE_LIMIT);
    if (removed > 0) setTimeout(() => showToast(`📜 История обрезана до ${HISTORY_PRUNE_LIMIT} записей`), 800);
    saveDB('history');

    const noteItems = [];
    runState.workout.exercises.forEach((el, i) => {
        if (el.kind === 'exercise' && runState.exerciseNotes[i]) {
            noteItems.push(`<div style="padding:8px 0; border-bottom:1px solid var(--border-soft);"><div style="font-size:0.9rem; color:var(--muted);">${escapeHtml(el.name)}</div><div style="color:var(--text); font-size:0.9rem; margin-top:2px;">${escapeHtml(runState.exerciseNotes[i])}</div></div>`);
        }
    });

    let exListHtml = '';
    if ((runState.warmupSeconds || 0) > 0) {
        exListHtml += `<div style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid var(--border-soft);"><span style="color:var(--warn); font-size:0.9rem;">🔥 Разминка</span><span style="color:var(--warn); font-weight:700;">${formatTime(runState.warmupSeconds)}</span></div>`;
    }
    let exCounter = 0;
    runState.workout.exercises.forEach((el, i) => {
        if (el.kind !== 'exercise') return;
        exCounter++;
        const t = runState.exerciseTimes[exCounter - 1];
        const sets = runState.setResults[i];
        const weights = (runState.setWeights && runState.setWeights[i]) || [];
        const isSkipped = t !== undefined && t !== null && t < 0;
        const hasSets = Array.isArray(sets) && sets.length;
        const hasWeight = Array.isArray(weights) && weights.length && weights.some(w => w > 0);
        const timeStr = isSkipped ? '⏭' : formatTime(t || 0);
        const timeColor = isSkipped ? 'var(--muted)' : 'var(--accent)';
        if (hasSets && hasWeight) {
            exListHtml += `<div style="padding:10px 0; border-bottom:1px solid var(--border-soft);">
                <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
                    <span style="color:var(--muted); font-size:0.9rem; flex:1; min-width:0; word-break:break-word;">${exCounter}. ${escapeHtml(el.name || 'Упражнение')}</span>
                    <span style="color:${timeColor}; font-weight:700; white-space:nowrap;">${timeStr}</span>
                </div>
                <div style="display:flex; justify-content:flex-end; margin-top:4px;">
                    <span style="color:var(--blue); font-size:0.85rem; font-weight:600; white-space:nowrap;">подходы: ${sets.join('/')}</span>
                </div>
                <div style="display:flex; justify-content:flex-end; margin-top:2px;">
                    <span style="color:var(--warn); font-size:0.85rem; font-weight:600; white-space:nowrap;">вес: ${weights.map(w => formatWeightVal(w || 0)).join('/')}</span>
                </div>
            </div>`;
        } else {
            let rightMeta = '';
            if (hasSets) rightMeta = `<span style="color:var(--blue); font-size:0.85rem; font-weight:600; white-space:nowrap;">подходы: ${sets.join('/')}</span>`;
            else if (hasWeight) rightMeta = `<span style="color:var(--warn); font-size:0.85rem; font-weight:600; white-space:nowrap;">вес: ${weights.map(w => formatWeightVal(w || 0)).join('/')}</span>`;
            exListHtml += `<div style="display:flex; justify-content:space-between; align-items:center; padding:8px 0; border-bottom:1px solid var(--border-soft); gap:8px;">
                <span style="color:var(--muted); font-size:0.9rem; flex:1; min-width:0; word-break:break-word;">${exCounter}. ${escapeHtml(el.name || 'Упражнение')}</span>
                <div style="display:flex; flex-shrink:0; align-items:center; gap:12px;">
                    ${rightMeta}
                    <span style="color:${timeColor}; font-weight:700; min-width:48px; text-align:right; white-space:nowrap;">${timeStr}</span>
                </div>
            </div>`;
        }
		});

    // Личные рекорды (сравниваем с историей без только что добавленной записи)
    let prHtml = '';
    if (getEffectiveSetting('trackPRs')) {
        const prItems = [];
        const curId = record.id;
        const savedHist = DB.history;
        DB.history = DB.history.filter(h => h.id !== curId);
        try {
            runState.workout.exercises.forEach((el, i) => {
                if (!el || el.kind !== 'exercise') return;
                const sets = runState.setResults[i];
                if (!Array.isArray(sets) || !sets.length) return;
                const weights = (runState.setWeights && runState.setWeights[i]) || [];
                const news = detectNewPRs(el.name, sets, weights);
                news.forEach(n => prItems.push({ name: el.name || 'Упражнение', label: n.label, value: n.value, detail: n.detail || '' }));
            });
        } finally {
            DB.history = savedHist;
        }
        if (prItems.length) {
            prHtml = `<div class="card" style="margin-top:12px; border:1px solid var(--warn); background:linear-gradient(135deg,var(--warn-soft),var(--card));">
                <div style="font-weight:800; font-size:1.05rem; margin-bottom:10px; text-align:center;">🏆 Новые рекорды</div>
                ${prItems.map(p => `<div style="display:flex; justify-content:space-between; gap:8px; padding:8px 0; border-bottom:1px solid var(--border-soft);">
                    <div style="min-width:0;"><div style="font-weight:700; font-size:0.9rem;">${escapeHtml(p.name)}</div>
                    <div style="color:var(--muted); font-size:0.78rem;">${escapeHtml(p.label)}${p.detail ? ' · ' + escapeHtml(p.detail) : ''}</div></div>
                    <div style="color:var(--warn); font-weight:800; white-space:nowrap;">${escapeHtml(p.value)}</div>
                </div>`).join('')}
            </div>`;
        }
    }

    let volumeHtml = '';
    if (getEffectiveSetting('showVolumeStats') !== false) {
        const vol = sessionVol > 0 ? sessionVol : calcSessionVolume(runState.setResults, runState.setWeights);
        if (vol > 0) {
            volumeHtml = `<div class="card" style="margin-top:12px; text-align:center;"><div style="color:var(--muted); font-size:0.75rem; text-transform:uppercase; letter-spacing:1px; margin-bottom:6px;">📦 Сегодня подняли</div><div style="font-size:1.5rem; font-weight:800; color:var(--primary);">${formatWeightVal(vol)}</div><div style="color:var(--muted); font-size:0.78rem; margin-top:4px;">тоннаж · повторы × вес</div></div>`;
        }
    }
    document.getElementById('phase-finish').innerHTML = `
        <div class="finish-card" style="margin-top:0;">
            <div class="finish-title">🎉 Готово!</div>
            <div class="stats-grid">
                <div class="stat-row"><div class="stat-label">🕐 Начало</div><div class="stat-value">${formatClock(runState.startTime)}</div></div>
                <div class="stat-row"><div class="stat-label">🏁 Конец</div><div class="stat-value">${formatClock(endTime)}</div></div>
                <div class="stat-row"><div class="stat-label">⏱ Длительность</div><div class="stat-value">${formatTime(totalDuration)}</div></div>
                <div class="stat-row"><div class="stat-label">💪 Работа</div><div class="stat-value highlight">${formatTime(runState.totalWorkTime)}</div></div>
                ${(runState.warmupSeconds || 0) > 0 ? `<div class="stat-row"><div class="stat-label">🔥 Разминка</div><div class="stat-value">${formatTime(runState.warmupSeconds)}</div></div>` : ''}
            </div>
            <details class="finish-ex-stats">
                <summary>📈 Статистика по упражнениям</summary>
                <div class="finish-ex-stats-body">${exListHtml || '<div style="color:var(--muted);font-size:0.85rem;padding:6px 0;">Нет данных</div>'}</div>
            </details>
        </div>
        ${volumeHtml}
        ${prHtml}
        ${noteItems.length ? `<details class="finish-section-details" open><summary>📝 Заметки по упражнениям</summary><div class="finish-section-body">${noteItems.join('')}</div></details>` : ''}
        <div id="finish-note-card" class="finish-note-wrap">
            <button type="button" id="finish-note-toggle" class="btn ghost" onclick="toggleFinishNote()">📝 Добавить заметку к тренировке</button>
            <div id="finish-note-block" style="display:none; margin-top:10px;">
                <textarea id="finish-note" class="input" placeholder="Как самочувствие?" style="min-height:70px;">${escapeHtml(runState.workoutNoteDraft || '')}</textarea>
                <button type="button" class="btn small accent" style="margin-top:8px; width:100%;" onclick="saveWorkoutNote(${record.id})">💾 Сохранить</button>
            </div>
        </div>
        <div class="finish-actions">
            <button type="button" class="btn accent" onclick="shareResult(${record.id})">📤 Поделиться</button>
            <button type="button" class="btn ghost" onclick="saveCurrentRunAsTemplate()">💾 Сохранить как шаблон</button>
            <button type="button" class="btn" onclick="repeatLastWorkout(${runState.workout.id})">🔁 Повторить тренировку</button>
        </div>
        <div class="finish-nav">
            <button type="button" class="btn ghost" onclick="goAfterRunEnd()" id="finish-back-btn">← Назад</button>
            <button type="button" class="btn ghost" onclick="showScreen('screen-home')">🏠 На главную</button>
        </div>
    `;
    document.getElementById('phase-finish').style.display = 'block';
    releaseWakeLock();
    try { applyLargeRunControls(); } catch(e) {}
}
function toggleFinishNote() {
    const block = document.getElementById('finish-note-block');
    const toggle = document.getElementById('finish-note-toggle');
    if (!block || !toggle) return;
    if (block.style.display === 'none') { block.style.display = 'block'; toggle.style.display = 'none'; }
    else { block.style.display = 'none'; toggle.style.display = 'block'; }
}
function saveWorkoutNote(recordId) {
    const ta = document.getElementById('finish-note');
    if (!ta) return;
    const r = DB.history.find(x => x.id === recordId);
    if (r) {
        r.workoutNote = ta.value;
        saveDB('history');
        showToast('📝 Заметка сохранена');
        const block = document.getElementById('finish-note-block');
        const toggle = document.getElementById('finish-note-toggle');
        if (block) block.style.display = 'none';
        if (toggle) { toggle.style.display = 'block'; toggle.innerText = '📝 Редактировать заметку к тренировке'; }
    }
}
let _lastFinishedWorkoutSnapshot = null;

function repeatLastWorkout(workoutId) {
    // Prefer live workout from DB
    if (workoutId) {
        const w = DB.workouts.find(x => x.id === workoutId);
        if (w) {
            runState = null;
            startWorkout(workoutId, false);
            return;
        }
    }
    // Fallback to snapshot (for temp / quick-start / deleted)
    if (_lastFinishedWorkoutSnapshot) {
        const w = JSON.parse(JSON.stringify(_lastFinishedWorkoutSnapshot));
        w.id = Date.now();
        startTempWorkout(w);
        showToast('Повтор из снимка');
        return;
    }
    showToast('⚠️ Нет данных для повтора');
}

function renderHistory() { renderHistoryList(); renderHistoryStats(); renderHistoryRecords(); renderHistoryPrograms(); }
function switchHistoryTab(tab, el) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    el.classList.add('active');
    ['list','stats','records','programs'].forEach(t => { document.getElementById('history-tab-' + t).style.display = (t === tab) ? 'block' : 'none'; });
    if (tab === 'programs') renderHistoryPrograms();
}
function getFilteredHistory() {
    const searchEl = document.getElementById('history-search');
    const periodEl = document.getElementById('history-period');
    const q = searchEl ? searchEl.value.toLowerCase().trim() : '';
    const period = periodEl ? periodEl.value : 'all';
    let items = [...DB.history];
    if (period !== 'all') {
        const days = parseInt(period) || 0;
        if (days > 0) { const cutoff = Date.now() - days * 24 * 60 * 60 * 1000; items = items.filter(r => { try { return new Date(r.startTime).getTime() >= cutoff; } catch(e) { return false; } }); }
    }
    if (q) {
        items = items.filter(r => {
            const nameMatch = (r.workoutName || '').toLowerCase().includes(q);
            const noteMatch = (r.workoutNote || '').toLowerCase().includes(q);
            const exMatch = Array.isArray(r.exerciseNames) && r.exerciseNames.some(n => (n || '').toLowerCase().includes(q));
            return nameMatch || noteMatch || exMatch;
        });
    }
    return items;
}
function getHistoryBulkToggleLabel() {
    const items = getFilteredHistory();
    const keys = [...new Set(items.map(r => historyGroupForRecord(r).key))];
    const anyExpanded = keys.some(key => !historyGroupCollapsed[key]);
    return anyExpanded ? 'Свернуть все группы' : 'Развернуть все группы';
}
function toggleAllHistoryGroups() {
    const items = getFilteredHistory();
    const keys = [...new Set(items.map(r => historyGroupForRecord(r).key))];
    if (!keys.length) { showToast('Нет групп для сворачивания'); return; }
    const collapse = keys.some(key => !historyGroupCollapsed[key]);
    keys.forEach(key => { historyGroupCollapsed[key] = collapse; });
    DB.settings.historyGroupCollapsed = historyGroupCollapsed;
    saveDB('settings');
    renderHistoryList();
    showToast(collapse ? 'Все группы свёрнуты' : 'Все группы развёрнуты');
}
function isHistoryProgramsTabActive() {
    const el = document.getElementById('history-tab-programs');
    return !!el && el.style.display !== 'none';
}
function getHistoryProgramDaysToggleLabel() {
    const days = DB.settings.historyProgramDayCollapsed || {};
    const visibleKeys = window.__historyProgramDayKeys || [];
    const anyExpanded = visibleKeys.some(key => !days[key]);
    return anyExpanded ? 'Свернуть все дни' : 'Развернуть все дни';
}
function getHistoryProgramsToggleLabel() {
    const states = DB.settings.historyProgramCollapsed || {};
    const keys = window.__historyProgramKeys || [];
    const anyExpanded = keys.some(key => !states[key]);
    return anyExpanded ? 'Свернуть все программы' : 'Развернуть все программы';
}
function toggleHistoryProgramGroup(key) {
    if (!DB.settings.historyProgramCollapsed || typeof DB.settings.historyProgramCollapsed !== 'object') DB.settings.historyProgramCollapsed = {};
    DB.settings.historyProgramCollapsed[key] = !DB.settings.historyProgramCollapsed[key];
    saveDB('settings');
    renderHistoryPrograms();
}
function toggleAllHistoryPrograms() {
    const keys = window.__historyProgramKeys || [];
    if (!keys.length) { showToast('Нет программ для сворачивания'); return; }
    if (!DB.settings.historyProgramCollapsed || typeof DB.settings.historyProgramCollapsed !== 'object') DB.settings.historyProgramCollapsed = {};
    const collapse = keys.some(key => !DB.settings.historyProgramCollapsed[key]);
    keys.forEach(key => { DB.settings.historyProgramCollapsed[key] = collapse; });
    saveDB('settings');
    renderHistoryPrograms();
    showToast(collapse ? 'Все программы свёрнуты' : 'Все программы развёрнуты');
}
function toggleHistoryProgramDay(key) {
    if (!DB.settings.historyProgramDayCollapsed || typeof DB.settings.historyProgramDayCollapsed !== 'object') DB.settings.historyProgramDayCollapsed = {};
    DB.settings.historyProgramDayCollapsed[key] = !DB.settings.historyProgramDayCollapsed[key];
    saveDB('settings');
    renderHistoryPrograms();
}
function toggleAllHistoryProgramDays() {
    const keys = window.__historyProgramDayKeys || [];
    if (!keys.length) { showToast('Нет дней для сворачивания'); return; }
    if (!DB.settings.historyProgramDayCollapsed || typeof DB.settings.historyProgramDayCollapsed !== 'object') DB.settings.historyProgramDayCollapsed = {};
    const collapse = keys.some(key => !DB.settings.historyProgramDayCollapsed[key]);
    keys.forEach(key => { DB.settings.historyProgramDayCollapsed[key] = collapse; });
    saveDB('settings');
    renderHistoryPrograms();
    showToast(collapse ? 'Все дни свёрнуты' : 'Все дни развёрнуты');
}
function openHistoryActions() {
    const programsTab = isHistoryProgramsTabActive();
    const collapseAction = programsTab
        ? `<button class="btn ghost" onclick="closeTopSheet(); toggleAllHistoryPrograms();">${getHistoryProgramsToggleLabel()}</button><button class="btn ghost" onclick="closeTopSheet(); toggleAllHistoryProgramDays();">${getHistoryProgramDaysToggleLabel()}</button>`
        : `<button class="btn ghost" onclick="closeTopSheet(); toggleAllHistoryGroups();">${getHistoryBulkToggleLabel()}</button>`;
    const ov = document.createElement('div');
    ov.className = 'notif-side-overlay action-menu-overlay';
    ov.innerHTML = `<div class="notif-side-sheet"><div class="notif-side-grabber"><div class="notif-side-grabber-bar"></div></div><h2 class="sheet-title">Действия</h2><button class="btn ghost" onclick="closeTopSheet(); ${historySelectionMode ? 'exitHistoryBulkMode()' : 'enterHistoryBulkMode()'};">${historySelectionMode ? 'Отменить выбор' : 'Выбрать'}</button>${collapseAction}<button class="btn ghost" onclick="closeTopSheet(); renderHistory(); showToast('Обновлено');">Обновить</button><button class="btn ghost" onclick="openGlobalSettingsFrom('screen-history')">⚙️ Общие настройки</button>${DB.history.length > 0 ? `<button class="btn danger" onclick="clearHistory();">Удалить всю историю (${DB.history.length})</button>` : ''}<button class="btn sheet-btn-cancel" onclick="closeTopSheetCancel()">Отмена</button></div>`;
    decorateActionMenu(ov, 'История');
    document.body.appendChild(ov);
    setupSideSwipe(ov.querySelector('.notif-side-sheet'), ov);
    ov.addEventListener('click', (e) => { if (e.target === ov) ov.remove(); });
}
function enterHistoryBulkMode() { historySelectionMode = true; historySelectedIds = new Set(); renderHistoryList(); }
function exitHistoryBulkMode() { historySelectionMode = false; historySelectedIds = new Set(); const bar = document.getElementById('bulk-action-bar'); if (bar) bar.remove(); renderHistoryList(); }
function toggleHistorySelection(id) { if (historySelectedIds.has(id)) historySelectedIds.delete(id); else historySelectedIds.add(id); renderHistoryList(); }
function toggleSelectAllHistory() {
    const items = getFilteredHistory();
    if (historySelectedIds.size === items.length) historySelectedIds.clear();
    else historySelectedIds = new Set(items.map(r => r.id));
    renderHistoryList();
}
async function deleteSelectedHistory() {
    const ids = [...historySelectedIds];
    if (ids.length === 0) return;
    if (!await customConfirm(`Удалить ${ids.length} записей?`, { danger: true, okText: 'Удалить' })) return;
    const removed = [];
    DB.history = DB.history.filter(r => { if (historySelectedIds.has(r.id)) { removed.push(r); return false; } return true; });
    saveDB('history');
    historySelectionMode = false; historySelectedIds = new Set();
    renderHistory();
    showUndoToast(`Удалено ${removed.length} записей`, () => { DB.history.push(...removed); saveDB('history'); renderHistory(); showToast('Восстановлено'); });
}
function setHistoryGroupMode(mode) {
    if (!['day', 'week', 'month'].includes(mode)) return;
    historyGroupMode = mode;
    DB.settings.historyGroupMode = mode;
    saveDB('settings');
    renderHistoryList();
}
function toggleHistoryGroup(key) {
    historyGroupCollapsed[key] = !historyGroupCollapsed[key];
    DB.settings.historyGroupCollapsed = historyGroupCollapsed;
    saveDB('settings');
    renderHistoryList();
}
function historyGroupForRecord(record) {
    const d = new Date(record.startTime);
    if (historyGroupMode === 'day') {
        const key = formatDateKey(d);
        return { key: 'day:' + key, label: d.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' }) };
    }
    if (historyGroupMode === 'month') {
        const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
        let label = d.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });
        return { key: 'month:' + key, label: label.charAt(0).toUpperCase() + label.slice(1) };
    }
    const mondayKey = formatDateKey(startOfWeekMonday(d));
    return { key: 'week:' + mondayKey, label: 'Неделя · ' + formatWeekRange(mondayKey) };
}
function renderHistoryList() {
    const c = document.getElementById('history-tab-list');
    if (!c) return;
    const items = getFilteredHistory();
    const existingBar = document.getElementById('bulk-action-bar');
    if (existingBar) existingBar.remove();
    if (DB.history.length === 0) {
        c.innerHTML = `<div class="empty-state"><span class="icon">📭</span><div class="title">История пуста</div>
            <div style="margin-bottom:14px;">Сделайте первую тренировку — здесь появятся итоги и тоннаж.</div>
            <button class="btn accent" onclick="showScreen('screen-workouts')" style="max-width:280px;margin:0 auto;">🏋️ К тренировкам</button>
        </div>`;
        return;
    }
    const totalWork = items.reduce((s, r) => s + (r.workTime || 0), 0);
    const totalDuration = items.reduce((s, r) => s + (r.totalDuration || 0), 0);
    const totalWarmup = items.reduce((s, r) => s + (r.warmupSeconds || 0), 0);
    const totalVolume = items.reduce((s, r) => s + getRecordVolume(r), 0);
    let limitWarn = '';
    const histLen = DB.history.length;
    if (histLen >= HISTORY_HARD_LIMIT) {
        limitWarn = `<div style="margin-top:10px;padding:10px 12px;background:var(--warn-soft);border-radius:10px;font-size:0.82rem;color:var(--warn);">⚠️ История заполнена (${histLen}/${HISTORY_HARD_LIMIT}). Старые записи будут удаляться.</div>`;
    } else if (histLen >= Math.floor(HISTORY_HARD_LIMIT * 0.85)) {
        limitWarn = `<div style="margin-top:10px;padding:10px 12px;background:var(--warn-soft);border-radius:10px;font-size:0.82rem;color:var(--warn);">⏳ История почти заполнена: ${histLen} из ${HISTORY_HARD_LIMIT}. Рекомендуется сделать бэкап.</div>`;
    }
    const summaryHtml = `<div class="history-summary-card"><div class="history-summary-title">Найдено</div><div class="history-summary-big">${items.length}</div><div class="history-summary-big-sub">${pluralWorkouts(items.length)}</div><div class="history-summary-row"><div class="history-summary-item"><div class="val">${formatTime(Math.floor(totalDuration))}</div><div class="lbl">⏱ общее</div></div><div class="history-summary-item"><div class="val">${formatTime(Math.floor(totalWork))}</div><div class="lbl">💪 работа</div></div>${totalVolume > 0 ? `<div class="history-summary-item"><div class="val">${formatWeightVal(totalVolume)}</div><div class="lbl">📦 тоннаж</div></div>` : ''}${totalWarmup > 0 ? `<div class="history-summary-item"><div class="val">${formatTime(Math.floor(totalWarmup))}</div><div class="lbl">🔥 разминка</div></div>` : ''}</div>${limitWarn}</div>`;
    if (items.length === 0) { c.innerHTML = summaryHtml + '<div class="empty-state"><span class="icon">🔍</span><div class="title">Ничего не найдено</div></div>'; return; }
    const sorted = [...items].sort((a, b) => new Date(b.startTime) - new Date(a.startTime));
    const grouped = new Map();
    sorted.forEach(r => { const g = historyGroupForRecord(r); if (!grouped.has(g.key)) grouped.set(g.key, { ...g, records: [] }); grouped.get(g.key).records.push(r); });
    const historyGroupModeLabel = historyGroupMode === 'day' ? 'дням' : (historyGroupMode === 'week' ? 'неделям' : 'месяцам');
    const groupToolbar = `<div class="history-group-toolbar"><div class="history-group-title-wrap"><div class="history-group-heading">История <span>${items.length}</span></div><div class="history-group-subtitle">Группировка по ${historyGroupModeLabel}</div></div><div class="history-group-controls">${[['day','Дни'],['week','Недели'],['month','Месяцы']].map(([v,l]) => `<button type="button" class="${historyGroupMode===v?'active':''}" aria-pressed="${historyGroupMode===v}" onclick="setHistoryGroupMode('${v}')">${l}</button>`).join('')}</div></div>`;
    c.innerHTML = summaryHtml + groupToolbar + [...grouped.values()].map(group => {
        const isGroupCollapsed = !!historyGroupCollapsed[group.key];
        const recordsHtml = group.records.map(r => {
        const wExists = r.workoutId && DB.workouts.find(w => w.id === r.workoutId);
        const notes = r.exerciseNotes || {};
        const hasNotes = Object.values(notes).some(n => n) || r.workoutNote;
        const hasWarmup = (r.warmupSeconds || 0) > 0;
        const origIdxs = getExerciseOriginalIndices(r);
        const isChecked = historySelectedIds.has(r.id);
        if (historySelectionMode) {
            return `<div class="history-card" onclick="toggleHistorySelection(${r.id})" style="cursor:pointer;"><div class="history-top"><div class="bulk-checkbox ${isChecked ? 'checked' : ''}"></div><div class="history-info"><div class="name">${escapeHtml(r.workoutName)}</div><div class="stats">${formatDate(new Date(r.startTime))} · ${formatTime(r.totalDuration)}</div></div></div></div>`;
        }
        const vol = getRecordVolume(r);
        const volPart = vol > 0 ? ` · 📦 ${formatWeightVal(vol)}` : '';
        return `<div class="swipe-container" data-history-id="${r.id}"><button class="swipe-delete-btn" data-delete-id="${r.id}">🗑 Удалить</button><div class="history-card" onclick="openHistoryItemDetail(${r.id})">
            <div class="history-top"><div class="history-info"><div class="name">${escapeHtml(r.workoutName)}${r.isDeload ? ' 🏷' : ''}</div><div class="stats">${formatDate(new Date(r.startTime))} · ${formatTime(r.totalDuration)} · 💪 ${formatTime(r.workTime)}${volPart}${hasWarmup ? ' · 🔥 ' + formatTime(r.warmupSeconds) : ''}</div></div><div class="history-actions">${wExists ? `<button class="icon-btn" onclick="event.stopPropagation(); repeatLastWorkout(${r.workoutId})" title="Повторить" aria-label="Повторить">▶</button>` : ''}<button class="icon-btn" onclick="event.stopPropagation(); shareResult(${r.id})" title="Поделиться" aria-label="Поделиться">📤</button><button class="icon-btn delete" onclick="event.stopPropagation(); deleteHistoryRecord(${r.id})" title="Удалить" aria-label="Удалить">🗑</button></div></div>
            ${r.workoutNote ? `<div style="background:var(--primary-soft); border-left:3px solid var(--primary); border-radius:10px; padding:10px 12px; font-size:0.85rem;">📝 ${escapeHtml(r.workoutNote)}</div>` : ''}
        </div></div>`;
    }).join('');
        return `<section class="history-group"><button type="button" class="history-group-header" onclick="toggleHistoryGroup('${group.key}')"><span class="history-group-name">${group.label}</span><span class="history-group-count">${group.records.length} ${pluralWorkouts(group.records.length)}</span></button><div class="history-group-body" style="${isGroupCollapsed ? 'display:none;' : ''}">${recordsHtml}</div></section>`;
    }).join('');
    c.querySelectorAll('.swipe-container').forEach(container => {
        const id = parseInt(container.dataset.historyId);
        initSwipeDelete(container, () => { const card = container.querySelector('.history-card'); if (card) card.style.transform = ''; deleteHistoryRecord(id); });
    });
    if (historySelectionMode && historySelectedIds.size > 0) {
        const bar = document.createElement('div');
        bar.className = 'bulk-action-bar';
        bar.id = 'bulk-action-bar';
        bar.innerHTML = `<button class="btn danger small" onclick="deleteSelectedHistory()" style="width:100%;">Удалить ${historySelectedIds.size}</button>`;
        document.body.appendChild(bar);
    }
}

function openHistoryItemDetail(id) {
    const r = DB.history.find(x => x.id === id);
    if (!r) { showToast('Запись не найдена'); return; }
    const startT = new Date(r.startTime);
    const endT = r.endTime ? new Date(r.endTime) : new Date(startT.getTime() + (r.totalDuration || 0) * 1000);
    const totalDuration = r.totalDuration || 0;
    const workTime = r.workTime || 0;
    const warmupSeconds = r.warmupSeconds || 0;
    const exNames = r.exerciseNames || [];
    const exTimes = r.exerciseTimes || [];
    const setResults = r.setResults || {};
    const origIdxs = getExerciseOriginalIndices(r);
    let exListHtml = '';
    if (warmupSeconds > 0) {
        exListHtml += `<div style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid var(--border-soft);"><span style="color:var(--warn); font-size:0.9rem;">🔥 Разминка</span><span style="color:var(--warn); font-weight:700;">${formatTime(warmupSeconds)}</span></div>`;
    }
    exNames.forEach((name, i) => {
        const t = exTimes[i];
        const origIdx = origIdxs[i] !== undefined ? origIdxs[i] : i;
        const sets = setResults[origIdx];
        const weights = ((r.setWeights || {})[origIdx]) || [];
        const isSkipped = t !== undefined && t !== null && t < 0;
        const hasSets = Array.isArray(sets) && sets.length;
        const hasWeight = Array.isArray(weights) && weights.length && weights.some(w => w > 0);
        const timeStr = isSkipped ? '⏭' : formatTime(t || 0);
        const timeColor = isSkipped ? 'var(--muted)' : 'var(--accent)';
        if (hasSets && hasWeight) {
            exListHtml += `<div style="padding:10px 0; border-bottom:1px solid var(--border-soft);">
                <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
                    <span style="color:var(--muted); font-size:0.9rem; flex:1; min-width:0; word-break:break-word;">${i + 1}. ${escapeHtml(name || 'Упражнение')}</span>
                    <span style="color:${timeColor}; font-weight:700; white-space:nowrap;">${timeStr}</span>
                </div>
                <div style="display:flex; justify-content:flex-end; margin-top:4px;">
                    <span style="color:var(--blue); font-size:0.85rem; font-weight:600; white-space:nowrap;">подходы: ${sets.join('/')}</span>
                </div>
                <div style="display:flex; justify-content:flex-end; margin-top:2px;">
                    <span style="color:var(--warn); font-size:0.85rem; font-weight:600; white-space:nowrap;">вес: ${weights.map(w => formatWeightVal(w || 0)).join('/')}</span>
                </div>
            </div>`;
        } else {
            let rightMeta = '';
            if (hasSets) rightMeta = `<span style="color:var(--blue); font-size:0.85rem; font-weight:600; white-space:nowrap;">подходы: ${sets.join('/')}</span>`;
            else if (hasWeight) rightMeta = `<span style="color:var(--warn); font-size:0.85rem; font-weight:600; white-space:nowrap;">вес: ${weights.map(w => formatWeightVal(w || 0)).join('/')}</span>`;
            exListHtml += `<div style="display:flex; justify-content:space-between; align-items:center; padding:8px 0; border-bottom:1px solid var(--border-soft); gap:8px;">
                <span style="color:var(--muted); font-size:0.9rem; flex:1; min-width:0; word-break:break-word;">${i + 1}. ${escapeHtml(name || 'Упражнение')}</span>
                <div style="display:flex; flex-shrink:0; align-items:center; gap:12px;">
                    ${rightMeta}
                    <span style="color:${timeColor}; font-weight:700; min-width:48px; text-align:right; white-space:nowrap;">${timeStr}</span>
                </div>
            </div>`;
        }
		});
    let notesHtml = '';
    if (r.exerciseNotes && Object.keys(r.exerciseNotes).length > 0) {
        const items = Object.entries(r.exerciseNotes).map(([idx, note]) => {
            const exIdx = parseInt(idx);
            const name = exNames[origIdxs.indexOf(exIdx)] || 'Упражнение';
            return `<div style="padding:8px 0; border-bottom:1px solid var(--border-soft);"><div style="font-size:0.9rem; color:var(--muted);">${escapeHtml(name)}</div><div style="color:var(--text); font-size:0.9rem; margin-top:2px;">${escapeHtml(note)}</div></div>`;
        }).join('');
        notesHtml = `<div style="margin-top:12px;"><div style="font-size:0.72rem; color:var(--muted); text-transform:uppercase; letter-spacing:1px; margin-bottom:6px;">📝 Заметки</div>${items}</div>`;
    }
    const wExists = r.workoutId && DB.workouts.find(w => w.id === r.workoutId);
    const ov = document.createElement('div');
    ov.className = 'notif-side-overlay';
    ov.innerHTML = `<div class="notif-side-sheet" style="max-height: 85vh;">
        <div class="notif-side-grabber"><div class="notif-side-grabber-bar"></div></div>
        <h2 class="sheet-title">${escapeHtml(r.workoutName)}</h2>
        <div class="sheet-scroll-area" style="flex:1; overflow-y:auto; display:flex; flex-direction:column; gap:8px; padding-right: 4px;">
            <div class="history-summary-card" style="margin-bottom:0; padding:14px;">
                <div class="history-summary-title">Статистика</div>
                <div class="history-summary-row" style="margin-top:0; padding-top:0; border-top:none;">
                    <div class="history-summary-item"><div class="val">${formatClock(startT)}</div><div class="lbl">🕐 Начало</div></div>
                    <div class="history-summary-item"><div class="val">${formatClock(endT)}</div><div class="lbl">🏁 Конец</div></div>
                    <div class="history-summary-item"><div class="val">${formatTime(totalDuration)}</div><div class="lbl">⏱ Длит.</div></div>
                    <div class="history-summary-item"><div class="val" style="color:var(--accent);">${formatTime(workTime)}</div><div class="lbl">💪 Работа</div></div>
                    ${warmupSeconds > 0 ? `<div class="history-summary-item"><div class="val" style="color:var(--warn);">${formatTime(warmupSeconds)}</div><div class="lbl">🔥 Разминка</div></div>` : ''}
                </div>
            </div>
            <div style="font-size:0.75rem; color:var(--muted); text-transform:uppercase; letter-spacing:1px;">Упражнения</div>
            ${exListHtml}
            ${notesHtml}
            ${r.workoutNote ? `<div style="background:var(--primary-soft); border-left:3px solid var(--primary); border-radius:10px; padding:10px 12px; font-size:0.85rem;">📝 ${escapeHtml(r.workoutNote)}</div>` : ''}
        </div>
        <div class="sheet-fixed-bottom" style="flex-shrink: 0; display: flex; flex-direction: column; gap: 8px; padding-top: 4px;">
            ${wExists ? `<button class="btn accent" onclick="closeTopSheet(); repeatLastWorkout(${r.workoutId})">▶ Повторить</button>` : ''}
            <button class="btn ghost" onclick="shareResult(${r.id})">📤 Поделиться</button>
            <button class="btn sheet-btn-cancel" onclick="closeTopSheet()">Закрыть</button>
        </div>
    </div>`;
    document.body.appendChild(ov);
    setupSideSwipe(ov.querySelector('.notif-side-sheet'), ov);
    ov.addEventListener('click', (e) => { if (e.target === ov) ov.remove(); });
}

async function deleteHistoryRecord(id) {
    if (!await customConfirm('Удалить запись?', { danger: true, okText: '🗑 Удалить' })) return;
    const idx = DB.history.findIndex(r => r.id === id);
    if (idx < 0) return;
    const removed = DB.history[idx];
    DB.history.splice(idx, 1);
    saveDB('history'); renderHistory();
    showUndoToast('Запись удалена', () => { DB.history.splice(idx, 0, removed); saveDB('history'); renderHistory(); showToast('Восстановлено'); });
}
function renderHistoryStats() {
    const c = document.getElementById('history-tab-stats');
    if (!c) return;
    const items = getFilteredHistory();
    if (DB.history.length === 0) { c.innerHTML = '<div class="empty-state">Нет данных</div>'; return; }
    if (items.length === 0) { c.innerHTML = '<div class="empty-state">Ничего не найдено</div>'; return; }
    const now = new Date();
    const week = items.filter(r => new Date(r.startTime) >= new Date(now.getTime() - 7*24*60*60*1000));
    const month = items.filter(r => new Date(r.startTime) >= new Date(now.getTime() - 30*24*60*60*1000));
    const totalTime = items.reduce((s, r) => s + r.totalDuration, 0);
    const totalWork = items.reduce((s, r) => s + r.workTime, 0);
    const totalWarmup = items.reduce((s, r) => s + (r.warmupSeconds || 0), 0);
    const avgDuration = items.length > 0 ? Math.floor(totalTime / items.length) : 0;
    const avgWork = items.length > 0 ? Math.floor(totalWork / items.length) : 0;
    const exMap = {};
    items.forEach(r => { (r.exerciseNames || []).forEach((name, i) => { const t = (r.exerciseTimes || [])[i] || 0; if (t > 0) { const key = name || 'Упражнение'; exMap[key] = (exMap[key] || 0) + t; } }); });
    const top3 = Object.entries(exMap).sort((a, b) => b[1] - a[1]).slice(0, 3);
    let top3Html = '';
    if (top3.length > 0) {
        top3Html = `<div class="card" style="margin-top:12px;"><div style="font-weight:700; margin-bottom:8px;">🏆 Топ-3 упражнения по времени</div>`;
        top3.forEach(([name, t], i) => { const medal = ['🥇', '🥈', '🥉'][i] || '•'; top3Html += `<div class="stat-row"><div class="stat-label">${medal} ${escapeHtml(name)}</div><div class="stat-value">${formatTime(Math.floor(t))}</div></div>`; });
        top3Html += `</div>`;
    }
    c.innerHTML = `<div class="card"><div class="stat-row"><div class="stat-label">📅 Эта неделя</div><div class="stat-value">${week.length} трен.</div></div><div class="stat-row"><div class="stat-label">📅 Этот месяц</div><div class="stat-value">${month.length} трен.</div></div><div class="stat-row"><div class="stat-label">🏆 Найдено</div><div class="stat-value highlight">${items.length}</div></div><div class="stat-row"><div class="stat-label">⏱ Общее время</div><div class="stat-value">${formatTime(Math.floor(totalTime))}</div></div><div class="stat-row"><div class="stat-label">💪 Чистое время</div><div class="stat-value">${formatTime(Math.floor(totalWork))}</div></div>${totalWarmup > 0 ? `<div class="stat-row"><div class="stat-label">🔥 Разминка</div><div class="stat-value">${formatTime(Math.floor(totalWarmup))}</div></div>` : ''}</div><div class="card" style="margin-top:12px;"><div style="font-weight:700; margin-bottom:8px;">📈 В среднем</div><div class="stat-row"><div class="stat-label">⏱ Длительность</div><div class="stat-value">${formatTime(avgDuration)}</div></div><div class="stat-row"><div class="stat-label">💪 Работа</div><div class="stat-value">${formatTime(avgWork)}</div></div></div>${top3Html}`;
}
function getHistoryPersonalRecordAchievements() {
    const sorted = [...(Array.isArray(DB.history) ? DB.history : [])]
        .filter(r => r && r.startTime && Array.isArray(r.exerciseNames))
        .sort((a, b) => new Date(a.startTime) - new Date(b.startTime) || (Number(a.id) || 0) - (Number(b.id) || 0));
    const prior = [];
    const achievements = [];
    sorted.forEach(record => {
        const names = record.exerciseNames || [];
        const originalIndices = getExerciseOriginalIndices(record);
        names.forEach((name, i) => {
            const originalIndex = originalIndices[i] !== undefined ? originalIndices[i] : i;
            const sets = record.setResults && record.setResults[originalIndex];
            if (!name || !Array.isArray(sets) || !sets.length) return;
            const weights = (record.setWeights && record.setWeights[originalIndex]) || [];
            const prs = detectNewPRs(name, sets, weights, prior, true);
            prs.forEach(pr => achievements.push({
                id: `${record.id || record.startTime}:${i}:${pr.type}`,
                recordId: record.id,
                exercise: name,
                workoutName: record.workoutName || 'Тренировка',
                date: record.startTime,
                type: pr.type,
                label: pr.label,
                value: pr.value,
                detail: pr.detail || ''
            }));
        });
        prior.push(record);
    });
    return achievements.sort((a, b) => new Date(b.date) - new Date(a.date));
}

function toggleHistoryPersonalRecords() {
    DB.settings.historyPersonalRecordsCollapsed = !DB.settings.historyPersonalRecordsCollapsed;
    saveDB('settings');
    renderHistoryRecords();
}
function renderHistoryRecords() {
    const c = document.getElementById('history-tab-records');
    if (!c) return;
    const items = getFilteredHistory();
    if (DB.history.length === 0) { c.innerHTML = '<div class="empty-state">Нет данных</div>'; return; }
    if (items.length === 0) { c.innerHTML = '<div class="empty-state">Ничего не найдено</div>'; return; }
    const visibleIds = new Set(items.map(r => r.id));
    const prAchievements = getHistoryPersonalRecordAchievements().filter(p => visibleIds.has(p.recordId));
    const prCollapsed = !!DB.settings.historyPersonalRecordsCollapsed;
    const prToggleIcon = prCollapsed
        ? '<svg viewBox="0 0 24 24" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>'
        : '<svg viewBox="0 0 24 24" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>';
    const prAchievementsHtml = `<section class="history-pr-section${prCollapsed ? ' collapsed' : ''}"><div class="history-pr-heading"><span class="history-pr-title">🏆 Личные рекорды</span><span class="history-pr-count">${prAchievements.length}</span><button type="button" class="icon-toggle-btn history-pr-toggle" onclick="toggleHistoryPersonalRecords()" aria-label="${prCollapsed ? 'Развернуть личные рекорды' : 'Свернуть личные рекорды'}" title="${prCollapsed ? 'Развернуть' : 'Свернуть'}">${prToggleIcon}</button></div><div class="history-pr-body" style="${prCollapsed ? 'display:none;' : ''}">${prAchievements.length ? prAchievements.map(p => `<article class="history-pr-item"><div class="history-pr-icon">🏅</div><div class="history-pr-info"><div class="history-pr-exercise">${escapeHtml(p.exercise)}</div><div class="history-pr-label">${escapeHtml(p.label)}${p.detail ? ' · ' + escapeHtml(p.detail) : ''}</div><div class="history-pr-meta">${escapeHtml(p.workoutName)} · ${formatDate(new Date(p.date))}</div></div><div class="history-pr-value">${escapeHtml(p.value)}</div></article>`).join('') : `<div class="history-pr-empty-text">В выбранном периоде новых личных рекордов пока нет. Они появятся здесь, когда результат упражнения превысит предыдущий.</div>`}</div></section>`;
    const longest = items.reduce((a, b) => a.totalDuration > b.totalDuration ? a : b);
    const mostWork = items.reduce((a, b) => a.workTime > b.workTime ? a : b);
    let bestVol = null, bestVolVal = 0, bestW = null, bestWVal = 0;
    items.forEach(r => {
        const vol = (typeof getRecordVolume === 'function') ? getRecordVolume(r) : 0;
        if (vol > bestVolVal) { bestVolVal = vol; bestVol = r; }
        const sw = r.setWeights || {};
        Object.keys(sw).forEach(k => {
            (Array.isArray(sw[k]) ? sw[k] : []).forEach(w => {
                const n = Number(w) || 0;
                if (n > bestWVal) { bestWVal = n; bestW = r; }
            });
        });
    });
    let html = prAchievementsHtml + `<div class="record-item"><div class="label">🏅 Самая длинная</div><div class="value">${formatTime(longest.totalDuration)}</div></div><div style="color:var(--muted); font-size:0.8rem; margin:-4px 0 12px 4px;">${escapeHtml(longest.workoutName)}</div>
        <div class="record-item"><div class="label">💪 Больше работы</div><div class="value">${formatTime(mostWork.workTime)}</div></div><div style="color:var(--muted); font-size:0.8rem; margin:-4px 0 12px 4px;">${escapeHtml(mostWork.workoutName)}</div>`;
    if (bestVol && bestVolVal > 0) {
        html += `<div class="record-item"><div class="label">📦 Макс. тоннаж</div><div class="value">${formatWeightVal(bestVolVal)}</div></div><div style="color:var(--muted); font-size:0.8rem; margin:-4px 0 12px 4px;">${escapeHtml(bestVol.workoutName || '')}</div>`;
    }
    if (bestW && bestWVal > 0) {
        html += `<div class="record-item"><div class="label">🏋️ Макс. вес</div><div class="value">${formatWeightVal(bestWVal)}</div></div><div style="color:var(--muted); font-size:0.8rem; margin:-4px 0 12px 4px;">${escapeHtml(bestW.workoutName || '')}</div>`;
    }
    c.innerHTML = html;
}
function renderHistoryPrograms() {
    const c = document.getElementById('history-tab-programs');
    if (!c) return;
    const periodEl = document.getElementById('history-period');
    const period = periodEl ? periodEl.value : 'all';
    const today = new Date(); today.setHours(0,0,0,0);
    const todayKey = formatDateKey(today);
    let cutoff = null;
    if (period !== 'all') {
        const days = parseInt(period) || 0;
        if (days > 0) cutoff = addDays(today, -days + 1);
    }

    // Формируем отдельную историю для каждой программы. Пустые дни без назначенных
    // тренировок не создаём — они не несут полезной информации в истории.
    const programGroups = [];
    const globalOccurrence = new Map();
    let doneCount = 0, missedCount = 0;

    DB.programs.forEach((program, programIndex) => {
        const programKey = 'history-program:' + String(program.id != null ? program.id : programIndex);
        const dayMap = new Map();
        (program.weeks || []).forEach(week => {
            if (!week || !week.days || !week.startDate) return;
            DAY_KEYS.forEach((dayKey, dayIdx) => {
                const ids = Array.isArray(week.days[dayKey]) ? week.days[dayKey] : [];
                if (!ids.length) return;
                const date = addDays(parseDateKey(week.startDate), dayIdx);
                const dateKey = formatDateKey(date);
                if (dateKey > todayKey || (cutoff && date < cutoff)) return;
                if (!dayMap.has(dateKey)) dayMap.set(dateKey, { date, dateKey, items: [] });
                const day = dayMap.get(dateKey);
                ids.forEach(wid => {
                    const occurrenceKey = dateKey + ':' + String(wid);
                    const occurrenceIndex = globalOccurrence.get(occurrenceKey) || 0;
                    globalOccurrence.set(occurrenceKey, occurrenceIndex + 1);
                    const workout = DB.workouts.find(x => x.id === wid);
                    const status = getPlanStatus(wid, date, occurrenceIndex);
                    if (status.status === 'done') doneCount++;
                    else if (status.status === 'missed') missedCount++;
                    day.items.push({ wid, name: workout ? workout.name : '(удалено)', ...status });
                });
            });
        });
        const days = [...dayMap.values()].sort((a, b) => b.dateKey.localeCompare(a.dateKey));
        if (days.length) programGroups.push({ program, programIndex, programKey, days });
    });

    const dayKeys = [];
    const programKeys = programGroups.map(group => group.programKey);
    window.__historyProgramKeys = programKeys;
    const collapsedDays = DB.settings.historyProgramDayCollapsed && typeof DB.settings.historyProgramDayCollapsed === 'object'
        ? DB.settings.historyProgramDayCollapsed : (DB.settings.historyProgramDayCollapsed = {});
    const collapsedPrograms = DB.settings.historyProgramCollapsed && typeof DB.settings.historyProgramCollapsed === 'object'
        ? DB.settings.historyProgramCollapsed : (DB.settings.historyProgramCollapsed = {});
    const total = doneCount + missedCount;
    const pct = total > 0 ? Math.round(doneCount / total * 100) : 0;
    const summaryHtml = `<div class="history-summary-card"><div class="history-summary-title">Выполнение программ</div><div class="history-summary-row" style="margin-top:0; padding-top:0; border-top:none;"><div class="history-summary-item"><div class="val" style="color:var(--accent);">${doneCount}</div><div class="lbl">✅ выполнено</div></div><div class="history-summary-item"><div class="val" style="color:var(--danger);">${missedCount}</div><div class="lbl">❌ пропущено</div></div>${total > 0 ? `<div class="history-summary-item"><div class="val">${pct}%</div><div class="lbl">процент</div></div>` : ''}</div></div>`;

    const groupsHtml = programGroups.map(group => {
        const p = group.program;
        const programCollapsed = !!collapsedPrograms[group.programKey];
        const allItems = group.days.flatMap(day => day.items);
        const pDone = allItems.filter(item => item.status === 'done').length;
        const pMissed = allItems.filter(item => item.status === 'missed').length;
        const pTotal = pDone + pMissed;
        const pPct = pTotal ? Math.round(pDone / pTotal * 100) : 0;
        const daysHtml = group.days.map(day => {
            const dayIndex = (day.date.getDay() + 6) % 7;
            const dayName = DAY_NAMES_SHORT[DAY_KEYS[dayIndex]];
            const dd = String(day.date.getDate()).padStart(2, '0');
            const mm = String(day.date.getMonth() + 1).padStart(2, '0');
            const dateStr = `${dayName} ${dd}.${mm}`;
            const dayGroupKey = group.programKey + ':day:' + day.dateKey;
            dayKeys.push(dayGroupKey);
            const dayCollapsed = !!collapsedDays[dayGroupKey];
            const doneOfTotal = day.items.filter(item => item.status === 'done').length;
            const counter = `<div class="program-history-day-count">${doneOfTotal} из ${day.items.length}</div>`;
            const itemsHtml = day.items.map(item => {
                if (item.status === 'done') return `<div class="program-history-entry" style="color:var(--accent);" onclick="openHistoryItemDetail(${Number(item.recordId) || 0})">✅ ${escapeHtml(item.name)}${item.time ? ` <span style="color:var(--muted); font-size:0.8em;">(${item.time})</span>` : ''}</div>`;
                if (item.status === 'missed') return `<div class="program-history-entry" style="color:var(--danger);">❌ ${escapeHtml(item.name)}</div>`;
                return `<div class="program-history-entry" style="color:var(--warn);">⏳ ${escapeHtml(item.name)}</div>`;
            }).join('');
            return `<section class="card program-history-day ${dayCollapsed ? 'collapsed' : ''}"><button type="button" class="program-history-day-header" onclick="toggleHistoryProgramDay('${dayGroupKey}')"><span class="program-history-day-title">${dateStr}</span>${counter}<span class="program-history-day-chevron"><svg viewBox="0 0 24 24" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="${dayCollapsed ? '6 9 12 15 18 9' : '18 15 12 9 6 15'}"/></svg></span></button><div class="program-history-day-body" style="${dayCollapsed ? 'display:none;' : ''}">${itemsHtml}</div></section>`;
        }).join('');
        const weekCount = (p.weeks || []).length;
        return `<section class="card history-program-group ${programCollapsed ? 'collapsed' : ''}"><button type="button" class="history-program-group-header" onclick="toggleHistoryProgramGroup('${group.programKey}')"><span class="history-program-group-main"><strong>📅 ${escapeHtml(p.name || 'Без названия')}</strong><span>${weekCount} нед. · ${pDone} выполнено · ${pMissed} пропущено</span></span><span class="history-program-group-progress">${pPct}%</span><span class="program-history-day-chevron"><svg viewBox="0 0 24 24" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="${programCollapsed ? '6 9 12 15 18 9' : '18 15 12 9 6 15'}"/></svg></span></button><div class="history-program-group-body" style="${programCollapsed ? 'display:none;' : ''}"><div class="history-program-group-track"><span style="width:${pPct}%"></span></div>${daysHtml}</div></section>`;
    }).join('');

    window.__historyProgramDayKeys = dayKeys;
    if (!programGroups.length) {
        c.innerHTML = '<div class="empty-state"><span class="icon">📭</span><div class="title">Нет данных</div>В выбранном периоде нет запланированных тренировок по программам.</div>';
        return;
    }
    c.innerHTML = summaryHtml + groupsHtml;
}

function shareResult(id) {
    const r = DB.history.find(x => x.id === id);
    if (!r) return;
    const startT = new Date(r.startTime);
    const endT = r.endTime ? new Date(r.endTime) : new Date(startT.getTime() + (r.totalDuration || 0) * 1000);
    let text = `💪 ${r.workoutName || 'Тренировка'}`;
    if (r.isDeload) text += ` (разгрузочная)`;
    text += `\n🕐 ${formatClock(startT)} → ${formatClock(endT)}`;
    text += `\n⏱ ${formatTime(r.totalDuration || 0)} · 💪 ${formatTime(r.workTime || 0)}`;
    if ((r.warmupSeconds || 0) > 0) text += ` · 🔥 ${formatTime(r.warmupSeconds)}`;
    const exNames = r.exerciseNames || [];
    const exTimes = r.exerciseTimes || [];
    const setResults = r.setResults || {};
    const origIdxs = (typeof getExerciseOriginalIndices === 'function') ? getExerciseOriginalIndices(r) : exNames.map((_, i) => i);
    if (exNames.length) {
        text += `\n\nУпражнения:`;
        exNames.forEach((name, i) => {
            const t = exTimes[i];
            const isSkipped = t !== undefined && t !== null && t < 0;
            const sets = setResults[origIdxs[i] !== undefined ? origIdxs[i] : i];
            const setsStr = Array.isArray(sets) && sets.length ? ` (${sets.join('/')})` : '';
            text += `\n${i + 1}. ${name || 'Упражнение'}${setsStr} — ${isSkipped ? '⏭' : formatTime(t || 0)}`;
        });
    }
    text += `\n\n#FitTrainer`;
    if (DB.settings.shareImageCard !== false) {
        try { shareResultImage(r, text); return; } catch (e) { console.error('[share-image]', e); }
    }
    if (navigator.share) navigator.share({ title: 'Тренировка', text }).catch(() => showShareFallback(text));
    else if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => showToast('📋 Скопировано')).catch(() => showShareFallback(text));
    else showShareFallback(text);
}
async function shareResultImage(r, textFallback) {
    const W = 1080;
    const pad = 64;
    const innerPad = 48;
    const isLight = document.body.classList.contains('light');
    const startT = new Date(r.startTime);
    const endT = r.endTime ? new Date(r.endTime) : new Date(startT.getTime() + (r.totalDuration || 0) * 1000);
    const exNames = r.exerciseNames || [];
    const exTimes = r.exerciseTimes || [];
    const setResults = r.setResults || {};
    const origIdxs = (typeof getExerciseOriginalIndices === 'function') ? getExerciseOriginalIndices(r) : exNames.map((_, i) => i);
    const warmupSeconds = r.warmupSeconds || 0;

    // Оценка высоты под контент
    const titleLinesEst = Math.max(1, Math.ceil(String(r.workoutName || 'Тренировка').length / 18));
    const exRows = exNames.length + (warmupSeconds > 0 ? 1 : 0);
    const H = Math.min(2800, Math.max(1400, 560 + titleLinesEst * 70 + 300 + exRows * 78 + 120));

    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');

    const roundRect = (x, y, w, h, rad) => {
        const rr = Math.min(rad, w / 2, h / 2);
        ctx.beginPath();
        ctx.moveTo(x + rr, y);
        ctx.arcTo(x + w, y, x + w, y + h, rr);
        ctx.arcTo(x + w, y + h, x, y + h, rr);
        ctx.arcTo(x, y + h, x, y, rr);
        ctx.arcTo(x, y, x + w, y, rr);
        ctx.closePath();
    };
    const fillTextEllipsis = (text, x, y, maxW) => {
        let t = String(text || '');
        if (ctx.measureText(t).width <= maxW) { ctx.fillText(t, x, y); return; }
        while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
        ctx.fillText(t + '…', x, y);
    };

    // Фон
    const grd = ctx.createLinearGradient(0, 0, W, H);
    if (isLight) { grd.addColorStop(0, '#f3f3f9'); grd.addColorStop(1, '#e8e6f5'); }
    else { grd.addColorStop(0, '#12121a'); grd.addColorStop(0.5, '#1a1530'); grd.addColorStop(1, '#0a0a10'); }
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(167,139,250,0.16)';
    ctx.beginPath(); ctx.arc(W * 0.88, 140, 240, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(52,211,153,0.10)';
    ctx.beginPath(); ctx.arc(100, H - 160, 260, 0, Math.PI * 2); ctx.fill();

    // Карточка
    const cardX = pad, cardY = pad, cardW = W - pad * 2, cardH = H - pad * 2;
    roundRect(cardX, cardY, cardW, cardH, 48);
    ctx.fillStyle = isLight ? 'rgba(255,255,255,0.94)' : 'rgba(22,22,30,0.90)';
    ctx.fill();

    const contentX = cardX + innerPad;
    const contentW = cardW - innerPad * 2;
    let y = cardY + 56;

    // Заголовок приложения
    ctx.fillStyle = isLight ? '#8a8a95' : '#8a8a9c';
    ctx.font = '600 30px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif';
    ctx.fillText('Fit Trainer Pro', contentX, y);
    y += 70;

    // Название тренировки
    ctx.fillStyle = '#a78bfa';
    ctx.font = '800 54px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif';
    const title = String(r.workoutName || 'Тренировка');
    const words = title.split(/\s+/);
    let line = '';
    for (let n = 0; n < words.length; n++) {
        const test = (line ? line + ' ' : '') + words[n];
        if (ctx.measureText(test).width > contentW && line) {
            ctx.fillText(line, contentX, y);
            y += 64;
            line = words[n];
        } else line = test;
    }
    if (line) { ctx.fillText(line, contentX, y); y += 64; }
    if (r.isDeload) {
        y += 8;
        ctx.fillStyle = isLight ? '#bd790d' : '#ffc66e';
        ctx.font = '700 28px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif';
        ctx.fillText('🏷 Разгрузочная', contentX, y);
        y += 40;
    }
    y += 28;

    // Блок статистики (с увеличенными отступами сверху и снизу)
    const statsBoxH = 250;
    roundRect(contentX, y, contentW, statsBoxH, 28);
    ctx.fillStyle = isLight ? 'rgba(124,77,255,0.07)' : 'rgba(167,139,250,0.10)';
    ctx.fill();

    ctx.fillStyle = isLight ? '#8a8a95' : '#8a8a9c';
    ctx.font = '700 24px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('СТАТИСТИКА', contentX + contentW / 2, y + 48);

    const stats = [
        { icon: '🕐', label: 'НАЧАЛО', value: formatClock(startT), color: isLight ? '#079d78' : '#38e0aa' },
        { icon: '🏁', label: 'КОНЕЦ', value: formatClock(endT), color: isLight ? '#079d78' : '#38e0aa' },
        { icon: '⏱', label: 'ДЛИТ.', value: formatTime(r.totalDuration || 0), color: isLight ? '#079d78' : '#38e0aa' },
        { icon: '💪', label: 'РАБОТА', value: formatTime(r.workTime || 0), color: isLight ? '#079d78' : '#38e0aa' },
        { icon: '🔥', label: 'РАЗМИНКА', value: formatTime(warmupSeconds), color: isLight ? '#bd790d' : '#ffc66e' }
    ];
    const colW = contentW / 3;
    stats.slice(0, 3).forEach((s, i) => {
        const cx = contentX + colW * i + colW / 2;
        ctx.fillStyle = s.color;
        ctx.font = '800 36px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif';
        ctx.fillText(s.value, cx, y + 110);
        ctx.fillStyle = isLight ? '#8a8a95' : '#8a8a9c';
        ctx.font = '600 20px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif';
        ctx.fillText(`${s.icon} ${s.label}`, cx, y + 140);
    });
    const row2Y = y + 190;
    stats.slice(3).forEach((s, i) => {
        const cx = contentX + contentW * (i === 0 ? 0.33 : 0.67);
        ctx.fillStyle = s.color;
        ctx.font = '800 36px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif';
        ctx.fillText(s.value, cx, row2Y);
        ctx.fillStyle = isLight ? '#8a8a95' : '#8a8a9c';
        ctx.font = '600 20px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif';
        ctx.fillText(`${s.icon} ${s.label}`, cx, row2Y + 30);
    });
    ctx.textAlign = 'left';
    y += statsBoxH + 40;

    // Упражнения
    if (exNames.length > 0 || warmupSeconds > 0) {
        ctx.fillStyle = isLight ? '#8a8a95' : '#8a8a9c';
        ctx.font = '700 24px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif';
        ctx.fillText('УПРАЖНЕНИЯ', contentX, y);
        y += 28;

        if (warmupSeconds > 0) {
            ctx.fillStyle = isLight ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.04)';
            ctx.fillRect(contentX, y, contentW, 1);
            y += 42;
            ctx.fillStyle = isLight ? '#bd790d' : '#ffc66e';
            ctx.font = '600 32px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif';
            ctx.fillText('🔥 Разминка', contentX, y);
            ctx.textAlign = 'right';
            ctx.font = '700 32px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif';
            ctx.fillText(formatTime(warmupSeconds), contentX + contentW, y);
            ctx.textAlign = 'left';
            y += 28;
        }

        exNames.forEach((name, i) => {
            const t = exTimes[i];
            const origIdx = origIdxs[i] !== undefined ? origIdxs[i] : i;
            const sets = setResults[origIdx];
            const isSkipped = t !== undefined && t !== null && t < 0;
            const hasSets = Array.isArray(sets) && sets.length;
            const timeStr = isSkipped ? '⏭' : formatTime(t || 0);
            const timeColor = isSkipped ? (isLight ? '#8a8a95' : '#6c6c80') : (isLight ? '#079d78' : '#38e0aa');

            ctx.fillStyle = isLight ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.04)';
            ctx.fillRect(contentX, y, contentW, 1);
            y += 42;

            const nameStr = `${i + 1}. ${name || 'Упражнение'}`;
            ctx.fillStyle = isLight ? '#5a5a6a' : '#c8c8d4';
            ctx.font = '500 30px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif';
            const rightReserve = hasSets ? 280 : 140;
            fillTextEllipsis(nameStr, contentX, y, contentW - rightReserve);

            ctx.textAlign = 'right';
            if (hasSets) {
                ctx.fillStyle = isLight ? '#286fc0' : '#75b8ff';
                ctx.font = '600 26px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif';
                ctx.fillText(`подходы: ${sets.join('/')}`, contentX + contentW - 130, y);
            }
            ctx.fillStyle = timeColor;
            ctx.font = '700 30px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif';
            ctx.fillText(timeStr, contentX + contentW, y);
            ctx.textAlign = 'left';
            y += 28;
        });
    }

    // Хештег
    ctx.fillStyle = isLight ? '#8a8a95' : '#6c6c80';
    ctx.font = '600 28px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif';
    ctx.fillText('#FitTrainer', contentX, cardY + cardH - 40);

    const blob = await new Promise(res => canvas.toBlob(res, 'image/png', 0.95));
    if (!blob) {
        if (navigator.share) navigator.share({ title: 'Тренировка', text: textFallback }).catch(() => showShareFallback(textFallback));
        else showShareFallback(textFallback);
        return;
    }
    const file = new File([blob], `fit-trainer-${Date.now()}.png`, { type: 'image/png' });
    try {
        if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
            await navigator.share({ files: [file], title: r.workoutName || 'Тренировка', text: textFallback });
            return;
        }
    } catch (e) {}
    try {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = file.name;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showToast('🖼️ Карточка сохранена');
    } catch (e) {
        showShareFallback(textFallback);
    }
}
async function clearHistory() {
    if (DB.history.length === 0) { showToast('История пуста'); return; }
    // Закрыть меню действий / шторки, чтобы не осталось «второй» слой после подтверждения
    try {
        document.querySelectorAll('.notif-side-overlay.action-menu-overlay, .notif-side-overlay.action-menu-overlay ~ .notif-side-overlay').forEach(el => {
            try { el.remove(); } catch (e) {}
        });
        document.querySelectorAll('.notif-side-overlay').forEach(el => {
            // не трогаем уже открытый confirm
            if (el.querySelector('#cc-ok')) return;
            if (el.classList.contains('action-menu-overlay') || el.querySelector('.sheet-title')) {
                const title = (el.querySelector('.sheet-title') || {}).textContent || '';
                if (/действия|история/i.test(title) || el.classList.contains('action-menu-overlay')) {
                    try { el.remove(); } catch (e) {}
                }
            }
        });
        updateNotifGrabber();
    } catch (e) {}
    if (!await customConfirm('Удалить всю историю?', { title: 'Очистить историю', danger: true, okText: 'Удалить всё', cancelText: 'Отмена' })) return;
    // На всякий случай убрать залипшие оверлеи после confirm
    try {
        document.querySelectorAll('.notif-side-overlay').forEach(el => {
            if (el.querySelector('#cc-ok') || el.querySelector('#cc-cancel')) {
                try { el.remove(); } catch (e) {}
            }
        });
        updateNotifGrabber();
    } catch (e) {}
    const backup = [...DB.history];
    DB.history = [];
    saveDB('history');
    try { if (typeof exitHistoryBulkMode === 'function' && historySelectionMode) exitHistoryBulkMode(); } catch (e) {}
    renderHistory();
    showUndoToast('История очищена', () => {
        const current = Array.isArray(DB.history) ? DB.history : [];
        const backupIds = new Set(backup.map(r => r.id));
        const newOnes = current.filter(r => !backupIds.has(r.id));
        DB.history = [...backup, ...newOnes];
        saveDB('history'); renderHistory(); showToast('Восстановлено');
    });
}
function csvEscape(v) {
    const s = String(v === undefined || v === null ? '' : v);
    if (s.indexOf(';') >= 0 || s.indexOf('"') >= 0 || s.indexOf('\n') >= 0) return '"' + s.replace(/"/g, '""') + '"';
    return s;
}
function exportCSV() {
    if (!DB.history.length) { showToast('История пуста'); return; }
    const headers = ['Дата', 'Начало', 'Конец', 'Тренировка', 'Длительность', 'Длительность_сек', 'Работа', 'Работа_сек', 'Разминка_сек', 'Упражнений', 'Заметка'];
    const rows = DB.history.map(r => {
        const start = new Date(r.startTime);
        const end = r.endTime ? new Date(r.endTime) : new Date(start.getTime() + (r.totalDuration || 0) * 1000);
        return [formatDateKey(start), formatClock(start), formatClock(end), r.workoutName || '', formatTime(r.totalDuration || 0), r.totalDuration || 0, formatTime(r.workTime || 0), r.workTime || 0, r.warmupSeconds || 0, r.exercisesCount || (r.exerciseNames || []).length, r.workoutNote || ''];
    });
    const csv = [headers, ...rows].map(row => row.map(csvEscape).join(';')).join('\n');
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `fit-trainer-history-${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('📥 CSV экспортирован');
}
async function resetAllSettings() {
    if (!await customConfirm('Сбросить все настройки к значениям по умолчанию?\nТренировки, программы и история останутся.', { danger: true, okText: '↺ Сбросить' })) return;
    DB.settings = {
        wakeLock: false, countdown: false, defaultAutoStart: true, continuousBeep: false, overtimeStopwatch: false, finalWarnSeconds: 5,
        workoutSettingsPriority: 'workout',
        alarmSound: 'alarm', hiddenBuiltins: [], minuteBeep: false, minuteBeepInterval: 60,
        announceNumbers: true, announceWorkoutName: true, announceExerciseName: true, announceExerciseGoal: true, announceRestName: true, countdownDuration: 3, showStartTime: false,
        themeMode: 'auto', voiceRate: 1, voiceURI: null, announceButtons: false,
        notifyScheduledWorkouts: true, notifyShowCompleted: true, showActivityCalendar: true,
        autoBackupReminder: true, lastBackupAt: 0, lastBackupRecordCount: 0, askReps: true, askWeight: false,
        showLastExercise: true, autoFillWeight: true, autoFillReps: true, trackPRs: true, shareImageCard: true,
        hiddenMenuItems: [], hiddenBottomNavItems: [], showBottomNav: true, accordions: {}, dismissedUntil: {},
        lastNotifAutoShow: '', snoozeDuration: 2, fontSizeMode: 'normal',
        highContrast: false, compactWorkouts: false, streakGuard: true, streakGuardHour: 18,
        weeklyDigest: true, quietHours: false, quietHoursStart: 22, quietHoursEnd: 8,
        programsCalendarCollapsed: false, builtinTemplatesCollapsed: false, soundMode: 'beep',
        weekMetric: 'work', weekRange: 8,
        homeStreakCollapsed: false, homePlanCollapsed: false, quickStartCollapsed: false
    };
    if (DB.settings.soundMode !== 'voice' && DB.settings.soundMode !== 'beep') DB.settings.soundMode = 'beep';
    saveDB('settings');
    applyTheme(); applyFontSize(); applyCompactWorkouts(); applyHomeMenuVisibility();
    renderSettings();
    showToast('↺ Настройки сброшены');
}
function showErrorLog() {
    const log = readStoredArray('ft_error_log');
    if (log.length === 0) { showToast('Ошибок нет'); return; }
    const ov = document.createElement('div');
    ov.className = 'notif-side-overlay';
    ov.innerHTML = `<div class="notif-side-sheet" style="max-height:80vh;"><div class="notif-side-grabber"><div class="notif-side-grabber-bar"></div></div><h2 class="sheet-title">Лог ошибок (${log.length})</h2><div style="flex:1; overflow-y:auto; display:flex; flex-direction:column; gap:6px; font-size:0.8rem;">${log.slice().reverse().map(e => `<div style="background:var(--card-2); border-radius:8px; padding:8px 10px;"><div style="color:var(--muted); font-size:0.7rem;">${new Date(e.ts).toLocaleString('ru-RU')}</div><div style="color:var(--danger); margin-top:2px; word-break:break-word;">${escapeHtml(e.msg)}</div>${e.src ? `<div style="color:var(--muted-2); font-size:0.7rem; margin-top:2px;">${escapeHtml(e.src)}:${e.line}</div>` : ''}</div>`).join('')}</div><button class="btn danger" onclick="clearErrorLog()">🗑 Очистить лог</button><button class="btn sheet-btn-cancel" onclick="closeTopSheet()">Закрыть</button></div>`;
    document.body.appendChild(ov);
    setupSideSwipe(ov.querySelector('.notif-side-sheet'), ov);
    ov.addEventListener('click', (e) => { if (e.target === ov) ov.remove(); });
}
function clearErrorLog() { try { localStorage.removeItem('ft_error_log'); } catch(e) {} closeTopSheet(); updateErrorLogInfo(); showToast('Лог очищен'); }
function updateErrorLogInfo() {
    const el = document.getElementById('error-log-info');
    if (!el) return;
    try {
        const log = readStoredArray('ft_error_log');
        if (log.length === 0) { el.innerHTML = '✅ Ошибок нет'; }
        else { el.innerHTML = `⚠️ <a href="#" onclick="showErrorLog(); return false;" style="color:var(--danger); text-decoration:underline;">Ошибок в логе: ${log.length}</a>`; }
    } catch(e) { el.textContent = ''; }
}
function getSettingsGroupsState() {
    const groups = Array.from(document.querySelectorAll('#screen-settings .settings-group'));
    return { groups, allOpen: groups.length > 0 && groups.every(group => group.open) };
}
function getSettingsGroupsActionLabel() {
    return getSettingsGroupsState().allOpen ? 'Свернуть все разделы' : 'Развернуть все разделы';
}
function toggleAllSettingsGroups() {
    const state = getSettingsGroupsState();
    const shouldOpen = !state.allOpen;
    state.groups.forEach(group => { group.open = shouldOpen; });
    showToast(shouldOpen ? 'Все разделы развернуты' : 'Все разделы свёрнуты');
}
function resetSettingsSearch() {
    const input = document.getElementById('settings-search');
    if (input) input.value = '';
    filterSettings('');
    const scroller = document.querySelector('.app-container');
    if (scroller) scroller.scrollTo({ top: 0, behavior: 'smooth' });
}
function openSettingsActions() {
    if (hasOpenOverlay()) return;
    const ov = document.createElement('div');
    ov.className = 'notif-side-overlay action-menu-overlay';
    const hasSearch = !!((document.getElementById('settings-search')?.value || '').trim());
    ov.innerHTML = `<div class="notif-side-sheet">
        <div class="notif-side-grabber"><div class="notif-side-grabber-bar"></div></div>
        <h2 class="sheet-title">Настройки · Действия</h2>
        <button class="btn ghost" onclick="closeTopSheet(); toggleAllSettingsGroups();">${getSettingsGroupsActionLabel()}</button>
        ${hasSearch ? '<button class="btn ghost" onclick="closeTopSheet(); resetSettingsSearch();">✕ Сбросить поиск</button>' : ''}
        <button class="btn ghost" onclick="closeTopSheet(); exportData();">💾 Сделать бэкап</button>
        <div style="color:var(--muted);font-size:.78rem;line-height:1.4;text-align:center;">Создаёт зашифрованную резервную копию всех данных приложения. Для восстановления понадобится пароль.</div>
        <button class="btn danger" onclick="closeTopSheet(); resetAllSettings();">↺ Сбросить настройки</button>
        <div style="color:var(--muted);font-size:.78rem;line-height:1.4;text-align:center;">Сброс вернёт параметры приложения к исходным значениям. Тренировки, программы и история сохранятся.</div>
        <button class="btn sheet-btn-cancel" onclick="closeTopSheet()">Закрыть</button>
    </div>`;
    decorateActionMenu(ov, 'Настройки');
    document.body.appendChild(ov);
    setupSideSwipe(ov.querySelector('.notif-side-sheet'), ov);
    ov.addEventListener('click', (e) => { if (e.target === ov) closeTopSheet(); });
}

function filterSettings(q) {
    q = (q || '').toLowerCase().trim();
    const DYNAMIC_IDS = ['minute-beep-options', 'countdown-interval-options', 'final-warn-options', 'quiet-hours-row', 'streak-guard-hour-row', 'vibration-warning'];
    document.querySelectorAll('#screen-settings .settings-group').forEach(group => {
        const body = group.querySelector('.group-body');
        if (!body) return;
        let any = false;
        Array.from(body.children).forEach(row => {
            if (row.id && DYNAMIC_IDS.includes(row.id)) return;
            if (!q) { row.style.display = ''; return; }
            const text = (row.textContent || '').toLowerCase();
            const match = text.includes(q);
            row.style.display = match ? '' : 'none';
            if (match) any = true;
        });
        if (!q) { group.style.display = ''; return; }
        group.style.display = any ? '' : 'none';
        if (any) group.open = true;
    });
}
function setWorkoutSettingsPriority(mode, opts) {
    if (mode !== 'global' && mode !== 'workout') return;
    DB.settings.workoutSettingsPriority = mode;
    try { saveDB('settings'); } catch(e) {}
}
async function enablePersonalSettingsForThisWorkout() {
    const choice = await customConfirm(
        'Сейчас у этой тренировки общие параметры.\n\nНастроить отдельно только её? Остальные тренировки не изменятся.\n\nЕсли нужно поменять правила для всех — выберите «Общие параметры».',
        {
            title: 'Параметры тренировки',
            okText: 'Только эту тренировку',
            cancelText: 'Общие параметры',
            danger: false
        }
    );
    if (choice === true) {
        editorUsesPersonalSettings = true;
        document.getElementById("editor-settings-group").open = true;
        updateEditorWorkoutSettingsMode();
        showToast('✅ Параметры только для этой тренировки');
        return;
    }
    if (choice === false) {
        openGlobalWorkoutSettingsFromEditor();
    }
}
function openGlobalWorkoutSettingsFromEditor() {
    try { settingsReturnScreen = 'screen-editor'; } catch(e) {}
    showScreen('screen-settings');
    setTimeout(() => {
        try {
            const g = document.querySelector('#screen-settings details[data-group="strength"]')
                || document.querySelector('#screen-settings details[data-group="workout-preferences"]')
                || document.querySelector('#screen-settings details[data-group="timers"]');
            if (g) { g.open = true; g.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
        } catch(e) {}
    }, 120);
}
function notifySaved(msg) {
    showToast(msg || '✅ Сохранено');
}
function notifyCancelled(msg) {
    showToast(msg || 'Отменено');
}
function closeTopSheetCancel() {
    closeTopSheet();
    notifyCancelled();
}
function renderWorkoutSettingsPriority() { /* персональность на уровне тренировки */ }
function renderSettings() {
    renderWorkoutSettingsPriority();
    document.getElementById('set-wakelock').checked = DB.settings.wakeLock;
    document.getElementById('set-countdown').checked = DB.settings.countdown;
    document.getElementById('set-default-auto').checked = DB.settings.defaultAutoStart;
    document.getElementById('set-continuous-beep').checked = DB.settings.continuousBeep;
    const otsSetEl = document.getElementById('set-overtime-stopwatch');
    if (otsSetEl) otsSetEl.checked = !!DB.settings.overtimeStopwatch;
    const fwSetEl = document.getElementById('set-final-warn');
    if (fwSetEl) fwSetEl.checked = Number(DB.settings.finalWarnSeconds) > 0;
    document.getElementById('set-minute-beep').checked = DB.settings.minuteBeep;
    document.getElementById('set-announce-numbers').checked = DB.settings.announceNumbers;
    const awnSetEl = document.getElementById('set-announce-workout-name');
    if (awnSetEl) awnSetEl.checked = DB.settings.announceWorkoutName !== false;
    const aenSetEl = document.getElementById('set-announce-exercise-name');
    if (aenSetEl) aenSetEl.checked = DB.settings.announceExerciseName !== false;
    const aegSetEl = document.getElementById('set-announce-exercise-goal');
    if (aegSetEl) aegSetEl.checked = DB.settings.announceExerciseGoal !== false;
    const arnSetEl = document.getElementById('set-announce-rest-name');
    if (arnSetEl) arnSetEl.checked = DB.settings.announceRestName !== false;
    document.getElementById('set-show-start-time').checked = DB.settings.showStartTime;
    document.getElementById('set-announce-buttons').checked = DB.settings.announceButtons;
    document.getElementById('set-notify-scheduled').checked = DB.settings.notifyScheduledWorkouts;
    document.getElementById('set-notify-show-completed').checked = DB.settings.notifyShowCompleted;
    const showActivityEl = document.getElementById('set-show-activity');
    if (showActivityEl) showActivityEl.checked = DB.settings.showActivityCalendar !== false;
    const askRepsEl = document.getElementById('set-ask-reps');
    if (askRepsEl) askRepsEl.checked = DB.settings.askReps;
    const askWeightEl = document.getElementById('set-ask-weight');
    if (askWeightEl) askWeightEl.checked = !!DB.settings.askWeight;
    const sleSet = document.getElementById('set-show-last-exercise');
    if (sleSet) sleSet.checked = DB.settings.showLastExercise !== false;
    const afwSet = document.getElementById('set-auto-fill-weight');
    if (afwSet) afwSet.checked = DB.settings.autoFillWeight !== false;
    const afrSet = document.getElementById('set-auto-fill-reps');
    if (afrSet) afrSet.checked = DB.settings.autoFillReps !== false;
    const tprSet = document.getElementById('set-track-prs');
    if (tprSet) tprSet.checked = DB.settings.trackPRs !== false;
    const rwSet = document.getElementById('set-round-weight');
    if (rwSet) rwSet.checked = !!DB.settings.roundWeight;
    const svsSet = document.getElementById('set-show-volume-stats');
    if (svsSet) svsSet.checked = DB.settings.showVolumeStats !== false;
    const lrcSet = document.getElementById('set-large-run-controls');
    if (lrcSet) lrcSet.checked = !!DB.settings.largeRunControls;
    const cskSet = document.getElementById('set-confirm-skip');
    if (cskSet) cskSet.checked = !!DB.settings.confirmSkipExercise;
    const sicSet = document.getElementById('set-share-image-card');
    if (sicSet) sicSet.checked = DB.settings.shareImageCard !== false;
    const backupChk = document.getElementById('set-auto-backup');
    if (backupChk) backupChk.checked = DB.settings.autoBackupReminder;
    const showNavChk = document.getElementById('set-show-bottom-nav');
    if (showNavChk) showNavChk.checked = DB.settings.showBottomNav !== false;
    const cwEl = document.getElementById('set-compact-workouts');
    if (cwEl) cwEl.checked = !!DB.settings.compactWorkouts;
    const sgEl = document.getElementById('set-streak-guard');
    if (sgEl) sgEl.checked = !!DB.settings.streakGuard;
    const sghEl = document.getElementById('set-streak-guard-hour');
    if (sghEl) sghEl.value = String(DB.settings.streakGuardHour || 18);
    const sghRow = document.getElementById('streak-guard-hour-row');
    if (sghRow) sghRow.style.display = DB.settings.streakGuard ? 'flex' : 'none';
    const wdEl = document.getElementById('set-weekly-digest');
    if (wdEl) wdEl.checked = !!DB.settings.weeklyDigest;
    const qhEl = document.getElementById('set-quiet-hours');
    if (qhEl) qhEl.checked = !!DB.settings.quietHours;
    const qsEl = document.getElementById('set-quiet-start');
    if (qsEl) qsEl.value = String(DB.settings.quietHoursStart);
    const qeEl = document.getElementById('set-quiet-end');
    if (qeEl) qeEl.value = String(DB.settings.quietHoursEnd);
    const qhRow = document.getElementById('quiet-hours-row');
    if (qhRow) qhRow.style.display = DB.settings.quietHours ? 'flex' : 'none';
    const vib = document.getElementById('vibration-warning');
    if (vib) vib.style.display = (typeof navigator.vibrate === 'function') ? 'none' : 'flex';
    const hideMapInit = { 'set-hide-templates': 'templates', 'set-hide-programs': 'programs', 'set-hide-activity': 'activity', 'set-hide-history': 'history', 'set-hide-measurements': 'measurements' };
    Object.keys(hideMapInit).forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.checked = DB.settings.hiddenMenuItems.includes(hideMapInit[id]);
        el.onchange = () => {
            const key = hideMapInit[id];
            if (el.checked) { if (!DB.settings.hiddenMenuItems.includes(key)) DB.settings.hiddenMenuItems.push(key); }
            else DB.settings.hiddenMenuItems = DB.settings.hiddenMenuItems.filter(k => k !== key);
            saveDB('settings');
            applyHomeMenuVisibility();
        };
    });
    const hideNavMapInit = { 'set-hide-nav-templates': 'templates', 'set-hide-nav-programs': 'programs', 'set-hide-nav-activity': 'activity', 'set-hide-nav-history': 'history', 'set-hide-nav-measurements': 'measurements' };
    Object.keys(hideNavMapInit).forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.checked = DB.settings.hiddenBottomNavItems.includes(hideNavMapInit[id]);
        el.onchange = () => {
            const key = hideNavMapInit[id];
            if (el.checked) { if (!DB.settings.hiddenBottomNavItems.includes(key)) DB.settings.hiddenBottomNavItems.push(key); }
            else DB.settings.hiddenBottomNavItems = DB.settings.hiddenBottomNavItems.filter(k => k !== key);
            saveDB('settings');
            applyHomeMenuVisibility();
        };
    });
    renderThemeModeOptions(); renderFontSizeOptions(); renderSoundModeOptions(); renderSoundOptions(); renderVoiceOptions(); renderVoiceRateOptions(); renderMinuteBeepOptions(); renderCountdownIntervals(); renderFinalWarnOptions(); renderSnoozeDurationOptions();
    updateAnnounceVisibility(); updateBackupInfo(); updateErrorLogInfo();
    document.querySelectorAll('#screen-settings .settings-group').forEach(group => {
        const key = group.dataset.group;
        if (!key) return;
        if (DB.settings.accordions && DB.settings.accordions[key] !== undefined) group.open = DB.settings.accordions[key];
        if (group.dataset.accBound === '1') return;
        group.dataset.accBound = '1';
        group.addEventListener('toggle', () => { DB.settings.accordions = DB.settings.accordions || {}; DB.settings.accordions[key] = group.open; Storage.set('ft_settings', DB.settings); });
    });
    const map = {
        'set-wakelock': 'wakeLock', 'set-countdown': 'countdown', 'set-default-auto': 'defaultAutoStart',
        'set-continuous-beep': 'continuousBeep', 'set-overtime-stopwatch': 'overtimeStopwatch', 'set-final-warn': '_finalWarnToggle', 'set-minute-beep': 'minuteBeep',
        'set-announce-numbers': 'announceNumbers', 'set-announce-workout-name': 'announceWorkoutName',
        'set-announce-exercise-name': 'announceExerciseName', 'set-announce-exercise-goal': 'announceExerciseGoal', 'set-announce-rest-name': 'announceRestName',
        'set-show-start-time': 'showStartTime', 'set-announce-buttons': 'announceButtons',
        'set-notify-scheduled': 'notifyScheduledWorkouts', 'set-notify-show-completed': 'notifyShowCompleted',
        'set-show-activity': 'showActivityCalendar', 'set-auto-backup': 'autoBackupReminder', 'set-ask-reps': 'askReps', 'set-ask-weight': 'askWeight',
        'set-show-last-exercise': 'showLastExercise', 'set-auto-fill-weight': 'autoFillWeight', 'set-auto-fill-reps': 'autoFillReps', 'set-track-prs': 'trackPRs', 'set-share-image-card': 'shareImageCard',
        'set-round-weight': 'roundWeight', 'set-show-volume-stats': 'showVolumeStats', 'set-large-run-controls': 'largeRunControls', 'set-confirm-skip': 'confirmSkipExercise',
        'set-show-bottom-nav': 'showBottomNav', 'set-compact-workouts': 'compactWorkouts',
        'set-streak-guard': 'streakGuard', 'set-weekly-digest': 'weeklyDigest', 'set-quiet-hours': 'quietHours'
    };
    Object.keys(map).forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.onchange = () => {
            if (id === 'set-final-warn') {
                if (el.checked) {
                    if (![5,10,15,20,30].includes(Number(DB.settings.finalWarnSeconds))) DB.settings.finalWarnSeconds = 5;
                } else {
                    DB.settings.finalWarnSeconds = 0;
                }
                saveDB('settings');
                renderFinalWarnOptions();
                return;
            }
            DB.settings[map[id]] = el.checked;
            saveDB('settings');
            if (id === 'set-notify-scheduled' && el.checked) { try { localStorage.removeItem(NOTIF_DISMISSED_KEY); } catch(e) {} }
            if (id === 'set-continuous-beep') renderSoundOptions();
            if (id === 'set-minute-beep') renderMinuteBeepOptions();
            if (id === 'set-countdown') renderCountdownIntervals();
            if (id === 'set-show-activity') renderStreakBanner();
            if (id === 'set-show-bottom-nav') { applyNavVisibility(); updateNotifGrabber(); }
            if (id === 'set-notify-scheduled') { updateNotifGrabber(); }
            if (id === 'set-wakelock') { if (DB.settings.wakeLock) { if (runState && runState.phase !== 'finish') acquireWakeLock(); } else releaseWakeLock(); }
            if (id === 'set-compact-workouts') applyCompactWorkouts();
            if (id === 'set-streak-guard') { const row = document.getElementById('streak-guard-hour-row'); if (row) row.style.display = el.checked ? 'flex' : 'none'; }
            if (id === 'set-quiet-hours') { const row = document.getElementById('quiet-hours-row'); if (row) row.style.display = el.checked ? 'flex' : 'none'; }
        };
    });
    const sgHour = document.getElementById('set-streak-guard-hour');
    if (sgHour) sgHour.onchange = () => { DB.settings.streakGuardHour = parseInt(sgHour.value) || 18; saveDB('settings'); };
    const qsSel = document.getElementById('set-quiet-start');
    if (qsSel) qsSel.onchange = () => { DB.settings.quietHoursStart = parseInt(qsSel.value); saveDB('settings'); };
    const qeSel = document.getElementById('set-quiet-end');
    if (qeSel) qeSel.onchange = () => { DB.settings.quietHoursEnd = parseInt(qeSel.value); saveDB('settings'); };
}
function updateBackupInfo() {
    const el = document.getElementById('last-backup-info');
    if (!el) return;
    if (DB.settings.lastBackupAt) { el.textContent = `Последний: ${formatDate(new Date(DB.settings.lastBackupAt))}`; }
    else { el.textContent = 'Ещё не делался'; }
}
function updateAnnounceVisibility() {
    const voiceOn = DB.settings.soundMode === 'voice';
    const el = document.getElementById('announce-buttons-row');
    if (el) el.classList.toggle('disabled', !voiceOn);
    document.querySelectorAll('#screen-settings .announce-opt-row').forEach(row => {
        row.classList.toggle('disabled', !voiceOn);
    });
    const hint = document.getElementById('settings-announce-voice-hint');
    if (hint) hint.style.display = voiceOn ? 'none' : 'block';
}
function updateWorkoutAnnounceHint() {
    const smEl = document.getElementById('workout-sound-mode');
    const hint = document.getElementById('workout-announce-voice-hint');
    // In global priority mode the workout sound selector is disabled — show hint based on global mode
    const globalMode = DB.settings.workoutSettingsPriority !== 'workout';
    const mode = globalMode
        ? (DB.settings.soundMode === 'voice' ? 'voice' : 'beep')
        : ((smEl && smEl.value === 'voice') ? 'voice' : 'beep');
    const voiceOn = mode === 'voice';
    if (hint) hint.style.display = voiceOn ? 'none' : 'block';
    // Dim/disable announce checkboxes when not in voice mode (same UX as global settings)
    const announceIds = [
        'workout-announce-numbers',
        'workout-announce-workout-name',
        'workout-announce-exercise-name',
        'workout-announce-exercise-goal',
        'workout-announce-rest-name'
    ];
    announceIds.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        const row = el.closest('.checkbox-row');
        if (row) row.classList.toggle('disabled', !voiceOn);
        // Don't force-disable the input if the whole editor is in global-priority mode
        // (setWorkoutSettingsFieldsDisabled already handles that). Only dim when voice is off.
        if (!globalMode) el.disabled = !voiceOn;
    });
}
function renderSoundModeOptions() {
    const c = document.getElementById('sound-mode-options');
    if (!c) return;
    const modes = [{ v: 'voice', name: '🗣 Озвучивать', desc: 'Голосом' }, { v: 'beep', name: '🔔 Пикать', desc: 'Короткие сигналы' }];
    c.innerHTML = modes.map(m => { const sel = DB.settings.soundMode === m.v; return `<div class="sound-option ${sel ? 'selected' : ''}" onclick="selectSoundMode('${m.v}')"><div class="radio"></div><div class="sound-info"><div class="sound-name">${m.name}</div><div class="sound-desc">${m.desc}</div></div></div>`; }).join('');
    updateAnnounceVisibility();
}
function selectSoundMode(mode) {
    if (!['voice','beep'].includes(mode)) return;
    DB.settings.soundMode = mode;
    saveDB('settings');
    renderSoundModeOptions();
    try { updateWorkoutAnnounceHint(); } catch(e) {}
}
function renderSoundOptions() {
    const c = document.getElementById('sound-options');
    c.innerHTML = Object.keys(ALARM_SOUNDS).map(k => { const s = ALARM_SOUNDS[k]; const sel = DB.settings.alarmSound === k; return `<div class="sound-option ${sel ? 'selected' : ''}" onclick="selectAlarmSound('${k}')"><div class="radio"></div><div class="sound-info"><div class="sound-name">${s.name}</div><div class="sound-desc">${s.desc}</div></div><button class="preview-btn" onclick="event.stopPropagation(); previewAlarmSound('${k}')" aria-label="Прослушать">▶</button></div>`; }).join('');
}
function selectAlarmSound(k) { DB.settings.alarmSound = k; saveDB('settings'); renderSoundOptions(); }
function renderMinuteBeepOptions() {
    const c = document.getElementById('minute-beep-options');
    c.style.display = DB.settings.minuteBeep ? 'block' : 'none';
    document.getElementById('minute-beep-interval-options').innerHTML = MINUTE_BEEP_INTERVALS.map(o => { const sel = DB.settings.minuteBeepInterval === o.v; return `<div class="sound-option ${sel ? 'selected' : ''}" onclick="selectMinuteBeepInterval(${o.v})"><div class="radio"></div><div class="sound-info"><div class="sound-name">${o.t}</div></div></div>`; }).join('');
}
function selectMinuteBeepInterval(v) { DB.settings.minuteBeepInterval = v; saveDB('settings'); renderMinuteBeepOptions(); }
function renderCountdownIntervals() {
    const c = document.getElementById('countdown-interval-options');
    c.style.display = DB.settings.countdown ? 'block' : 'none';
    document.getElementById('countdown-interval-list').innerHTML = COUNTDOWN_INTERVALS.map(o => { const sel = DB.settings.countdownDuration === o.v; return `<div class="sound-option ${sel ? 'selected' : ''}" onclick="selectCountdownInterval(${o.v})"><div class="radio"></div><div class="sound-info"><div class="sound-name">${o.t}</div></div></div>`; }).join('');
}
function selectCountdownInterval(v) { DB.settings.countdownDuration = v; saveDB('settings'); renderCountdownIntervals(); }
const FINAL_WARN_INTERVALS = [
    { v: 5, t: '5 секунд' },
    { v: 10, t: '10 секунд' },
    { v: 15, t: '15 секунд' },
    { v: 20, t: '20 секунд' },
    { v: 30, t: '30 секунд' }
];
function renderFinalWarnOptions() {
    const wrap = document.getElementById('final-warn-options');
    const list = document.getElementById('final-warn-seconds-list');
    const enabled = Number(DB.settings.finalWarnSeconds) > 0;
    if (wrap) wrap.style.display = enabled ? 'block' : 'none';
    if (!list) return;
    const cur = [5,10,15,20,30].includes(Number(DB.settings.finalWarnSeconds)) ? Number(DB.settings.finalWarnSeconds) : 5;
    list.innerHTML = FINAL_WARN_INTERVALS.map(o => {
        const sel = cur === o.v;
        return `<div class="sound-option ${sel ? 'selected' : ''}" onclick="selectFinalWarnSeconds(${o.v})"><div class="radio"></div><div class="sound-info"><div class="sound-name">${o.t}</div></div></div>`;
    }).join('');
}
function selectFinalWarnSeconds(v) {
    if (![5,10,15,20,30].includes(Number(v))) return;
    DB.settings.finalWarnSeconds = Number(v);
    saveDB('settings');
    const fw = document.getElementById('set-final-warn');
    if (fw) fw.checked = true;
    renderFinalWarnOptions();
}
function _markBackupDone() {
    DB.settings.lastBackupAt = Date.now();
    DB.settings.lastBackupRecordCount = DB.history.length;
    saveDB('settings');
    try { updateBackupInfo(); } catch(e) {}
}
function _downloadJsonBlob(obj, filename) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
}
async function exportData() {
    try {
        const payload = { workouts: DB.workouts, templates: DB.templates, programs: DB.programs, history: DB.history, measurements: DB.measurements, settings: DB.settings, exportedAt: new Date().toISOString() };
        const password = await askBackupPassword({ mode: 'encrypt', title: 'Пароль для бэкапа', info: 'Файл будет зашифрован. Пароль понадобится при импорте.', confirmText: '🔒 Зашифровать' });
        if (!password) return;
        let envelope;
        try { envelope = await encryptBackupData(JSON.stringify(payload), password); }
        catch(e) { showToast('Ошибка шифрования: ' + (e.message || e), 4000); return; }
        _downloadJsonBlob(envelope, `fit-trainer-backup-${new Date().toISOString().slice(0,10)}.enc.json`);
        _markBackupDone();
        showToast('💾 Бэкап сохранён', 3500);
    } catch(e) { showToast('Ошибка: ' + (e.message || e), 4000); }
}
/** Полный бэкап без пароля — удобно для личного архива. */
async function exportDataPlain() {
    try {
        const ok = await customConfirm('Сохранить бэкап БЕЗ пароля?\n\nФайл можно открыть любым редактором. Не отправляйте его посторонним.', {
            title: 'Бэкап без пароля', okText: '📄 Скачать JSON', cancelText: 'Отмена', danger: false
        });
        if (!ok) return;
        const payload = {
            type: 'fit-trainer-backup',
            workouts: DB.workouts, templates: DB.templates, programs: DB.programs,
            history: DB.history, measurements: DB.measurements, settings: DB.settings,
            exportedAt: new Date().toISOString()
        };
        _downloadJsonBlob(payload, `fit-trainer-backup-${new Date().toISOString().slice(0,10)}.json`);
        _markBackupDone();
        showToast('📄 JSON-бэкап сохранён', 3500);
    } catch (e) { showToast('Ошибка: ' + (e.message || e), 4000); }
}
function importData(event) {
    const file = event.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = async e => {
        try {
            const data = JSON.parse(e.target.result);
            const ok = await customConfirm(`Импортировать данные?\nТренировок: ${data.workouts?.length || 0}\nШаблонов: ${data.templates?.length || 0}\nПрограмм: ${data.programs?.length || 0}\nЗаписей: ${data.history?.length || 0}\nЗамеров: ${data.measurements?.length || 0}\n\nТекущие данные будут ЗАМЕНЕНЫ.`, { title: 'Импорт данных', okText: '📥 Импортировать', danger: true });
            if (!ok) return;
            if (data.workouts && Array.isArray(data.workouts)) DB.workouts = data.workouts;
            if (data.templates && Array.isArray(data.templates)) DB.templates = data.templates;
            if (data.programs && Array.isArray(data.programs)) DB.programs = data.programs;
            if (data.history && Array.isArray(data.history)) DB.history = data.history;
            if (data.measurements && Array.isArray(data.measurements)) DB.measurements = data.measurements;
            if (data.settings) { DB.settings = Object.assign(DB.settings, data.settings); if ('announceConfirm' in DB.settings) delete DB.settings.announceConfirm; }
            if (!Array.isArray(DB.settings.hiddenBuiltins)) DB.settings.hiddenBuiltins = [];
            if (DB.settings.soundMode !== 'voice' && DB.settings.soundMode !== 'beep') DB.settings.soundMode = 'beep';
            if ('voice' in DB.settings) delete DB.settings.voice;
            if (!['auto','light','dark'].includes(DB.settings.themeMode)) DB.settings.themeMode = 'auto';
            if (![0.8,1,1.3].includes(DB.settings.voiceRate)) DB.settings.voiceRate = 1;
            if (typeof DB.settings.autoBackupReminder !== 'boolean') DB.settings.autoBackupReminder = true;
            if (typeof DB.settings.lastBackupAt !== 'number') DB.settings.lastBackupAt = 0;
            if (typeof DB.settings.lastBackupRecordCount !== 'number') DB.settings.lastBackupRecordCount = 0;
            if (typeof DB.settings.askReps !== 'boolean') DB.settings.askReps = true;
            if (typeof DB.settings.askWeight !== 'boolean') DB.settings.askWeight = false;
            if (typeof DB.settings.showLastExercise !== 'boolean') DB.settings.showLastExercise = true;
            if (typeof DB.settings.autoFillWeight !== 'boolean') DB.settings.autoFillWeight = true;
            if (typeof DB.settings.autoFillReps !== 'boolean') DB.settings.autoFillReps = true;
            if (typeof DB.settings.trackPRs !== 'boolean') DB.settings.trackPRs = true;
            if (typeof DB.settings.shareImageCard !== 'boolean') DB.settings.shareImageCard = true;
            if ('weightUnit' in DB.settings) delete DB.settings.weightUnit;
            if (typeof DB.settings.announceWorkoutName !== 'boolean') DB.settings.announceWorkoutName = true;
            if (typeof DB.settings.announceExerciseName !== 'boolean') DB.settings.announceExerciseName = true;
            if (typeof DB.settings.announceExerciseGoal !== 'boolean') DB.settings.announceExerciseGoal = true;
            if (typeof DB.settings.announceRestName !== 'boolean') DB.settings.announceRestName = true;
            if (typeof DB.settings.showActivityCalendar !== 'boolean') DB.settings.showActivityCalendar = true;
            if (typeof DB.settings.notifyScheduledWorkouts !== 'boolean') DB.settings.notifyScheduledWorkouts = true;
            if (typeof DB.settings.notifyShowCompleted !== 'boolean') DB.settings.notifyShowCompleted = true;
            if (typeof DB.settings.showBottomNav !== 'boolean') DB.settings.showBottomNav = true;
            if (!DB.settings.accordions || typeof DB.settings.accordions !== 'object') DB.settings.accordions = {};
            if (!DB.settings.dismissedUntil || typeof DB.settings.dismissedUntil !== 'object' || Array.isArray(DB.settings.dismissedUntil)) DB.settings.dismissedUntil = {};
            if (typeof DB.settings.lastNotifAutoShow !== 'string') DB.settings.lastNotifAutoShow = '';
            if (![1,2,3,4,24].includes(DB.settings.snoozeDuration)) DB.settings.snoozeDuration = 2;
            if (!Array.isArray(DB.settings.hiddenMenuItems)) DB.settings.hiddenMenuItems = [];
            DB.settings.hiddenMenuItems = DB.settings.hiddenMenuItems.filter(k => HIDEABLE_MENU_KEYS.includes(k));
            if (!Array.isArray(DB.settings.hiddenBottomNavItems)) DB.settings.hiddenBottomNavItems = [];
            DB.settings.hiddenBottomNavItems = DB.settings.hiddenBottomNavItems.filter(k => HIDEABLE_MENU_KEYS.includes(k));
            if (!['small','normal','large'].includes(DB.settings.fontSizeMode)) DB.settings.fontSizeMode = 'normal';
            if (typeof DB.settings.highContrast !== 'boolean') DB.settings.highContrast = false;
            if (typeof DB.settings.compactWorkouts !== 'boolean') DB.settings.compactWorkouts = false;
            if (typeof DB.settings.streakGuard !== 'boolean') DB.settings.streakGuard = true;
            if (typeof DB.settings.streakGuardHour !== 'number') DB.settings.streakGuardHour = 18;
            if (typeof DB.settings.weeklyDigest !== 'boolean') DB.settings.weeklyDigest = true;
            if (typeof DB.settings.quietHours !== 'boolean') DB.settings.quietHours = false;
            if (typeof DB.settings.quietHoursStart !== 'number') DB.settings.quietHoursStart = 22;
            if (typeof DB.settings.quietHoursEnd !== 'number') DB.settings.quietHoursEnd = 8;
            if (typeof DB.settings.programsCalendarCollapsed !== 'boolean') DB.settings.programsCalendarCollapsed = false;
            if (typeof DB.settings.builtinTemplatesCollapsed !== 'boolean') DB.settings.builtinTemplatesCollapsed = false;
            if (typeof DB.settings.weekMetric !== 'string') DB.settings.weekMetric = 'work';
            if (![4,8,12].includes(DB.settings.weekRange)) DB.settings.weekRange = 8;
            if (typeof DB.settings.homeStreakCollapsed !== 'boolean') DB.settings.homeStreakCollapsed = false;
            if (typeof DB.settings.homePlanCollapsed !== 'boolean') DB.settings.homePlanCollapsed = false;
            if (typeof DB.settings.quickStartCollapsed !== 'boolean') DB.settings.quickStartCollapsed = false;
            saveDB('workouts'); saveDB('templates'); saveDB('programs'); saveDB('history'); saveDB('measurements'); saveDB('settings');
            validateAndMigrateDB();
            applyTheme(); applyFontSize(); applyCompactWorkouts(); applyHomeMenuVisibility();
            invalidateActivityCache();
            showToast('Импорт успешен');
            showScreen('screen-home');
        } catch(err) { showToast('Ошибка: ' + err.message); }
    };
    reader.readAsText(file);
    event.target.value = '';
}
function checkAutoBackupReminder() {
    if (!DB.settings.autoBackupReminder) return;
    if (!DB.history.length) return;
    if (loadSavedRunState()) return;
    if (runState) return;
    if (isQuietHours()) return;
    const lastAt = DB.settings.lastBackupAt || 0;
    const lastCount = DB.settings.lastBackupRecordCount || 0;
    const sinceCount = DB.history.length - lastCount;
    const sinceDays = lastAt > 0 ? (Date.now() - lastAt) / (1000 * 60 * 60 * 24) : 0;
    let reason = '', due = false;
    if (lastAt === 0) { if (DB.history.length >= 5) { due = true; reason = `${DB.history.length} тренировок, ни одного бэкапа`; } }
    else { if (sinceCount >= 20) { due = true; reason = `${sinceCount} новых тренировок`; } else if (sinceDays >= 7) { due = true; reason = `${Math.floor(sinceDays)} дней`; } }
    if (!due) return;
    setTimeout(() => showBackupReminder(reason), 2500);
}
function showBackupReminder(reason) {
    if (!DB.settings.autoBackupReminder) return;
    if (document.getElementById('backup-reminder-overlay')) return;
    if (hasOpenOverlay()) return;
    const ov = document.createElement('div');
    ov.className = 'notif-side-overlay';
    ov.id = 'backup-reminder-overlay';
    ov.innerHTML = `<div class="notif-side-sheet"><div class="notif-side-grabber"><div class="notif-side-grabber-bar"></div></div><div class="sheet-icon">💾</div><h2 class="sheet-title">Пора сделать бэкап</h2><div class="sheet-info"><div class="sheet-info-name">Прошло: ${escapeHtml(reason)}</div><div class="sheet-info-details">Сохраните данные, чтобы не потерять прогресс.</div></div><button class="btn accent" onclick="doBackupAndClose(this)">💾 Сделать бэкап</button><button class="btn ghost" onclick="snoozeBackup(this)">Позже</button><button class="btn notif-dismiss" style="background:transparent;color:var(--muted);font-size:0.85rem;" onclick="disableBackupReminder(this)">Отключить напоминания</button></div>`;
    document.body.appendChild(ov);
    setupSideSwipe(ov.querySelector('.notif-side-sheet'), ov);
    ov.addEventListener('click', (e) => { if (e.target === ov) ov.remove(); });
}
function doBackupAndClose(btn) { try { exportData(); } catch(e) { console.error(e); } const ov = btn.closest('.notif-side-overlay'); if (ov) ov.remove(); updateNotifGrabber(); }
function snoozeBackup(btn) {
    DB.settings.lastBackupAt = Date.now() - (4 * 24 * 60 * 60 * 1000);
    DB.settings.lastBackupRecordCount = DB.history.length - 5;
    saveDB('settings');
    try { updateBackupInfo(); } catch(e) {}
    const ov = btn.closest('.notif-side-overlay');
    if (ov) ov.remove(); updateNotifGrabber();
    showToast('Напомним позже');
}
function disableBackupReminder(btn) {
    DB.settings.autoBackupReminder = false;
    saveDB('settings');
    const ov = btn.closest('.notif-side-overlay');
    if (ov) ov.remove(); updateNotifGrabber();
    try { renderSettings(); } catch(e) {}
    showToast('Напоминания отключены');
}
const NOTIF_DISMISSED_KEY = 'ft_notif_dismissed';
function checkScheduledNotifications() {
    if (runState) return;
    if (hasOpenOverlay()) return;
    if (isQuietHours()) return;
    cleanupDismissedNotifications();
    updateNotifGrabber();
    const todayKey = formatDateKey(new Date());
    if (DB.settings.lastNotifAutoShow === todayKey) return;
    const visible = getVisibleNotifications();
    if (visible.length === 0) return;
    DB.settings.lastNotifAutoShow = todayKey;
    saveDB('settings');
    // Log appearance
    visible.forEach(n => logNotifHistory({ type: 'show', key: n.key, title: n.title }));
    // Prefer specific dialog for streak
    const streak = visible.find(n => n.type === 'streak');
    if (streak) {
        offerStreakGuard(streak);
        return;
    }
    openNotifCenter();
}
async function offerStreakGuard(notif) {
    if (hasOpenOverlay()) return;
    const streakMatch = (notif.title || '').match(/(\d+)/);
    const days = streakMatch ? streakMatch[1] : '';
    const msg = days
        ? `У вас серия из ${days} ${pluralDays(parseInt(days))} подряд!\n\nСегодня ещё не было тренировки.\nЕсли не потренируетесь — стрик сгорит.\n\nЧто делаем?`
        : `Сегодня ещё не было активности.\nСерия под угрозой.\n\nЧто делаем?`;
    const ok = await customConfirm(msg, {
        title: '🔥 Стрик-гард',
        okText: 'Понятно',
        cancelText: 'Закрыть напоминание',
        danger: false
    });
    if (ok === false) {
        // dismiss
        DB.settings.dismissedUntil = DB.settings.dismissedUntil || {};
        DB.settings.dismissedUntil[notif.key] = Date.now() + 7 * 24 * 60 * 60 * 1000;
        saveDB('settings');
        logNotifHistory({ type: 'dismiss', key: notif.key, title: notif.title });
        updateNotifGrabber();
        showToast('🔕 Напоминание о стрике закрыто');
    } else {
        // just acknowledge, keep in notifs
        updateNotifGrabber();
        // optionally open center if other notifs
        const others = getVisibleNotifications().filter(n => n.key !== notif.key);
        if (others.length > 0) openNotifCenter();
    }
}
document.addEventListener('touchstart', (e) => {
    const sheet = e.target.closest('.notif-side-sheet');
    if (!sheet) return;
    const grip = e.target.closest('.notif-side-grabber');
    if (!grip && sheet.scrollTop > 0) return;
    let startX = e.touches[0].clientX;
    let dx = 0;
    let dragging = false;
    const overlay = sheet.parentElement;
    const onMove = (ev) => {
        const current = ev.touches[0].clientX;
        dx = current - startX;
        if (dx < 0) dx = 0;
        if (dx > 4) dragging = true;
        if (dragging) { sheet.style.transition = 'none'; sheet.style.transform = `translateX(${dx}px)`; if (overlay) overlay.style.background = `rgba(0,0,0,${Math.max(0, 0.5 - dx/500)})`; }
    };
    const onEnd = () => {
        document.removeEventListener('touchmove', onMove);
        document.removeEventListener('touchend', onEnd);
        sheet.style.transition = 'transform 0.2s ease-out';
        if (overlay) overlay.style.background = '';
        if (dx > 100) {
            sheet.style.transform = `translateX(100%)`;
            if (overlay) overlay.style.opacity = '0';
            // Важно: если это диалог ввода повторов/веса — резолвим промис, иначе зависает finishExercise
            let handled = false;
            try {
                if (overlay && typeof overlay._ftOnDismiss === 'function') {
                    overlay._ftOnDismiss();
                    handled = true;
                }
            } catch(e) {}
            if (!handled) {
                setTimeout(() => { try { if (overlay && overlay.parentNode) overlay.remove(); } catch(e) {} updateNotifGrabber(); }, 200);
            }
        }
        else { sheet.style.transform = ''; }
        startX = 0; dx = 0; dragging = false;
    };
    document.addEventListener('touchmove', onMove, { passive: true });
    document.addEventListener('touchend', onEnd);
}, { passive: true });

(function setupPullToRefresh() {
    const appContainer = document.querySelector('.app-container');
    if (!appContainer) return;
    let indicator = document.getElementById('ptr-indicator');
    if (!indicator) {
        indicator = document.createElement('div');
        indicator.id = 'ptr-indicator';
        indicator.className = 'ptr-indicator';
        indicator.textContent = 'Потяните';
        document.body.appendChild(indicator);
    }
    let startY = 0, pulling = false, threshold = 90;
    function canPull() {
        // Не мешаем тренировке и оверлеям
        if (document.querySelector('.notif-side-overlay, .bottom-sheet-overlay, .multi-tab-warning')) return false;
        const run = document.getElementById('screen-run');
        if (run && run.classList.contains('active')) return false;
        return appContainer.scrollTop <= 2;
    }
    function refreshActiveScreen() {
        const active = document.querySelector('.screen.active');
        if (!active) return;
        const id = active.id;
        try {
            if (id === 'screen-home') {
                if (typeof ensureNoStuckRunState === 'function') ensureNoStuckRunState();
                renderStreakBanner(); renderHomeTodayBanner(); applyHomeMenuVisibility();
                if (typeof applyQuickStartCollapsed === 'function') applyQuickStartCollapsed();
                updateFooter(); updateNotifGrabber();
            } else if (id === 'screen-history') renderHistory();
            else if (id === 'screen-activity') renderActivity();
            else if (id === 'screen-workouts') renderWorkoutsList();
            else if (id === 'screen-measurements') renderMeasurements();
            else if (id === 'screen-programs') renderPrograms();
            else if (id === 'screen-templates') renderTemplates();
            else if (id === 'screen-settings') { if (typeof renderSettings === 'function') renderSettings(); }
            else if (id === 'screen-editor') { /* не сбрасываем редактор */ }
            else if (id === 'screen-run') { if (typeof renderRun === 'function') renderRun(); }
        } catch (err) { console.error('[ptr]', err); }
    }
    appContainer.addEventListener('touchstart', (e) => {
        if (canPull()) { startY = e.touches[0].clientY; pulling = true; }
        else pulling = false;
    }, { passive: true });
    appContainer.addEventListener('touchmove', (e) => {
        if (!pulling) return;
        const dy = e.touches[0].clientY - startY;
        if (dy > 36) {
            indicator.classList.add('active');
            indicator.classList.remove('refreshing');
            // Короткие фразы — всегда в одну строку
            indicator.textContent = dy > threshold ? 'Отпустите для обновления' : 'Потяните для обновления';
        } else {
            indicator.classList.remove('active');
        }
    }, { passive: true });
    appContainer.addEventListener('touchend', (e) => {
        if (!pulling) return;
        pulling = false;
        const dy = e.changedTouches[0].clientY - startY;
        if (dy > threshold) {
            indicator.classList.add('active', 'refreshing');
            indicator.textContent = 'Обновляем…';
            refreshActiveScreen();
            (async () => {
                const updateResult = await checkForAppUpdate();
                if (updateResult === 'waiting') {
                    indicator.textContent = 'Устанавливаем обновление…';
                    // Сначала подписываемся на смену worker, затем отправляем SKIP_WAITING.
                    // Так не пропускаем controllerchange и не перезагружаем старую версию.
                    let reloaded = false;
                    const onControllerChange = () => {
                        if (reloaded || !isSafeToApplyAppUpdate()) return;
                        reloaded = true;
                        navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
                        setTimeout(() => location.reload(), 250);
                    };
                    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
                    const activated = await activateWaitingAppUpdate();
                    if (!activated) navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
                    setTimeout(() => {
                        if (!reloaded) navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
                    }, 10000);
                } else if (updateResult === 'deferred') {
                    indicator.textContent = 'Обновление отложено до завершения работы';
                } else if (updateResult === 'offline') {
                    indicator.textContent = 'Данные обновлены · нет связи для проверки версии';
                } else if (updateResult === 'unavailable') {
                    indicator.textContent = 'Данные экрана обновлены';
                } else {
                    indicator.textContent = 'Данные обновлены · версия актуальна';
                }
                setTimeout(() => {
                    indicator.classList.remove('refreshing', 'active');
                    indicator.textContent = 'Потяните для обновления';
                }, updateResult === 'waiting' ? 1800 : 1400);
            })();
        } else {
            indicator.classList.remove('active', 'refreshing');
            indicator.textContent = 'Потяните для обновления';
        }
    }, { passive: true });
})();

document.addEventListener('click', unlockAudio, { capture: true });
document.addEventListener('touchstart', unlockAudio, { capture: true, passive: true });
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        hiddenAt = 0;
        if ((DB.settings.themeMode || 'auto') === 'auto') applyTheme();
        if (runState && runState.phase !== 'finish') {
            if (DB.settings.wakeLock) acquireWakeLock();
            // Перезапуск тикера + мгновенный пересчёт по wall-clock (не «отстаёт» после фона)
            try { restartTicker(); } catch (e) { try { ensureTicker(); updateTimersUI(); } catch (e2) {} }
            saveRunState();
        }
        updateFooter();
        if (document.getElementById('screen-home').classList.contains('active')) { try { renderHomeTodayBanner(); renderStreakBanner(); } catch(e) {} }
        updateNotifGrabber();
    } else {
        hiddenAt = Date.now();
        if (runState && runState.phase !== 'finish') {
            try { restartTicker(); } catch (e) {}
            saveRunState();
        }
    }
});

if ('speechSynthesis' in window) {
    try { refreshVoices(); if (speechSynthesis.onvoiceschanged !== undefined) speechSynthesis.onvoiceschanged = () => refreshVoices(); } catch(e) {}
}
try {
    applyTheme();
    try {
        const mq = window.matchMedia('(prefers-color-scheme: light)');
        if (mq && mq.addEventListener) mq.addEventListener('change', () => { if ((DB.settings.themeMode || 'auto') === 'auto') applyTheme(); });
    } catch(e) {}
} catch(e) {}
try { applyFontSize(); applyCompactWorkouts(); } catch(e) {}

function openFinishedWorkoutMenu() {
    if (!runState || runState.phase !== 'finish' || hasOpenOverlay()) return;
    const workoutId = runState.workout && runState.workout.id;
    const record = DB.history.find(r => r.id === runState.finishRecordId) ||
        [...DB.history].reverse().find(r => r.workoutId === workoutId);
    const recordId = record ? record.id : null;
    const ov = document.createElement('div');
    ov.className = 'notif-side-overlay action-menu-overlay';
    ov.innerHTML = `<div class="notif-side-sheet">
        <div class="notif-side-grabber"><div class="notif-side-grabber-bar"></div></div>
        <h2 class="sheet-title">Действия с тренировкой</h2>
        ${recordId ? `<button class="btn accent" onclick="closeTopSheet(); shareResult(${recordId});">📤 Поделиться результатом</button>` : ''}
        <button class="btn ghost" onclick="closeTopSheet(); saveCurrentRunAsTemplate();">💾 Сохранить как шаблон</button>
        <button class="btn ghost" onclick="closeTopSheet(); repeatLastWorkout(${Number(workoutId) || 0});">🔁 Повторить тренировку</button>
        <button class="btn ghost" onclick="closeTopSheet(); goAfterRunEnd();">← Назад</button>
        <button class="btn ghost" onclick="closeTopSheet(); showScreen('screen-home');">🏠 На главную</button>
        <button class="btn sheet-btn-cancel" onclick="closeTopSheet()">Закрыть</button>
    </div>`;
    decorateActionMenu(ov, 'Итоги тренировки');
    document.body.appendChild(ov);
    setupSideSwipe(ov.querySelector('.notif-side-sheet'), ov);
    ov.addEventListener('click', (e) => { if (e.target === ov) closeTopSheet(); });
}

function openRunMenu() {
    if (!runState) return;
    if (hasOpenOverlay()) return;
    if (runState.phase === 'finish') { openFinishedWorkoutMenu(); return; }
    if (finishExerciseInProgress || runState.setFinishing) return;

    pauseRunForSettings();
    function resumeTimersFromMenu() { resumeRunAfterSettings(); setTimeout(() => { if (runState && !runState._menuOpen && runState.phase === "ready" && runState.workout.autoStart) beginCurrentElementFlow(true); }, 0); }

    const ov = document.createElement('div');
    ov.className = 'notif-side-overlay action-menu-overlay';
    ov.innerHTML = `<div class="notif-side-sheet">
        <div class="notif-side-grabber"><div class="notif-side-grabber-bar"></div></div>
        <h2 class="sheet-title">Управление тренировкой</h2>
        <button class="btn ghost" onclick="closeTopSheet(); openLiveEditor();">✏️ Редактировать тренировку</button>
        <button class="btn ghost" onclick="closeTopSheet(); openRunQueueEditor();">Изменить порядок</button>
        <button class="btn ghost" onclick="closeTopSheet(); pauseRunForSettings(); openGlobalSettingsFrom('screen-run');">⚙️ Общие настройки</button>
        <button class="btn accent" onclick="closeTopSheet(); finishWorkoutEarly();">Завершить сейчас</button>
        <button class="btn danger" onclick="closeTopSheet(); cancelWorkout();">✕ Отменить тренировку</button>
        <button class="btn sheet-btn-cancel" onclick="closeTopSheet()">Закрыть</button>
    </div>`;
    decorateActionMenu(ov, 'Тренировка');
    document.body.appendChild(ov);
    setupSideSwipe(ov.querySelector('.notif-side-sheet'), ov, () => { resumeTimersFromMenu(); });
    ov.addEventListener('click', (e) => { if (e.target === ov) { resumeTimersFromMenu(); ov.remove(); } });
    const origClose = window.closeTopSheet;
    window.closeTopSheet = function() {
        if (ov && document.body.contains(ov)) {
            resumeTimersFromMenu();
            ov.remove();
            window.closeTopSheet = origClose;
            updateNotifGrabber();
            return;
        }
        origClose();
    };
}

function openRunQueueEditor() {
    if (!runState || runState.phase === 'finish') return;
    if (hasOpenOverlay()) return;

    const tempExercises = [];
    runState.workout.exercises.forEach((el, i) => {
        const copy = JSON.parse(JSON.stringify(el));
        copy._origIndex = i;
        copy._removed = false;
        tempExercises.push(copy);
    });
    (runState._removedExercises || []).forEach((el, i) => {
        const copy = JSON.parse(JSON.stringify(el));
        copy._origIndex = -1;
        copy._removed = true;
        tempExercises.push(copy);
    });

    let exCounter = 0;
    tempExercises.forEach((el, i) => {
        if (el.kind === 'exercise' && !el._removed) {
            const t = runState.exerciseTimes[exCounter];
            if (t !== undefined && t !== null) {
                el._done = (t >= 0);
                el._skipped = (t === -1);
            }
            exCounter++;
        }
    });
    tempExercises.forEach((el, i) => {
        if (el.kind === 'rest' && !el._removed && el._origIndex >= 0 && el._origIndex < runState.index) {
            el._done = true;
        }
    });

    let currentIdx = runState.index;

    pauseRunForSettings();
    runState._queueEditing = true;
    function resumeAfterClose() {
        if (!runState) return;
        runState._queueEditing = false;
        resumeRunAfterSettings();
        if (runState.phase === 'ready' && runState.workout.autoStart) beginCurrentElementFlow(true);
    }

    function renderList() {
        return tempExercises.map((el, i) => {
            if (!el) return '';
            let icon = '🏋️', name = el.name || 'Упражнение', sub = '';
            const isCurrent = (i === currentIdx);
            const isDone = !!el._done;
            const isSkipped = !!el._skipped;
            const isRemoved = !!el._removed;
            let isPastWarmup = false;
            if (el.kind === 'warmup' && el._origIndex >= 0 && el._origIndex < runState.index) {
                isPastWarmup = true;
            }
            const isPast = (el._origIndex >= 0 && el._origIndex < runState.index) || isDone || isSkipped || isPastWarmup;

            if (el.kind === 'exercise') {
                if (el.type === 'sets') sub = `${el.setsCount || 3}×${el.setMode === 'time' ? (el.setDuration || 45) + 'с' : (el.targetReps || 10) + 'п'}`;
                else if (el.type === 'reps') sub = `${el.targetReps || 10} повт.`;
                else if (el.type === 'timer') sub = formatTime(el.timerDuration || 60);
                else sub = 'секундомер';
            } else if (el.kind === 'warmup') {
                icon = '🔥'; name = 'Разминка'; sub = el.mode === 'free' ? 'свободно' : formatTime(el.duration || 180);
            } else if (el.kind === 'rest') {
                const isW = el.restType === 'water';
                icon = isW ? '💧' : '🛌';
                name = isW ? 'Вода' : 'Отдых';
                sub = el.duration === null ? 'без таймера' : formatTime(el.duration || 60);
            }

            let statusBadge = '';
            if (isCurrent) statusBadge = `<span class="run-queue-status-badge" style="display:inline-block; white-space:nowrap; vertical-align:middle; font-size:0.68rem; background:var(--accent); color:#0a0a10; padding:2px 6px; border-radius:6px; font-weight:700; margin:2px 0 0 6px;">СЕЙЧАС</span>`;
            else if (isDone || (isPastWarmup && !isCurrent)) statusBadge = `<span style="font-size:0.68rem; background:var(--card-3); color:var(--muted); padding:2px 6px; border-radius:6px; font-weight:700; margin-left:6px;">✓</span>`;
            else if (isSkipped) statusBadge = `<span style="font-size:0.68rem; background:var(--card-3); color:var(--muted); padding:2px 6px; border-radius:6px; font-weight:700; margin-left:6px;">⏭</span>`;

            let strike = '';
            if (isDone || isSkipped || isPastWarmup) strike = 'text-decoration: line-through; color: var(--muted); opacity: 0.7;';
            if (isRemoved) strike = 'color: var(--muted); opacity: 0.6; background: var(--card-3);';

            const canDrag = !isPast && !isRemoved && !isCurrent;
            let actionBtn = '';
            if (isRemoved) {
                actionBtn = `<button class="btn small ghost" style="padding:6px 8px; min-height:0; margin:0; font-size:0.85rem; color:var(--accent); border-color:var(--accent); background:var(--accent-soft);" onclick="event.stopPropagation(); runQueueRestore(${i})" aria-label="Восстановить">✅</button>`;
            } else if (isPast) {
                actionBtn = `<button class="btn small ghost" style="padding:6px 8px; min-height:0; margin:0; font-size:0.85rem; opacity:0.3; pointer-events:none;" aria-label="Заблокировано">✕</button>`;
            } else {
                actionBtn = `
                    <button class="btn small ghost" style="padding:6px 8px; min-height:0; margin:0; font-size:0.85rem;" onclick="event.stopPropagation(); runQueueMove(${i},-1)" ${i === 0 ? 'disabled' : ''} aria-label="Вверх">↑</button>
                    <button class="btn small ghost" style="padding:6px 8px; min-height:0; margin:0; font-size:0.85rem;" onclick="event.stopPropagation(); runQueueMove(${i},1)" ${i === tempExercises.length - 1 ? 'disabled' : ''} aria-label="Вниз">↓</button>
                    <button class="btn small ghost" style="padding:6px 8px; min-height:0; margin:0; font-size:0.85rem; color:var(--danger);" onclick="event.stopPropagation(); runQueueDelete(${i})" aria-label="Удалить">✕</button>
                `;
            }

            return `<div class="run-queue-item${canDrag ? ' run-queue-item-draggable' : ''}" data-queue-index="${i}" style="display:flex; align-items:center; gap:8px; padding:8px 10px; background:var(--card-2); border-radius:10px; border:1px solid ${isCurrent ? 'var(--accent)' : 'var(--border-soft)'}; ${strike}">
                <div style="font-size:1.2rem; flex-shrink:0; opacity:${(isPast || isRemoved) && !isCurrent ? 0.5 : 1};">${icon}</div>
                <div style="flex:1; min-width:0;">
                    <div style="font-weight:600; font-size:0.9rem; word-break:break-word;">${escapeHtml(name)}${statusBadge}</div>
                    <div style="font-size:0.72rem; color:var(--muted); margin-top:2px;">${sub}</div>
                </div>
                <div style="display:flex; gap:4px; flex-shrink:0;">
                    ${actionBtn}
                </div>
            </div>`;
        }).join('');
    }

    function bindRunQueueDrag() {
        const list = document.getElementById('run-queue-list');
        if (!list) return;
        list.querySelectorAll('.run-queue-item-draggable').forEach(el => {
            initDragAndDrop(el, {
                containerSelector: '#run-queue-list',
                itemSelector: '.run-queue-item',
                dbKey: 'runQueueOrder'
            });
        });
    }

    function refresh() {
        const el = document.getElementById('run-queue-list');
        if (el) el.innerHTML = renderList();
        bindRunQueueDrag();
    }

    window._runQueueOnReorder = function() {
        const list = document.getElementById('run-queue-list');
        if (!list) return;
        const els = Array.from(list.querySelectorAll('.run-queue-item'));
        const newIdxs = els.map(el => parseInt(el.dataset.queueIndex, 10)).filter(n => !isNaN(n));
        if (newIdxs.length !== tempExercises.length) { refresh(); return; }
        // Выполненные и текущий блок нельзя менять местами
        for (let k = 0; k <= currentIdx && k < newIdxs.length; k++) {
            if (newIdxs[k] !== k) {
                showToast('Выполненные и текущий блок нельзя перемещать');
                refresh();
                return;
            }
        }
        const reordered = newIdxs.map(i => tempExercises[i]).filter(Boolean);
        if (reordered.length !== tempExercises.length) { refresh(); return; }
        tempExercises.splice(0, tempExercises.length, ...reordered);
        refresh();
    };

    window.runQueueMove = function(i, d) {
        const j = i + d;
        if (j < 0 || j >= tempExercises.length) return;
        if (i <= currentIdx || tempExercises[i]._done || tempExercises[i]._skipped || tempExercises[i]._removed) return;
        if (j <= currentIdx) return;
        [tempExercises[i], tempExercises[j]] = [tempExercises[j], tempExercises[i]];
        refresh();
    };
    window.runQueueDelete = function(i) {
        if (i < 0 || i >= tempExercises.length) return;
        if (i <= currentIdx || tempExercises[i]._done || tempExercises[i]._skipped) {
            showToast('Нельзя удалить выполненное или текущее');
            return;
        }
        tempExercises[i]._removed = true;
        refresh();
    };
    window.runQueueRestore = function(i) {
        if (i < 0 || i >= tempExercises.length) return;
        if (tempExercises[i]._removed) {
            tempExercises[i]._removed = false;
            refresh();
        }
    };
    window.applyRunQueue = function() {
        try { window._runQueueOnReorder = null; } catch(e) {}
        const active = [];
        const removed = [];
        tempExercises.forEach(el => {
            if (el._removed) removed.push(el);
            else active.push(el);
        });
        const cleanActive = active.map(el => {
            const c = Object.assign({}, el);
            delete c._origIndex; delete c._done; delete c._skipped; delete c._removed;
            return c;
        });
        const cleanRemoved = removed.map(el => {
            const c = Object.assign({}, el);
            delete c._origIndex; delete c._done; delete c._skipped; delete c._removed;
            return c;
        });
        if (cleanActive.length === 0) { showToast('Нельзя оставить пустую тренировку'); return; }
        runState.workout.exercises = cleanActive;
        runState._removedExercises = cleanRemoved;
        let newIdx = 0;
        let count = 0;
        for (let k = 0; k < tempExercises.length; k++) {
            if (k === currentIdx) { newIdx = count; break; }
            if (!tempExercises[k]._removed) count++;
        }
        runState.index = Math.max(0, Math.min(newIdx, cleanActive.length - 1));
        saveRunState();
        resumeAfterClose();
        closeTopSheet();
        showToast('✅ Порядок обновлён');
    };
    window.closeRunQueue = function() {
        try { window._runQueueOnReorder = null; } catch(e) {}
        resumeAfterClose();
        closeTopSheet();
    };

    const ov = document.createElement('div');
    ov.className = 'notif-side-overlay';
    ov.innerHTML = `<div class="notif-side-sheet" style="max-height: 88vh;">
        <div class="notif-side-grabber"><div class="notif-side-grabber-bar"></div></div>
        <h2 class="sheet-title">Порядок тренировки</h2>
        <div style="color:var(--muted); font-size:0.8rem; text-align:center;">Отменённые упражнения можно вернуть (галочка). Выполненные заблокированы.</div>
        <div id="run-queue-list" class="sheet-scroll-area" style="flex:1; overflow-y:auto; display:flex; flex-direction:column; gap:6px;">${renderList()}</div>
        <div class="sheet-fixed-bottom" style="display:flex; flex-direction:column; gap:8px;">
            <button class="btn accent" onclick="applyRunQueue()">Применить</button>
            <button class="btn sheet-btn-cancel" onclick="closeRunQueue()">Отмена</button>
        </div>
    </div>`;
    document.body.appendChild(ov);
    setupSideSwipe(ov.querySelector('.notif-side-sheet'), ov, () => {
        try { window._runQueueOnReorder = null; } catch(e) {}
        resumeAfterClose();
    });
    ov.addEventListener('click', (e) => {
        if (e.target === ov) {
            try { window._runQueueOnReorder = null; } catch(e2) {}
            resumeAfterClose();
            ov.remove();
        }
    });
    bindRunQueueDrag();
}

async function finishWorkoutEarly() {
    if (!runState || runState.phase === 'finish') return;
    const ok = await customConfirm('Завершить тренировку сейчас?\n\nДанные сохранятся в историю.', { title: 'Завершить тренировку', okText: 'Завершить', cancelText: 'Продолжить', danger: false });
    if (!ok) return;
    showFinishScreen();
}


function getRunReturnScreen() {
    if (runReturnScreen) return runReturnScreen;
    if (runState && runState.isTemp) return 'screen-home';
    return 'screen-workouts';
}
function goAfterRunEnd() {
    const target = getRunReturnScreen();
    runReturnScreen = 'screen-home';
    showScreen(target);
}

async function cancelWorkout() {
    if (!runState || runState.phase === 'finish') return;
    const ok = await customConfirm('Отменить тренировку?\n\nДанные НЕ сохранятся в историю.', { title: 'Отменить тренировку', okText: '✕ Отменить', cancelText: 'Продолжить', danger: true });
    if (!ok) return;
    stopTickInterval();
    if (runState.countdownInterval) clearInterval(runState.countdownInterval);
    stopRestAlarm(); stopExerciseAlarm(); releaseWakeLock();
    clearSavedRunState(); disableExitProtection();
    try { finishExerciseInProgress = false; } catch(e) {}
    try { skipExerciseInProgress = false; } catch(e) {}
    try {
        askRepsBusy = false;
        while (askRepsQueue.length) {
            const q = askRepsQueue.shift();
            try { if (q && typeof q.resolve === 'function') q.resolve(null); } catch(err) {}
        }
        document.querySelectorAll('.notif-side-overlay[data-ft-ask-dialog="1"]').forEach(ov => {
            try { if (typeof ov._ftOnDismiss === 'function') ov._ftOnDismiss(); else ov.remove(); } catch(err) {}
        });
    } catch(e) {}
    runState = null;
    goAfterRunEnd();
    showToast('❌ Тренировка отменена');
}

window.addEventListener('load', () => {
    setTimeout(async () => {
        try { initTabLock(); } catch(e) {}
        try {
            if (typeof forceClearRunState === 'function' && runState && runState.phase === 'finish') forceClearRunState();
            if (typeof ensureNoStuckRunState === 'function') ensureNoStuckRunState();
            if (typeof runDataIntegrityCheck === 'function') runDataIntegrityCheck(false);
            renderStreakBanner(); renderHomeTodayBanner(); applyHomeMenuVisibility();
            if (typeof applyQuickStartCollapsed === 'function') applyQuickStartCollapsed();
        } catch(e) {}
        try { updateFooter(); } catch(e) {}
        try { initNotifGrabber(); updateNotifGrabber(); } catch(e) {}
        try { await initServiceWorker(); } catch(e) { console.error('[SW]', e); }
        try { await offerResumeSavedSession(); } catch(e) { console.error(e); }
        setTimeout(() => {
            try { checkScheduledNotifications(); } catch(e) { console.error('[notif]', e); }
            setTimeout(() => { try { checkAutoBackupReminder(); } catch(e) { console.error('[backup]', e); } }, 1500);
        }, 500);
    }, 200);
});
