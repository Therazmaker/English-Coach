// ================================================================
//  ENGLISH COACH - MOBILE WEB APP
// ================================================================

// ── CONFIG ────────────────────────────────────────────────────
// Multiple CORS proxies as fallbacks (in case one times out)
const OLLAMA_PROXIES = [
  'https://corsproxy.io/?https://ollama.com/api/chat',
  'https://corsproxy.io/?https://api.ollama.ai/api/chat',
  'https://cors-proxy.fringe.zone/https://api.ollama.ai/api/chat'
];
const OLLAMA_KEY   = 'a749df26093a49c892fece6c0cf7ab36.w1UdR9t19ujmPA2Cycz964Rk';
const OLLAMA_MODEL = 'gemma3:12b';

let lastWorkingProxyIndex = 0;

async function fetchWithFallback(body) {
  for (let offset = 0; offset < OLLAMA_PROXIES.length; offset++) {
    let i = (lastWorkingProxyIndex + offset) % OLLAMA_PROXIES.length;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60000); // 60s timeout for slow LLMs
      const res = await fetch(OLLAMA_PROXIES[i], {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OLLAMA_KEY },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      clearTimeout(timeout);
      if (res.ok) {
        lastWorkingProxyIndex = i; // Remember the working proxy
        return res;
      }
      console.warn(`[Coach] Proxy ${i+1} returned ${res.status}, trying next...`);
    } catch (e) {
      console.warn(`[Coach] Proxy ${i+1} failed:`, e.message);
    }
  }
  throw new Error('All proxies failed. Check your internet connection.');
}

const BASE_PHRASES = [
  "I apologize for the delay with your order",
  "You can either wait for it to arrive, or we can cancel it",
  "I will send a return label to your email address",
  "I am sorry to hear that the item arrived defective",
  "Let me check the tracking status for you",
  "We can offer a replacement or a full refund",
  "You have 30 days from the shipping date to return it",
  "Your refund will be processed within 15 days",
  "Is there anything else I can assist you with today"
];

// ── LEVELS & XP ───────────────────────────────────────────────
const LEVELS = [
  { level: 1, xpNeeded: 0,    title: 'Rookie Agent' },
  { level: 2, xpNeeded: 100,  title: 'Junior Agent' },
  { level: 3, xpNeeded: 250,  title: 'Agent' },
  { level: 4, xpNeeded: 500,  title: 'Senior Agent' },
  { level: 5, xpNeeded: 850,  title: 'Lead Agent' },
  { level: 6, xpNeeded: 1300, title: 'Supervisor' },
  { level: 7, xpNeeded: 1900, title: 'Team Leader' },
  { level: 8, xpNeeded: 2700, title: 'Expert' },
  { level: 9, xpNeeded: 3700, title: 'Master' },
  { level:10, xpNeeded: 5000, title: 'Elite Coach' },
];

let state = { xp: 0, calls: [], learnedPhrases: [], dailyMissions: [], lastMissionDate: null };

// ── DOM ELEMENTS ──────────────────────────────────────────────
const $ = id => document.getElementById(id);
const elTranscript = $('transcript-box');
const elEmpty      = $('empty-state');
const btnStart     = $('btn-start');
const btnPause     = $('btn-pause');
const btnHold      = $('btn-hold');
const btnEnd       = $('btn-end');
const btnNew       = $('btn-new');
const btnAnalyze   = $('btn-analyze');
const btnHistory   = $('btn-history');
const recDot       = $('rec-dot');

const elVocabList    = $('vocab-list');
const elPhraseList   = $('phrase-list');
const btnRefreshPhrases = $('btn-refresh-phrases');
const elPhraseCeleb  = $('phrase-celebration');
const statHits       = $('stat-hits');
const elCustomPhraseInput = $('custom-phrase-text');
const btnAddPhrase        = $('btn-add-phrase');
let phrasesHitThisCall = 0;

// ── AUDIO & RECOGNITION ───────────────────────────────────────
let isRecording = false;
let isPaused = false;
let recognition = null;
let audioContext, analyser, microphone, drawVisual;
let transcriptLines = [];

const statTime = $('stat-time');
const statWords = $('stat-words');
const callStats = $('call-stats');
let callTimer = null;
let secondsElapsed = 0;
let wordCount = 0;
let isOnHold = false;

function formatTime(s) {
  const m = Math.floor(s/60).toString().padStart(2, '0');
  const sec = (s%60).toString().padStart(2, '0');
  return `${m}:${sec}`;
}

// ── FUZZY MATCHING (PRONUNCIATION ENGINE) ─────────────────────
function levenshteinDistance(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const matrix = [];
  for (let i = 0; i <= b.length; i++) { matrix[i] = [i]; }
  for (let j = 0; j <= a.length; j++) { matrix[0][j] = j; }
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) == a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(matrix[i - 1][j - 1] + 1, Math.min(matrix[i][j - 1] + 1, matrix[i - 1][j] + 1));
      }
    }
  }
  return matrix[b.length][a.length];
}

function calculateSimilarity(str1, str2) {
  const longer = str1.length > str2.length ? str1 : str2;
  const shorter = str1.length > str2.length ? str2 : str1;
  const longerLength = longer.length;
  if (longerLength === 0) return 1.0;
  return (longerLength - levenshteinDistance(longer, shorter)) / parseFloat(longerLength);
}

function findBestMatch(transcript, target) {
  const tWords = transcript.split(' ');
  const mWords = target.split(' ');
  if (tWords.length < Math.max(1, mWords.length - 3)) return calculateSimilarity(transcript, target);
  
  let bestSim = 0;
  const maxLoops = Math.max(1, tWords.length - mWords.length + 1);
  
  for (let i = 0; i < maxLoops; i++) {
    // Test chunks of exact size, size-1, and size+1
    const chunkExact = tWords.slice(i, i + mWords.length).join(' ');
    const chunkPlus = tWords.slice(i, i + mWords.length + 1).join(' ');
    const chunkMinus = tWords.slice(i, Math.max(1, i + mWords.length - 1)).join(' ');

    const simExact = calculateSimilarity(chunkExact, target);
    const simPlus = calculateSimilarity(chunkPlus, target);
    const simMinus = calculateSimilarity(chunkMinus, target);
    
    const localBest = Math.max(simExact, simPlus, simMinus);
    if (localBest > bestSim) bestSim = localBest;
  }
  return Math.max(bestSim, calculateSimilarity(transcript, target));
}

