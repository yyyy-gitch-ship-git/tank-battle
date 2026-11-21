(() => {
  'use strict';

  /* ------------------------------------------------------------------ */
  /*  Constants & helpers                                               */
  /* ------------------------------------------------------------------ */

  const TILE = 36;
  const COLS = 20;
  const ROWS = 20;
  const W = COLS * TILE;
  const H = ROWS * TILE;
  const STEP = 1 / 60;
  const MAX_LEVEL = 5;
  const TANK_SIZE = 30;
  const TANK_HALF = TANK_SIZE / 2;
  const SNAP_DISTANCE = 9;

  const EMPTY = 0;
  const BRICK = 1;
  const STEEL = 2;
  const WATER = 3;
  const GRASS = 4;
  const BASE = 5;
  const BASE_DEAD = 6;
  const SOLID = new Set([BRICK, STEEL, WATER, BASE, BASE_DEAD]);

  const BASE_COL = 9;
  const BASE_ROW = 17;
  const BASE_CENTER = { x: (BASE_COL + 1) * TILE, y: (BASE_ROW + 1) * TILE };

  const DIRS = [
    { x: 0, y: -1 },
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    { x: -1, y: 0 },
  ];

  const PLAYER_SPAWN = { col: 5, row: 18 };
  const ENEMY_SPAWNS = [
    { col: 1, row: 1 },
    { col: 9, row: 1 },
    { col: 18, row: 1 },
  ];

  const TANK_STYLES = {
    player: { light: '#8dffe3', mid: '#41cbb0', dark: '#147d6e', turret: '#c9fff2', track: '#294643' },
    standard: { light: '#f08a80', mid: '#c94b49', dark: '#7d252b', turret: '#ffb3a8', track: '#43292c' },
    fast: { light: '#f7c66f', mid: '#cf8a2f', dark: '#815019', turret: '#ffe2a5', track: '#453722' },
    armored: { light: '#c4a7ff', mid: '#8658d9', dark: '#4b2d89', turret: '#e5d4ff', track: '#322943' },
  };

  const POWERUP_COLORS = {
    shield: '#67c8ff',
    rapid: '#ffc45e',
    life: '#6ff0a1',
  };

  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
  const rand = (min, max) => min + Math.random() * (max - min);
  const randInt = (min, max) => Math.floor(rand(min, max + 1));
  const choose = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const pad = (n, len = 2) => String(n).padStart(len, '0');

  function hash2(x, y) {
    let n = (x * 374761393 + y * 668265263) | 0;
    n = (n ^ (n >> 13)) * 1274126177;
    return ((n ^ (n >> 16)) >>> 0);
  }

  function mulberry32(seed) {
    return function random() {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function roundedRect(g, x, y, w, h, r) {
    const radius = Math.min(r, w / 2, h / 2);
    g.beginPath();
    g.moveTo(x + radius, y);
    g.arcTo(x + w, y, x + w, y + h, radius);
    g.arcTo(x + w, y + h, x, y + h, radius);
    g.arcTo(x, y + h, x, y, radius);
    g.arcTo(x, y, x + w, y, radius);
    g.closePath();
  }

  function circleHitsTank(x, y, radius, tank) {
    const nx = clamp(x, tank.x - TANK_HALF, tank.x + TANK_HALF);
    const ny = clamp(y, tank.y - TANK_HALF, tank.y + TANK_HALF);
    const dx = x - nx;
    const dy = y - ny;
    return dx * dx + dy * dy <= radius * radius;
  }

  function distSq(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return dx * dx + dy * dy;
  }

  /* ------------------------------------------------------------------ */
  /*  DOM                                                               */
  /* ------------------------------------------------------------------ */

  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const overlay = document.getElementById('overlay');
  const stage = document.getElementById('stage');
  const pauseBtn = document.getElementById('pauseBtn');
  const soundBtn = document.getElementById('soundBtn');
  const soundLabel = soundBtn.querySelector('.sound-label');
  const scoreEl = document.getElementById('scoreEl');
  const bestEl = document.getElementById('bestEl');
  const levelEl = document.getElementById('levelEl');
  const livesEl = document.getElementById('livesEl');
  const enemiesEl = document.getElementById('enemiesEl');
  const buffsEl = document.getElementById('buffs');
  const touchControls = document.getElementById('touchControls');
  const fireBtn = document.getElementById('fireBtn');

  let dpr = 1;

  function setupCanvas() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const targetWidth = Math.round(W * dpr);
    const targetHeight = Math.round(H * dpr);
    if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
      canvas.width = targetWidth;
      canvas.height = targetHeight;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
  }

  setupCanvas();
  window.addEventListener('resize', setupCanvas);

  /* ------------------------------------------------------------------ */
  /*  Persistence                                                       */
  /* ------------------------------------------------------------------ */

  const BEST_KEY = 'tank-battle-best-v1';
  const SOUND_KEY = 'tank-battle-sound-v1';

  function readStorage(key, fallback) {
    try {
      const value = window.localStorage.getItem(key);
      return value === null ? fallback : value;
    } catch {
      return fallback;
    }
  }

  function writeStorage(key, value) {
    try {
      window.localStorage.setItem(key, String(value));
    } catch {
      /* storage can be unavailable in private mode */
    }
  }

  let best = Math.max(0, parseInt(readStorage(BEST_KEY, '0'), 10) || 0);
  let soundEnabled = readStorage(SOUND_KEY, 'on') !== 'off';

  /* ------------------------------------------------------------------ */
  /*  Audio                                                             */
  /* ------------------------------------------------------------------ */

  let audioCtx = null;
  let masterGain = null;
  let noiseBuffer = null;

  function getAudio() {
    if (!soundEnabled) return null;
    try {
      if (!audioCtx) {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) return null;
        audioCtx = new AudioContextClass();
        masterGain = audioCtx.createGain();
        masterGain.gain.value = 0.55;
        masterGain.connect(audioCtx.destination);
      }
      if (audioCtx.state === 'suspended') audioCtx.resume();
      return audioCtx;
    } catch {
      return null;
    }
  }

  function getNoise() {
    const ac = audioCtx;
    if (!noiseBuffer) {
      const length = Math.floor(ac.sampleRate * 0.7);
      noiseBuffer = ac.createBuffer(1, length, ac.sampleRate);
      const data = noiseBuffer.getChannelData(0);
      for (let i = 0; i < length; i++) {
        data[i] = (Math.random() * 2 - 1) * (1 - i / length);
      }
    }
    return noiseBuffer;
  }

  function tone(freq, endFreq, duration, type, volume, delay = 0) {
    const ac = getAudio();
    if (!ac) return;
    const now = ac.currentTime + delay;
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(Math.max(20, freq), now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), now + duration);
    gain.gain.setValueAtTime(volume, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    osc.connect(gain);
    gain.connect(masterGain);
    osc.start(now);
    osc.stop(now + duration + 0.02);
  }

  function noiseBurst(duration, volume, cutoffFrom = 1400, cutoffTo = 100) {
    const ac = getAudio();
    if (!ac) return;
    const now = ac.currentTime;
    const source = ac.createBufferSource();
    source.buffer = getNoise();
    const filter = ac.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(cutoffFrom, now);
    filter.frequency.exponentialRampToValueAtTime(cutoffTo, now + duration);
    const gain = ac.createGain();
    gain.gain.setValueAtTime(volume, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(masterGain);
    source.start(now);
    source.stop(now + duration + 0.02);
  }

  function playSound(name) {
    if (!soundEnabled) return;
    const ac = getAudio();
    if (!ac) return;
    switch (name) {
      case 'shoot':
        tone(360, 150, 0.075, 'square', 0.035);
        break;
      case 'enemyShoot':
        tone(180, 85, 0.09, 'triangle', 0.028);
        break;
      case 'brick':
        noiseBurst(0.08, 0.06, 900, 180);
        break;
      case 'steel':
        tone(1350, 740, 0.035, 'square', 0.022);
        break;
      case 'explosion':
        noiseBurst(0.42, 0.24, 1600, 80);
        tone(120, 32, 0.38, 'sine', 0.16);
        break;
      case 'armorHit':
        tone(820, 380, 0.06, 'sawtooth', 0.035);
        break;
      case 'powerup':
        tone(620, 620, 0.09, 'sine', 0.055);
        tone(880, 880, 0.1, 'sine', 0.05, 0.07);
        tone(1240, 1240, 0.16, 'sine', 0.045, 0.14);
        break;
      case 'level':
        tone(392, 392, 0.11, 'triangle', 0.055);
        tone(523, 523, 0.12, 'triangle', 0.055, 0.1);
        tone(659, 659, 0.22, 'triangle', 0.05, 0.2);
        break;
      case 'start':
        tone(196, 392, 0.18, 'sawtooth', 0.038);
        tone(392, 523, 0.22, 'triangle', 0.045, 0.1);
        break;
      case 'gameover':
        tone(330, 300, 0.25, 'sawtooth', 0.045);
        tone(245, 220, 0.28, 'sawtooth', 0.045, 0.22);
        tone(155, 70, 0.7, 'triangle', 0.055, 0.46);
        break;
      case 'victory':
        [523, 659, 784, 1047].forEach((f, i) => {
          tone(f, f, 0.22, 'triangle', 0.05, i * 0.13);
        });
        break;
      case 'ui':
        tone(540, 620, 0.045, 'sine', 0.026);
        break;
      case 'drop':
        tone(760, 1180, 0.14, 'sine', 0.04);
        break;
      default:
        break;
    }
  }

  function updateSoundButton() {
    soundBtn.setAttribute('aria-pressed', String(soundEnabled));
    soundLabel.textContent = soundEnabled ? '声音' : '静音';
    soundBtn.title = soundEnabled ? '关闭声音 (M)' : '打开声音 (M)';
  }

  function toggleSound() {
    soundEnabled = !soundEnabled;
    writeStorage(SOUND_KEY, soundEnabled ? 'on' : 'off');
    updateSoundButton();
    if (soundEnabled) playSound('ui');
  }

  updateSoundButton();

  /* ------------------------------------------------------------------ */
  /*  Sprite atlas                                                      */
  /* ------------------------------------------------------------------ */

  let brickSprites = [];
  let steelSprite = null;
  let waterSprites = [];
  let grassSprites = [];
  let baseSprite = null;
  let baseDeadSprite = null;

  function makeSprite(width, height) {
    const scale = 2;
    const c = document.createElement('canvas');
    c.width = width * scale;
    c.height = height * scale;
    const g = c.getContext('2d');
    g.scale(scale, scale);
    return { canvas: c, g };
  }

  function makeBrickSprite(variant) {
    const { canvas: c, g } = makeSprite(TILE, TILE);
    const bases = ['#a54d31', '#96432b', '#b15636'];
    const lights = ['#c66b45', '#b75a38', '#c9764e'];
    g.fillStyle = '#2b1712';
    g.fillRect(0, 0, TILE, TILE);
    g.save();
    g.beginPath();
    g.rect(0, 0, TILE, TILE);
    g.clip();
    const offset = (variant * 7) % 18;
    for (let row = 0; row < 3; row++) {
      for (let col = -1; col < 3; col++) {
        const bx = col * 18 + offset + (row % 2 === 0 ? 0 : 9);
        const by = row * 12;
        const shade = (row + col + variant) % 3;
        g.fillStyle = bases[(shade + 3) % 3];
        g.fillRect(bx + 1, by + 1, 16, 10);
        g.fillStyle = lights[(shade + 1) % 3];
        g.fillRect(bx + 1, by + 1, 16, 2);
        g.fillStyle = 'rgba(40, 16, 9, 0.28)';
        g.fillRect(bx + 1, by + 9, 16, 2);
      }
    }
    g.restore();
    const edge = g.createLinearGradient(0, 0, 0, TILE);
    edge.addColorStop(0, 'rgba(255, 220, 180, 0.1)');
    edge.addColorStop(1, 'rgba(0, 0, 0, 0.24)');
    g.fillStyle = edge;
    g.fillRect(0, 0, TILE, TILE);
    return c;
  }

  function makeSteelSprite() {
    const { canvas: c, g } = makeSprite(TILE, TILE);
    const bg = g.createLinearGradient(0, 0, TILE, TILE);
    bg.addColorStop(0, '#9bafb6');
    bg.addColorStop(0.45, '#526b74');
    bg.addColorStop(0.72, '#758e96');
    bg.addColorStop(1, '#394e57');
    roundedRect(g, 0.5, 0.5, TILE - 1, TILE - 1, 2.5);
    g.fillStyle = bg;
    g.fill();
    g.strokeStyle = 'rgba(12, 24, 29, 0.7)';
    g.lineWidth = 1.5;
    g.stroke();

    roundedRect(g, 4, 4, TILE - 8, TILE - 8, 1.5);
    g.strokeStyle = 'rgba(222, 241, 245, 0.22)';
    g.lineWidth = 1;
    g.stroke();

    g.strokeStyle = 'rgba(20, 37, 43, 0.48)';
    g.beginPath();
    g.moveTo(5, 27);
    g.lineTo(27, 5);
    g.moveTo(9, 31);
    g.lineTo(31, 9);
    g.stroke();

    g.fillStyle = 'rgba(236, 249, 251, 0.68)';
    [[8, 8], [28, 8], [8, 28], [28, 28]].forEach(([x, y]) => {
      g.beginPath();
      g.arc(x, y, 1.7, 0, Math.PI * 2);
      g.fill();
    });
    g.fillStyle = 'rgba(0, 0, 0, 0.32)';
    [[8.7, 9.2], [28.7, 9.2], [8.7, 29.2], [28.7, 29.2]].forEach(([x, y]) => {
      g.beginPath();
      g.arc(x, y, 1.1, 0, Math.PI * 2);
      g.fill();
    });
    return c;
  }

  function makeWaterSprite(frame) {
    const { canvas: c, g } = makeSprite(TILE, TILE);
    const bg = g.createLinearGradient(0, 0, 0, TILE);
    bg.addColorStop(0, '#0d4059');
    bg.addColorStop(1, '#0a2b40');
    g.fillStyle = bg;
    g.fillRect(0, 0, TILE, TILE);

    const phase = (frame / 3) * Math.PI * 2;
    for (let row = 0; row < 3; row++) {
      g.beginPath();
      for (let x = -4; x <= TILE + 4; x += 4) {
        const y = 7 + row * 11 + Math.sin(x * 0.25 + phase + row) * 2.2;
        if (x === -4) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.strokeStyle = row === 1 ? 'rgba(118, 226, 244, 0.34)' : 'rgba(86, 188, 215, 0.22)';
      g.lineWidth = row === 1 ? 1.4 : 1;
      g.stroke();
    }
    g.fillStyle = 'rgba(190, 248, 255, 0.34)';
    g.fillRect(5 + frame * 7, 23, 7, 1.2);
    g.fillRect(22 - frame * 3, 31, 5, 1.2);
    return c;
  }

  function makeGrassSprite(variant) {
    const { canvas: c, g } = makeSprite(TILE, TILE);
    const random = mulberry32(1337 + variant * 999);
    g.fillStyle = 'rgba(20, 59, 35, 0.34)';
    g.fillRect(0, 0, TILE, TILE);
    const colors = ['#1f5d39', '#2c7645', '#3b8e51', '#57a45e', '#194d31'];
    for (let i = 0; i < 18; i++) {
      const x = random() * TILE;
      const baseY = 10 + random() * 27;
      const height = 7 + random() * 14;
      const lean = -4 + random() * 8;
      g.beginPath();
      g.moveTo(x, baseY);
      g.quadraticCurveTo(x + lean * 0.4, baseY - height * 0.6, x + lean, baseY - height);
      g.strokeStyle = colors[Math.floor(random() * colors.length)];
      g.lineWidth = 1.2 + random() * 1.4;
      g.lineCap = 'round';
      g.stroke();
    }
    g.fillStyle = 'rgba(130, 220, 130, 0.12)';
    for (let i = 0; i < 5; i++) {
      g.fillRect(random() * TILE, random() * TILE, 1.4, 3 + random() * 3);
    }
    return c;
  }

  function drawStar(g, cx, cy, outer, inner, points = 5) {
    g.beginPath();
    for (let i = 0; i < points * 2; i++) {
      const radius = i % 2 === 0 ? outer : inner;
      const angle = -Math.PI / 2 + (i * Math.PI) / points;
      const x = cx + Math.cos(angle) * radius;
      const y = cy + Math.sin(angle) * radius;
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.closePath();
  }

  function makeBaseSprite(dead) {
    const { canvas: c, g } = makeSprite(TILE * 2, TILE * 2);
    const size = TILE * 2;
    g.fillStyle = dead ? '#161311' : '#131d1d';
    g.fillRect(0, 0, size, size);

    const plate = g.createLinearGradient(0, 0, size, size);
    if (dead) {
      plate.addColorStop(0, '#332722');
      plate.addColorStop(1, '#171210');
    } else {
      plate.addColorStop(0, '#2b3c3b');
      plate.addColorStop(0.5, '#172422');
      plate.addColorStop(1, '#0e1717');
    }
    roundedRect(g, 4, 4, size - 8, size - 8, 5);
    g.fillStyle = plate;
    g.fill();
    g.strokeStyle = dead ? 'rgba(123, 71, 56, 0.6)' : 'rgba(255, 205, 109, 0.42)';
    g.lineWidth = 1.5;
    g.stroke();

    const cornerColor = dead ? 'rgba(139, 72, 50, 0.7)' : 'rgba(255, 205, 109, 0.75)';
    g.strokeStyle = cornerColor;
    g.lineWidth = 2;
    const m = 9;
    const arm = 9;
    [[m, m, 1, 1], [size - m, m, -1, 1], [m, size - m, 1, -1], [size - m, size - m, -1, -1]].forEach(([x, y, sx, sy]) => {
      g.beginPath();
      g.moveTo(x + sx * arm, y);
      g.lineTo(x, y);
      g.lineTo(x, y + sy * arm);
      g.stroke();
    });

    const cx = size / 2;
    const cy = size / 2 - 1;

    g.save();
    g.beginPath();
    g.ellipse(cx, cy, 30, 33, 0, 0, Math.PI * 2);
    g.fillStyle = dead ? 'rgba(136, 58, 38, 0.08)' : 'rgba(255, 199, 92, 0.09)';
    g.fill();
    g.restore();

    // Wings
    g.fillStyle = dead ? 'rgba(110, 69, 54, 0.55)' : 'rgba(206, 156, 61, 0.62)';
    g.beginPath();
    g.moveTo(cx - 9, cy - 8);
    g.lineTo(cx - 28, cy - 17);
    g.lineTo(cx - 24, cy - 6);
    g.lineTo(cx - 30, cy + 1);
    g.lineTo(cx - 10, cy + 6);
    g.closePath();
    g.fill();
    g.beginPath();
    g.moveTo(cx + 9, cy - 8);
    g.lineTo(cx + 28, cy - 17);
    g.lineTo(cx + 24, cy - 6);
    g.lineTo(cx + 30, cy + 1);
    g.lineTo(cx + 10, cy + 6);
    g.closePath();
    g.fill();

    // Shield
    const shield = g.createLinearGradient(cx, cy - 22, cx, cy + 25);
    if (dead) {
      shield.addColorStop(0, '#6d594a');
      shield.addColorStop(1, '#30251f');
    } else {
      shield.addColorStop(0, '#ffe39a');
      shield.addColorStop(0.55, '#e6b453');
      shield.addColorStop(1, '#a06d24');
    }
    g.beginPath();
    g.moveTo(cx, cy - 24);
    g.lineTo(cx + 17, cy - 17);
    g.lineTo(cx + 15, cy + 3);
    g.quadraticCurveTo(cx + 11, cy + 18, cx, cy + 26);
    g.quadraticCurveTo(cx - 11, cy + 18, cx - 15, cy + 3);
    g.lineTo(cx - 17, cy - 17);
    g.closePath();
    g.fillStyle = shield;
    g.fill();
    g.strokeStyle = dead ? 'rgba(30, 20, 16, 0.8)' : 'rgba(255, 241, 196, 0.55)';
    g.lineWidth = 1.2;
    g.stroke();

    if (dead) {
      g.strokeStyle = 'rgba(23, 16, 13, 0.9)';
      g.lineWidth = 1.6;
      g.beginPath();
      g.moveTo(cx - 7, cy - 18);
      g.lineTo(cx - 1, cy - 6);
      g.lineTo(cx - 9, cy + 3);
      g.lineTo(cx - 2, cy + 15);
      g.stroke();
      g.strokeStyle = 'rgba(255, 114, 68, 0.42)';
      g.beginPath();
      g.moveTo(cx + 6, cy - 13);
      g.lineTo(cx + 2, cy);
      g.lineTo(cx + 8, cy + 9);
      g.stroke();
    } else {
      g.fillStyle = '#1b2927';
      drawStar(g, cx, cy - 1, 11, 4.4);
      g.fill();
      g.strokeStyle = 'rgba(255, 255, 255, 0.25)';
      g.lineWidth = 0.8;
      g.stroke();
      g.fillStyle = 'rgba(255, 244, 205, 0.48)';
      g.fillRect(cx - 14, cy + 32, 28, 1);
    }

    g.fillStyle = dead ? 'rgba(203, 107, 62, 0.4)' : 'rgba(255, 212, 122, 0.42)';
    for (let i = 0; i < 3; i++) {
      g.beginPath();
      g.arc(cx - 10 + i * 10, size - 12, 1.2, 0, Math.PI * 2);
      g.fill();
    }
    return c;
  }

  function buildSprites() {
    brickSprites = [0, 1, 2].map(makeBrickSprite);
    steelSprite = makeSteelSprite();
    waterSprites = [0, 1, 2].map(makeWaterSprite);
    grassSprites = [0, 1].map(makeGrassSprite);
    baseSprite = makeBaseSprite(false);
    baseDeadSprite = makeBaseSprite(true);
  }

  buildSprites();

  /* ------------------------------------------------------------------ */
  /*  Game state                                                        */
  /* ------------------------------------------------------------------ */

  let mode = 'menu';
  let map = [];
  let score = 0;
  let lives = 3;
  let level = 1;
  let kills = 0;
  let player = null;
  let enemies = [];
  let bullets = [];
  let particles = [];
  let rings = [];
  let floaters = [];
  let powerups = [];

  let enemyTotal = 8;
  let enemiesSpawned = 0;
  let maxActive = 3;
  let spawnTimer = 1.4;
  let spawnCursor = 0;
  let levelEnding = false;
  let levelEndTimer = 0;
  let pendingOver = null;
  let banner = null;
  let shake = 0;
  let flash = 0;
  let visualTime = 0;
  let hudTimer = 0;

  const input = {
    heldDirs: new Set(),
    dirStack: [],
    lastDir: null,
    fire: false,
    touchFire: false,
  };

  function resetInput() {
    input.heldDirs.clear();
    input.dirStack.length = 0;
    input.lastDir = null;
    input.fire = false;
    input.touchFire = false;
    fireBtn.classList.remove('active');
    touchControls.querySelectorAll('.dpad-btn.active').forEach((btn) => btn.classList.remove('active'));
  }

  function pressDir(dir) {
    if (!input.heldDirs.has(dir)) {
      input.heldDirs.add(dir);
      input.dirStack.push(dir);
    }
    input.lastDir = dir;
  }

  function releaseDir(dir) {
    input.heldDirs.delete(dir);
    input.dirStack = input.dirStack.filter((d) => d !== dir);
    input.lastDir = input.dirStack.length ? input.dirStack[input.dirStack.length - 1] : null;
  }

  /* ------------------------------------------------------------------ */
  /*  Map generation                                                    */
  /* ------------------------------------------------------------------ */

  function buildMap(levelNumber) {
    const grid = Array.from({ length: ROWS }, () => Array(COLS).fill(EMPTY));

    for (let x = 0; x < COLS; x++) {
      grid[0][x] = STEEL;
      grid[ROWS - 1][x] = STEEL;
    }
    for (let y = 0; y < ROWS; y++) {
      grid[y][0] = STEEL;
      grid[y][COLS - 1] = STEEL;
    }

    const rect = (x, y, w, h, type) => {
      for (let yy = y; yy < y + h; yy++) {
        for (let xx = x; xx < x + w; xx++) {
          if (xx > 0 && xx < COLS - 1 && yy > 0 && yy < ROWS - 1) {
            grid[yy][xx] = type;
          }
        }
      }
    };
    const mirrorX = (x, w) => COLS - x - w;

    const style = (levelNumber - 1) % 3;

    if (style === 0) {
      rect(3, 4, 1, 5, BRICK);
      rect(mirrorX(3, 1), 4, 1, 5, BRICK);
      rect(6, 8, 1, 3, BRICK);
      rect(mirrorX(6, 1), 8, 1, 3, BRICK);
      rect(9, 6, 2, 1, STEEL);
      rect(9, 9, 2, 1, STEEL);
      rect(8, 11, 4, 2, WATER);
      rect(2, 13, 3, 2, GRASS);
      rect(mirrorX(2, 3), 13, 3, 2, GRASS);
      rect(6, 14, 2, 1, BRICK);
      rect(mirrorX(6, 2), 14, 2, 1, BRICK);
    } else if (style === 1) {
      rect(4, 4, 1, 3, STEEL);
      rect(mirrorX(4, 1), 4, 1, 3, STEEL);
      rect(2, 6, 4, 1, BRICK);
      rect(mirrorX(2, 4), 6, 4, 1, BRICK);
      rect(8, 4, 4, 1, BRICK);
      rect(9, 7, 2, 1, STEEL);
      rect(7, 9, 6, 1, BRICK);
      rect(3, 11, 2, 4, WATER);
      rect(mirrorX(3, 2), 11, 2, 4, WATER);
      rect(6, 13, 1, 3, BRICK);
      rect(mirrorX(6, 1), 13, 1, 3, BRICK);
      rect(8, 12, 4, 2, GRASS);
      rect(9, 14, 2, 1, STEEL);
    } else {
      rect(2, 4, 2, 2, BRICK);
      rect(mirrorX(2, 2), 4, 2, 2, BRICK);
      rect(6, 4, 2, 1, STEEL);
      rect(mirrorX(6, 2), 4, 2, 1, STEEL);
      rect(9, 3, 2, 3, BRICK);
      rect(4, 8, 1, 3, STEEL);
      rect(mirrorX(4, 1), 8, 1, 3, STEEL);
      rect(7, 8, 2, 1, BRICK);
      rect(mirrorX(7, 2), 8, 2, 1, BRICK);
      rect(8, 11, 4, 2, GRASS);
      rect(2, 12, 2, 3, WATER);
      rect(mirrorX(2, 2), 12, 2, 3, WATER);
      rect(6, 13, 3, 1, BRICK);
      rect(mirrorX(6, 3), 13, 3, 1, BRICK);
      rect(9, 14, 2, 1, STEEL);
    }

    const clearSpawn = (col, row) => {
      for (let y = row - 1; y <= row + 2; y++) {
        for (let x = col - 2; x <= col + 2; x++) {
          if (x > 0 && x < COLS - 1 && y > 0 && y < ROWS - 1) grid[y][x] = EMPTY;
        }
      }
    };
    ENEMY_SPAWNS.forEach((s) => clearSpawn(s.col, s.row));
    clearSpawn(PLAYER_SPAWN.col, PLAYER_SPAWN.row);

    // Base fortress (built last so it is always intact)
    grid[BASE_ROW - 1][BASE_COL - 1] = BRICK;
    grid[BASE_ROW - 1][BASE_COL] = BRICK;
    grid[BASE_ROW - 1][BASE_COL + 1] = BRICK;
    grid[BASE_ROW - 1][BASE_COL + 2] = BRICK;
    grid[BASE_ROW][BASE_COL - 1] = BRICK;
    grid[BASE_ROW][BASE_COL + 2] = BRICK;
    grid[BASE_ROW + 1][BASE_COL - 1] = BRICK;
    grid[BASE_ROW + 1][BASE_COL + 2] = BRICK;
    for (let y = BASE_ROW; y <= BASE_ROW + 1; y++) {
      for (let x = BASE_COL; x <= BASE_COL + 1; x++) {
        grid[y][x] = BASE;
      }
    }

    return grid;
  }

  /* ------------------------------------------------------------------ */
  /*  HUD                                                               */
  /* ------------------------------------------------------------------ */

  const lifeIcon = '<svg viewBox="0 0 24 16" aria-hidden="true"><rect x="1" y="6" width="22" height="9" rx="2" fill="currentColor"/><rect x="8" y="1" width="8" height="8" rx="1" fill="currentColor"/><path d="M15 3h7" stroke="currentColor" stroke-width="2"/></svg>';
  let lastLives = null;

  function syncHUD() {
    const shownBest = Math.max(best, score);
    const remaining = Math.max(0, enemyTotal - enemiesSpawned + enemies.length);
    scoreEl.textContent = pad(score, 6);
    bestEl.textContent = pad(shownBest, 6);
    levelEl.textContent = pad(level, 2);
    enemiesEl.textContent = pad(remaining, 2);

    if (lives !== lastLives) {
      lastLives = lives;
      livesEl.innerHTML = lives > 0 ? lifeIcon.repeat(Math.min(lives, 6)) : '<span class="none">NONE</span>';
      livesEl.setAttribute('aria-label', `剩余 ${lives} 条生命`);
    }
  }

  function syncBuffs() {
    if (!player || !player.alive || mode !== 'playing') {
      if (buffsEl.childElementCount) buffsEl.innerHTML = '';
      return;
    }
    const chunks = [];
    if (player.shieldTime > 0) {
      chunks.push(`<span class="buff shield">护盾 <b>${Math.ceil(player.shieldTime)}s</b></span>`);
    }
    if (player.rapidTime > 0) {
      chunks.push(`<span class="buff rapid">速射 <b>${Math.ceil(player.rapidTime)}s</b></span>`);
    }
    buffsEl.innerHTML = chunks.join('');
  }

  function addScore(amount) {
    score += amount;
    if (score > best) best = score;
    syncHUD();
  }

  function saveBest() {
    if (score > best) best = score;
    writeStorage(BEST_KEY, best);
  }

  /* ------------------------------------------------------------------ */
  /*  Tanks                                                             */
  /* ------------------------------------------------------------------ */

  function makePlayer(x, y) {
    return {
      x,
      y,
      dir: 0,
      speed: 118,
      speedMul: 1,
      size: TANK_SIZE,
      half: TANK_HALF,
      style: TANK_STYLES.player,
      isPlayer: true,
      alive: true,
      cooldown: 0,
      respawnTimer: 0,
      invuln: 2.6,
      shieldTime: 0,
      rapidTime: 0,
      tread: 0,
      hitFlash: 0,
      spawnTimer: 0,
      dead: false,
    };
  }

  function isSpawnClear(x, y, ignore = null) {
    for (let yy = Math.floor((y - TANK_HALF) / TILE); yy <= Math.floor((y + TANK_HALF) / TILE); yy++) {
      for (let xx = Math.floor((x - TANK_HALF) / TILE); xx <= Math.floor((x + TANK_HALF) / TILE); xx++) {
        if (xx < 0 || xx >= COLS || yy < 0 || yy >= ROWS) return false;
        if (SOLID.has(map[yy][xx])) return false;
      }
    }
    const tanks = [...enemies];
    if (player && player !== ignore) tanks.push(player);
    for (const t of tanks) {
      if (t === ignore) continue;
      if (Math.hypot(t.x - x, t.y - y) < TANK_SIZE + 4) return false;
    }
    return true;
  }

  function spawnPlayer() {
    const candidates = [
      [PLAYER_SPAWN.col, PLAYER_SPAWN.row],
      [PLAYER_SPAWN.col - 1, PLAYER_SPAWN.row],
      [PLAYER_SPAWN.col + 1, PLAYER_SPAWN.row],
      [PLAYER_SPAWN.col, PLAYER_SPAWN.row - 1],
      [PLAYER_SPAWN.col - 2, PLAYER_SPAWN.row],
      [PLAYER_SPAWN.col + 2, PLAYER_SPAWN.row],
      [PLAYER_SPAWN.col, PLAYER_SPAWN.row - 2],
    ];
    let spot = null;
    for (const [col, row] of candidates) {
      const x = col * TILE + TILE / 2;
      const y = row * TILE + TILE / 2;
      if (isSpawnClear(x, y, null)) {
        spot = { x, y };
        break;
      }
    }
    if (!spot) {
      spot = {
        x: PLAYER_SPAWN.col * TILE + TILE / 2,
        y: PLAYER_SPAWN.row * TILE + TILE / 2,
      };
    }
    player = makePlayer(spot.x, spot.y);
    rings.push({ x: spot.x, y: spot.y, r: 8, maxR: 30, life: 0.5, maxLife: 0.5, color: '#7bffe5', width: 2 });
  }

  function targetEnemyCount(n) {
    return 6 + n * 2;
  }

  function buildLevel(n, preview = false) {
    level = n;
    map = buildMap(n);
    bullets = [];
    particles = [];
    rings = [];
    floaters = [];
    powerups = [];
    enemies = [];
    enemyTotal = targetEnemyCount(n);
    enemiesSpawned = 0;
    maxActive = n < 3 ? 3 : 4;
    spawnTimer = 1.3;
    spawnCursor = 0;
    levelEnding = false;
    levelEndTimer = 0;
    pendingOver = null;
    banner = null;
    shake = 0;
    flash = 0;
    lastLives = null;
    player = null;
    spawnPlayer();
    player.invuln = preview ? 0 : 2.6;
    if (preview) player.spawnTimer = 0;
    buffsEl.innerHTML = '';
    syncHUD();
    syncBuffs();
  }

  function spawnEnemy() {
    if (enemiesSpawned >= enemyTotal || enemies.length >= maxActive) return false;

    let spot = null;
    for (let attempt = 0; attempt < ENEMY_SPAWNS.length; attempt++) {
      const spawn = ENEMY_SPAWNS[(spawnCursor + attempt) % ENEMY_SPAWNS.length];
      const x = spawn.col * TILE + TILE / 2;
      const y = spawn.row * TILE + TILE / 2;
      if (isSpawnClear(x, y, null)) {
        spot = { x, y };
        spawnCursor = (spawnCursor + attempt + 1) % ENEMY_SPAWNS.length;
        break;
      }
    }
    if (!spot) return false;

    const index = enemiesSpawned;
    const special = index === 1 || index === 5;
    let kind = 'standard';
    const roll = Math.random();
    if (roll < 0.14 + level * 0.03) kind = 'fast';
    else if (roll < 0.28 + level * 0.045) kind = 'armored';

    const base = {
      x: spot.x,
      y: spot.y,
      dir: 2,
      kind,
      special,
      style: TANK_STYLES[kind],
      speed: kind === 'fast' ? 84 + level * 4 : kind === 'armored' ? 48 + level * 2 : 54 + level * 3,
      hp: kind === 'armored' ? 2 : 1,
      maxHp: kind === 'armored' ? 2 : 1,
      score: special ? 300 : kind === 'armored' ? 250 : kind === 'fast' ? 150 : 100,
      size: TANK_SIZE,
      half: TANK_HALF,
      spawnTimer: 0.9,
      fireTimer: rand(0.9, 1.8),
      aiTimer: rand(0.4, 1.1),
      tread: rand(0, 20),
      hitFlash: 0,
      stuck: 0,
      seed: rand(0, 10),
      dead: false,
      isPlayer: false,
    };
    enemies.push(base);
    enemiesSpawned += 1;
    syncHUD();
    return true;
  }

  function pointBlockedByWorld(x, y, half) {
    const left = Math.floor((x - half) / TILE);
    const right = Math.floor((x + half - 0.001) / TILE);
    const top = Math.floor((y - half) / TILE);
    const bottom = Math.floor((y + half - 0.001) / TILE);
    if (left < 0 || right >= COLS || top < 0 || bottom >= ROWS) return true;
    for (let ty = top; ty <= bottom; ty++) {
      for (let tx = left; tx <= right; tx++) {
        if (SOLID.has(map[ty][tx])) return true;
      }
    }
    return false;
  }

  function tankBlockedAt(tank, x, y) {
    if (pointBlockedByWorld(x, y, tank.half)) return true;
    const others = [];
    if (player && player !== tank && player.alive) others.push(player);
    for (const e of enemies) {
      if (e !== tank && !e.dead) others.push(e);
    }
    for (const other of others) {
      if (Math.abs(other.x - x) < tank.half + other.half - 1 && Math.abs(other.y - y) < tank.half + other.half - 1) {
        return true;
      }
    }
    return false;
  }

  function turnTank(tank, dir) {
    if (tank.dir === dir) return;
    tank.dir = dir;
    // Nudge onto the center line when close, so corridor turns feel crisp.
    if (DIRS[dir].x === 0) {
      const center = Math.floor(tank.x / TILE) * TILE + TILE / 2;
      if (Math.abs(tank.x - center) <= SNAP_DISTANCE && !tankBlockedAt(tank, center, tank.y)) {
        tank.x = center;
      }
    } else {
      const center = Math.floor(tank.y / TILE) * TILE + TILE / 2;
      if (Math.abs(tank.y - center) <= SNAP_DISTANCE && !tankBlockedAt(tank, tank.x, center)) {
        tank.y = center;
      }
    }
  }

  function moveTank(tank, distance) {
    const d = DIRS[tank.dir];
    const nx = tank.x + d.x * distance;
    const ny = tank.y + d.y * distance;
    if (tankBlockedAt(tank, nx, ny)) return false;
    tank.x = nx;
    tank.y = ny;
    tank.tread += distance;
    return true;
  }

  function fireTank(tank) {
    if (pendingOver || levelEnding) return false;
    const owner = tank.isPlayer ? 'player' : 'enemy';
    const existing = bullets.filter((b) => !b.dead && b.owner === owner);
    if (owner === 'player') {
      const limit = tank.rapidTime > 0 ? 5 : 3;
      if (existing.length >= limit || tank.cooldown > 0) return false;
      tank.cooldown = tank.rapidTime > 0 ? 0.155 : 0.36;
    } else {
      if (existing.length >= 14) return false;
    }
    const d = DIRS[tank.dir];
    const muzzleX = tank.x + d.x * (TANK_HALF + 3);
    const muzzleY = tank.y + d.y * (TANK_HALF + 3);
    const speed = owner === 'player' ? (tank.rapidTime > 0 ? 620 : 470) : 268 + level * 11;
    bullets.push({
      x: muzzleX,
      y: muzzleY,
      dir: tank.dir,
      speed,
      owner,
      radius: 3.2,
      life: 4,
      dead: false,
    });
    for (let i = 0; i < 4; i++) {
      particles.push({
        x: muzzleX,
        y: muzzleY,
        vx: d.x * rand(30, 90) + rand(-30, 30),
        vy: d.y * rand(30, 90) + rand(-30, 30),
        life: rand(0.08, 0.2),
        maxLife: 0.2,
        size: rand(1, 2.4),
        color: owner === 'player' ? '#ffe6a8' : '#ff9e8b',
        kind: 'spark',
        drag: 0.9,
      });
    }
    playSound(owner === 'player' ? 'shoot' : 'enemyShoot');
    return true;
  }

  /* ------------------------------------------------------------------ */
  /*  Effects                                                           */
  /* ------------------------------------------------------------------ */

  function addExplosion(x, y, scale = 1, withSound = true) {
    shake = Math.max(shake, 8 * scale);
    const sparkColors = ['#ffd479', '#ff9b4a', '#ef6a52', '#fff0c9'];
    for (let i = 0; i < Math.round(18 * scale); i++) {
      const angle = rand(0, Math.PI * 2);
      const speed = rand(35, 220) * scale;
      particles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: rand(0.25, 0.75),
        maxLife: 0.75,
        size: rand(1.2, 3.6) * scale,
        color: choose(sparkColors),
        kind: 'spark',
        drag: 0.93,
      });
    }
    for (let i = 0; i < Math.round(7 * scale); i++) {
      const angle = rand(0, Math.PI * 2);
      particles.push({
        x: x + rand(-8, 8),
        y: y + rand(-8, 8),
        vx: Math.cos(angle) * rand(10, 60),
        vy: Math.sin(angle) * rand(10, 60) - 18,
        life: rand(0.5, 1.2),
        maxLife: 1.2,
        size: rand(4, 9) * scale,
        color: choose(['#6f7677', '#4f5b5d', '#9b7b5e']),
        kind: 'smoke',
        drag: 0.96,
      });
    }
    rings.push({ x, y, r: 8 * scale, maxR: 36 * scale, life: 0.4, maxLife: 0.4, color: '#ffd17c', width: 2.2 });
    if (withSound) playSound('explosion');
  }

  function addSparks(x, y, color, count = 6, speed = 120) {
    for (let i = 0; i < count; i++) {
      const angle = rand(0, Math.PI * 2);
      particles.push({
        x,
        y,
        vx: Math.cos(angle) * rand(20, speed),
        vy: Math.sin(angle) * rand(20, speed),
        life: rand(0.12, 0.35),
        maxLife: 0.35,
        size: rand(0.8, 2.2),
        color,
        kind: 'spark',
        drag: 0.92,
      });
    }
  }

  function addBrickDebris(cx, cy) {
    for (let i = 0; i < 7; i++) {
      particles.push({
        x: cx + rand(-8, 8),
        y: cy + rand(-8, 8),
        vx: rand(-70, 70),
        vy: rand(-100, -10),
        life: rand(0.3, 0.65),
        maxLife: 0.65,
        size: rand(1.5, 3.5),
        color: choose(['#a54d31', '#c26a44', '#7d3925']),
        kind: 'debris',
        gravity: 320,
        drag: 0.98,
      });
    }
  }

  function addFloater(x, y, text, color = '#ffe5a3') {
    floaters.push({ x, y, text, color, life: 0.9, maxLife: 0.9 });
  }

  function updateParticles(dt) {
    for (const p of particles) {
      p.life -= dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.gravity) p.vy += p.gravity * dt;
      if (p.drag) {
        const drag = Math.pow(p.drag, dt * 60);
        p.vx *= drag;
        p.vy *= drag;
      }
      if (p.kind === 'smoke') p.size += dt * 9;
    }
    if (particles.length && particles[0].life <= 0) {
      particles = particles.filter((p) => p.life > 0);
    }

    for (const r of rings) {
      r.life -= dt;
      const t = 1 - Math.max(0, r.life) / r.maxLife;
      r.r = r.maxR * Math.min(1, t * 1.35);
    }
    rings = rings.filter((r) => r.life > 0);

    for (const f of floaters) {
      f.life -= dt;
      f.y -= dt * 26;
    }
    floaters = floaters.filter((f) => f.life > 0);
  }

  /* ------------------------------------------------------------------ */
  /*  Player                                                            */
  /* ------------------------------------------------------------------ */

  function updatePlayer(dt) {
    if (!player) return;
    if (!player.alive) {
      player.respawnTimer -= dt;
      if (player.respawnTimer <= 0) {
        if (lives > 0) spawnPlayer();
        else endGame('装甲耗尽');
      }
      return;
    }

    player.invuln = Math.max(0, player.invuln - dt);
    player.shieldTime = Math.max(0, player.shieldTime - dt);
    player.rapidTime = Math.max(0, player.rapidTime - dt);
    player.cooldown = Math.max(0, player.cooldown - dt);
    player.hitFlash = Math.max(0, player.hitFlash - dt);

    if (input.lastDir !== null) {
      if (player.dir !== input.lastDir) turnTank(player, input.lastDir);
      moveTank(player, player.speed * dt);
    }

    if (input.fire || input.touchFire) fireTank(player);
  }

  function damagePlayer(sourceX, sourceY) {
    if (!player || !player.alive || pendingOver) return;
    if (player.shieldTime > 0) {
      rings.push({ x: player.x, y: player.y, r: 20, maxR: 30, life: 0.3, maxLife: 0.3, color: '#67c8ff', width: 2 });
      addSparks(player.x, player.y, '#9fe5ff', 8, 130);
      return;
    }
    if (player.invuln > 0) {
      addSparks(player.x, player.y, '#a9fff0', 8, 120);
      return;
    }

    player.alive = false;
    player.respawnTimer = 1.7;
    lives -= 1;
    addExplosion(player.x, player.y, 1.25);
    flash = Math.max(flash, 0.35);
    shake = 16;
    addFloater(player.x, player.y - 20, 'ARMOR LOST', '#ff9387');
    syncHUD();
    syncBuffs();
  }

  /* ------------------------------------------------------------------ */
  /*  Enemy AI                                                          */
  /* ------------------------------------------------------------------ */

  function chooseEnemyDir(enemy, forced = false) {
    let target = BASE_CENTER;
    if (player && player.alive && Math.random() < 0.52) target = player;
    const dx = target.x - enemy.x;
    const dy = target.y - enemy.y;
    const primary = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : 3) : (dy > 0 ? 2 : 0);

    let dir;
    if (forced) {
      const options = [0, 1, 2, 3].filter((d) => d !== enemy.dir && d !== (enemy.dir + 2) % 4);
      if (options.length) {
        dir = Math.random() < 0.55
          ? options.reduce((best, d) => (Math.abs(d - primary) < Math.abs(best - primary) ? d : best), options[0])
          : choose(options);
      } else {
        dir = (enemy.dir + 2) % 4;
      }
    } else {
      dir = Math.random() < 0.68 ? primary : randInt(0, 3);
      if (dir === (enemy.dir + 2) % 4 && Math.random() < 0.72) dir = randInt(0, 3);
    }
    turnTank(enemy, dir);
    enemy.aiTimer = rand(0.7, 1.8) * (level >= 4 ? 0.82 : 1);
  }

  function enemyConsiderFire(enemy) {
    if (enemy.fireTimer > 0 || enemy.spawnTimer > 0 || pendingOver || levelEnding) return;
    let aimDir = null;
    const targets = [];
    if (player && player.alive) targets.push(player);
    targets.push(BASE_CENTER);

    for (const target of targets) {
      const dx = target.x - enemy.x;
      const dy = target.y - enemy.y;
      if (Math.abs(dx) < 16 && Math.abs(dy) > 10) {
        aimDir = dy < 0 ? 0 : 2;
        break;
      }
      if (Math.abs(dy) < 16 && Math.abs(dx) > 10) {
        aimDir = dx < 0 ? 3 : 1;
        break;
      }
    }

    if (aimDir !== null) {
      if (enemy.dir !== aimDir) turnTank(enemy, aimDir);
      fireTank(enemy);
      enemy.fireTimer = rand(1.25, 2.15) - level * 0.04;
    } else if (Math.random() < 0.3) {
      fireTank(enemy);
      enemy.fireTimer = rand(1.4, 2.5);
    } else {
      enemy.fireTimer = rand(0.55, 1.1);
    }
  }

  function updateEnemies(dt) {
    for (const enemy of enemies) {
      if (enemy.dead) continue;
      enemy.hitFlash = Math.max(0, enemy.hitFlash - dt);
      if (enemy.spawnTimer > 0) {
        enemy.spawnTimer -= dt;
        continue;
      }
      enemy.fireTimer -= dt;
      enemy.aiTimer -= dt;
      if (enemy.aiTimer <= 0) chooseEnemyDir(enemy);

      const moved = moveTank(enemy, enemy.speed * dt);
      if (!moved) {
        enemy.stuck += dt;
        if (enemy.stuck > 0.16) {
          chooseEnemyDir(enemy, true);
          enemy.stuck = 0;
        }
      } else {
        enemy.stuck = 0;
      }
      enemyConsiderFire(enemy);
    }
  }

  function damageEnemy(enemy) {
    if (enemy.dead || enemy.spawnTimer > 0) return;
    enemy.hp -= 1;
    enemy.hitFlash = 0.12;
    if (enemy.hp > 0) {
      addSparks(enemy.x, enemy.y, '#d9c4ff', 9, 150);
      playSound('armorHit');
      return;
    }
    enemy.dead = true;
    kills += 1;
    addScore(enemy.score);
    addExplosion(enemy.x, enemy.y, enemy.kind === 'armored' ? 1.25 : 1);
    addFloater(enemy.x, enemy.y - 16, `+${enemy.score}`, '#ffe7a6');
    if (enemy.special) spawnPowerup(enemy.x, enemy.y);
    syncHUD();
  }

  /* ------------------------------------------------------------------ */
  /*  Bullets & collisions                                              */
  /* ------------------------------------------------------------------ */

  function spark(x, y, color) {
    addSparks(x, y, color, 5, 95);
  }

  function hitTile(bullet, tx, ty) {
    const tile = map[ty][tx];
    const cx = tx * TILE + TILE / 2;
    const cy = ty * TILE + TILE / 2;
    if (tile === BRICK) {
      map[ty][tx] = EMPTY;
      bullet.dead = true;
      addBrickDebris(cx, cy);
      spark(bullet.x, bullet.y, '#e7a077');
      playSound('brick');
      return true;
    }
    if (tile === STEEL) {
      bullet.dead = true;
      spark(bullet.x, bullet.y, '#e6f5f8');
      playSound('steel');
      return true;
    }
    if (tile === BASE) {
      bullet.dead = true;
      if (bullet.owner === 'enemy') {
        destroyBase();
      } else {
        spark(bullet.x, bullet.y, '#ffd884');
      }
      return true;
    }
    if (tile === BASE_DEAD) {
      bullet.dead = true;
      spark(bullet.x, bullet.y, '#9b8c7c');
      return true;
    }
    return false;
  }

  function destroyBase() {
    if (pendingOver) return;
    for (let y = BASE_ROW; y <= BASE_ROW + 1; y++) {
      for (let x = BASE_COL; x <= BASE_COL + 1; x++) {
        if (map[y][x] === BASE) map[y][x] = BASE_DEAD;
      }
    }
    addExplosion(BASE_CENTER.x, BASE_CENTER.y, 1.8);
    addExplosion(BASE_CENTER.x - 18, BASE_CENTER.y + 12, 1.1, false);
    addExplosion(BASE_CENTER.x + 20, BASE_CENTER.y - 8, 1.2, false);
    flash = 0.7;
    shake = 22;
    pendingOver = { reason: '基地被摧毁', timer: 1.8 };
    player.shieldTime = 0;
    syncBuffs();
  }

  function updateBullets(dt) {
    for (const bullet of bullets) {
      if (bullet.dead) continue;
      bullet.life -= dt;
      const d = DIRS[bullet.dir];
      bullet.x += d.x * bullet.speed * dt;
      bullet.y += d.y * bullet.speed * dt;

      if (bullet.life <= 0 || bullet.x < 0 || bullet.x > W || bullet.y < 0 || bullet.y > H) {
        bullet.dead = true;
        continue;
      }

      const tx = Math.floor(bullet.x / TILE);
      const ty = Math.floor(bullet.y / TILE);
      if (tx >= 0 && tx < COLS && ty >= 0 && ty < ROWS) {
        hitTile(bullet, tx, ty);
      }
    }

    for (let i = 0; i < bullets.length; i++) {
      const a = bullets[i];
      if (a.dead) continue;
      for (let j = i + 1; j < bullets.length; j++) {
        const b = bullets[j];
        if (b.dead || a.owner === b.owner) continue;
        if (distSq(a, b) < 100) {
          a.dead = true;
          b.dead = true;
          spark((a.x + b.x) / 2, (a.y + b.y) / 2, '#fff2c9');
          break;
        }
      }
    }

    for (const bullet of bullets) {
      if (bullet.dead) continue;
      if (bullet.owner === 'player') {
        for (const enemy of enemies) {
          if (enemy.dead || enemy.spawnTimer > 0) continue;
          if (circleHitsTank(bullet.x, bullet.y, bullet.radius + 1, enemy)) {
            bullet.dead = true;
            damageEnemy(enemy);
            break;
          }
        }
      } else if (player && player.alive) {
        if (circleHitsTank(bullet.x, bullet.y, bullet.radius + 1, player)) {
          bullet.dead = true;
          damagePlayer(bullet.x, bullet.y);
        }
      }
    }

    bullets = bullets.filter((b) => !b.dead);
    enemies = enemies.filter((e) => !e.dead);
  }

  /* ------------------------------------------------------------------ */
  /*  Power-ups                                                         */
  /* ------------------------------------------------------------------ */

  function spawnPowerup(x, y) {
    const available = ['shield', 'rapid'];
    if (lives < 5) available.push('life', 'life');
    const type = choose(available);
    powerups.push({
      x: clamp(x, TILE + 12, W - TILE - 12),
      y: clamp(y, TILE + 12, H - TILE - 12),
      type,
      life: 14,
      phase: rand(0, 6),
      dead: false,
    });
    rings.push({ x, y, r: 4, maxR: 28, life: 0.5, maxLife: 0.5, color: POWERUP_COLORS[type], width: 2 });
    playSound('drop');
  }

  function updatePowerups(dt) {
    for (const p of powerups) {
      p.life -= dt;
      if (p.life <= 0) {
        p.dead = true;
        continue;
      }
      if (player && player.alive && Math.hypot(player.x - p.x, player.y - p.y) < TANK_HALF + 12) {
        p.dead = true;
        if (p.type === 'shield') {
          player.shieldTime = Math.max(player.shieldTime, 8);
          addFloater(p.x, p.y - 14, '护盾 8s', POWERUP_COLORS.shield);
        } else if (p.type === 'rapid') {
          player.rapidTime = Math.max(player.rapidTime, 10);
          addFloater(p.x, p.y - 14, '速射 10s', POWERUP_COLORS.rapid);
        } else {
          lives = Math.min(5, lives + 1);
          addFloater(p.x, p.y - 14, '+1 装甲', POWERUP_COLORS.life);
          lastLives = null;
        }
        addScore(50);
        rings.push({ x: p.x, y: p.y, r: 10, maxR: 36, life: 0.45, maxLife: 0.45, color: POWERUP_COLORS[p.type], width: 2 });
        playSound('powerup');
        syncHUD();
        syncBuffs();
      }
    }
    powerups = powerups.filter((p) => !p.dead);
  }

  /* ------------------------------------------------------------------ */
  /*  Spawning & level flow                                             */
  /* ------------------------------------------------------------------ */

  function handleSpawning(dt) {
    if (levelEnding || pendingOver) return;
    if (enemiesSpawned >= enemyTotal) return;
    if (enemies.length >= maxActive) return;
    spawnTimer -= dt;
    if (spawnTimer > 0) return;
    if (spawnEnemy()) {
      spawnTimer = rand(1.4, 2.2) - Math.min(0.35, level * 0.05);
    } else {
      spawnTimer = 0.5;
    }
  }

  function finishLevel() {
    if (lives <= 0 && (!player || !player.alive)) {
      endGame('装甲耗尽');
      return;
    }
    saveBest();
    if (level >= MAX_LEVEL) {
      mode = 'victory';
      saveBest();
      playSound('victory');
      resetInput();
      setOverlay(victoryHtml());
      syncBuffs();
    } else {
      mode = 'levelclear';
      playSound('level');
      resetInput();
      setOverlay(levelClearHtml());
      syncBuffs();
    }
  }

  function endGame(reason) {
    if (mode === 'gameover' || mode === 'victory') return;
    mode = 'gameover';
    saveBest();
    playSound('gameover');
    resetInput();
    setOverlay(gameOverHtml(reason));
    syncHUD();
    syncBuffs();
  }

  /* ------------------------------------------------------------------ */
  /*  Main update                                                       */
  /* ------------------------------------------------------------------ */

  function updateEffects(dt) {
    updateParticles(dt);
    shake = Math.max(0, shake - dt * 42);
    flash = Math.max(0, flash - dt * 1.8);
    if (banner) {
      banner.time -= dt;
      if (banner.time <= 0) banner = null;
    }
  }

  function update(dt) {
    updateEffects(dt);

    hudTimer -= dt;
    if (hudTimer <= 0) {
      hudTimer = 0.12;
      syncHUD();
      syncBuffs();
    }

    if (pendingOver) {
      pendingOver.timer -= dt;
      if (pendingOver.timer <= 0) endGame(pendingOver.reason);
      return;
    }

    updatePlayer(dt);
    updateEnemies(dt);
    updateBullets(dt);
    updatePowerups(dt);
    handleSpawning(dt);

    if (!levelEnding && enemiesSpawned >= enemyTotal && enemies.length === 0) {
      levelEnding = true;
      levelEndTimer = 1.15;
    }

    if (levelEnding && !pendingOver) {
      levelEndTimer -= dt;
      if (levelEndTimer <= 0) finishLevel();
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Rendering                                                         */
  /* ------------------------------------------------------------------ */

  function drawGround() {
    ctx.fillStyle = '#091820';
    ctx.fillRect(0, 0, W, H);

    for (let ty = 0; ty < ROWS; ty++) {
      for (let tx = 0; tx < COLS; tx++) {
        const tile = map[ty][tx];
        if (tile === EMPTY || tile === GRASS || tile === BASE || tile === BASE_DEAD) continue;
        const x = tx * TILE;
        const y = ty * TILE;
        if (tile === BRICK) {
          ctx.drawImage(brickSprites[hash2(tx, ty) % brickSprites.length], x, y, TILE, TILE);
        } else if (tile === STEEL) {
          ctx.drawImage(steelSprite, x, y, TILE, TILE);
        } else if (tile === WATER) {
          const count = waterSprites.length;
          const frame = (((Math.floor(Math.max(0, visualTime) * 3.2) + (hash2(tx, ty) % count)) % count) + count) % count;
          ctx.drawImage(waterSprites[frame], x, y, TILE, TILE);
        }
      }
    }

    // Faint ground grid
    ctx.strokeStyle = 'rgba(110, 175, 180, 0.045)';
    ctx.lineWidth = 1;
    for (let i = 1; i < COLS; i++) {
      ctx.beginPath();
      ctx.moveTo(i * TILE, 0);
      ctx.lineTo(i * TILE, H);
      ctx.stroke();
    }
    for (let i = 1; i < ROWS; i++) {
      ctx.beginPath();
      ctx.moveTo(0, i * TILE);
      ctx.lineTo(W, i * TILE);
      ctx.stroke();
    }

    const baseX = BASE_COL * TILE;
    const baseY = BASE_ROW * TILE;
    const dead = map[BASE_ROW][BASE_COL] === BASE_DEAD;

    if (!dead) {
      const pulse = 0.1 + Math.sin(visualTime * 2.2) * 0.035;
      const glow = ctx.createRadialGradient(BASE_CENTER.x, BASE_CENTER.y, 8, BASE_CENTER.x, BASE_CENTER.y, 74);
      glow.addColorStop(0, `rgba(255, 200, 95, ${pulse})`);
      glow.addColorStop(1, 'rgba(255, 200, 95, 0)');
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = glow;
      ctx.fillRect(baseX - 50, baseY - 50, TILE * 2 + 100, TILE * 2 + 100);
      ctx.restore();
    } else {
      const smokeGlow = ctx.createRadialGradient(BASE_CENTER.x, BASE_CENTER.y, 5, BASE_CENTER.x, BASE_CENTER.y, 60);
      smokeGlow.addColorStop(0, 'rgba(255, 90, 45, 0.12)');
      smokeGlow.addColorStop(1, 'rgba(255, 90, 45, 0)');
      ctx.fillStyle = smokeGlow;
      ctx.fillRect(baseX - 40, baseY - 40, TILE * 2 + 80, TILE * 2 + 80);
    }
    ctx.drawImage(dead ? baseDeadSprite : baseSprite, baseX, baseY, TILE * 2, TILE * 2);
  }

  function drawGrass() {
    for (let ty = 0; ty < ROWS; ty++) {
      for (let tx = 0; tx < COLS; tx++) {
        if (map[ty][tx] !== GRASS) continue;
        const sprite = grassSprites[hash2(tx, ty) % grassSprites.length];
        ctx.globalAlpha = 0.94;
        ctx.drawImage(sprite, tx * TILE, ty * TILE, TILE, TILE);
      }
    }
    ctx.globalAlpha = 1;
  }

  function drawTank(tank) {
    const x = tank.x;
    const y = tank.y;
    const style = tank.style;
    const angle = tank.dir * (Math.PI / 2);

    ctx.save();
    ctx.translate(x, y);

    if (tank.spawnTimer > 0) {
      const progress = 1 - tank.spawnTimer / 0.9;
      ctx.save();
      ctx.rotate(visualTime * 4);
      ctx.strokeStyle = `rgba(255, 218, 127, ${0.4 + Math.sin(visualTime * 18) * 0.2})`;
      ctx.setLineDash([5, 5]);
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(0, 0, 21 - progress * 3, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
      ctx.globalAlpha = 0.4 + progress * 0.6;
    }

    // Shadow
    ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
    ctx.beginPath();
    ctx.ellipse(2, 4, 16, 14, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.rotate(angle);

    // Tracks
    roundedRect(ctx, -14, -15, 7, 30, 3);
    ctx.fillStyle = style.track;
    ctx.fill();
    roundedRect(ctx, 7, -15, 7, 30, 3);
    ctx.fill();

    ctx.save();
    ctx.beginPath();
    roundedRect(ctx, -14, -15, 7, 30, 3);
    roundedRect(ctx, 7, -15, 7, 30, 3);
    ctx.clip();
    ctx.strokeStyle = 'rgba(205, 232, 228, 0.33)';
    ctx.lineWidth = 1.4;
    const shift = ((tank.tread % 7) + 7) % 7;
    for (let i = -3; i < 6; i++) {
      const ty = -15 + shift + i * 7;
      ctx.beginPath();
      ctx.moveTo(-15, ty);
      ctx.lineTo(-6, ty);
      ctx.moveTo(6, ty);
      ctx.lineTo(15, ty);
      ctx.stroke();
    }
    ctx.restore();

    roundedRect(ctx, -14, -15, 7, 30, 3);
    ctx.strokeStyle = 'rgba(220, 242, 238, 0.16)';
    ctx.lineWidth = 1;
    ctx.stroke();
    roundedRect(ctx, 7, -15, 7, 30, 3);
    ctx.stroke();

    // Hull
    const hull = ctx.createLinearGradient(-12, -14, 12, 14);
    hull.addColorStop(0, style.light);
    hull.addColorStop(0.5, style.mid);
    hull.addColorStop(1, style.dark);
    roundedRect(ctx, -11, -13, 22, 27, 4);
    ctx.fillStyle = hull;
    ctx.fill();
    ctx.strokeStyle = 'rgba(5, 15, 18, 0.6)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Front armor
    roundedRect(ctx, -9, -15, 18, 5, 2);
    ctx.fillStyle = style.light;
    ctx.globalAlpha *= 0.62;
    ctx.fill();
    ctx.globalAlpha = tank.spawnTimer > 0 ? clamp(0.4 + (1 - tank.spawnTimer / 0.9) * 0.6, 0, 1) : 1;

    // Hull detail
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-8, 7);
    ctx.lineTo(8, 7);
    ctx.stroke();

    // Barrel
    roundedRect(ctx, -2.5, -24, 5, 17, 2);
    ctx.fillStyle = '#263136';
    ctx.fill();
    ctx.strokeStyle = 'rgba(230, 245, 245, 0.3)';
    ctx.lineWidth = 0.8;
    ctx.stroke();
    roundedRect(ctx, -4, -25, 8, 3.5, 1.5);
    ctx.fillStyle = style.turret;
    ctx.fill();

    // Turret
    const turretGrad = ctx.createRadialGradient(-2, -4, 1, 0, 0, 10);
    turretGrad.addColorStop(0, style.turret);
    turretGrad.addColorStop(1, style.dark);
    ctx.beginPath();
    ctx.arc(0, 0, 8.4, 0, Math.PI * 2);
    ctx.fillStyle = turretGrad;
    ctx.fill();
    ctx.strokeStyle = 'rgba(6, 18, 20, 0.55)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(-2.5, -2.5, 3.2, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.fill();

    if (tank.isPlayer) {
      ctx.fillStyle = '#07221c';
      ctx.beginPath();
      ctx.moveTo(0, -4.4);
      ctx.lineTo(3, 1);
      ctx.lineTo(-3, 1);
      ctx.closePath();
      ctx.fill();
    } else if (tank.kind === 'armored') {
      ctx.strokeStyle = 'rgba(232, 220, 255, 0.7)';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(0, 0, 10.6, 0, Math.PI * 2);
      ctx.stroke();
    } else if (tank.kind === 'fast') {
      ctx.fillStyle = '#2c2113';
      ctx.beginPath();
      ctx.moveTo(-4, -2);
      ctx.lineTo(0, -6);
      ctx.lineTo(4, -2);
      ctx.closePath();
      ctx.fill();
    }

    if (tank.special) {
      const glow = 0.55 + Math.sin(visualTime * 8 + tank.seed) * 0.3;
      ctx.strokeStyle = `rgba(255, 205, 100, ${glow})`;
      ctx.lineWidth = 1.6;
      roundedRect(ctx, -15, -15, 30, 30, 6);
      ctx.stroke();
      ctx.fillStyle = `rgba(255, 225, 150, ${glow})`;
      drawStar(ctx, 0, 0, 3.2, 1.3, 4);
      ctx.fill();
    }

    if (tank.hitFlash > 0) {
      roundedRect(ctx, -11, -13, 22, 27, 4);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
      ctx.fill();
    }

    ctx.restore();

    if (tank.isPlayer) {
      const shieldActive = tank.shieldTime > 0 || tank.invuln > 0;
      if (shieldActive) {
        const shieldColor = tank.shieldTime > 0 ? '103, 200, 255' : '140, 255, 235';
        const pulse = 0.55 + Math.sin(visualTime * 6) * 0.18;
        ctx.save();
        ctx.translate(x, y);
        ctx.strokeStyle = `rgba(${shieldColor}, ${pulse})`;
        ctx.lineWidth = 1.6;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.arc(0, 0, 21 + Math.sin(visualTime * 4) * 1.2, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = `rgba(${shieldColor}, 0.055)`;
        ctx.beginPath();
        ctx.arc(0, 0, 20, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }
  }

  function drawBullets() {
    for (const bullet of bullets) {
      if (bullet.dead) continue;
      const d = DIRS[bullet.dir];
      const color = bullet.owner === 'player' ? '#ffe9a8' : '#ff7f74';
      ctx.save();
      ctx.translate(bullet.x, bullet.y);
      ctx.rotate(Math.atan2(d.y, d.x) + Math.PI / 2);
      ctx.shadowColor = color;
      ctx.shadowBlur = 10;
      ctx.fillStyle = color;
      roundedRect(ctx, -1.8, -5, 3.6, 10, 1.8);
      ctx.fill();
      ctx.fillStyle = '#fffdf1';
      roundedRect(ctx, -0.9, -3.8, 1.8, 4.4, 0.9);
      ctx.fill();
      ctx.restore();
    }
    ctx.shadowBlur = 0;
  }

  function drawPowerups() {
    for (const p of powerups) {
      const bob = Math.sin(visualTime * 3 + p.phase) * 2.5;
      const color = POWERUP_COLORS[p.type];
      const blink = p.life < 3 && Math.floor(visualTime * 8) % 2 === 0;
      ctx.save();
      ctx.globalAlpha = blink ? 0.35 : 1;
      ctx.translate(p.x, p.y + bob);

      const glow = ctx.createRadialGradient(0, 0, 2, 0, 0, 22);
      glow.addColorStop(0, `${color}44`);
      glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = glow;
      ctx.fillRect(-24, -24, 48, 48);

      ctx.strokeStyle = color;
      ctx.globalAlpha *= 0.7;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.arc(0, 0, 15 + Math.sin(visualTime * 2.4 + p.phase) * 1.5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = blink ? 0.35 : 1;

      ctx.save();
      ctx.rotate(Math.PI / 4);
      roundedRect(ctx, -10, -10, 20, 20, 4);
      ctx.fillStyle = 'rgba(5, 17, 22, 0.88)';
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.6;
      ctx.stroke();
      ctx.restore();

      ctx.fillStyle = color;
      ctx.strokeStyle = color;
      if (p.type === 'shield') {
        ctx.beginPath();
        ctx.moveTo(0, -7);
        ctx.lineTo(5.5, -4.5);
        ctx.lineTo(4.8, 2);
        ctx.quadraticCurveTo(3.5, 6, 0, 8);
        ctx.quadraticCurveTo(-3.5, 6, -4.8, 2);
        ctx.lineTo(-5.5, -4.5);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#08212b';
        ctx.beginPath();
        ctx.arc(0, 0.5, 2, 0, Math.PI * 2);
        ctx.fill();
      } else if (p.type === 'rapid') {
        ctx.beginPath();
        ctx.moveTo(1, -8);
        ctx.lineTo(-5, 1);
        ctx.lineTo(-0.5, 1);
        ctx.lineTo(-2, 8);
        ctx.lineTo(5.5, -1.5);
        ctx.lineTo(0.8, -1.5);
        ctx.closePath();
        ctx.fill();
      } else {
        roundedRect(ctx, -1.7, -6.5, 3.4, 13, 1.3);
        ctx.fill();
        roundedRect(ctx, -6.5, -1.7, 13, 3.4, 1.3);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  function drawParticles() {
    for (const p of particles) {
      const alpha = clamp(p.life / p.maxLife, 0, 1);
      if (p.kind === 'smoke') {
        ctx.globalAlpha = alpha * 0.3;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      } else if (p.kind === 'debris') {
        ctx.globalAlpha = alpha;
        ctx.fillStyle = p.color;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.life * 7);
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 1.4);
        ctx.restore();
      } else {
        ctx.globalAlpha = alpha;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

    for (const r of rings) {
      const alpha = clamp(r.life / r.maxLife, 0, 1);
      ctx.globalAlpha = alpha * 0.8;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = r.width;
      ctx.beginPath();
      ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function drawFloaters() {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '600 11px "Cascadia Mono", Consolas, monospace';
    for (const f of floaters) {
      const alpha = clamp(f.life / f.maxLife, 0, 1);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = f.color;
      ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
      ctx.shadowBlur = 3;
      ctx.fillText(f.text, f.x, f.y);
    }
    ctx.restore();
  }

  function drawBanner() {
    if (!banner) return;
    const elapsed = 1 - banner.time / banner.total;
    const alpha = clamp(Math.min(elapsed / 0.2, banner.time / 0.4), 0, 1);
    ctx.save();
    ctx.globalAlpha = alpha;
    const bandY = H * 0.42;
    const band = ctx.createLinearGradient(0, bandY - 60, 0, bandY + 55);
    band.addColorStop(0, 'rgba(4, 13, 18, 0)');
    band.addColorStop(0.35, 'rgba(4, 13, 18, 0.62)');
    band.addColorStop(0.65, 'rgba(4, 13, 18, 0.62)');
    band.addColorStop(1, 'rgba(4, 13, 18, 0)');
    ctx.fillStyle = band;
    ctx.fillRect(0, bandY - 60, W, 115);

    ctx.textAlign = 'center';
    ctx.fillStyle = '#57e3c3';
    ctx.font = '600 9px "Cascadia Mono", Consolas, monospace';
    ctx.fillText(`SECTOR ${pad(level, 2)}`, W / 2, bandY - 24);

    ctx.fillStyle = '#f1f7f6';
    ctx.font = '700 36px Bahnschrift, "Segoe UI", sans-serif';
    ctx.fillText(banner.title, W / 2, bandY + 12);

    ctx.fillStyle = 'rgba(212, 231, 232, 0.68)';
    ctx.font = '400 11px Bahnschrift, "Microsoft YaHei", sans-serif';
    ctx.fillText(banner.sub, W / 2, bandY + 34);

    ctx.strokeStyle = 'rgba(87, 227, 195, 0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(W / 2 - 70, bandY + 17);
    ctx.lineTo(W / 2 - 20, bandY + 17);
    ctx.moveTo(W / 2 + 20, bandY + 17);
    ctx.lineTo(W / 2 + 70, bandY + 17);
    ctx.stroke();
    ctx.restore();
  }

  function drawMenuTankPreview() {
    if (mode !== 'menu' || !player) return;
    // A subtle spotlight behind the idle player on the menu.
    const glow = ctx.createRadialGradient(player.x, player.y, 0, player.x, player.y, 80);
    glow.addColorStop(0, 'rgba(87, 227, 195, 0.09)');
    glow.addColorStop(1, 'rgba(87, 227, 195, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(player.x - 90, player.y - 90, 180, 180);
  }

  function render() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const shakeX = shake > 0 && !reduceMotion ? rand(-shake, shake) * 0.35 : 0;
    const shakeY = shake > 0 && !reduceMotion ? rand(-shake, shake) * 0.35 : 0;
    ctx.save();
    ctx.translate(shakeX, shakeY);

    drawGround();
    drawMenuTankPreview();
    drawPowerups();

    for (const enemy of enemies) drawTank(enemy);
    if (player && player.alive) drawTank(player);

    drawBullets();
    drawGrass();
    drawParticles();
    drawFloaters();
    drawBanner();

    ctx.restore();

    if (flash > 0) {
      ctx.fillStyle = `rgba(255, 214, 157, ${clamp(flash * 0.35, 0, 0.4)})`;
      ctx.fillRect(0, 0, W, H);
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Overlay UI                                                        */
  /* ------------------------------------------------------------------ */

  const MENU_TANK_SVG = `
    <svg viewBox="0 0 100 70" fill="none" aria-hidden="true">
      <ellipse cx="50" cy="61" rx="38" ry="4" fill="currentColor" opacity="0.12"/>
      <path d="M18 47h64" stroke="currentColor" stroke-width="1" opacity="0.25"/>
      <rect x="11" y="44" width="78" height="17" rx="8" stroke="currentColor" stroke-width="2"/>
      <circle cx="26" cy="52.5" r="5.5" stroke="currentColor" stroke-width="1.4" opacity="0.55"/>
      <circle cx="50" cy="52.5" r="5.5" stroke="currentColor" stroke-width="1.4" opacity="0.55"/>
      <circle cx="74" cy="52.5" r="5.5" stroke="currentColor" stroke-width="1.4" opacity="0.55"/>
      <path d="M17 44 24 30h50l10 14" stroke="currentColor" stroke-width="2" fill="currentColor" fill-opacity="0.08"/>
      <rect x="32" y="18" width="31" height="14" rx="3" fill="currentColor" fill-opacity="0.9"/>
      <path d="M63 23h27" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>
      <circle cx="43" cy="25" r="4.6" stroke="#07141b" stroke-width="1.5" opacity="0.6"/>
      <path d="M72 17v-8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" opacity="0.7"/>
      <path d="M26 38h42" stroke="#07141b" stroke-width="1.2" opacity="0.5"/>
    </svg>`;

  const STAR_SVG = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.4l6.1-.9L12 3Z" fill="currentColor"/></svg>`;

  function statsHtml(rows) {
    return `<div class="result-stats">${rows
      .map((r) => `<div><span>${r.label}</span><strong class="${r.className || ''}">${r.value}</strong></div>`)
      .join('')}</div>`;
  }

  function menuHtml() {
    return `
      <div class="overlay-card">
        <span class="eyebrow">ARCADE PROTOCOL // 1985</span>
        <div class="menu-tank">${MENU_TANK_SVG}</div>
        <h2>坦克大战<span class="thin">STEEL DEFENSE</span></h2>
        <p class="sub">守住南侧基地，击退五波装甲部队。<br>你的每条生命，都是最后一道防线。</p>
        <div class="btn-row">
          <button class="btn primary" type="button" data-action="start" data-primary>开始战斗 <kbd>ENTER</kbd></button>
        </div>
        <p class="overlay-hint desktop-hint"><kbd>WASD</kbd> / <kbd>方向键</kbd> 移动 · <kbd>SPACE</kbd> 开火 · <kbd>P</kbd> 暂停</p>
        <p class="overlay-hint touch-hint">使用下方方向键移动 · 点击 FIRE 开火</p>
      </div>`;
  }

  function pauseHtml() {
    return `
      <div class="overlay-card">
        <span class="eyebrow">SYSTEM PAUSED</span>
        <h2>暂停<span class="thin">TAKE A BREATH</span></h2>
        <p class="sub">战场已冻结。敌军装甲仍在原地待命。</p>
        <div class="btn-row">
          <button class="btn primary" type="button" data-action="resume" data-primary>继续战斗 <kbd>P</kbd></button>
          <button class="btn secondary" type="button" data-action="restart">重新开始</button>
        </div>
        <p class="overlay-hint"><kbd>ENTER</kbd> 继续 · <kbd>R</kbd> 重开本局</p>
      </div>`;
  }

  function levelClearHtml() {
    return `
      <div class="overlay-card">
        <span class="eyebrow">SECTOR CLEARED</span>
        <h2>关卡完成<span class="thin">STAGE ${pad(level, 2)} SECURED</span></h2>
        <p class="sub">区域内敌军已全部清除。<br>下一波装甲部队正在集结。</p>
        ${statsHtml([
          { label: '当前得分 SCORE', value: pad(score, 6), className: 'accent' },
          { label: '剩余装甲 ARMOR', value: `${lives} / 5` },
        ])}
        <div class="btn-row">
          <button class="btn primary" type="button" data-action="next" data-primary>进入第 ${level + 1} 关 <kbd>ENTER</kbd></button>
        </div>
        <p class="overlay-hint">基地完整度 <b style="color:#57e3c3">100%</b> · 击毁敌军 ${kills} 辆</p>
      </div>`;
  }

  function gameOverHtml(reason) {
    return `
      <div class="overlay-card">
        <span class="eyebrow" style="color:#ff8f86">MISSION FAILED</span>
        <h2>任务失败<span class="thin">${reason}</span></h2>
        <p class="sub">防线已被突破。${reason === '基地被摧毁' ? '基地徽章已被敌军炮火摧毁。' : '所有备用装甲均已耗尽。'}</p>
        ${statsHtml([
          { label: '最终得分 SCORE', value: pad(score, 6), className: 'bad' },
          { label: '最高纪录 BEST', value: pad(best, 6) },
          { label: '抵达关卡 STAGE', value: `${pad(level, 2)} / ${pad(MAX_LEVEL, 2)}` },
          { label: '击毁敌军 KILLS', value: pad(kills, 2) },
        ])}
        <div class="btn-row">
          <button class="btn primary" type="button" data-action="restart" data-primary>再战一次 <kbd>ENTER</kbd></button>
          <button class="btn secondary" type="button" data-action="menu">返回主菜单</button>
        </div>
      </div>`;
  }

  function victoryHtml() {
    return `
      <div class="overlay-card">
        <span class="eyebrow">ALL SECTORS SECURED</span>
        <div class="medal">${STAR_SVG}</div>
        <h2>防线守住了<span class="thin">MISSION COMPLETE</span></h2>
        <p class="sub">五波装甲部队全部击退。基地徽章依然屹立在硝烟之中。</p>
        ${statsHtml([
          { label: '最终得分 SCORE', value: pad(score, 6), className: 'accent' },
          { label: '最高纪录 BEST', value: pad(best, 6) },
          { label: '击毁敌军 KILLS', value: pad(kills, 2) },
          { label: '基地状态 BASE', value: 'SECURE', className: 'accent' },
        ])}
        <div class="btn-row">
          <button class="btn primary" type="button" data-action="restart" data-primary>再次挑战 <kbd>ENTER</kbd></button>
          <button class="btn secondary" type="button" data-action="menu">返回主菜单</button>
        </div>
      </div>`;
  }

  function setOverlay(html) {
    overlay.innerHTML = html;
    overlay.classList.add('visible');
    overlay.setAttribute('aria-hidden', 'false');
    pauseBtn.hidden = true;
    requestAnimationFrame(() => {
      const primary = overlay.querySelector('[data-primary]');
      if (primary) primary.focus({ preventScroll: true });
    });
  }

  function hideOverlay() {
    overlay.classList.remove('visible');
    overlay.setAttribute('aria-hidden', 'true');
    pauseBtn.hidden = mode !== 'playing';
  }

  /* ------------------------------------------------------------------ */
  /*  State transitions                                                 */
  /* ------------------------------------------------------------------ */

  function startGame() {
    resetInput();
    score = 0;
    lives = 3;
    kills = 0;
    hudTimer = 0;
    buildLevel(1);
    mode = 'playing';
    hideOverlay();
    banner = { title: 'STAGE 01', sub: '守住基地 · 击退全部敌军', time: 2.2, total: 2.2 };
    lastLives = null;
    syncHUD();
    syncBuffs();
    playSound('start');
  }

  function nextLevel() {
    resetInput();
    buildLevel(level + 1);
    mode = 'playing';
    hideOverlay();
    banner = { title: `STAGE ${pad(level, 2)}`, sub: level === MAX_LEVEL ? '最终防线 · 不惜一切代价' : '守住基地 · 击退全部敌军', time: 2.2, total: 2.2 };
    lastLives = null;
    syncHUD();
    syncBuffs();
    playSound('start');
  }

  function pauseGame() {
    if (mode !== 'playing' || pendingOver) return;
    mode = 'paused';
    resetInput();
    playSound('ui');
    setOverlay(pauseHtml());
  }

  function resumeGame() {
    if (mode !== 'paused') return;
    mode = 'playing';
    resetInput();
    hideOverlay();
    playSound('ui');
  }

  function showMenu() {
    resetInput();
    score = 0;
    lives = 3;
    kills = 0;
    lastLives = null;
    buildLevel(1, true);
    mode = 'menu';
    setOverlay(menuHtml());
    pauseBtn.hidden = true;
    syncHUD();
    syncBuffs();
  }

  /* ------------------------------------------------------------------ */
  /*  Events                                                            */
  /* ------------------------------------------------------------------ */

  overlay.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    playSound('ui');
    switch (button.dataset.action) {
      case 'start':
      case 'restart':
        startGame();
        break;
      case 'resume':
        resumeGame();
        break;
      case 'next':
        nextLevel();
        break;
      case 'menu':
        showMenu();
        break;
      default:
        break;
    }
  });

  pauseBtn.addEventListener('click', () => {
    if (mode === 'playing') pauseGame();
  });

  soundBtn.addEventListener('click', toggleSound);

  const KEY_DIRS = {
    ArrowUp: 0,
    KeyW: 0,
    ArrowRight: 1,
    KeyD: 1,
    ArrowDown: 2,
    KeyS: 2,
    ArrowLeft: 3,
    KeyA: 3,
  };
  const FIRE_KEYS = new Set(['Space', 'KeyJ']);

  function overlayButtonFocused() {
    return overlay.classList.contains('visible') &&
      document.activeElement instanceof HTMLElement &&
      overlay.contains(document.activeElement) &&
      document.activeElement.tagName === 'BUTTON';
  }

  function triggerPrimaryAction() {
    if (mode === 'menu' || mode === 'gameover' || mode === 'victory') startGame();
    else if (mode === 'paused') resumeGame();
    else if (mode === 'levelclear') nextLevel();
  }

  window.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const code = event.code;

    if (Object.prototype.hasOwnProperty.call(KEY_DIRS, code)) {
      if (mode === 'playing') {
        event.preventDefault();
        if (!event.repeat) pressDir(KEY_DIRS[code]);
      }
      return;
    }

    if (FIRE_KEYS.has(code)) {
      if (mode === 'playing') {
        event.preventDefault();
        input.fire = true;
        return;
      }
      if (overlayButtonFocused()) return; // let the focused button receive Space
      event.preventDefault();
      if (!event.repeat) triggerPrimaryAction();
      return;
    }

    if (code === 'Enter') {
      if (mode === 'playing' || overlayButtonFocused()) return;
      event.preventDefault();
      if (!event.repeat) triggerPrimaryAction();
      return;
    }

    if (code === 'KeyP' || code === 'Escape') {
      if (mode === 'playing') {
        event.preventDefault();
        pauseGame();
      } else if (mode === 'paused') {
        event.preventDefault();
        resumeGame();
      }
      return;
    }

    if (code === 'KeyR') {
      if (mode === 'gameover' || mode === 'victory') {
        event.preventDefault();
        startGame();
      } else if (mode === 'paused') {
        event.preventDefault();
        startGame();
      }
      return;
    }

    if (code === 'KeyM') {
      toggleSound();
    }
  });

  window.addEventListener('keyup', (event) => {
    const code = event.code;
    if (Object.prototype.hasOwnProperty.call(KEY_DIRS, code)) {
      releaseDir(KEY_DIRS[code]);
    }
    if (FIRE_KEYS.has(code)) {
      input.fire = false;
    }
  });

  window.addEventListener('blur', () => {
    input.fire = false;
    input.touchFire = false;
    input.heldDirs.clear();
    input.dirStack.length = 0;
    input.lastDir = null;
    touchControls.querySelectorAll('.active').forEach((el) => el.classList.remove('active'));
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && mode === 'playing') pauseGame();
  });

  function bindHoldButton(button, onPress, onRelease) {
    button.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      try {
        button.setPointerCapture?.(event.pointerId);
      } catch {
        /* synthetic pointers may not be capturable */
      }
      button.classList.add('active');
      onPress();
    });
    const release = (event) => {
      event.preventDefault();
      button.classList.remove('active');
      onRelease();
    };
    button.addEventListener('pointerup', release);
    button.addEventListener('pointercancel', release);
    button.addEventListener('lostpointercapture', () => {
      button.classList.remove('active');
      onRelease();
    });
    button.addEventListener('contextmenu', (event) => event.preventDefault());
  }

  touchControls.querySelectorAll('.dpad-btn').forEach((button) => {
    const dir = Number(button.dataset.dir);
    bindHoldButton(
      button,
      () => {
        if (mode === 'playing') pressDir(dir);
      },
      () => releaseDir(dir),
    );
  });

  bindHoldButton(
    fireBtn,
    () => {
      if (mode === 'playing') input.touchFire = true;
      else triggerPrimaryAction();
    },
    () => {
      input.touchFire = false;
    },
  );

  stage.addEventListener('contextmenu', (event) => event.preventDefault());

  /* ------------------------------------------------------------------ */
  /*  Boot                                                              */
  /* ------------------------------------------------------------------ */

  buildLevel(1, true);
  mode = 'menu';
  setOverlay(menuHtml());
  pauseBtn.hidden = true;
  syncHUD();

  let lastFrame = performance.now();
  let accumulator = 0;

  function frame(now) {
    const elapsed = clamp((now - lastFrame) / 1000, 0, 0.1);
    lastFrame = now;
    visualTime += elapsed;

    if (mode === 'playing') {
      accumulator += elapsed;
      let steps = 0;
      while (accumulator >= STEP && steps < 5) {
        update(STEP);
        accumulator -= STEP;
        steps += 1;
        if (mode !== 'playing') {
          accumulator = 0;
          break;
        }
      }
      if (steps === 5) accumulator = 0;
    } else {
      accumulator = 0;
    }

    render();
    window.requestAnimationFrame(frame);
  }

  window.requestAnimationFrame(frame);
})();
