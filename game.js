try{ document.body.classList.add('preloading'); }catch(e){}

// ========== TELEGRAM WEBAPP FULLSCREEN INIT ==========
(function initTelegramFullscreen(){
  try {
    const tg = window.Telegram && window.Telegram.WebApp;
    if (!tg) return;
    
    // Сообщаем Telegram что приложение готово
    tg.ready();
    
    // Раскрываем на весь экран (обязательно!)
    tg.expand();
    
    // Запрос полноэкранного режима (Telegram WebApp 8.0+)
    if (typeof tg.requestFullscreen === 'function') {
      tg.requestFullscreen();
    }
    
    // Отключаем вертикальные свайпы, чтобы приложение не закрывалось случайно
    if (typeof tg.disableVerticalSwipes === 'function') {
      tg.disableVerticalSwipes();
    }
    
    if (typeof tg.lockOrientation === 'function') {
      tg.lockOrientation();
    }
    
    // Скрываем кнопку "Назад" если есть
    if (tg.BackButton && typeof tg.BackButton.hide === 'function') {
      tg.BackButton.hide();
    }
    
    // Устанавливаем цвет хедера под цвет игры (опционально)
    if (typeof tg.setHeaderColor === 'function') {
      try { tg.setHeaderColor('#1a0000'); } catch(e){}
    }
    if (typeof tg.setBackgroundColor === 'function') {
      try { tg.setBackgroundColor('#1a0000'); } catch(e){}
    }
    
  } catch(e) {
    console.warn('Telegram WebApp init error:', e);
  }
})();

(function(){
  function setVH(){
    var vh = window.innerHeight * 0.01;
    document.documentElement.style.setProperty('--vh', vh + 'px');
  }
  setVH();
  window.addEventListener('resize', setVH);
})();

const wrap = document.getElementById('wrap');
  const cvs  = document.getElementById('c');
  const ctx  = cvs.getContext('2d');

  
  // Регистрируем все игровые изображения, чтобы прелоудер мог дождаться именно их
  let GAME_IMG_TOTAL = 0;
  let GAME_IMG_LOADED = 0;

  let GAME_AUDIO_TOTAL = 0;
  let GAME_AUDIO_LOADED = 0;

  function registerGameAudio(audio){
    try{
      // В Telegram WebView события canplaythrough по аудио могут не приходить,
      // из-за чего прелоудер навсегда "ждет" звуки.
      // Считаем аудио загруженным сразу после создания объекта,
      // чтобы прелоудер опирался только на картинки.
      GAME_AUDIO_TOTAL++;
      GAME_AUDIO_LOADED++;
    }catch(e){}
  }

  function registerGameImg(im){
    GAME_IMG_TOTAL++;
    const onDone = function(){
      GAME_IMG_LOADED++;
      im.removeEventListener('load', onDone);
      im.removeEventListener('error', onDone);
    };
    im.addEventListener('load', onDone);
    im.addEventListener('error', onDone);
  }

  function makeImg(src){
    const im = new Image();
    try{
      registerGameImg(im);
    }catch(e){}
    im.src = src;
    return im;
  }

  // ========== ОПТИМИЗИРОВАННАЯ ЗВУКОВАЯ СИСТЕМА ==========
  // Гибридный подход: Web Audio API для мобильных, HTML5 Audio как fallback
  const Sound = (function(){
    let audioContext = null;
    const buffers = {};           // Web Audio буферы
    const audioElements = {};     // HTML5 Audio элементы (fallback)
    const pools = {};             // Пулы для HTML5 Audio
    const poolIndex = {};
    const CHANNELS_PER_SOUND = 3;
    let enabled = true;
    let masterVolume = 0.85;
    let unlocked = false;
    let useWebAudio = false;      // Флаг успешной инициализации Web Audio

    // Создаём AudioContext
    function getContext() {
      if (audioContext) return audioContext;
      try {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (AudioContextClass) {
          audioContext = new AudioContextClass();
        }
      } catch(e) {}
      return audioContext;
    }

    // Разблокировка аудио на мобильных
    function unlockAll() {
      if (unlocked) return;
      unlocked = true;
      
      const ctx = getContext();
      if (ctx) {
        try {
          if (ctx.state === 'suspended') {
            ctx.resume().catch(function(){});
          }
          // Тихий звук для разблокировки
          const buffer = ctx.createBuffer(1, 1, 22050);
          const source = ctx.createBufferSource();
          source.buffer = buffer;
          source.connect(ctx.destination);
          source.start(0);
        } catch(e) {}
      }
      
      // Также разблокируем HTML5 Audio элементы
      try {
        Object.keys(pools).forEach(function(key){
          const list = pools[key];
          if (!list || !list.length) return;
          const a = list[0];
          try {
            a.volume = 0;
            const p = a.play();
            if (p && typeof p.then === "function") {
              p.then(function(){
                try { a.pause(); a.currentTime = 0; } catch(e){}
              }).catch(function(){});
            }
          } catch(e){}
        });
      } catch(e){}
    }

    // Загрузка звука
    function load(name, src) {
      registerGameAudio(null);
      
      // Всегда создаём HTML5 Audio как fallback
      try {
        const base = new Audio();
        base.src = src;
        base.preload = "auto";
        audioElements[name] = base;

        const list = [];
        for (let i = 0; i < CHANNELS_PER_SOUND; i++){
          try {
            const a = base.cloneNode();
            a.load(); // Принудительная загрузка
            list.push(a);
          } catch(e){}
        }
        pools[name] = list;
        poolIndex[name] = 0;
      } catch(e){}

      // Пробуем загрузить в Web Audio API (для мобильных)
      const ctx = getContext();
      if (ctx) {
        // Используем XMLHttpRequest вместо fetch (работает с file://)
        try {
          const xhr = new XMLHttpRequest();
          xhr.open('GET', src, true);
          xhr.responseType = 'arraybuffer';
          xhr.onload = function() {
            if (xhr.status === 200 || xhr.status === 0) { // 0 для file://
              ctx.decodeAudioData(xhr.response, function(audioBuffer) {
                buffers[name] = audioBuffer;
                useWebAudio = true;
              }, function(err) {
                // Ошибка декодирования - используем fallback
              });
            }
          };
          xhr.onerror = function() {
            // Ошибка загрузки - используем fallback
          };
          xhr.send();
        } catch(e) {}
      }
    }

    // Воспроизведение через Web Audio API
    function playWebAudio(name, opts) {
      const ctx = getContext();
      if (!ctx) return false;
      
      const buffer = buffers[name];
      if (!buffer) return false;

      try {
        if (ctx.state === 'suspended') {
          ctx.resume().catch(function(){});
        }

        const source = ctx.createBufferSource();
        source.buffer = buffer;

        const gainNode = ctx.createGain();
        const vol = (opts && typeof opts.volume === "number") ? opts.volume : 1;
        gainNode.gain.value = Math.max(0, Math.min(1, masterVolume * vol));

        const rate = (opts && typeof opts.rate === "number") ? opts.rate : 1;
        source.playbackRate.value = rate;

        source.connect(gainNode);
        gainNode.connect(ctx.destination);
        source.start(0);
        return true;
      } catch(e) {
        return false;
      }
    }

    // Воспроизведение через HTML5 Audio (fallback)
    function playHTML5(name, opts) {
      const list = pools[name];
      if (!list || !list.length) return;
      
      let idx = poolIndex[name] || 0;
      const a = list[idx];
      poolIndex[name] = (idx + 1) % list.length;
      
      try {
        const vol = (opts && typeof opts.volume === "number") ? opts.volume : 1;
        const rate = (opts && typeof opts.rate === "number") ? opts.rate : 1;
        a.pause();
        try { a.currentTime = 0; } catch(e){}
        a.volume = Math.max(0, Math.min(1, masterVolume * vol));
        a.playbackRate = rate;
        a.play().catch(function(){});
      } catch(e){}
    }

    // Основная функция воспроизведения
    function play(name, opts) {
      if (!enabled) return;
      
      // Пробуем Web Audio API (быстрее на мобильных)
      if (useWebAudio && buffers[name]) {
        if (playWebAudio(name, opts)) return;
      }
      
      // Fallback на HTML5 Audio
      playHTML5(name, opts);
    }

    function setEnabled(v) {
      enabled = !!v;
    }

    function isEnabled() {
      return enabled;
    }

    return { load, play, setEnabled, isEnabled, unlockAll };
  })();

  // Разблокируем аудио в Telegram/WebView на первом действии пользователя
  // + трюк для обхода iOS silent mode
  (function(){
    try{
      let unlockAttempted = false;
      let silentAudio = null;
      
      // Тихий MP3 файл в base64 (0.1 сек тишины)
      const SILENT_MP3 = "data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA//tQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAABhgC7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7//////////////////////////////////////////////////////////////////8AAAAATGF2YzU4LjEzAAAAAAAAAAAAAAAAJAAAAAAAAAAAAYYNAAAAAAAAAAAAAAAAAAAA//tQZAAP8AAAaQAAAAgAAA0gAAABAAABpAAAACAAADSAAAAETEFNRTMuMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//tQZB4P8AAAaQAAAAgAAA0gAAABAAABpAAAACAAADSAAAAEVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVQ==";
      
      // iOS 17+ API для обхода silent mode
      function setAudioSessionPlayback() {
        try {
          if (navigator.audioSession && navigator.audioSession.type !== undefined) {
            navigator.audioSession.type = "playback";
          }
        } catch(e) {}
      }
      
      // Вызываем сразу при загрузке
      setAudioSessionPlayback();
      
      function onFirstInteraction(){
        if (unlockAttempted) return;
        unlockAttempted = true;
        
        // Повторно устанавливаем playback при первом взаимодействии
        setAudioSessionPlayback();
        
        try{
          Sound.unlockAll();
        }catch(e){}
        
        // Трюк для старых iOS: тихий HTML5 Audio в loop
        try {
          silentAudio = document.createElement("audio");
          silentAudio.setAttribute("x-webkit-airplay", "deny");
          silentAudio.preload = "auto";
          silentAudio.loop = true;
          silentAudio.volume = 0.001;
          silentAudio.src = SILENT_MP3;
          silentAudio.play().catch(function(){});
        } catch(e){}
        
        // Дополнительная разблокировка Web Audio API
        try {
          const AudioContextClass = window.AudioContext || window.webkitAudioContext;
          if (AudioContextClass) {
            const tempCtx = new AudioContextClass();
            const oscillator = tempCtx.createOscillator();
            const gain = tempCtx.createGain();
            gain.gain.value = 0.001;
            oscillator.connect(gain);
            gain.connect(tempCtx.destination);
            oscillator.start(0);
            oscillator.stop(tempCtx.currentTime + 0.001);
            
            if (tempCtx.state === 'suspended') {
              tempCtx.resume();
            }
          }
        } catch(e){}
        
        try{
          window.removeEventListener('pointerdown', onFirstInteraction);
          window.removeEventListener('touchstart', onFirstInteraction);
          window.removeEventListener('touchend', onFirstInteraction);
          window.removeEventListener('click', onFirstInteraction);
          window.removeEventListener('keydown', onFirstInteraction);
        }catch(e){}
      }
      
      window.addEventListener('pointerdown', onFirstInteraction);
      window.addEventListener('touchstart', onFirstInteraction);
      window.addEventListener('touchend', onFirstInteraction);
      window.addEventListener('click', onFirstInteraction);
      window.addEventListener('keydown', onFirstInteraction);
    }catch(e){}
  })();


  const SOUND_STORAGE_KEY = 'lb_sound_enabled';

  (function(){
    try{
      const saved = localStorage.getItem(SOUND_STORAGE_KEY);
      if (saved !== null){
        Sound.setEnabled(saved === '1');
      }
    }catch(e){}
  })();

  // SFX: твердая/движущая, прыгучая, исчезающая, шипы, сбор капли, падение
  Sound.load("solid",   "./assets/audio/solid.mp3");
  Sound.load("spring",  "./assets/audio/spring.mp3");
  Sound.load("fragile", "./assets/audio/fragile.mp3");
  Sound.load("spike",   "./assets/audio/spike.mp3");
  Sound.load("drop",    "./assets/audio/drop.mp3");
  Sound.load("falling", "./assets/audio/falling.mp3");

  const imgFragile = makeImg("./assets/images/platforms/platform_fragile.png");
  const imgMoving  = makeImg("./assets/images/platforms/platform_moving.png");
  const imgSpring  = makeImg("./assets/images/platforms/platform_spring.png");
  const imgSpike   = makeImg("./assets/images/platforms/platform_spike.png");
  const imgBack = makeImg("./assets/images/backgrounds/back.png");

  // Предзагрузка картинок стартового экрана (CSS background-image + HTML img)
  makeImg("./assets/images/backgrounds/start.png");
  makeImg("./assets/images/interface/Button.png");
  makeImg("./assets/images/interface/sound_on.png");
  makeImg("./assets/images/interface/sound_off.png");
  makeImg("./assets/images/text/text_start.png");
  
  
  const imgSolid1 = makeImg("./assets/images/platforms/platform_solid1.png");
  const imgSolid2 = makeImg("./assets/images/platforms/platform_solid2.png");
  const imgSolid3 = makeImg("./assets/images/platforms/platform_solid3.png");
  const imgSolid4 = makeImg("./assets/images/platforms/platform_solid4.png");
  const imgSolid5 = makeImg("./assets/images/platforms/platform_solid5.png");
  const imgSolid6 = makeImg("./assets/images/platforms/platform_solid6.png");
  const imgSolid7 = makeImg("./assets/images/platforms/platform_solid7.png");
  const imgSolid8 = makeImg("./assets/images/platforms/platform_solid8.png");
  const SOLID_SPRITES = [imgSolid1,imgSolid2,imgSolid3,imgSolid4,imgSolid5,imgSolid6,imgSolid7,imgSolid8];