// ── MISSIONS & LEARNING ───────────────────────────────────────
function checkDailyMissions() {
  const today = new Date().toDateString();
  if (state.lastMissionDate !== today || !state.dailyMissions || state.dailyMissions.length === 0) {
    generateDailyMissions();
  } else {
    renderMissions();
  }
  renderVocabBank();
}

function generateDailyMissions() {
  const pool = [...BASE_PHRASES, ...(state.learnedPhrases || [])];
  // Shuffle
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  
  state.dailyMissions = pool.slice(0, 3).map(p => ({ text: p, hit: false }));
  state.lastMissionDate = new Date().toDateString();
  saveState();
  renderMissions();
}

function renderMissions() {
  if (!elPhraseList) return;
  elPhraseList.innerHTML = state.dailyMissions.map((m, idx) => `
    <div class="phrase-card ${m.hit ? 'hit' : ''}" id="mission-${idx}">
      <span>${m.text}</span>
      <span class="status-icon">${m.hit ? '✅' : '🎯'}</span>
    </div>
  `).join('');
}

function renderVocabBank() {
  if (!elVocabList) return;
  if (!state.learnedPhrases || state.learnedPhrases.length === 0) {
    elVocabList.innerHTML = `<p style="font-size:12px; color:var(--text-dim);">No vocabulary saved yet. Complete calls to learn new words!</p>`;
    return;
  }
  elVocabList.innerHTML = state.learnedPhrases.map(v => `<span class="vocab-tag">${v}</span>`).join('');
}

// ── INITIALIZATION ────────────────────────────────────────────
function init() {
  loadState();
  updateXPUI();
  checkDailyMissions();
  renderSttRules();
  setupSpeechRecognition();
  setupEvents();
  setupTrainingRoom();
}

