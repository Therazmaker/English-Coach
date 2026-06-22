// ================================================================
//  ENGLISH COACH - MOBILE WEB APP
// ================================================================

// ── CONFIG ────────────────────────────────────────────────────
// Using corsproxy.io to bypass browser CORS constraints on GitHub pages
const OLLAMA_API   = 'https://corsproxy.io/?https://ollama.com/api/chat';
const OLLAMA_KEY   = 'a749df26093a49c892fece6c0cf7ab36.w1UdR9t19ujmPA2Cycz964Rk';
const OLLAMA_MODEL = 'gemma3:12b';

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
const btnEnd       = $('btn-end');
const btnPause     = $('btn-pause');
const btnNew       = $('btn-new');
const btnAnalyze   = $('btn-analyze');
const btnHistory   = $('btn-history');
const recDot       = $('rec-dot');

const elVocabList    = $('vocab-list');
const elPhraseList   = $('phrase-list');
const btnRefreshPhrases = $('btn-refresh-phrases');
const elPhraseCeleb  = $('phrase-celebration');
const statHits       = $('stat-hits');
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

function formatTime(s) {
  const m = Math.floor(s/60).toString().padStart(2, '0');
  const sec = (s%60).toString().padStart(2, '0');
  return `${m}:${sec}`;
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
  setupSpeechRecognition();
  setupEvents();
}

function loadState() {
  const saved = localStorage.getItem('ec_state');
  if (saved) state = JSON.parse(saved);
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
      if (elEmpty) elEmpty.style.display = 'none';
      
      // Check Daily Missions
      if (state.dailyMissions) {
        let missionCompleted = false;
        const cleanTranscript = finalTranscript.toLowerCase().replace(/[.,!?]/g, '');
        
        state.dailyMissions.forEach((m, idx) => {
          if (!m.hit && cleanTranscript.includes(m.text.toLowerCase().replace(/[.,!?]/g, ''))) {
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
          }
        });
        if (missionCompleted) saveState();
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

async function getQuickHint(text, lineEl) {
  if (text.split(' ').length < 4) return;
  try {
    const res = await fetch(OLLAMA_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + OLLAMA_KEY,
      },
      body: JSON.stringify({
        model: OLLAMA_MODEL, stream: false,
        messages: [{
          role: 'user',
          content: `You are a British English coach for a Bershka customer service agent. The tone should be friendly, modern and approachable, not overly formal. If the phrase makes no sense, it's likely a pronunciation error. Evaluate this phrase in ONE short sentence.\nRate: GOOD / OK / BAD. Format strictly: RATING|tip\nPhrase: "${text}"`
        }]
      })
    });
    const data = await res.json();
    const reply = data.message?.content?.trim() || '';
    const [rating, tip] = reply.split('|');
    if (!rating || !tip) return;

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
    btnEnd.classList.remove('hidden');
    recDot.classList.remove('hidden');
    
    secondsElapsed = 0;
    wordCount = 0;
    phrasesHitThisCall = 0;
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

  btnEnd.addEventListener('click', () => {
    isRecording = false;
    isPaused = false;
    if(recognition) recognition.stop();
    if(audioContext) audioContext.suspend();
    cancelAnimationFrame(drawVisual);
    
    btnPause.classList.add('hidden');
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
    const originalText = btnAnalyze.textContent;
    btnAnalyze.textContent = 'Analyzing...';
    try {
      await runAnalysis();
    } catch(err) {
      alert("Click Error: " + err.message);
    }
    btnAnalyze.textContent = '✦ Analyze';
    btnAnalyze.disabled = false;
  });

  btnHistory.addEventListener('click', renderHistory);
  $('close-history').addEventListener('click', () => $('modal-history').classList.add('hidden'));
  $('close-analysis').addEventListener('click', () => $('modal-analysis').classList.add('hidden'));
  if (btnRefreshPhrases) {
    btnRefreshPhrases.addEventListener('click', () => {
      generateDailyMissions();
      showToast("Missions refreshed!");
    });
  }
}

// ── ANALYSIS LOGIC ──────────────────────────────────────────────────
async function runAnalysis() {
  const text = transcriptLines.map(l => `[${l.ts}] ${l.text}`).join('\n');
  try {
    const res = await fetch(OLLAMA_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + OLLAMA_KEY,
      },
      body: JSON.stringify({
        model: OLLAMA_MODEL, stream: false,
        messages: [{
          role: 'user',
          content: `You are an expert British English coach for a Bershka customer service agent. The brand tone is friendly, modern, and close to the customer (polite but not overly formal or stiff).
Analyze this transcript. If you see nonsensical phrases, assume it's a pronunciation error where the speech-to-text failed, and point it out.
Respond ONLY in valid JSON.

Transcript:
${text}

Respond with exact structure: {"score":<0-100>,"scoreLabel":"<Label>","summary":"<summary>","strengths":["<s1>","<s2>"],"improvements":[{"original":"<o>","better":"<b>","why":"<w>"}],"vocabulary":["<v1>","<v2>"],"xpEarned":<10-50>}`
        }]
      })
    });
    
    const data = await res.json();
    let raw = data.message?.content?.trim() || '{}';
    raw = raw.replace(/```json|```/g, '').trim();
    
    // Fallback to extract JSON if ollama hallucinates wrapper text
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) raw = jsonMatch[0];
    
    const result = JSON.parse(raw);

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

    state.calls.unshift({
      date: new Date().toISOString(),
      ...result // Guardo el objeto de análisis COMPLETO (mejoras, vocabulario, etc.)
    });
    saveState();

    renderAnalysisModal(result);
  } catch (e) {
    alert('Analysis failed: ' + e.message);
    showToast('Analysis failed. Try again.');
    console.error(e);
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
  $('stat-calls').textContent = state.calls.length;
  if(state.calls.length > 0) {
    const avg = Math.round(state.calls.reduce((s,c)=>s+(c.score||0),0)/state.calls.length);
    $('stat-avg').textContent = avg;
    $('stat-avg').style.color = avg >= 75 ? 'var(--green)' : avg >= 50 ? 'var(--amber)' : 'var(--red)';
  }

  // Draw Trend Chart (últimas 10 llamadas)
  const recentCalls = state.calls.slice(0, 10).reverse();
  $('trend-bars').innerHTML = recentCalls.map(c => {
    const score = c.score || 0;
    const cl = score >= 75 ? 'trend-GOOD' : score >= 50 ? 'trend-OK' : 'trend-BAD';
    return `<div class="trend-bar ${cl}" style="height: ${Math.max(5, score)}%"><span>${score}</span></div>`;
  }).join('');

  $('history-list').innerHTML = state.calls.map((c, idx) => {
    const d = new Date(c.date);
    const dStr = `${d.toLocaleDateString('en-GB')} ${d.toLocaleTimeString('en-GB', {hour:'2-digit',minute:'2-digit'})}`;
    const score = c.score || 0;
    const color = score >= 75 ? 'var(--green)' : score >= 50 ? 'var(--amber)' : 'var(--red)';
    const sum = c.summary ? c.summary.substring(0,40) + '...' : 'Review details';
    
    return `<div class="history-item" onclick="openHistoricalAnalysis(${idx})">
      <div>
        <div class="hi-date">${dStr}</div>
        <div style="font-size:11px; color:var(--text-dim); margin-top:4px;">${sum} <span style="color:var(--cyan)">👉</span></div>
      </div>
      <div class="hi-score" style="color:${color}">${score}</div>
    </div>`;
  }).join('');

  $('modal-history').classList.remove('hidden');
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