function imgReady(im){ return !!(im && im.complete && (im.naturalWidth||im.width)>0); }
  
  function drawInfiniteBg(ctx, camY, W, H){
    if (!imgReady(imgBack)) return;
    const dpr = (window.devicePixelRatio||1);
    const px = v => Math.round(v*dpr)/dpr;
    const iw = (imgBack.naturalWidth||imgBack.width)||1;
    const ih = (imgBack.naturalHeight||imgBack.height)||1;
    const scale = W / iw;           
    const tileH = ih * scale;
    let off = (camY * 0.5) % tileH; 
    if (off < 0) off += tileH;
    const y1 = px(-off);
    const y2 = px(y1 + tileH);
    ctx.drawImage(imgBack, 0,0, iw,ih, 0, y1, W, tileH);
    ctx.drawImage(imgBack, 0,0, iw,ih, 0, y2, W, tileH);
  }

  
  const SPARK_LAYERS = [
    { count: 40, size: 1, speed: 18,  alpha: 0.35 }, 
    { count: 28, size: 2, speed: 30,  alpha: 0.45 }, 
    { count: 16, size: 3, speed: 48,  alpha: 0.55 }  
  ];
  const SPARKS = [];
  function initSparks(W, H){
    SPARKS.length = 0;
    const rng = Math.random;
    for (let li=0; li<SPARK_LAYERS.length; li++){
      const L = SPARK_LAYERS[li];
      const arr = [];
      for (let i=0;i<L.count;i++){
        arr.push({
          x: Math.random()*W,
          y: Math.random()*H,
          jx: (rng()*0.6-0.3),       
        });
      }
      SPARKS.push(arr);
    }
  }
  function drawSparks(ctx, camY, W, H, t){
    if (!SPARKS.length) initSparks(W, H);
    const dpr = (window.devicePixelRatio||1);
    const px = v => Math.round(v*dpr)/dpr;
    for (let li=0; li<SPARK_LAYERS.length; li++){
      const L = SPARK_LAYERS[li];
      const arr = SPARKS[li];
      ctx.globalAlpha = L.alpha;
      for (let i=0; i<arr.length; i++){
        const s = arr[i];
        
        let yy = (s.y + L.speed * t) % (H + 20);
        if (yy < -20) yy += (H + 20);
        
        const xx = s.x + Math.sin((t*0.6 + i*0.7 + li)*2.0) * (2 + L.size) + s.jx * 8;
        const sz = L.size;
        
        ctx.fillStyle = "rgba(255,70,70,1)";
        ctx.fillRect(px(xx), px(yy), px(sz), px(sz));
      }
    }
    ctx.globalAlpha = 1;
  }
function solidCapsReady(){ return false; }
  
  
  const __DPR0 = Math.max(1, Math.min(3, window.devicePixelRatio||1));
  const __MOBILE_GUESS0 =
    (window.matchMedia && matchMedia('(pointer:coarse)').matches)
    || /Mobi|Android|iPhone|iPad|iPod|Mobile|CriOS/i.test(navigator.userAgent);
  const MOBILE_GEOM_SCALE = __MOBILE_GUESS0 ? 1.50 : 1.0;
  const VHEIGHT = { solid:38, fragile:32, moving:36, spring:36, spike:46 };
  const VHEIGHT_SCALED = {
    solid: Math.round(VHEIGHT.solid  * MOBILE_GEOM_SCALE * 1.15),
    fragile: Math.round(VHEIGHT.fragile* MOBILE_GEOM_SCALE * 1.15),
    moving:  Math.round(VHEIGHT.moving * MOBILE_GEOM_SCALE * 1.15),
    spring:  Math.round(VHEIGHT.spring * MOBILE_GEOM_SCALE * 1.15),
    spike:   Math.round(VHEIGHT.spike  * MOBILE_GEOM_SCALE * 1.15)
  };
  function widthFromAR(img, targetH){
    const h0 = (img.naturalHeight||img.height)||1;
    const w0 = (img.naturalWidth||img.width)||1;
    const s = targetH / h0;
    return Math.max(8, Math.round(w0 * s));
  }
ctx.imageSmoothingEnabled = false;
  const RAW_DPR = window.devicePixelRatio||1;
  const IS_WINDOWS = /Windows/i.test(navigator.userAgent);
  const DPR  = Math.max(1, Math.min(3, IS_WINDOWS ? 2 : RAW_DPR));
  var IS_MOBILE = /Mobi|Android|iPhone|iPad|iPod|Mobile|CriOS/i.test(navigator.userAgent)
                    || (window.matchMedia && matchMedia('(pointer:coarse)').matches);
  var MOBILE_SCALE = IS_MOBILE ? 1.0 : 1.0;
  let W=0, H=0;
  function fit(){ const r=wrap.getBoundingClientRect(); W=cvs.width=Math.round(r.width*DPR); H=cvs.height=Math.round(r.height*DPR); }
  new ResizeObserver(fit).observe(wrap); fit();

  const tg = window.Telegram?.WebApp||null;

  const hudH=document.getElementById('h'), hudDrops=document.getElementById('drops'), hudBest=document.getElementById('best');
  const bloodFill=document.getElementById('bloodFill');
  const menuEl=document.getElementById('menu'), overEl=document.getElementById('gameover');
  const startBtn=document.getElementById('startBtn'), howBtn=document.getElementById('howBtn'), againBtn=document.getElementById('againBtn'), shareBtn=document.getElementById('shareBtn');
  const progressBtn=document.getElementById('progressBtn');
  const progressOverlay=document.getElementById('progressOverlay');

  let soundBtn = document.getElementById('soundBtn');

  function syncSoundButtonUI(){
    if (!soundBtn) return;
    try{
      if (Sound.isEnabled()){
        soundBtn.classList.remove('muted');
      } else {
        soundBtn.classList.add('muted');
      }
    }catch(e){}
  }

  if (!soundBtn && wrap){
    soundBtn = document.createElement('button');
    soundBtn.id = 'soundBtn';
    soundBtn.type = 'button';
    soundBtn.className = 'sound-btn';
    wrap.appendChild(soundBtn);
  }

  if (soundBtn){
    syncSoundButtonUI();
    soundBtn.addEventListener('click', function(e){
      e.stopPropagation();
      try{
        const enabled = Sound.isEnabled();
        Sound.setEnabled(!enabled);
        try{
          localStorage.setItem(SOUND_STORAGE_KEY, Sound.isEnabled() ? '1' : '0');
        }catch(_){}
      }catch(_){}
      syncSoundButtonUI();
    });
  }

  const progressTableWrap=document.getElementById('progressTable');
  const progressTabs=document.querySelectorAll('[data-progress-tab]');
  const progressCloseBtn=document.getElementById('progressClose');