function loadState() {
  const saved = localStorage.getItem('ec_state');
  if (saved) {
    try {
      state = JSON.parse(saved);
      if (!state.calls) state.calls = [];
      if (!state.learnedPhrases) state.learnedPhrases = [];
      if (!state.sttRules) state.sttRules = [];
      if (!state.xp) state.xp = 0;
      
      // DEDUPLICATION: Remove any duplicated sessions from history
      const seen = new Set();
      state.calls = state.calls.filter(c => {
        // Use a combination of date and duration/wordcount as a unique key
        const dStr = c.date ? c.date.substring(0, 19) : ''; // down to the second
        const key = dStr + '_' + (c.duration||0) + '_' + (c.wordCount||0);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      saveState();
      
    } catch(e) {
      console.warn('Error loading state', e);
    }
  }
}

function saveState() {
  try {
    // Limit history to 50 calls to prevent Quota Exceeded errors over time
    if (state.calls && state.calls.length > 50) {
      state.calls = state.calls.slice(0, 50);
    }
    localStorage.setItem('ec_state', JSON.stringify(state));
  } catch (e) {
    console.warn('Failed to save state to localStorage (Private Mode or Quota Exceeded)', e);
  }
  updateXPUI();
}

// ── STT RULES ─────────────────────────────────────────────────
function renderSttRules() {
  const el = $('stt-rules-list');
  if (!el) return;
  if (!state.sttRules || state.sttRules.length === 0) {
    el.innerHTML = '<p style="font-size:12px; color:var(--text-dim);">No rules added yet.</p>';
    return;
  }
  el.innerHTML = state.sttRules.map((r, idx) => `
    <div class="tone-tip" style="display:flex; justify-content:space-between; align-items:center;">
      <span style="font-size:12px; color:var(--cyan);">"${r.heard}" ➜ "${r.meant}"</span>
      <button onclick="removeSttRule(${idx})" style="background:transparent; border:none; color:var(--red); cursor:pointer;">✖</button>
    </div>
  `).join('');
}

window.removeSttRule = function(idx) {
  if(state.sttRules) {
    state.sttRules.splice(idx, 1);
    saveState();
    renderSttRules();
  }
};

function getLevelInfo(xp) {
  let current = LEVELS[0];
  for (const l of LEVELS) { if (xp >= l.xpNeeded) current = l; else break; }
  const idx = LEVELS.indexOf(current);
  const next = LEVELS[idx + 1];
  const xpInLevel = xp - current.xpNeeded;
  const xpNeeded = next ? next.xpNeeded - current.xpNeeded : 999;
  const pct = next ? Math.min(100, Math.round((xpInLevel / xpNeeded) * 100)) : 100;
  return { ...current, next, xpInLevel, xpNeeded, pct };
}

function updateXPUI() {
  const info = getLevelInfo(state.xp);
  $('level-label').textContent = `LVL ${info.level}`;
  $('level-title').textContent = info.title;
  $('xp-label').textContent = info.next ? `${info.xpInLevel} / ${info.xpNeeded} XP` : 'MAX LEVEL';
  $('xp-fill').style.width = info.pct + '%';
}

function showToast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  setTimeout(() => t.classList.add('hidden'), 3000);
}

// ── SPEECH RECOGNITION ────────────────────────────────────────
function setupSpeechRecognition() {
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRec) {
    showToast("Your browser doesn't support speech recognition.");
    return;
  }
  recognition = new SpeechRec();
  recognition.lang = 'en-GB';
  recognition.continuous = true;
  recognition.interimResults = true; // Enables live typing

  let currentInterimElement = null;

  recognition.onresult = (event) => {
    let finalTranscript = '';
    let interimTranscript = '';

    for (let i = event.resultIndex; i < event.results.length; ++i) {
      if (event.results[i].isFinal) {
        finalTranscript += event.results[i][0].transcript;
      } else {
        interimTranscript += event.results[i][0].transcript;
      }
    }

    if (finalTranscript) {
      finalTranscript = finalTranscript.trim();
      
      // Apply user-defined STT Correction Rules
      if (state.sttRules && state.sttRules.length > 0) {
        state.sttRules.forEach(r => {
           if (!r.heard) return;
           const regex = new RegExp(r.heard.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
           finalTranscript = finalTranscript.replace(regex, r.meant);
        });
      }
      
      if (elEmpty) elEmpty.style.display = 'none';
      
      // Check Daily Missions
      if (state.dailyMissions) {
        let missionCompleted = false;
        let pronunciationAlerts = [];
        const cleanTranscript = finalTranscript.toLowerCase().replace(/[.,!?]/g, '');
        
        state.dailyMissions.forEach((m, idx) => {
          if (!m.hit) {
            const targetClean = m.text.toLowerCase().replace(/[.,!?]/g, '');
            const sim = findBestMatch(cleanTranscript, targetClean);
            
            if (cleanTranscript.includes(targetClean) || sim >= 0.80) {
              m.hit = true;
              missionCompleted = true;
              phrasesHitThisCall++;
              if (statHits) statHits.textContent = phrasesHitThisCall;
              
              const card = $(`mission-${idx}`);
              if (card) {
                card.classList.add('hit');
                card.querySelector('.status-icon').textContent = '✅';
              }
              
              if (elPhraseCeleb) {
                elPhraseCeleb.textContent = 'Phrase Hit! +10 XP';
                elPhraseCeleb.classList.remove('hidden');
                elPhraseCeleb.style.animation = 'none';
                elPhraseCeleb.offsetHeight; /* trigger reflow */
                elPhraseCeleb.style.animation = null;
                setTimeout(() => elPhraseCeleb.classList.add('hidden'), 1500);
              }
              
              awardXP(10);
            } else if (sim >= 0.65 && sim < 0.80) {
               // Pronunciation Error (Near Miss)
               pronunciationAlerts.push({
                 target: m.text,
                 heard: finalTranscript,
                 sim: Math.round(sim * 100)
               });
            }
          }
        });
        if (missionCompleted) saveState();
        
        // Render Alerts
        pronunciationAlerts.forEach(alert => {
          if (!state.currentCallAlerts) state.currentCallAlerts = [];
          state.currentCallAlerts.push(alert);

          const alertEl = document.createElement('div');
          alertEl.className = 't-line scored-BAD';
          alertEl.style.marginTop = '8px';
          alertEl.innerHTML = `
            <div class="t-text" style="color:var(--amber); font-size: 12px; font-weight: bold;">
               ⚠️ Pronunciation Alert (${alert.sim}% match)
            </div>
            <div class="t-hint" style="color:var(--text); background:transparent; padding: 4px 0 0 0;">
               You tried to say: <i style="color:var(--cyan);">"${alert.target}"</i><br>
               System heard: <i>"${alert.heard}"</i>
            </div>`;
          elTranscript.appendChild(alertEl);
          elTranscript.scrollTop = elTranscript.scrollHeight;
        });
      }
      
      const ts = new Date().toLocaleTimeString('en-GB', { hour12: false });
      transcriptLines.push({ ts, text: finalTranscript });
      
      wordCount += finalTranscript.split(/\s+/).filter(w => w.length > 0).length;
      if (statWords) statWords.textContent = wordCount;
      
      if (currentInterimElement) {
        currentInterimElement.remove();
        currentInterimElement = null;
      }

      const lineEl = document.createElement('div');
      lineEl.className = 't-line';
      lineEl.innerHTML = `<div class="t-text">${finalTranscript}</div>`;
      elTranscript.appendChild(lineEl);
      elTranscript.scrollTop = elTranscript.scrollHeight;

      getQuickHint(finalTranscript, lineEl);
      triggerSmartPrompter(finalTranscript);
    }

    if (interimTranscript) {
      if (elEmpty) elEmpty.style.display = 'none';
      if (!currentInterimElement) {
        currentInterimElement = document.createElement('div');
        currentInterimElement.className = 't-interim';
        elTranscript.appendChild(currentInterimElement);
      }
      currentInterimElement.textContent = interimTranscript;
      elTranscript.scrollTop = elTranscript.scrollHeight;
    }
  };

  recognition.onerror = (e) => { 
    console.warn('Speech error:', e.error);
    if (e.error !== 'no-speech') showToast('Speech Error: ' + e.error);
  };
  recognition.onend = () => { if (isRecording) recognition.start(); };
}

// ── SMART PROMPTER ─────────────────────────────────────────────
const elPrompter = $('smart-prompter');
const elPrompterText = $('prompter-text');
let prompterHideTimer = null;

// Build a smart suggestion pool from past AI improvements
function buildSuggestionPool() {
  const pool = {};
  // Base keyword triggers with Bershka tone
  const BASE_TRIGGERS = [
    { keywords: ['refund', 'money', 'return'], suggestion: 'I\'ll arrange a refund for you right away.' },
    { keywords: ['order', 'parcel', 'package', 'delivery'], suggestion: 'I can look into your order status now.' },
    { keywords: ['delay', 'late', 'wait'], suggestion: 'I\'m sorry for the inconvenience — let me check what\'s happening.' },
    { keywords: ['size', 'exchange', 'change'], suggestion: 'I can help you exchange that for the right size.' },
    { keywords: ['track', 'courier', 'shipped'], suggestion: 'Let me pull up the tracking information for you.' },
    { keywords: ['cancel', 'cancellation'], suggestion: 'I\'ll cancel that order for you immediately.' },
    { keywords: ['hello', 'hi', 'hey', 'good morning', 'good afternoon'], suggestion: 'Thank you for calling Bershka, how can I help you today?' },
    { keywords: ['email', 'confirmation', 'receipt'], suggestion: 'I\'ll send you a confirmation email right now.' },
    { keywords: ['discount', 'promo', 'code', 'voucher'], suggestion: 'I\'d be happy to look into any promotions for you.' },
    { keywords: ['sorry', 'apolog', 'mistake'], suggestion: 'I completely understand, and I sincerely apologise for this.' },
    { keywords: ['hold', 'minute', 'moment'], suggestion: 'Could you bear with me for just one moment?' },
    { keywords: ['name', 'account', 'email'], suggestion: 'Could I take your full name and email address, please?' },
  ];

  // Inject learnings from past AI improvements
  if (state.calls) {
    state.calls.forEach(c => {
      if (!c.improvements) return;
      c.improvements.forEach(imp => {
        if (!imp.original || !imp.better) return;
        // Use words from the ORIGINAL (bad) phrase as keyword triggers
        const keywords = imp.original.toLowerCase().replace(/[^a-z ]/g,'').split(' ').filter(w => w.length > 3);
        if (keywords.length > 0) {
          BASE_TRIGGERS.push({ keywords, suggestion: imp.better });
        }
      });
    });
  }
  return BASE_TRIGGERS;
}

function triggerSmartPrompter(transcript) {
  if (!elPrompter || !elPrompterText) return;
  const lower = transcript.toLowerCase();
  const pool = buildSuggestionPool();

  for (const trigger of pool) {
    const hit = trigger.keywords.some(kw => lower.includes(kw));
    if (hit) {
      if (prompterHideTimer) clearTimeout(prompterHideTimer);
      elPrompterText.textContent = trigger.suggestion;
      elPrompter.classList.remove('hidden');
      // Auto-hide after 6 seconds
      prompterHideTimer = setTimeout(() => {
        elPrompter.classList.add('hidden');
      }, 6000);
      break; // Only show one suggestion at a time
    }
  }
}

async function getQuickHint(text, lineEl) {
  if (text.split(' ').length < 4) return;
  try {
    const res = await fetchWithFallback({
      model: OLLAMA_MODEL, stream: false,
      messages: [{
        role: 'user',
        content: `You are a British English coach for a Bershka customer service agent. The tone should be friendly, modern and approachable.
If the phrase makes absolutely no sense in English (gibberish/nonsense words), it means the user put the customer on hold and is speaking Spanish to their team. In this case, respond STRICTLY with "IGNORE|" and nothing else.
Evaluate this phrase in ONE short sentence.
Rate: GOOD / OK / BAD. Format strictly: RATING|tip
Phrase: "${text}"`
      }]
    });
    const data = await res.json();
    const reply = data.message?.content?.trim() || '';
    const [rating, tip] = reply.split('|');
    if (!rating || !tip || rating.includes('IGNORE')) return;

    const cl = rating.includes('GOOD') ? 'GOOD' : rating.includes('BAD') ? 'BAD' : 'OK';
    const hintDiv = document.createElement('div');
    hintDiv.className = `t-hint`;
    hintDiv.textContent = tip.trim();
    lineEl.appendChild(hintDiv);
    lineEl.classList.add(`scored-${cl}`);
    elTranscript.scrollTop = elTranscript.scrollHeight;
  } catch (e) {
    console.warn('[Coach] Quick hint error:', e);
  }
}

// ── AUDIO VISUALIZER ──────────────────────────────────────────
async function initAudioVisualizer() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioContext.createAnalyser();
    microphone = audioContext.createMediaStreamSource(stream);
    microphone.connect(analyser);
    analyser.fftSize = 256;
    drawWaveform();
  } catch (err) {
    console.warn('Microphone access denied', err);
    showToast('Microphone access is required.');
  }
}

function drawWaveform() {
  const canvas = $('waveform');
  const ctx = canvas.getContext('2d');
  
  // Resize canvas to match display size
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);

  const W = rect.width;
  const H = rect.height;
  const bufferLength = analyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);

  function draw() {
    if (!isRecording) {
      ctx.clearRect(0, 0, W, H);
      ctx.beginPath();
      ctx.moveTo(0, H/2);
      ctx.lineTo(W, H/2);
      ctx.strokeStyle = 'rgba(255,255,255,0.1)';
      ctx.lineWidth = 2;
      ctx.stroke();
      if(isPaused) drawVisual = requestAnimationFrame(draw);
      return;
    }
    drawVisual = requestAnimationFrame(draw);
    analyser.getByteFrequencyData(dataArray);

    ctx.clearRect(0, 0, W, H);
    
    ctx.beginPath();
    ctx.moveTo(0, H / 2);
    
    let x = 0;
    const sliceWidth = W / bufferLength;
    
    // Draw top half smooth curve
    for (let i = 0; i < bufferLength; i++) {
      let v = dataArray[i] / 255.0;
      let windowFactor = Math.sin((i / bufferLength) * Math.PI); // Smooth edges
      let y = (H / 2) - (v * (H / 2) * windowFactor * 1.5); // 1.5x amplification
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      x += sliceWidth;
    }
    
    // Draw bottom half symmetric
    for (let i = bufferLength - 1; i >= 0; i--) {
      let v = dataArray[i] / 255.0;
      let windowFactor = Math.sin((i / bufferLength) * Math.PI);
      let y = (H / 2) + (v * (H / 2) * windowFactor * 1.5);
      x -= sliceWidth;
      ctx.lineTo(x, y);
    }
    ctx.closePath();
    
    const gradient = ctx.createLinearGradient(0, 0, W, 0);
    gradient.addColorStop(0, '#6EE7FF');
    gradient.addColorStop(0.5, '#a78bfa');
    gradient.addColorStop(1, '#6EE7FF');
    
    ctx.fillStyle = gradient;
    ctx.fill();
    ctx.shadowColor = '#a78bfa';
    ctx.shadowBlur = 20;
  }
  draw();
}