const SUPABASE_URL = 'https://xysyawfwdstgfktsxxhl.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh5c3lhd2Z3ZHN0Z2ZrdHN4eGhsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjI1NzEzNDUsImV4cCI6MjA3ODE0NzM0NX0.aspYgKHlOWLg3weHwAYv1we9V2JYbiwE3zORwqZrmEY';

let supabaseClient = null;
let currentPlayer = {
  telegram_id: null,
  username: null,
  score: 0,
  total_drops: 0
};
let playerInitPromise = null;

function getSupabase(){
  if (supabaseClient) return supabaseClient;
  try{
    if (window.supabase && window.supabase.createClient){
      supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    }
  }catch(e){
    console.error('Supabase init error', e);
  }
  return supabaseClient;
}

async function generateFallbackName(client){
  
  try{
    const { data, error } = await client
      .from('scores')
      .select('telegram_id, created_at')
      .ilike('telegram_id', 'lilboy_%')
      .order('created_at', { ascending:false })
      .limit(1000);

    if (error){
      console.error('generateFallbackName error', error);
      return 'lilboy_' + Math.floor(100000 + Math.random()*900000);
    }

    let maxN = 0;
    (data||[]).forEach(row=>{
      const name = row.telegram_id || '';
      const m = /lilboy_(\d+)/i.exec(name);
      if (m){
        const n = parseInt(m[1], 10);
        if (!Number.isNaN(n) && n>maxN) maxN = n;
      }
    });
    return 'lilboy_' + (maxN+1);
  }catch(e){
    console.error('generateFallbackName fatal', e);
    return 'lilboy_' + Math.floor(100000 + Math.random()*900000);
  }
}

async function initPlayer(){
  if (playerInitPromise) return playerInitPromise;
  playerInitPromise = (async ()=>{
    const client = getSupabase();
    if (!client) return;

    let username = null;
    try{
      const tgUser = tg && tg.initDataUnsafe && tg.initDataUnsafe.user;
      if (tgUser && tgUser.username){
        username = String(tgUser.username);
      }
    }catch(e){
      console.warn('Telegram user read error', e);
    }

    if (!username){
      username = await generateFallbackName(client);
    }

    currentPlayer.telegram_id = username;
    currentPlayer.username = username;

    try{
      const { data, error } = await client
        .from('scores')
        .select('telegram_id, username, score, total_drops')
        .eq('telegram_id', username)
        .maybeSingle();

      if (error){
        console.error('load player error', error);
      }

      if (!data){
        const insertPayload = {
          telegram_id: username,
          username: username,
          score: 0,
          total_drops: 0,
          game_id: 'lilboy_bleeding_up'
        };
        const { data: inserted, error: insertErr } = await client
          .from('scores')
          .insert(insertPayload)
          .select('telegram_id, username, score, total_drops')
          .single();
        if (insertErr){
          console.error('create player error', insertErr);
        }else if (inserted){
          currentPlayer.score = inserted.score || 0;
          currentPlayer.total_drops = inserted.total_drops || 0;
        }
      }else{
        currentPlayer.score = data.score || 0;
        currentPlayer.total_drops = data.total_drops || 0;
      }
    }catch(e){
      console.error('initPlayer fatal', e);
    }
  })();
  return playerInitPromise;
}

async function saveRunToSupabase(){
  const client = getSupabase();
  if (!client) return;
  try{
    await initPlayer();
    if (!currentPlayer.telegram_id) return;

    const currentBest = Number(currentPlayer.score || 0);
    const runScore = Number(score || 0);
    const newBestScore = Math.max(currentBest, runScore);
    const addedDrops = Number(dropsCollected || 0);
    const newTotalDrops = Number(currentPlayer.total_drops || 0) + addedDrops;

    const { data, error } = await client
      .from('scores')
      .update({
        score: newBestScore,
        total_drops: newTotalDrops
      })
      .eq('telegram_id', currentPlayer.telegram_id)
      .select('score, total_drops')
      .single();

    if (error){
      console.error('saveRun error', error);
      return;
    }

    currentPlayer.score = (data && data.score) != null ? data.score : newBestScore;
    currentPlayer.total_drops = (data && data.total_drops) != null ? data.total_drops : newTotalDrops;
  }catch(e){
    console.error('saveRunToSupabase fatal', e);
  }
}

async function fetchLeaderboard(orderField){
  const client = getSupabase();
  if (!client) return [];
  try{
    await initPlayer();
    const { data, error } = await client
      .from('scores')
      .select('telegram_id, username, score, total_drops')
      .order(orderField, { ascending:false })
      .limit(50);

    if (error){
      console.error('fetchLeaderboard error', error);
      return [];
    }
    return data || [];
  }catch(e){
    console.error('fetchLeaderboard fatal', e);
    return [];
  }
}

async function fetchMyBank(){
  const client = getSupabase();
  if (!client) return 0;
  try{
    await initPlayer();
    if (!currentPlayer.telegram_id) return 0;

    const { data, error } = await client
      .from('scores')
      .select('total_drops')
      .eq('telegram_id', currentPlayer.telegram_id)
      .maybeSingle();

    if (error){
      console.error('fetchMyBank error', error);
      return currentPlayer.total_drops || 0;
    }
    const bank = Number(data && data.total_drops != null ? data.total_drops : 0);
    currentPlayer.total_drops = bank;
    return bank;
  }catch(e){
    console.error('fetchMyBank fatal', e);
    return currentPlayer.total_drops || 0;
  }
}


let MY_BANK = 0;
let activeProgressTab = 'score';

async function renderProgress(tab){
  if (!progressTableWrap) return;
  progressTableWrap.innerHTML = '<div class="progress-loading">Загрузка...</div>';

  try{
    if (tab === 'bank'){
      const bank = await fetchMyBank();
      MY_BANK = bank || 0;

      const displayName = (currentPlayer && (currentPlayer.username || currentPlayer.telegram_id)) || '';

      progressTableWrap.innerHTML = `
        <div class="bank-card">
          <div class="bank-label">Банк</div>
          <div class="bank-value">
            <img class="drop-ico bank" src="./assets/images/game elements/drop.png" alt=""/>
            ${MY_BANK}
          </div>
        </div>
        <div class="bank-player">${displayName}</div>
      `;
      return;
    }

    const orderField = (tab === 'drops') ? 'total_drops' : 'score';
    const rows = await fetchLeaderboard(orderField);
    const isDropsTab = (tab === 'drops');

    const headerHtml = isDropsTab
      ? '<tr><th class="progress-rank">#</th><th>ИГРОК</th><th><img class=\"progress-ico\" src=\"./assets/images/game elements/drop.png\" alt=\"\"/></th><th><img class=\"progress-ico\" src=\"./assets/images/interface/cup.png\" alt=\"\"/></th></tr>'
      : '<tr><th class="progress-rank">#</th><th>ИГРОК</th><th><img class=\"progress-ico\" src=\"./assets/images/interface/cup.png\" alt=\"\"/></th><th><img class=\"progress-ico\" src=\"./assets/images/game elements/drop.png\" alt=\"\"/></th></tr>';

    let bodyHtml = '';
    (rows || []).slice(0, 10).forEach((row, idx)=>{
      const rank = idx + 1;
      const name = row.username || row.telegram_id || ('Lil Boy ' + rank);
      const scoreVal = Number(row.score || 0);
      const dropsVal = Number(row.total_drops || 0);

      const mainVal = isDropsTab ? dropsVal : scoreVal;
      const altVal = isDropsTab ? scoreVal : dropsVal;

      const isMe = currentPlayer && currentPlayer.telegram_id && row.telegram_id === currentPlayer.telegram_id;

      bodyHtml += `
        <tr class="${isMe ? 'me' : ''}">
          <td class="progress-rank">${rank}</td>
          <td class="progress-name">${name}</td>
          <td>${mainVal}</td>
          <td>${altVal}</td>
        </tr>
      `;
    });

    if (!bodyHtml){
      bodyHtml = '<tr><td colspan="4" class="empty">Пока никто не попал в таблицу. Стань первым.</td></tr>';
    }

    progressTableWrap.innerHTML = `
      <table class="progress-table">
        <thead>${headerHtml}</thead>
        <tbody>${bodyHtml}</tbody>
      </table>
    `;
  }catch(e){
    console.error('renderProgress fatal', e);
    progressTableWrap.innerHTML = '<div class="progress-error">Не удалось загрузить данные. Попробуй ещё раз.</div>';
  }
}

function openProgress(){
  if (!progressOverlay) return;
  progressOverlay.style.display = 'flex';
  renderProgress(activeProgressTab);
}
function closeProgress(){
  if (!progressOverlay) return;
  progressOverlay.style.display = 'none';
}