// ── EVENTS ────────────────────────────────────────────────────
function setupEvents() {
  btnStart.addEventListener('click', () => {
    isRecording = true;
    isPaused = false;
    transcriptLines = [];
    
    // Clear previous transcript items except empty-state
    Array.from(elTranscript.children).forEach(c => {
      if(c.id !== 'empty-state') c.remove();
    });
    
    btnStart.classList.add('hidden');
    btnNew.classList.add('hidden');
    btnAnalyze.classList.add('hidden');
    
    btnPause.classList.remove('hidden');
    btnPause.textContent = '⏸ Pause';
    btnHold.classList.remove('hidden');
    btnHold.textContent = '🎧 Consult Team';
    btnHold.style.backgroundColor = 'var(--amber)';
    isOnHold = false;
    btnEnd.classList.remove('hidden');
    recDot.classList.remove('hidden');
    
    secondsElapsed = 0;
    wordCount = 0;
    phrasesHitThisCall = 0;
    state.currentCallAlerts = [];
    state._pendingCallId = null;
    if(statTime) statTime.textContent = '00:00';
    if(statWords) statWords.textContent = '0';
    if(statHits) statHits.textContent = '0';
    if(callStats) callStats.classList.remove('hidden');
    
    if (callTimer) clearInterval(callTimer);
    callTimer = setInterval(() => {
      if (isRecording && !isPaused) {
        secondsElapsed++;
        if(statTime) statTime.textContent = formatTime(secondsElapsed);
      }
    }, 1000);
    
    if(recognition) {
      try { recognition.start(); } catch(e) { console.error('Start error:', e); }
    }
    initAudioVisualizer(); // Removed await so recognition starts immediately
    awardXP(5); // Start call reward
  });

  btnPause.addEventListener('click', () => {
    isPaused = !isPaused;
    if (isPaused) {
      btnPause.textContent = '▶ Resume';
      isRecording = false; // Pauses waveform
      recDot.classList.add('hidden');
      if(recognition) recognition.stop();
      if(audioContext) audioContext.suspend();
    } else {
      btnPause.textContent = '⏸ Pause';
      isRecording = true;
      recDot.classList.remove('hidden');
      if(recognition) {
        try { recognition.start(); } catch(e) {}
      }
      if(audioContext) audioContext.resume();
    }
  });

  btnHold.addEventListener('click', () => {
    isOnHold = !isOnHold;
    if (isOnHold) {
      btnHold.textContent = '🎙️ Back to Customer';
      btnHold.style.backgroundColor = 'var(--red)';
      
      // Stop listening to English while speaking Spanish
      isRecording = false; 
      if (recognition) recognition.stop();
      if (audioContext) audioContext.suspend();
      
      // Inject hold marker
      const ts = formatTime(secondsElapsed);
      transcriptLines.push({ ts, text: '[Consulting with team in Spanish...]' });
      const holdEl = document.createElement('div');
      holdEl.className = 't-line';
      holdEl.innerHTML = `<span class="t-time" style="color:var(--amber)">[${ts}]</span> <span style="color:var(--amber); font-style:italic;">[Consulting with team in Spanish...]</span>`;
      elTranscript.appendChild(holdEl);
      elTranscript.scrollTop = elTranscript.scrollHeight;

    } else {
      btnHold.textContent = '🎧 Consult Team';
      btnHold.style.backgroundColor = 'var(--amber)';
      
      // Resume English recognition
      isRecording = true;
      if (recognition) { try { recognition.start(); } catch(e) {} }
      if (audioContext) audioContext.resume();
      
      // Inject return marker
      const ts = formatTime(secondsElapsed);
      transcriptLines.push({ ts, text: '[Returned to Customer]' });
      const holdEl = document.createElement('div');
      holdEl.className = 't-line';
      holdEl.innerHTML = `<span class="t-time" style="color:var(--green)">[${ts}]</span> <span style="color:var(--green); font-style:italic;">[Returned to Customer]</span>`;
      elTranscript.appendChild(holdEl);
      elTranscript.scrollTop = elTranscript.scrollHeight;
    }
  });

  btnEnd.addEventListener('click', () => {
    isRecording = false;
    isPaused = false;
    if(recognition) recognition.stop();
    if(audioContext) audioContext.suspend();
    cancelAnimationFrame(drawVisual);
    
    btnPause.classList.add('hidden');
    btnHold.classList.add('hidden');
    btnEnd.classList.add('hidden');
    recDot.classList.add('hidden');
    
    btnNew.classList.remove('hidden');
    btnAnalyze.classList.remove('hidden');
    if (transcriptLines.length > 0) {
      btnAnalyze.disabled = false;
      btnAnalyze.classList.add('btn-analyze-magic');
    } else {
      btnAnalyze.disabled = true;
      btnAnalyze.classList.remove('btn-analyze-magic');
    }
    
    if (callTimer) clearInterval(callTimer);
    
    // ── AUTO-BACKUP: Save raw session immediately on End Call ──
    if (transcriptLines.length > 0) {
      state._pendingCallId = Date.now();
      state.calls.unshift({
        _id: state._pendingCallId,
        date: new Date().toISOString(),
        wordCount: wordCount || 0,
        duration: secondsElapsed,
        score: null,          // null = not yet analyzed
        summary: 'Session recorded — awaiting AI analysis',
        rawTranscript: transcriptLines.map(l => `[${l.ts}] ${l.text}`).join('\n'),
        phrasesHit: phrasesHitThisCall,
        pronunciationAlerts: state.currentCallAlerts || []
      });
      saveState();
      showToast('Session saved! Press ✦ Analyze for full report.');
    }
  });

  btnNew.addEventListener('click', () => {
    transcriptLines = [];
    Array.from(elTranscript.children).forEach(c => {
      if(c.id !== 'empty-state') c.remove();
    });
    if($('empty-state')) $('empty-state').style.display = 'block';

    const canvas = $('waveform');
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    btnNew.classList.add('hidden');
    btnAnalyze.classList.add('hidden');
    btnAnalyze.classList.remove('btn-analyze-magic');
    btnStart.classList.remove('hidden');
    if (callStats) callStats.classList.add('hidden');
    if (callTimer) clearInterval(callTimer);
  });

    btnAnalyze.addEventListener('click', async () => {
    btnAnalyze.disabled = true;
    btnAnalyze.classList.remove('btn-analyze-magic');
    btnAnalyze.textContent = 'Analyzing...';
    try {
      await runAnalysis();
    } catch(err) {
      console.error('Analysis error:', err);
      showToast('Analysis failed. Your session is already backed up.');
      btnAnalyze.disabled = false; // Allow retry
    }
    btnAnalyze.textContent = '✦ Analyze';
  });

  window.retryAnalysis = async function(callId, btnEl) {
    btnEl.disabled = true;
    btnEl.textContent = '...';
    try {
      await runAnalysis(callId);
      showToast('Analysis recovered successfully!');
      renderHistory(); // refresh the list
    } catch(e) {
      btnEl.disabled = false;
      btnEl.textContent = 'Retry';
      showToast('Retry failed.');
    }
  };

  btnHistory.addEventListener('click', renderHistory);
  $('close-history').addEventListener('click', () => $('view-history').classList.add('hidden'));
  $('close-analysis').addEventListener('click', () => $('modal-analysis').classList.add('hidden'));
  if (btnRefreshPhrases) {
    btnRefreshPhrases.addEventListener('click', () => {
      generateDailyMissions();
      showToast("Missions refreshed!");
    });
  }

  if (btnAddPhrase && elCustomPhraseInput) {
    btnAddPhrase.addEventListener('click', async () => {
      const text = elCustomPhraseInput.value.trim();
      if (!text) return;
      
      btnAddPhrase.disabled = true;
      btnAddPhrase.textContent = '...';
      
      try {
        const res = await fetchWithFallback({
          model: OLLAMA_MODEL, stream: false,
          messages: [{
            role: 'user',
            content: `Translate the following Spanish phrase into a natural, friendly, British English customer service phrase for Bershka. Respond ONLY with the translated English phrase, no quotes, no explanations.\nPhrase: "${text}"`
          }]
        });
        const data = await res.json();
        let englishPhrase = data.message?.content?.trim() || '';
        englishPhrase = englishPhrase.replace(/^["']|["']$/g, ''); // Remove quotes if any
        
        if (englishPhrase) {
          if (!state.learnedPhrases) state.learnedPhrases = [];
          if (!state.learnedPhrases.includes(englishPhrase)) {
            state.learnedPhrases.push(englishPhrase);
            
            // Add directly to today's missions to practice immediately
            if (state.dailyMissions && state.dailyMissions.length < 5) {
               state.dailyMissions.push({ text: englishPhrase, hit: false });
               renderMissions();
            }
            
            renderVocabBank();
            saveState();
            showToast("Custom phrase translated & added!");
            elCustomPhraseInput.value = '';
          } else {
             showToast("Phrase already exists in your bank.");
          }
        }
      } catch (e) {
        console.error("Translation error:", e);
        showToast("Translation failed. Try again.");
      } finally {
        btnAddPhrase.disabled = false;
        btnAddPhrase.textContent = 'Add';
      }
    });
  }

  const btnAddSttRule = $('btn-add-stt-rule');
  if (btnAddSttRule) {
    btnAddSttRule.addEventListener('click', () => {
       const heard = $('stt-heard').value.trim();
       const meant = $('stt-meant').value.trim();
       if (heard && meant) {
          if (!state.sttRules) state.sttRules = [];
          state.sttRules.push({ heard, meant });
          saveState();
          renderSttRules();
          $('stt-heard').value = '';
          $('stt-meant').value = '';
          showToast("Rule saved! The mic will now autocorrect this.");
       }
    });
  }
}

// ── TRAINING ROOM ────────────────────────────────────────────────
function setupTrainingRoom() {
  const btnTraining  = $('btn-training');
  const modal        = $('modal-training');
  const btnClose     = $('close-training');
  const btnRecord    = $('btn-train-record');
  const btnNext      = $('btn-train-next');
  const btnPrev      = $('btn-train-prev');
  const btnSkip      = $('btn-train-skip');
  const elPhraseText = $('training-phrase-text');
  const elCounter    = $('training-phrase-counter');
  const elRulesCount = $('training-rules-count');
  const elProgress   = $('training-progress-fill');
  const elResult     = $('training-result');
  const elHeard      = $('tr-heard');
  const elTarget     = $('tr-target');
  const elOutcome    = $('tr-outcome');
  const elIcon       = $('train-record-icon');
  const elLabel      = $('train-record-label');

  if (!btnTraining || !modal) return;

  let phrases = [];
  let currentIdx = 0;
  let trainRec = null;
  let isTrainRecording = false;
  let sessionRulesSaved = 0;

  function buildTrainingPhrases() {
    const pool = new Set();
    // Priority 1: current missions
    if (state.dailyMissions) state.dailyMissions.forEach(m => pool.add(m.text));
    // Priority 2: vocab bank
    if (state.learnedPhrases) state.learnedPhrases.forEach(p => pool.add(p));
    // Priority 3: base phrases
    BASE_PHRASES.forEach(p => pool.add(p));
    return [...pool];
  }

  function renderTrainingPhrase() {
    if (!phrases.length) return;
    const phrase = phrases[currentIdx];
    elPhraseText.textContent = `"${phrase}"`;
    elCounter.textContent = `Phrase ${currentIdx + 1} of ${phrases.length}`;
    elProgress.style.width = `${((currentIdx + 1) / phrases.length) * 100}%`;
    elRulesCount.textContent = `✅ ${(state.sttRules || []).length} rules saved`;
    // Reset result area
    elResult.classList.add('hidden');
    elOutcome.className = 'tr-outcome';
    elOutcome.textContent = '';
    btnRecord.classList.remove('recording');
    elIcon.textContent = '🎤';
    elLabel.textContent = 'Tap & Say It';
    isTrainRecording = false;
  }

  function processTrainingResult(target, heard) {
    const targetClean = target.toLowerCase().replace(/[.,!?]/g, '');
    const heardClean  = heard.toLowerCase().replace(/[.,!?]/g, '');
    const sim = findBestMatch(heardClean, targetClean);

    elHeard.textContent  = `"${heard}"`;
    elTarget.textContent = `"${target}"`;
    elResult.classList.remove('hidden');

    if (sim >= 0.80) {
      // Perfect — no rule needed
      elOutcome.className = 'tr-outcome success';
      elOutcome.textContent = '✨ Great pronunciation! No correction needed.';
      awardXP(5);
      showToast('+5 XP — Pronounced correctly!');
    } else if (sim >= 0.45) {
      // Different enough — auto-save rule
      // Find the most different word chunk between heard and target
      const heardWords  = heardClean.split(' ').filter(w => w.length > 2);
      const targetWords = targetClean.split(' ').filter(w => w.length > 2);
      // Find heard words NOT in target — those are the mishearings
      const misheard = heardWords.filter(w => !targetWords.some(tw => calculateSimilarity(w, tw) > 0.7));
      const ruleFrom = misheard.length > 0 ? misheard.join(' ') : heard;

      if (!state.sttRules) state.sttRules = [];
      // Avoid duplicate rules
      const alreadyExists = state.sttRules.some(r => r.heard.toLowerCase() === ruleFrom.toLowerCase());
      if (!alreadyExists && ruleFrom.trim()) {
        state.sttRules.push({ heard: ruleFrom, meant: target });
        saveState();
        renderSttRules();
        sessionRulesSaved++;
        elRulesCount.textContent = `✅ ${state.sttRules.length} rules saved`;
        awardXP(10);
        showToast(`🛠 Auto-rule saved! +10 XP`);
      }
      elOutcome.className = 'tr-outcome saved';
      elOutcome.textContent = `🛠 Rule auto-saved: "${ruleFrom}" ➜ "${target}"`;
    } else {
      // Too different — probably noise
      elOutcome.className = 'tr-outcome';
      elOutcome.textContent = '⚠️ Too much noise. Try again in a quieter spot.';
      elOutcome.style.color = 'var(--text-dim)';
    }
  }

  function startTrainRecording() {
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRec) { showToast('Speech recognition not supported.'); return; }
    trainRec = new SpeechRec();
    trainRec.lang = 'en-GB';
    trainRec.continuous = false;
    trainRec.interimResults = false;
    trainRec.onresult = (e) => {
      const heard = e.results[0][0].transcript.trim();
      const target = phrases[currentIdx];
      stopTrainRecording();
      processTrainingResult(target, heard);
    };
    trainRec.onerror = (e) => {
      stopTrainRecording();
      showToast('Could not hear you. Try again.');
    };
    trainRec.onend = () => {
      if (isTrainRecording) stopTrainRecording();
    };
    trainRec.start();
    isTrainRecording = true;
    btnRecord.classList.add('recording');
    elIcon.textContent = '⏹️';
    elLabel.textContent = 'Recording...';
  }

  function stopTrainRecording() {
    if (trainRec) { try { trainRec.stop(); } catch(e) {} trainRec = null; }
    isTrainRecording = false;
    btnRecord.classList.remove('recording');
    elIcon.textContent = '🎤';
    elLabel.textContent = 'Tap & Say It';
  }

  // Open modal
  btnTraining.addEventListener('click', () => {
    phrases = buildTrainingPhrases();
    currentIdx = 0;
    sessionRulesSaved = 0;
    renderTrainingPhrase();
    modal.classList.remove('hidden');
  });

  btnClose.addEventListener('click', () => {
    stopTrainRecording();
    modal.classList.add('hidden');
    if (sessionRulesSaved > 0) {
      showToast(`🎓 Training complete! ${sessionRulesSaved} new rule${sessionRulesSaved > 1 ? 's' : ''} saved.`);
    }
  });

  btnRecord.addEventListener('click', () => {
    if (isTrainRecording) { stopTrainRecording(); return; }
    startTrainRecording();
  });

  btnNext.addEventListener('click', () => {
    if (currentIdx < phrases.length - 1) { currentIdx++; renderTrainingPhrase(); }
    else { showToast('🏆 All phrases completed! Great session.'); }
  });

  btnPrev.addEventListener('click', () => {
    if (currentIdx > 0) { currentIdx--; renderTrainingPhrase(); }
  });

  btnSkip.addEventListener('click', () => {
    if (currentIdx < phrases.length - 1) { currentIdx++; renderTrainingPhrase(); }
  });
}

// ── ANALYSIS LOGIC ──────────────────────────────────────────────────
async function runAnalysis(retryCallId = null) {
  let text = '';
  let alerts = [];

  if (retryCallId) {
    const c = state.calls.find(x => x._id === retryCallId);
    if (!c) throw new Error("Call not found");
    text = c.rawTranscript;
    alerts = c.pronunciationAlerts || [];
    state._pendingCallId = retryCallId;
  } else {
    text = transcriptLines.map(l => `[${l.ts}] ${l.text}`).join('\n');
    alerts = state.currentCallAlerts || [];
  }

  const contextAlerts = alerts.length > 0 
    ? `\nIMPORTANT CONTEXT: The user had pronunciation errors (the system transcribed them wrongly). Here are their attempts:\n` + 
      alerts.map(a => `- Tried to say: "${a.target}" but it sounded like: "${a.heard}"`).join('\n') +
      `\nFocus heavily on giving phonetics tips on how to correctly pronounce the specific words they failed on.`
    : '';

  try {
    const res = await fetchWithFallback({
      model: OLLAMA_MODEL, stream: false,
      messages: [{
        role: 'user',
        content: `You are an expert British English coach for a Bershka customer service agent. The brand tone is friendly, modern, and close to the customer (polite but not overly formal or stiff). ${contextAlerts}
Analyze this transcript. CRITICAL RULE: If you see blocks of text that make absolutely no sense in English (gibberish/nonsense words) but might phonetically sound like Spanish, IGNORE THEM COMPLETELY. The user is putting the customer on hold and talking to their internal team in Spanish. DO NOT penalize the user for this, DO NOT list it as a pronunciation error, and DO NOT mention it in the summary.
Respond ONLY in valid JSON.

Transcript:
${text}

Respond with exact structure: {"score":<0-100>,"scoreLabel":"<Label>","summary":"<summary>","strengths":["<s1>","<s2>"],"improvements":[{"original":"<o>","better":"<b>","why":"<w>"}],"vocabulary":["<v1>","<v2>"],"xpEarned":<10-50>}`
      }]
    });
    
    const data = await res.json();
    let raw = data.message?.content?.trim() || '{}';
    raw = raw.replace(/```json|```/g, '').trim();
    
    // Fallback to extract JSON if ollama hallucinates wrapper text
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) raw = jsonMatch[0];
    
    let result;
    try {
      result = JSON.parse(raw);
    } catch (jsonErr) {
      console.warn("JSON parse failed. Attempting sanitization...", jsonErr);
      // Basic sanitization for common LLM JSON errors
      let sanitized = raw.replace(/,\s*([}\]])/g, '$1'); // trailing commas
      sanitized = sanitized.replace(/[\u0000-\u001F]+/g, " "); // control chars
      try {
        result = JSON.parse(sanitized);
      } catch (e2) {
        throw new Error("AI returned malformed JSON structure.");
      }
    }

    // Adaptive Learning: Save new vocabulary
    if (result.vocabulary && Array.isArray(result.vocabulary)) {
      if (!state.learnedPhrases) state.learnedPhrases = [];
      let newVocabAdded = false;
      result.vocabulary.forEach(v => {
        if (typeof v === 'string' && !state.learnedPhrases.includes(v)) {
          state.learnedPhrases.push(v);
          newVocabAdded = true;
        }
      });
      if (newVocabAdded) {
        renderVocabBank();
      }
    }

    const oldLevel = getLevelInfo(state.xp).level;
    awardXP(result.xpEarned || 20);
    const newLevel = getLevelInfo(state.xp).level;
    if (newLevel > oldLevel) fireParticles();

    // Enrich the existing backup record (don't create a duplicate)
    const pendingIdx = state.calls.findIndex(c => c._id === state._pendingCallId);
    const enriched = {
      date: pendingIdx >= 0 ? state.calls[pendingIdx].date : new Date().toISOString(),
      wordCount: pendingIdx >= 0 ? state.calls[pendingIdx].wordCount : (wordCount || 0),
      duration: pendingIdx >= 0 ? state.calls[pendingIdx].duration : secondsElapsed,
      phrasesHit: pendingIdx >= 0 ? (state.calls[pendingIdx].phrasesHit || 0) : phrasesHitThisCall,
      pronunciationAlerts: pendingIdx >= 0 ? (state.calls[pendingIdx].pronunciationAlerts || []) : (state.currentCallAlerts || []),
      ...result // Full AI result (score, summary, improvements, vocabulary, etc.)
    };
    if (pendingIdx >= 0) {
      state.calls[pendingIdx] = enriched; // Update in place
    } else {
      state.calls.unshift(enriched); // Fallback: no backup found, insert new
    }
    state._pendingCallId = null;
    saveState();

    renderAnalysisModal(result);
  } catch (e) {
    console.error('[Coach] Analysis failed:', e);
    showToast('⚠️ Analysis failed — session already saved as backup.');
  }
}

function renderAnalysisModal(data) {
  let html = `
    <div class="an-score">${data.score || 0}</div>
    <div class="an-label">${data.scoreLabel || 'Completed'}</div>
    <div class="an-summary">${data.summary || 'Session analyzed.'}</div>
  `;

  if (data.strengths?.length) {
    html += `<div class="an-section"><h3>✨ Strengths</h3><div class="an-list">` + 
      data.strengths.map(s => `<div class="an-list-item">${s}</div>`).join('') + `</div></div>`;
  }
  if (data.improvements?.length) {
    html += `<div class="an-section"><h3>🛠 Improvements</h3><div class="an-list">` + 
      data.improvements.map(i => `<div class="an-list-item an-imp"><div class="an-imp-orig">"${i.original}"</div><div class="an-imp-better">${i.better}</div><div class="an-imp-why">${i.why}</div></div>`).join('') + `</div></div>`;
  }
  if (data.vocabulary?.length) {
    html += `<div class="an-section"><h3>📚 Pro Vocabulary</h3><div class="an-list">` + 
      data.vocabulary.map(v => `<div class="an-list-item">${v}</div>`).join('') + `</div></div>`;
  }
  
  html += `<div style="text-align:center; margin-top:20px; color:var(--cyan); font-family:var(--mono);">+${data.xpEarned} XP Earned</div>`;

  $('analysis-content').innerHTML = html;
  $('modal-analysis').classList.remove('hidden');
}