if (progressBtn){
  progressBtn.addEventListener('click',(e)=>{
    e.stopPropagation();
    openProgress();
  });
}
if (progressCloseBtn){
  progressCloseBtn.addEventListener('click',(e)=>{
    e.stopPropagation();
    closeProgress();
  });
}
if (progressTabs && progressTabs.length){
  progressTabs.forEach(btn=>{
    btn.addEventListener('click',()=>{
      const tab = btn.getAttribute('data-progress-tab');
      activeProgressTab = tab;
      progressTabs.forEach(b=>b.classList.toggle('active', b===btn));
      renderProgress(tab);
    });
  });
}

function refreshProgressButton(){
  if (!progressBtn && !soundBtn) return;
  const show = (state === STATE.MENU || state === STATE.OVER);
  if (progressBtn){
    progressBtn.style.display = show ? 'flex' : 'none';
  }
  if (soundBtn){
    soundBtn.style.display = show ? 'flex' : 'none';
  }
}
const imgPlayer=new Image(); imgPlayer.src='./assets/images/lil boy/lil boy.png';
const imgPlayerRed = new Image(); imgPlayerRed.src = './assets/images/lil boy/lil boy_red.png';

  const imgDrop=new Image();   imgDrop.src='./assets/images/game elements/drop.png';
  let playerImgOk=false, dropImgOk=false; imgPlayer.onload=()=>playerImgOk=true; imgDrop.onload=()=>dropImgOk=true;

  
  const G=3200*1.15, VX_MAX=440*1.15, SMOOTH=6.8;
  const JUMP = (IS_MOBILE ? Math.round(-1250*(1.20 * Math.sqrt(1.10))) : -1250) * 1.15;  
  const T_UP=Math.abs(JUMP/G), PEAK=(JUMP*JUMP)/(2*G), REACH_Y=PEAK*0.8, FLIGHT=2*T_UP;
  let MAX_DX = VX_MAX * FLIGHT * 0.8;
  const VEL_THRESH = IS_MOBILE ? 80*1.15 : 80; 

  const STATE={MENU:0,PLAY:1,OVER:2}; let state=STATE.MENU;
  const player={x:0,y:0,r:28,vx:0,vy:0, sx:1, sy:1, landBounce:0};
  let blood=1, drainPerSec=0.085, dropRefill=0.18; let lastSpringAt=-999; let springRings=[]; let lastSpikeAt=-999; let spikeRings=[];
  let timeSinceGround = 0;
  let heightTop=0, score=0, dropsCollected=0;
  const bestKey='lb_bleeding_best'; let best=Number(localStorage.getItem(bestKey)||0); hudBest.textContent=best;

  const platforms=[]; const drops=[];
  let SPACING = 0; let cameraY = 0; let hitTimer=0; let camKick=0;

  const sparks=[]; const bloodFX=[];

  
  function mulberry32(a){ return function(){ let t=a+=0x6D2B79F5; t=Math.imul(t^t>>>15,t|1); t^=t+Math.imul(t^t>>>7,t|61); return ((t^t>>>14)>>>0)/4294967296; } }
  const SEED = 1337;
  function randN(seed,n){ return mulberry32((seed ^ (n*0x9e3779b9))>>>0)(); }
  function lerp(a,b,t){ return a+(b-a)*t; }
  function clamp(v,a,b){ return Math.max(a, Math.min(b,v)); }





function drawSolidCaps(ctx, p){
  
  if (!SOLID_SPRITES || SOLID_SPRITES.length===0) return false;
  
  let pick = SOLID_SPRITES[0], maxW = 0;
  for (let i=0;i<SOLID_SPRITES.length;i++){
    const im = SOLID_SPRITES[i];
    if (!imgReady(im)) continue;
    const iw=(im.naturalWidth||im.width)||1;
    if (iw>maxW){ maxW=iw; pick=im; }
  }
  const im = (p && p.isStart && imgReady(imgSolid8)) ? imgSolid8 : pick;
  if (!imgReady(im)) return false;
  const iw=(im.naturalWidth||im.width)||1, ih=(im.naturalHeight||im.height)||1;
  const dx = p.x, dw = p.w, dh = p.h;
  const px = (v)=> (typeof DPR!=='undefined' ? Math.round(v*DPR)/DPR : Math.round(v));

  
  ctx.drawImage(im, 0,0, iw,ih, px(dx), px(p.y), px(dw), px(dh));

  
  const right = dx + dw;
  if (dx < 0){ ctx.drawImage(im, 0,0, iw,ih, px(dx + W), px(p.y), px(dw), px(dh)); }
  if (right > W){ ctx.drawImage(im, 0,0, iw,ih, px(dx - W), px(p.y), px(dw), px(dh)); }
  return true;
}


let ringIndex=0, ringTopY=0, worldTopY=0, lastMainX=0;

  function addPlatform(cx,y,w,h,type='solid', vx=0){
  const p={x:cx-w/2,y,w,h,type,ttl:Infinity,touched:false,shake:0,vx:vx,alive:true};
  
  try{
    const margin = 0.02 * W;
    if (p.x < margin) p.x = margin;
    if (p.x + p.w > W - margin) p.x = W - margin - p.w;
  }catch(_){}
  platforms.push(p); return p;
}
  function addDropOnPlatform(p, offsetX=0, lift=28){
  const margin = 0.02 * W;
  const r = Math.round(18 * MOBILE_GEOM_SCALE * 1.15);
  const liftAdj = Math.round(lift * MOBILE_GEOM_SCALE * 1.15);
  let dx = p.x + p.w/2 + offsetX;
if (dx < margin) dx = margin;
if (dx > W - margin) dx = W - margin;
const d = { x: dx, y: p.y - liftAdj, r, parent: p, offsetX, lift: liftAdj };
  drops.push(d);
  return d;
}
function diffT(n){ return clamp((n-6)/70, 0, 1); }

  function genRing(seed, n, prevTopY, lastX){
    const r = (k)=>randN(seed, n*9973 + k);
    const t = diffT(n);
    const baseStep = Math.min(SPACING, REACH_Y);
    const stepY   = Math.min(SPACING, REACH_Y) * (IS_MOBILE ? 1.10 : 1.0);  
    const y       = prevTopY - stepY;

    const dxScale = n < 4 ? 0.40 : lerp(0.75, 1.50, t);
    const side    = (n&1)?1:-1;
    const dx      = (0.35 + r(1)*0.5) * MAX_DX * dxScale * side;
    const cx      = clamp(lastX + dx, 0.02*W, 0.98*W);

    const wMain   = lerp(0.36*W, 0.20*W, clamp(n/50,0,1)) * lerp(1.0, 0.92, t);
    const pFrag   = lerp(0.15, 0.50, t);
    const pMove   = (n>=12) ? lerp(0.05, 0.28, t) : 0.0;
    const rPick   = r(2);
    let type = 'solid', vx=0;
    if (rPick < pFrag){ type='fragile'; }
    else if (rPick < pFrag + pMove){ type='moving'; vx = lerp(60, 120, r(21)) * (side>0?1:-1); }

    const main    = {x:cx - wMain/2, y, w:wMain, h:22, type, vx};
    let clampShiftMain = 0;
    {
      const margin = 0.02*W;
      let nx = main.x;
      if (nx < margin) nx = margin;
      if (nx + main.w > W - margin) nx = W - margin - main.w;
      clampShiftMain = nx - main.x;
      if (clampShiftMain !== 0) main.x = nx;
    }
    let topY = y, sidePlat = null, dropSide = null, clampShiftSide = 0;

    if (r(3) < (n<4 ? 0.40 : 0.58)){
      const w2  = lerp(0.24*W, 0.15*W, clamp(n/50,0,1));
      const cx2 = clamp(cx + (r(4)-0.5)*MAX_DX*0.95, 0.02*W, 0.98*W);
      const cy  = y - lerp(stepY*0.38, stepY*0.58, r(5));
      sidePlat  = {x:cx2 - w2/2, y:cy, w:w2, h:18, type:'solid', vx:0};
      {
        const margin2 = 0.02*W;
        let nx2 = sidePlat.x;
        if (nx2 < margin2) nx2 = margin2;
        if (nx2 + sidePlat.w > W - margin2) nx2 = W - margin2 - sidePlat.w;
        clampShiftSide = nx2 - sidePlat.x;
        if (clampShiftSide !== 0) sidePlat.x = nx2;
      }
topY      = Math.min(topY, cy);
      if (r(6) < 0.78) dropSide = {x: cx2 + (r(7)-0.5)*w2*0.35, y: cy - 36, r:18};
      if (clampShiftSide !== 0) dropSide.x += clampShiftSide;
    }

    
    
    
    if (main.type==='solid' && n>=6){
      const ringsSince = n - lastSpringAt;
      const recentCount = springRings.filter(rr => n - rr < 12).length;
      const ok = (ringsSince >= 4) && (recentCount < 3);
      const pSpring = ok ? 0.12 : 0.0;
      if (Math.random() < pSpring){ main.type='spring'; }
    }
    if (sidePlat && sidePlat.type==='solid' && n>=18){
      const ringsSince = n - lastSpikeAt;
      const recentCount = spikeRings.filter(rr => n - rr < 18).length;
      const ok = (ringsSince >= 8) && (recentCount < 2);
      const pSpike = ok ? 0.18 : 0.0;
      if (Math.random() < pSpike){ sidePlat.type='spike'; }
    }
const dropMain = {x: cx + (r(8)-0.5)*(wMain*0.35), y: y - 36, r:18};
    if (clampShiftMain !== 0) dropMain.x += clampShiftMain;
    return {main, side:sidePlat, dropMain, dropSide, topY, mainCx: main.x + main.w*0.5};
  }

  function spawnAheadIfNeeded(){
    while (worldTopY > (cameraY - H*0.8)){
      const ring = genRing(SEED, ringIndex, ringTopY, lastMainX);
      const m = (function(){
      const _t = ring.main.type;
      const _h = VHEIGHT_SCALED[_t] || ring.main.h;
      let _w = ring.main.w;
      if (_t!=='solid'){ const _img = (_t==='fragile')?imgFragile: (_t==='moving')?imgMoving: (_t==='spring')?imgSpring: (_t==='spike')?imgSpike: null; if (_img && imgReady(_img)) _w = widthFromAR(_img, _h);} const __m = addPlatform(ring.main.x + ring.main.w/2, ring.main.y, _w, _h, _t, ring.main.vx||0); return __m;
    })();
      if (m.type==='spring'){ lastSpringAt = ringIndex; springRings.push(ringIndex); }
      addDropOnPlatform(m, ring.dropMain.x - (ring.main.x + ring.main.w/2), 28);
      if (ring.side){
        const s = (function(){
      const _t = ring.side.type;
      const _h = VHEIGHT_SCALED[_t] || ring.side.h;
      let _w = ring.side.w;
      if (_t!=='solid'){ const _img = (_t==='fragile')?imgFragile: (_t==='moving')?imgMoving: (_t==='spring')?imgSpring: (_t==='spike')?imgSpike: null; if (_img && imgReady(_img)) _w = widthFromAR(_img, _h);} const __s = addPlatform(ring.side.x + ring.side.w/2, ring.side.y, _w, _h, _t, 0); return __s;
    })();
        if (s.type==='spike'){ lastSpikeAt = ringIndex; spikeRings.push(ringIndex); }
        if (false){
          const rx = s.x + s.w/2 + ((Math.random()<0.5?-1:1) * (W*0.18));
          const ry = s.y - stepY*0.75;
          addPlatform(rx, ry, Math.max(54, s.w*0.9), s.h, 'spring', 0);
        }
        if (ring.dropSide){ addDropOnPlatform(s, ring.dropSide.x - (ring.side.x + ring.side.w/2), 28); }
      }
      lastMainX = ring.mainCx;
      ringTopY  = ring.topY;
      worldTopY = Math.min(worldTopY, ringTopY);
      ringIndex++;
    }
  }

  
  const input={dir:0};
  window.input = input; 
  window.addEventListener('keydown',e=>{
    if(e.key==='ArrowLeft'||e.key==='a') input.dir=-1;
    if(e.key==='ArrowRight'||e.key==='d') input.dir=1;
    if(state===STATE.MENU && e.key==='Enter') startGame();
    if(state===STATE.OVER && (e.key==='Enter'||e.key===' ')) restart();
  });
  window.addEventListener('keyup',e=>{ if(['ArrowLeft','a','ArrowRight','d'].includes(e.key)) input.dir=0; });
  let touchX=null;

  function overlayRestart(e){ if(state!==STATE.OVER) return; e?.stopPropagation?.(); e?.preventDefault?.(); restart(); }
  overEl.addEventListener('click', overlayRestart);
  overEl.addEventListener('touchstart', overlayRestart, {passive:false});
  againBtn.addEventListener('click', overlayRestart);