function renderHistory() {
  $('fs-stat-calls').textContent = state.calls.length;
  if(state.calls.length > 0) {
    const totalScore = state.calls.reduce((s,c)=>s+(c.score||0),0);
    const avg = Math.round(totalScore/state.calls.length);
    $('fs-stat-avg').textContent = avg;
    $('fs-stat-avg').style.color = avg >= 75 ? 'var(--green)' : avg >= 50 ? 'var(--amber)' : 'var(--red)';
    
    const totalWords = state.calls.reduce((s,c)=>s+(c.wordCount||0),0);
    $('fs-stat-words').textContent = totalWords;
    
    const totalXP = state.calls.reduce((s,c)=>s+(c.xpEarned||0),0);
    $('fs-stat-xp').textContent = totalXP;
  }

  // Draw Trend Charts (últimas 15 llamadas)
  const recentCalls = state.calls.slice(0, 15).reverse();
  
  // Score Chart
  $('fs-trend-score').innerHTML = recentCalls.map(c => {
    const score = c.score || 0;
    const cl = score >= 75 ? 'trend-GOOD' : score >= 50 ? 'trend-OK' : 'trend-BAD';
    return `<div class="trend-bar ${cl}" style="height: ${Math.max(5, score)}%"><span>${score}</span></div>`;
  }).join('');
  
  // Words per Call Chart
  const maxWords = Math.max(...recentCalls.map(c => c.wordCount || 10));
  $('fs-trend-words').innerHTML = recentCalls.map(c => {
    const words = c.wordCount || 0;
    const h = Math.max(5, (words / maxWords) * 100);
    return `<div class="trend-bar trend-NEUTRAL" style="height: ${h}%"><span>${words}</span></div>`;
  }).join('');

  // Data Mining: Top Mastered Phrases
  const vocabFreq = {};
  state.calls.forEach(c => {
    if (c.vocabulary && Array.isArray(c.vocabulary)) {
      c.vocabulary.forEach(v => {
        if (typeof v === 'string') {
          const w = v.toLowerCase();
          vocabFreq[w] = (vocabFreq[w] || 0) + 1;
        }
      });
    }
  });
  
  const sortedVocab = Object.keys(vocabFreq)
    .sort((a,b) => vocabFreq[b] - vocabFreq[a])
    .slice(0, 15);
    
  if (sortedVocab.length > 0) {
    $('fs-top-words').innerHTML = sortedVocab.map(v => 
      `<div class="top-word-tag">${v} <span class="top-word-count">x${vocabFreq[v]}</span></div>`
    ).join('');
  } else {
    $('fs-top-words').innerHTML = '<p class="mission-subtitle">No vocabulary data yet. Complete more calls!</p>';
  }

  $('history-list').innerHTML = state.calls.map((c, idx) => {
    const d = new Date(c.date);
    const dStr = `${d.toLocaleDateString('en-GB')} ${d.toLocaleTimeString('en-GB', {hour:'2-digit',minute:'2-digit'})}`;
    const score = c.score || 0;
    const color = score >= 75 ? 'var(--green)' : score >= 50 ? 'var(--amber)' : 'var(--red)';
    const sum = c.summary ? c.summary.substring(0,60) + '...' : 'Review details';
    
    if (c.score === null) {
      return `<div class="history-item" style="display:flex; justify-content:space-between; align-items:center;">
        <div>
          <div class="hi-date">${dStr}</div>
          <div style="font-size:12px; color:var(--amber); margin-top:6px;">⚠️ Pending AI Analysis</div>
        </div>
        <button class="btn btn-sm" onclick="event.stopPropagation(); retryAnalysis(${c._id}, this)" style="background:var(--cyan); color:var(--bg); border:none; padding:6px 12px; border-radius:4px; font-weight:600;">Retry</button>
      </div>`;
    }
    
    return `<div class="history-item" onclick="openHistoricalAnalysis(${idx})">
      <div>
        <div class="hi-date">${dStr}</div>
        <div style="font-size:12px; color:var(--text-dim); margin-top:6px;">${sum} <span style="color:var(--cyan)">👉</span></div>
      </div>
      <div class="hi-score" style="color:${color}">${score}</div>
    </div>`;
  }).join('');

  $('view-history').classList.remove('hidden');
}