try{
  overEl.removeEventListener('click', overlayRestart);
  overEl.removeEventListener('touchstart', overlayRestart);
  
  overEl.addEventListener('click', function(e){ e.stopPropagation(); }, {passive:false});
  overEl.addEventListener('touchstart', function(e){ e.stopPropagation(); }, {passive:false});
  
  againBtn.addEventListener('click', function(e){ e.stopPropagation(); overlayRestart(e); }, {passive:false});
}catch(_){}


  startBtn.onclick=startGame;
  if (howBtn) howBtn.onclick=()=>alert('Свайпы/стрелки влево-вправо. Автопрыжок. Сквозные края без шлейфа. Капли парят выше.');
  if (shareBtn) shareBtn.onclick=()=>{
    const msg=`Мой счёт в Lil Boy: Bleeding Up — ${score} • Капли: ${dropsCollected}`;
    navigator.clipboard?.writeText(msg);
    alert('Текст скопирован.');
  };

  
  function wrapX(x){
    const limit = W;
    if (x < -player.r) return x + limit + player.r*2;
    if (x > limit + player.r) return x - (limit + player.r*2);
    return x;
  }
  function withinXWrap(px, p){
    const a = (x)=> (x >= p.x && x <= p.x+p.w);
    return a(px) || a(px - W) || a(px + W);
  }
  function dxTorus(px, qx){
    let dx = px - qx;
    if (dx >  W/2) dx -= W;
    if (dx < -W/2) dx += W;
    return dx;
  }

  function addDropSparks(x,y){
    for(let i=0;i<14;i++){
      const a = Math.random()*Math.PI*2;
      const sp = 120 + Math.random()*120;
      sparks.push({
        x,y,
        vx: Math.cos(a)*sp,
        vy: Math.sin(a)*sp - 50,
        r: 4 + Math.random()*3,
        alpha: 0.8,
        life: 360,
      });
    }
  }

  