window.openHistoricalAnalysis = function(idx) {
  const data = state.calls[idx];
  renderAnalysisModal(data);
};

// ── XP & PARTICLES ────────────────────────────────────────────
function awardXP(amount) {
  state.xp += amount;
  saveState();
}

function fireParticles() {
  const canvas = $('particles-canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  
  const particles = [];
  const colors = ['#6EE7FF', '#a78bfa', '#22c55e', '#f59e0b'];
  
  for(let i=0; i<100; i++) {
    particles.push({
      x: canvas.width/2, y: canvas.height/2,
      vx: (Math.random()-0.5)*20, vy: (Math.random()-0.5)*20,
      size: Math.random()*5+2,
      color: colors[Math.floor(Math.random()*colors.length)],
      life: 1
    });
  }

  function render() {
    ctx.clearRect(0,0,canvas.width,canvas.height);
    let alive = false;
    particles.forEach(p => {
      p.x += p.vx; p.y += p.vy;
      p.vy += 0.5; // gravity
      p.life -= 0.02;
      if(p.life > 0) {
        alive = true;
        ctx.globalAlpha = p.life;
        ctx.fillStyle = p.color;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI*2); ctx.fill();
      }
    });
    if(alive) requestAnimationFrame(render);
    else ctx.clearRect(0,0,canvas.width,canvas.height);
  }
  render();
}

// Start
init();