function spawnBloodSplash(x,y){
  for(let i=0;i<12;i++){
    const a = Math.random()*Math.PI*2;
    const sp = 180 + Math.random()*180;
    const r  = 3 + Math.random()*4;
    bloodFX.push({x,y,vx:Math.cos(a)*sp,vy:Math.sin(a)*sp-60,r,alpha:1,life:320});
  }
}
function seedWorld(){
    platforms.length=0; drops.length=0; sparks.length=0;
    ringIndex=0; lastSpringAt=-999; springRings=[]; lastSpikeAt=-999; spikeRings=[];
    const start = addPlatform(W*0.5, H*0.82, 0.42*W, 42, 'solid');
    start.h = VHEIGHT_SCALED.solid; start.isStart = true;
addDropOnPlatform(start, 0, 36);
    lastMainX = start.x + start.w/2;
    ringTopY  = start.y;
    worldTopY = ringTopY;
    for(let i=0;i<10;i++){
      const ring = genRing(SEED, ringIndex, ringTopY, lastMainX);
      const m = (function(){
      const _t = ring.main.type;
      const _h = VHEIGHT_SCALED[_t] || ring.main.h;
      let _w = ring.main.w;
      if (_t!=='solid'){ const _img = (_t==='fragile')?imgFragile: (_t==='moving')?imgMoving: (_t==='spring')?imgSpring: (_t==='spike')?imgSpike: null; if (_img && imgReady(_img)) _w = widthFromAR(_img, _h);}
      const __m = addPlatform(ring.main.x + ring.main.w/2, ring.main.y, _w, _h, _t, ring.main.vx||0); return __m;
    })();
      if (m.type==='spring'){ lastSpringAt = ringIndex; springRings.push(ringIndex); }
      addDropOnPlatform(m, ring.dropMain.x - (ring.main.x + ring.main.w/2), 28);
      if (ring.side){
        const s = (function(){
      const _t = ring.side.type;
      const _h = VHEIGHT_SCALED[_t] || ring.side.h;
      let _w = ring.side.w;
      if (_t!=='solid'){ const _img = (_t==='fragile')?imgFragile: (_t==='moving')?imgMoving: (_t==='spring')?imgSpring: (_t==='spike')?imgSpike: null; if (_img && imgReady(_img)) _w = widthFromAR(_img, _h);}
      const __s = addPlatform(ring.side.x + ring.side.w/2, ring.side.y, _w, _h, _t, 0); return __s;
    })();
        if (s.type==='spike'){ lastSpikeAt = ringIndex; spikeRings.push(ringIndex); }
        if (false){
          const rx = s.x + s.w/2 + ((Math.random()<0.5?-1:1) * (W*0.18));
          const ry = s.y - stepY*0.75;
          addPlatform(rx, ry, Math.max(54, s.w*0.9), s.h, 'spring', 0);
        }
        if (ring.dropSide){ addDropOnPlatform(s, ring.dropSide.x - (ring.side.x + ring.side.w/2), 28); }
      }
      lastMainX = ring.mainCx; ringTopY = ring.topY; worldTopY = Math.min(worldTopY, ring.topY); ringIndex++;
    }
  }

  function startGame(){
    
    try {
      document.getElementById('hud').style.display = 'flex';
      const bw = document.querySelector('.barwrap');
      if (bw) bw.style.display = 'block';
    } catch(e) {}

    fit();
    document.body.classList.remove('over');
    state=STATE.PLAY; menuEl.style.display='none'; overEl.style.display='none'; if (progressOverlay) progressOverlay.style.display='none'; refreshProgressButton();
    input.dir = 0;
    SPACING = (IS_MOBILE ? 0.3402*H : 0.19*H) * 1.15;  
    MAX_DX  = VX_MAX * (2*Math.abs(JUMP/G)) * 0.8;
    blood=1; score=0; dropsCollected=0; heightTop=0; cameraY=0;
    seedWorld();
    const p0 = platforms[0];
    player.r = Math.round(28 * Math.max(1, DPR) * 1.15);
    player.x = p0.x + p0.w/2;
    player.y = p0.y - player.r - Math.round(40 * 1.15);
    player.vx=0; player.vy=0; player.sx=1; player.sy=1; player.landBounce=0;
    lastTime=performance.now(); loop();
  }

  function gameOver(reason='blood'){
    try{
      if (reason === 'blood' && typeof Sound !== 'undefined' && Sound.play){
        Sound.play("falling", { volume: 0.9, rate: 1.0 });
      }
    }catch(e){}
    input.dir=0; touchX=null;
    state=STATE.OVER;
    overEl.style.display=''; document.body.classList.add('over');
    refreshProgressButton();
    const titleEl = overEl.querySelector('h1');
    if (titleEl) titleEl.textContent = (reason === 'fall') ? 'Ты не взошёл' : 'Ты истёк';
    document.getElementById('finalStats').textContent = `Очки: ${score} • Капли: ${dropsCollected}`;
    if(score>best){ best=score; localStorage.setItem(bestKey,String(best)); hudBest.textContent=best; }
    saveRunToSupabase();
    try{ navigator.vibrate(50); }catch(e){}
    try{ overEl.focus(); }catch(e){}
}
  function restart(){ startGame(); }

  let lastTime=performance.now();
  function loop(now=performance.now()){
    if(state!==STATE.PLAY) return;
    const dtMs = Math.min(32, now-lastTime); lastTime=now;
    const dt = dtMs/1000;
    update(dt, dtMs); render(); requestAnimationFrame(loop);
  }

  function update(dt, dtMs){
    timeSinceGround += dt;
    if (camKick>0){ camKick = Math.max(0, camKick - dt*18); }

    if (hitTimer>0){ hitTimer -= dtMs; if (hitTimer<0) hitTimer=0; }

    const targetVx = input.dir * VX_MAX;
    player.vx += (targetVx - player.vx) * (SMOOTH * dt);
    const nextX = player.x + player.vx*dt;
    player.x  = wrapX(nextX);

    const prevY = player.y;
    player.vy += G * dt;
    player.y  += player.vy * dt;

    const cameraTarget = player.y - H*0.62;
    cameraY += (cameraTarget - cameraY) * Math.min(1, 10*dt);
    const bottomY  = cameraY + H;
    const cleanupY = bottomY + 120;

    if (player.y + player.r > bottomY){
      try{
        var maxFallTime = 1.4;
        var tFall = Math.max(0, Math.min(1, timeSinceGround / maxFallTime));
        var volFall = 0.55 + 0.35 * tFall;
        var rateFall = 1.15 - 0.25 * tFall;
        if (typeof Sound !== 'undefined' && Sound.play){
          Sound.play("falling", { volume: volFall, rate: rateFall });
        }
      }catch(e){}
      return gameOver('fall');
    }

    const step = Math.min(SPACING, REACH_Y);
    const currentHeight = Math.max(0, Math.round((H*0.82 - player.y) / step));
    heightTop = Math.max(heightTop, currentHeight);
    score = heightTop; hudH.textContent=score;

    const tDiff = Math.max(0, Math.min(1, heightTop/80));
    const drainBase = 0.085;
    const drainAdd  = lerp(0.0, 0.06, tDiff);
    drainPerSec = Math.max(0, Math.min(0.18, drainBase + drainAdd));
    blood -= drainPerSec * dt; if(blood<0) blood=0;
    bloodFill.style.transform=`scaleX(${Math.max(0,blood)})`;
    if(blood<=0) return gameOver('blood');

    
    for (let i=platforms.length-1;i>=0;i--){
      const p=platforms[i];
      if(p.type==='moving'){
        p.x += p.vx * dt;
        const minX = 0.02*W, maxX = 0.98*W - p.w;
        if (p.x < minX){ p.x=minX; p.vx = Math.abs(p.vx); }
        if (p.x > maxX){ p.x=maxX; p.vx = -Math.abs(p.vx); }
      }
      if(p.type==='fragile' && p.touched){
        p.shake = 1;
        p.ttl -= dt*1000;
        if(p.ttl<=0){ p.alive=false; platforms.splice(i,1); continue; }
      }
      if (p.y > cleanupY){ p.alive=false; platforms.splice(i,1); continue; }
    }

    
    for (let i=drops.length-1;i>=0;i--){
      const d=drops[i];
      if (d.parent && !d.parent.alive){ drops.splice(i,1); continue; }
      if (d.parent){ d.x = d.parent.x + d.parent.w/2 + d.offsetX; d.y = d.parent.y - d.lift; }
      if (d.y > cleanupY){ drops.splice(i,1); }
    }

    
    const prevFoot = prevY + player.r;
    const foot     = player.y + player.r;
    let landed = false;
    let landedType = null;
    for (let i=0;i<platforms.length;i++){
      const p=platforms[i];
      if (player.vy > 0 && withinXWrap(player.x, p) && prevFoot <= p.y && foot >= p.y){
        player.y = p.y - player.r;
        player.vy = (p.type==='spring' ? JUMP*1.6 : JUMP);
        if (p.type==='spike'){ blood = Math.max(0, blood - 0.07); spawnBloodSplash(player.x, player.y); hitTimer=160; camKick=4; try{ navigator.vibrate(25);}catch(e){} }
        landed = true;
        landedType = p.type;
        if (p.type==='fragile' && !p.touched){ p.touched=true; p.ttl=600; }
        try{ navigator.vibrate(10); }catch(e){}
        break;
      }
    }
    if (landed){
      timeSinceGround = 0;
      try{
        if (typeof Sound !== 'undefined' && Sound.play){
          if (landedType === 'spring'){
            Sound.play("spring", { volume: 1.0 });
          } else if (landedType === 'fragile'){
            Sound.play("fragile", { volume: 0.9 });
          } else if (landedType === 'spike'){
            Sound.play("spike", { volume: 1.0 });
          } else {
            // solid и движущиеся платформы
            Sound.play("solid", { volume: 0.85 });
          }
        }
      }catch(e){}
    }

    
    let targetSy = 1, targetSx = 1;
    if (IS_MOBILE){
      const speed = Math.abs(player.vy);
      const norm = Math.min(1, speed / (VEL_THRESH * 1.4));
      if (player.vy < 0){
        
        targetSy = 1 + 0.22 * norm;
        targetSx = 1 - 0.08 * norm;
      } else if (player.vy > 0){
        
        targetSy = 1 - 0.05 * norm;
        targetSx = 1 + 0.10 * norm;
      }
    } else {
      if (player.vy < -VEL_THRESH){ targetSy = 1.22; targetSx = 0.92; }
      else if (player.vy > VEL_THRESH){ targetSy = 0.95; targetSx = 1.10; }
    }
    if (landed){ targetSy = 1.18; targetSx = 0.92; player.landBounce = 1.0; }
    if (player.landBounce > 0){
      const t = player.landBounce;
      const osc = Math.sin((1-t)*Math.PI*1.2) * (t*0.12);
      targetSy = 1 + osc; targetSx = 1 - osc*0.6;
      player.landBounce = Math.max(0, t - dt*2.2);
    }
    const k = (IS_MOBILE ? 9*dt : 12*dt);
    player.sy += (targetSy - player.sy) * k;
    player.sx += (targetSx - player.sx) * k;

    
    for (let i=0;i<drops.length;i++){
      const d=drops[i];
      const dx = dxTorus(player.x, d.x);
      const dy = player.y - d.y;
      if (Math.hypot(dx,dy) < (player.r + d.r)*0.9){
        drops.splice(i,1); i--;
        blood=Math.min(1, blood+dropRefill);
        dropsCollected++; hudDrops.textContent=dropsCollected;
        addDropSparks(d.x, d.y);
        try{ navigator.vibrate(8); }catch(e){}
        try{
          if (typeof Sound !== 'undefined' && Sound.play){
            Sound.play("drop", { volume: 0.9 });
          }
        }catch(e){}
      }
    }

    
    for (let i=sparks.length-1;i>=0;i--){
      const s=sparks[i];
      s.life -= dtMs; s.alpha -= dt*2.2;
      s.vy += 900*dt;
      s.x += s.vx*dt; s.y += s.vy*dt;
      if (s.life<=0 || s.alpha<=0){ sparks.splice(i,1); }
    }
    
    for (let b=bloodFX.length-1;b>=0;b--){
      const f=bloodFX[b];
      f.life -= dtMs; f.alpha -= dt*2.0;
      f.vy += 1100*dt; f.x += f.vx*dt; f.y += f.vy*dt;
      if (f.life<=0 || f.alpha<=0){ bloodFX.splice(b,1); }
    }

    spawnAheadIfNeeded();
  }

  function render(){
    drawInfiniteBg(ctx, cameraY, W, H);
    drawSparks(ctx, cameraY, W, H, (performance.now()/1000));

    ctx.save(); ctx.translate(0,-cameraY + (camKick||0));

    const now = performance.now();
    platforms.forEach(p=>{
      let fill = '#2d1a25', stroke='rgba(241,58,83,.55)', lw=2;
      const __t = (p.type==='fragile')?imgFragile:(p.type==='moving')?imgMoving:(p.type==='spring')?imgSpring:(p.type==='spike')?imgSpike:null;
      const __has = !!(__t && imgReady(__t));
      if(__has){ fill='rgba(0,0,0,0)'; stroke='rgba(0,0,0,0)'; } if (p.type==='spring'){ fill='#3a1723'; stroke='rgba(255,95,120,1)'; lw=3; } if (p.type==='spike' && !(__t && imgReady(__t))){ fill='#2b121b'; stroke='rgba(241,58,83,0.95)'; lw=3; }
      if (p.type==='fragile' && !p.touched){ stroke='rgba(255,120,120,.95)'; lw=2.6; fill='#3b212c'; }
      else if (p.type==='fragile' && p.touched){ stroke='rgba(255,160,160,.95)'; lw=2.6; fill='#3b212c'; }
      else if (p.type==='moving'){ fill = '#2a1a26'; stroke='rgba(241,58,180,.6)'; }
      
      if(__has){ fill='rgba(0,0,0,0)'; stroke='rgba(0,0,0,0)'; lw=0; }

      const shakeX = p.shake ? Math.sin(now*0.06)*2 : 0;
      ctx.save(); ctx.translate(shakeX,0);
      if (p.type==='spring'){
        lw=0; stroke='rgba(0,0,0,0)';
        const tNow = performance.now();
        const pulse = 1 + 0.04 * Math.sin(tNow * 0.010 + (p.x * 0.02)); 
        ctx.translate(p.x + p.w/2, p.y + p.h/2);
        ctx.scale(pulse, pulse);
        ctx.translate(-(p.x + p.w/2), -(p.y + p.h/2));
        const intensity = (pulse - 1) / 0.04;
        ctx.shadowColor = 'rgba(255,95,130,' + (0.25 + 0.35 * Math.max(0,intensity)) + ')';
        ctx.shadowBlur = 10 + 14 * Math.max(0,intensity);
      }
      if (p.type!=='spring' && p.type!=='solid') { const r=7; ctx.beginPath();
      ctx.moveTo(p.x+r,p.y);
      ctx.arcTo(p.x+p.w,p.y,p.x+p.w,p.y+p.h,r);
      ctx.arcTo(p.x+p.w,p.y+p.h,p.x,p.y+p.h,r);
      ctx.arcTo(p.x,p.y+p.h,p.x,p.y,r);
      ctx.arcTo(p.x,p.y,p.x+p.w,p.y,r);
      ctx.closePath();
      ctx.fillStyle=fill; ctx.fill();
      if (p.type==='spring'){
        const grad = ctx.createLinearGradient(p.x, p.y, p.x, p.y + p.h);
        grad.addColorStop(0, 'rgba(255,120,140,0.35)');
        grad.addColorStop(1, 'rgba(255,120,140,0.0)');
        ctx.fillStyle = grad; ctx.fillRect(p.x, p.y, p.w, p.h);
      }
      if (p.type==='spike' && !(__t && imgReady(__t))){
        const teeth=Math.max(3, Math.floor(p.w/16)); const tw=p.w/teeth, th=8;
        for(let i=0;i<teeth;i++){ const tx=p.x+i*tw, ty=p.y-th; ctx.beginPath(); ctx.moveTo(tx,ty+th); ctx.lineTo(tx+tw*0.5,ty); ctx.lineTo(tx+tw,ty+th); ctx.closePath(); ctx.fillStyle='rgba(241,58,83,0.95)'; ctx.fill(); }
      }
      ctx.strokeStyle=stroke; ctx.lineWidth=lw; ctx.stroke();
      } if (p.type==='solid') { drawSolidCaps(ctx, p); } else { const t = (p.type==='fragile')?imgFragile:(p.type==='moving')?imgMoving:(p.type==='spring')?imgSpring:(p.type==='spike')?imgSpike:null; if (t && imgReady(t)) { if(p.type==='spring'){ctx.shadowColor='transparent'; ctx.shadowBlur=0; ctx.shadowOffsetX=0; ctx.shadowOffsetY=0;} ctx.drawImage(t, Math.round(p.x), Math.round(p.y), Math.round(p.w), Math.round(p.h)); } }
      ctx.restore();
    });

    
    sparks.forEach(s=>{
      ctx.globalAlpha=Math.max(0, Math.min(1, s.alpha));
      const grd = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.r*2);
      grd.addColorStop(0, 'rgba(241,58,83,0.9)');
      grd.addColorStop(1, 'rgba(241,58,83,0.0)');
      ctx.fillStyle=grd;
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r*2.2, 0, Math.PI*2); ctx.fill();
      ctx.globalAlpha=1;
    });

    
    drops.forEach(d=>{
      const s=d.r*2.2;
      if(dropImgOk){ ctx.drawImage(imgDrop, d.x-s/2, d.y-s/2, s, s); }
      else{ ctx.beginPath(); ctx.fillStyle='#f13a53'; ctx.arc(d.x,d.y,d.r,0,Math.PI*2); ctx.fill(); }
    });

    
    bloodFX.forEach(f=>{
      ctx.globalAlpha=Math.max(0, Math.min(1, f.alpha));
      const grd = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, f.r*2.2);
      grd.addColorStop(0, 'rgba(210,20,40,0.95)');
      grd.addColorStop(1, 'rgba(210,20,40,0.0)');
      ctx.fillStyle=grd; ctx.beginPath(); ctx.arc(f.x, f.y, f.r*2.2, 0, Math.PI*2); ctx.fill(); ctx.globalAlpha=1;
    });

    
    ctx.save();
    
    const __prevSmooth = ctx.imageSmoothingEnabled; ctx.imageSmoothingEnabled = true;
    ctx.translate(player.x, player.y);
    ctx.scale(player.sx, player.sy);
    if(playerImgOk){ const s=player.r*2.6; ctx.drawImage((hitTimer>0 && imgPlayerRed && imgPlayerRed.complete ? imgPlayerRed : imgPlayer), -s/2, -s/2, s, s); }
    else{ ctx.beginPath(); ctx.fillStyle='#0d0b0d'; ctx.arc(0,0,player.r,0,Math.PI*2); ctx.fill(); }
    
    ctx.imageSmoothingEnabled = __prevSmooth;
    ctx.restore();

    ctx.restore();

    hudH.textContent=score; hudBest.textContent=best;
  }

  menuEl.style.display='';
  refreshProgressButton();


;


(function(){
  function clamp(v){ return v<0?0:v>1?1:v; }
  function readScale(el){
    var tr = el.style.transform || '';
    var m = tr.match(/scaleX\(([^)]+)\)/);
    if(m){
      var p = parseFloat(m[1]);
      if(!isNaN(p)) return clamp(p);
    }
    return null;
  }
  function setup(){
    var bar  = document.querySelector('.bar');
    if(!bar) return;
    var fill = document.getElementById('bloodFill') || bar.querySelector('.fill');
    if(!fill) return;

    
    var wrap = bar.querySelector('.bar-inner-clip');
    if(!wrap){
      wrap = document.createElement('div');
      wrap.className = 'bar-inner-clip';
      bar.appendChild(wrap);
    }
    if(fill.parentNode !== wrap) wrap.appendChild(fill);

    
    var p0 = readScale(fill);
    if(p0===null){
      
      var fr = fill.getBoundingClientRect(), wr = wrap.getBoundingClientRect();
      p0 = wr.width>0 ? clamp(fr.width / wr.width) : 0;
    }
    fill.style.width = (p0*100).toFixed(3) + '%';

    
    function raf(){
      var p = readScale(fill);
      if(p!==null){
        fill.style.width = (p*100).toFixed(3) + '%';
      }
      requestAnimationFrame(raf);
    }
    requestAnimationFrame(raf);
  }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup);
  else setup();
})();


;





;


(function(){
  var wrap, fill;
  var lowThreshold = 0.33; 
  var lowActive = false;
  function clamp(v){ return v<0?0:v>1?1:v; }
  function ensureEls(){
    if (!wrap || !fill){
      var bar = document.querySelector('.bar');
      if(!bar) return false;
      wrap = bar.querySelector('.bar-inner-clip');
      fill = wrap && (document.getElementById('bloodFill') || wrap.querySelector('.fill'));
    }
    return !!(wrap && fill);
  }
  
  function hexToRgb(hex){
    hex = hex.replace('#','');
    if(hex.length===3){
      return { r:parseInt(hex[0]+hex[0],16), g:parseInt(hex[1]+hex[1],16), b:parseInt(hex[2]+hex[2],16) };
    }
    return { r:parseInt(hex.slice(0,2),16), g:parseInt(hex.slice(2,4),16), b:parseInt(hex.slice(4,6),16) };
  }
  function rgbToHex(r,g,b){
    r=Math.max(0,Math.min(255,Math.round(r)));
    g=Math.max(0,Math.min(255,Math.round(g)));
    b=Math.max(0,Math.min(255,Math.round(b)));
    function h(n){ return ('0'+n.toString(16)).slice(-2); }
    return '#'+h(r)+h(g)+h(b);
  }
  function mix(a,b,t){ return { r:a.r+(b.r-a.r)*t, g:a.g+(b.g-a.g)*t, b:a.b+(b.b-a.b)*t }; }
  function shade(rgb, amt){
    var w = amt>=0 ? 255 : 0, t = Math.abs(amt);
    return { r: rgb.r + (w-rgb.r)*t, g: rgb.g + (w-rgb.g)*t, b: rgb.b + (w-rgb.b)*t };
  }

  
  var HI = hexToRgb('#ce160d');
  var MD = hexToRgb('#b20b03');
  var LO = hexToRgb('#4f000e');

  function baseColor(p){ 
    var c1, c2, t;
    if (p > 0.5){ c1 = MD; c2 = HI; t = (p-0.5)/0.5; } 
    else       { c1 = LO; c2 = MD; t = p/0.5; }        
    return mix(c1,c2,t);
  }

  function updateVisual(p){
    if(!ensureEls()) return;
    var base = baseColor(p);
    
    var top  = shade(base,  0.10);
    var mid  = base;
    var bot  = shade(base, -0.18);
    var grad = 'linear-gradient(180deg,'+rgbToHex(top.r,top.g,top.b)+' 0%,'+
                                  rgbToHex(mid.r,mid.g,mid.b)+' 55%,'+
                                  rgbToHex(bot.r,bot.g,bot.b)+' 100%)';
    fill.style.background = grad;

    if(p < lowThreshold){
      if(!lowActive){ lowActive = true; fill.classList.add('low-breath'); }
    } else if(lowActive){
      lowActive = false; fill.classList.remove('low-breath');
    }
  }

  function readP(){
    if(!ensureEls()) return 0;
    var w = fill.style.width;
    if(w && w.endsWith('%')){
      var v = parseFloat(w);
      if(!isNaN(v)) return clamp(v/100);
    }
    var fr = fill.getBoundingClientRect(), wr = wrap.getBoundingClientRect();
    return wr.width>0 ? clamp(fr.width/wr.width) : 0;
  }

  function raf(){ updateVisual(readP()); requestAnimationFrame(raf); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function(){ ensureEls(); raf(); });
  else { ensureEls(); raf(); }
})();


;


(function(){
  function ensureFill(){
    var bar = document.querySelector('.bar');
    if(!bar) return null;
    var wrap = bar.querySelector('.bar-inner-clip') || bar;
    var fill = wrap.querySelector('#bloodFill') || wrap.querySelector('.fill');
    return fill || null;
  }
  function pulse(cls){
    var fill = ensureFill();
    if(!fill) return;
    fill.classList.remove(cls);
    void fill.offsetWidth;
    fill.classList.add(cls);
  }
  
  window.barOnCollect = function(){ pulse('bar-pulse-collect'); };
  window.barOnDamage  = function(){ pulse('bar-pulse-damage');  };

  
  document.addEventListener('DOMContentLoaded', function(){
    var dropsEl = document.getElementById('drops');
    if(!dropsEl) return;
    var last = parseInt(dropsEl.textContent || '0', 10) || 0;
    var obs = new MutationObserver(function(){
      var val = parseInt(dropsEl.textContent || '0', 10) || 0;
      if (val > last) { window.barOnCollect(); }
      if (val < last) { window.barOnDamage();  }
      last = val;
    });
    obs.observe(dropsEl, { childList:true, characterData:true, subtree:true });
  });
})();


;


(function(){
  var wrap, fill;
  function clamp(v){ return v<0?0:v>1?1:v; }
  function ensureEls(){
    if(!fill){
      var bar = document.querySelector('.bar');
      if(!bar) return false;
      wrap = bar.querySelector('.bar-inner-clip') || bar;
      fill = (wrap.querySelector('#bloodFill') || wrap.querySelector('.fill'));
    }
    return !!fill;
  }
  function hexToRgb(hex){
    hex = hex.replace('#',''); 
    if(hex.length===3){ return {r:parseInt(hex[0]+hex[0],16), g:parseInt(hex[1]+hex[1],16), b:parseInt(hex[2]+hex[2],16)}; }
    return { r:parseInt(hex.slice(0,2),16), g:parseInt(hex.slice(2,4),16), b:parseInt(hex.slice(4,6),16) };
  }
  function rgbToHex(o){ 
    function h(n){ n=Math.max(0,Math.min(255,Math.round(n))); return ('0'+n.toString(16)).slice(-2); }
    return '#'+h(o.r)+h(o.g)+h(o.b);
  }
  function mix(a,b,t){ return { r:a.r+(b.r-a.r)*t, g:a.g+(b.g-a.g)*t, b:a.b+(b.b-a.b)*t }; }
  function shade(rgb, amt){
    var w = amt>=0 ? 255 : 0, t = Math.abs(amt);
    return { r: rgb.r + (w-rgb.r)*t, g: rgb.g + (w-rgb.g)*t, b: rgb.b + (w-rgb.b)*t };
  }

  
  var C1 = hexToRgb('#c81120'); 
  var C2 = hexToRgb('#9b0014'); 
  var C3 = hexToRgb('#410002'); 

  
  var t1 = 2/3;   
  var t2 = 1/3;   
  var bw = 0.05;  

  function baseColorSmooth(p){
    
    if (p >= t1 + bw) return C1;                  
    if (p <= t2 - bw) return C3;                  
    if (p > t1 - bw && p < t1 + bw){              
      var t = (t1 + bw - p) / (2*bw);             
      return mix(C1, C2, clamp(t));
    }
    if (p > t2 - bw && p < t2 + bw){              
      var t = (t2 + bw - p) / (2*bw);             
      return mix(C2, C3, clamp(t));
    }
    
    return C2;
  }

  function readP(){
    if(!ensureEls()) return 0;
    var w = fill.style.width;
    if (w && w.endsWith('%')){
      var v = parseFloat(w);
      if(!isNaN(v)) return clamp(v/100);
    }
    var fr = fill.getBoundingClientRect(), wr = wrap.getBoundingClientRect();
    return wr.width>0 ? clamp(fr.width/wr.width) : 0;
  }

  function tick(){
    if(!ensureEls()) return;
    var p = readP();
    var base = baseColorSmooth(p);
    
    var top = shade(base, 0.10);
    var mid = base;
    var bot = shade(base, -0.18);
    fill.style.background = 'linear-gradient(180deg,'+rgbToHex(top)+' 0%,'+rgbToHex(mid)+' 55%,'+rgbToHex(bot)+' 100%)';
    requestAnimationFrame(tick);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', tick);
  else tick();
})();


;


(function(){
  var canvas = document.getElementById('c');
  if (!canvas) return;

  
  if (!window.input) window.input = { dir: 0 };

  function sideFromEvent(e){
    var t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]);
    var cx = (t ? t.clientX : (e.clientX||0));
    var rect = canvas.getBoundingClientRect();
    var x = cx - rect.left;
    return (x < rect.width * 0.5) ? -1 : 1;
  }

  var active = false;

  function onStart(e){
    if (e.cancelable) e.preventDefault();
    try{ if (typeof state !== 'undefined' && typeof STATE !== 'undefined' && state !== STATE.PLAY) return; }catch(_){}
    active = true;
    window.input.dir = sideFromEvent(e);
  }
  function onMove(e){
    if (!active) return;
    if (e.cancelable) e.preventDefault();
    try{ if (typeof state !== 'undefined' && typeof STATE !== 'undefined' && state !== STATE.PLAY) return; }catch(_){}
    window.input.dir = sideFromEvent(e);
  }
  function onEnd(e){
    if (e.cancelable) e.preventDefault();
    active = false;
    window.input.dir = 0;
  }

  canvas.addEventListener('touchstart', onStart, {passive:false});
  canvas.addEventListener('touchmove',  onMove,  {passive:false});
  canvas.addEventListener('touchend',   onEnd,   {passive:false});
  canvas.addEventListener('touchcancel',onEnd,   {passive:false});
})();


;


(function(){
  try{
    var fill;
    function ensure(){ 
      if (!fill){
        var bar = document.querySelector('.bar');
        if(!bar) return false;
        fill = bar.querySelector('#bloodFill') || bar.querySelector('.fill');
      }
      return !!fill;
    }
    window.barOnDamage = function(){  };
    document.addEventListener('DOMContentLoaded', function(){
      if(ensure()){ fill.classList.remove('damage'); }
    });
  }catch(e){}
})();


/* ===== Lil Boy preloader ===== */
(function(){
  var wrap = document.getElementById('wrap');
  if (!wrap) return;

  var pre = document.createElement('div');
  pre.id = 'preloader';
  pre.innerHTML =
    '<div class="pre-inner">' +
    '  <div class="pre-video-wrap">' +
    '    <div class="pre-video"></div>' +
    '  </div>' +
    '  <div class="pre-bar"><div class="pre-bar-inner"><div class="pre-fill"></div></div></div>' +
    '</div>';

  wrap.appendChild(pre);

  var fill = pre.querySelector('.pre-fill');
  var barEl = pre.querySelector('.pre-bar');
  var progress = 0;

  // Сначала прячем прогресс-бар, чтобы он не появлялся раньше спрайта
  if (barEl) {
    barEl.style.opacity = '0';
  }

  // Явно прогружаем спрайт, чтобы понимать, когда он готов анимироваться
  var spriteReady = false;
  var spriteImg = new Image();
  spriteImg.onload = function(){
    spriteReady = true;
    if (barEl) {
      barEl.style.opacity = '1';
    }
  };
  spriteImg.src = "./assets/images/preloader/lilboy_spin_sprite.png";

  function setProgress(p){
    if (!fill) return;
    p = Math.max(0, Math.min(1, p));
    progress = p;
    fill.style.width = (p * 100).toFixed(1) + '%';
  }

  var startedAt = performance.now();
  var MIN_MS = 2000; // минимум 2 секунды
  var loadTime = null;
  var endTime = null;
  var finished = false;
  var domLoaded = false;

  // Проверяем, что загрузился DOM, игровые изображения и звуки
  function coreAssetsReady(){
    try{
      if (!domLoaded) return false;

      var imgsReady = true;
      if (typeof GAME_IMG_TOTAL !== 'undefined' && typeof GAME_IMG_LOADED !== 'undefined'){
        if (GAME_IMG_TOTAL > 0){
          imgsReady = GAME_IMG_LOADED >= GAME_IMG_TOTAL;
        }
      }

      var audioReady = true;
      if (typeof GAME_AUDIO_TOTAL !== 'undefined' && typeof GAME_AUDIO_LOADED !== 'undefined'){
        if (GAME_AUDIO_TOTAL > 0){
          audioReady = GAME_AUDIO_LOADED >= GAME_AUDIO_TOTAL;
        }
      }

      return imgsReady && audioReady;
    }catch(e){
      return domLoaded;
    }
  }

  window.addEventListener('load', function(){
    domLoaded = true;
  });

  function finish(){
    if (finished) return;
    finished = true;
    try { setProgress(1); } catch(e){}
    setTimeout(function(){
      try{
        pre.remove();
      }catch(e){
        pre.style.display = 'none';
      }
      document.body.classList.remove('preloading');
      try{
        if (typeof menuEl !== 'undefined' && menuEl){
          menuEl.style.display = '';
        }
        if (typeof refreshProgressButton === 'function'){
          refreshProgressButton();
        }
      }catch(e){}
    }, 200);
  }

  function step(){
    if (!pre || finished) return;

    var now = performance.now();

    // Ждём не только загрузку DOM, но и всех игровых картинок
    if (typeof coreAssetsReady === 'function' ? !coreAssetsReady() : !loadTime){
      var t = Math.min(1, (now - startedAt) / MIN_MS);
      var visibleP = spriteReady ? 0.9 * t : 0;
      setProgress(visibleP);
    } else {
      if (!loadTime){
        loadTime = now;
      }
      // load уже случился — один раз фиксируем целевое время завершения
      if (!endTime){
        var minEnd = startedAt + MIN_MS;
        // чуть времени на мягкий докат, но не раньше минимума
        endTime = Math.max(loadTime + 160, minEnd);
      }
      var total = endTime - startedAt;
      var t2 = total > 0 ? Math.min(1, (now - startedAt) / total) : 1;
      setProgress(t2);
      if (now >= endTime){
        finish();
        return;
      }
    }

    requestAnimationFrame(step);
  }

  requestAnimationFrame(step);
})();
