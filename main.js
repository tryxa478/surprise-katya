(function () {
    'use strict';

    // ---------- БАЗА ----------
    const canvas = document.getElementById('greetingCanvas');
    const ctx = canvas.getContext('2d', { alpha: false });
    const captionEl = document.getElementById('styleCaption');
    const introEl = document.getElementById('intro');
    const openBtn = document.getElementById('openBtn');
    const soundBtn = document.getElementById('soundBtn');
    const replayEl = document.getElementById('replay');
    const replayBtn = document.getElementById('replayBtn');

    const FONT = '"Segoe UI", "Poppins", "Montserrat", system-ui, sans-serif';
    const LOVE_COLORS = ['#ff3366', '#ff4d6d', '#ff5e7e', '#ff6b8b', '#ff8aa8', '#ff2e63', '#ff477e'];
    const MAX_DT = 0.05; // ограничение скачка времени после ухода со вкладкой

    // параметры сценария-сюрприза
    const CFG = {
        assembleTime: 3.75,   // сборка частиц в сердце, с
        styleCycle: 12,       // автосмена стиля, с
        finaleAfter: 58,      // финал через N с после старта, с
        finaleDur: 3,         // длительность финальной фазы, с
        beatInterval: 1.18,   // интервал сердцебиения, с
        fadeTime: 0.5,        // кроссфейд смены стиля, с
        pointerRadius: 170,   // радиус притяжения к курсору, px
        finaleText: 'Катя, я люблю тебя ♥'
    };
    const STYLES = ['heart', 'rain', 'balloons', 'fireflies', 'wave'];
    const GLYPH_SIZE = 26;

    let width = 0;
    let height = 0;
    let dpr = 1;
    let time = 0;          // секунды; растут непрерывно, без обрывов
    let lastTs = 0;
    let backgroundGradient = null;

    // сценарий
    let started = false;
    let phase = 'intro';   // intro | assemble | main | finale
    let scenarioT = 0;     // секунд с момента клика «Открыть»
    let assembleT = 0;
    let finaleT = 0;
    let finaleReady = false;
    let finaleDone = false;
    let replayShown = false;

    // стили
    let currentStyle = 'heart';
    let pendingStyle = null;
    let fade = 1;          // альфа-умножитель активного стиля (кроссфейд)
    let cycleTimer = 0;
    let currentStyleIndex = 0;

    let scale = 1;
    let offsetX = 0;
    let offsetY = 0;
    let centerY = 0; // центр рабочей полосы (без поправки под bbox сердца)

    // частицы стилей
    let heartParts = [];
    let rainDrops = [];
    let balloons = [];
    let fireflies = [];
    let waveWords = [];
    let stars = [];
    let bokeh = [];
    let floatHearts = [];
    let meteors = [];
    let sparks = [];
    let meteorTimer = 4;

    // сердцебиение
    let beatP = 0;         // 1 → 0, визуальная сила удара
    let beat2At = -1;
    let nextBeat = 0;

    // курсор / тап
    let pointerX = -9999;
    let pointerY = -9999;
    let pointerInside = false;

    // финальная надпись
    let finalePoints = null;
    let finaleSprite = null;
    let nameSprite = null;

    // звук
    let audioCtx = null;
    let masterGain = null;
    let muted = false;

    // ---------- МАТЕМАТИКА ----------
    function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

    function smooth(x, a, b) {
        const t = clamp((x - a) / (b - a), 0, 1);
        return t * t * (3 - 2 * t);
    }

    function easeInOut(t) {
        return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    }

    // ---------- СПРАЙТЫ ----------
    // Текст со свечением рисуется в offscreen-канвас ОДИН раз и дальше
    // просто накладывается через drawImage. Вместо fillText + shadowBlur
    // на каждую частицу каждый кадр (главный источник тормозов).
    const measureCtx = document.createElement('canvas').getContext('2d');
    const spriteCache = new Map();

    function clearSpriteCache() {
        spriteCache.clear();
    }

    function makeSprite(key, wCss, hCss, drawFn) {
        const w = Math.max(1, Math.ceil(wCss * dpr));
        const h = Math.max(1, Math.ceil(hCss * dpr));
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;

        const g = c.getContext('2d');
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        drawFn(g, w / dpr, h / dpr);

        const sp = { canvas: c, w: w / dpr, h: h / dpr };
        spriteCache.set(key, sp);
        return sp;
    }

    function textSprite(text, color, size, weight, accent, accentAlpha) {
        const fontSize = Math.max(9, Math.round(size));
        const key = 't|' + weight + '|' + fontSize + '|' + color + '|' +
                    (accent || '-') + '|' + (accentAlpha || 0) + '|' + text;

        const cached = spriteCache.get(key);
        if (cached) return cached;

        measureCtx.font = weight + ' ' + fontSize + 'px ' + FONT;
        const textW = measureCtx.measureText(text).width;
        const glow = Math.ceil(fontSize * 0.55) + 4;
        const w = textW + glow * 2;
        const h = fontSize * 1.5 + glow * 2;

        return makeSprite(key, w, h, function (g, sw, sh) {
            const cx = sw / 2;
            const cy = sh / 2;
            g.font = weight + ' ' + fontSize + 'px ' + FONT;

            // свечение (два прохода — как в оригинале)
            g.shadowColor = color;
            g.shadowBlur = fontSize * 0.55;
            g.fillStyle = color;
            g.fillText(text, cx, cy);
            g.fillText(text, cx, cy);

            // плотное ядро текста
            g.shadowBlur = 0;
            g.fillStyle = color;
            g.fillText(text, cx, cy);

            if (accent) {
                g.globalAlpha = accentAlpha;
                g.fillStyle = accent;
                g.fillText(text, cx, cy);
                g.globalAlpha = 1;
            }
        });
    }

    // шарик: текст + сердечко сверху + верёвочка снизу — одним спрайтом
    function balloonSprite(text, color, size) {
        const fontSize = Math.max(10, Math.round(size));
        const key = 'b|' + fontSize + '|' + color + '|' + text;

        const cached = spriteCache.get(key);
        if (cached) return cached;

        measureCtx.font = '600 ' + fontSize + 'px ' + FONT;
        const textW = measureCtx.measureText(text).width;
        const glow = Math.ceil(fontSize * 0.55) + 4;
        const half = fontSize * 1.1; // место сверху и снизу от текста
        const w = textW + glow * 2;
        const h = half * 2 + glow * 2;

        return makeSprite(key, w, h, function (g, sw, sh) {
            const cx = sw / 2;
            const cy = sh / 2;

            // верёвочка (без свечения)
            const strHalf = Math.max(3, fontSize * 0.12);
            g.fillStyle = 'rgb(200,180,100)';
            g.beginPath();
            g.moveTo(cx, cy + fontSize * 0.6);
            g.lineTo(cx - strHalf, cy + fontSize * 0.95);
            g.lineTo(cx + strHalf, cy + fontSize * 0.95);
            g.closePath();
            g.fill();

            // текст со свечением
            g.font = '600 ' + fontSize + 'px ' + FONT;
            g.shadowColor = color;
            g.shadowBlur = fontSize * 0.55;
            g.fillStyle = color;
            g.fillText(text, cx, cy);
            g.fillText(text, cx, cy);
            g.shadowBlur = 0;
            g.fillStyle = color;
            g.fillText(text, cx, cy);

            // сердечко сверху
            g.font = fontSize * 0.6 + 'px sans-serif';
            g.shadowColor = color;
            g.shadowBlur = fontSize * 0.4;
            g.fillStyle = '#ff6688';
            g.fillText('❤️', cx, cy - fontSize * 0.7);
            g.shadowBlur = 0;
        });
    }

    function starSprite() {
        const cached = spriteCache.get('star');
        if (cached) return cached;

        return makeSprite('star', 16, 16, function (g, sw, sh) {
            const r = sw / 2;
            const grd = g.createRadialGradient(r, r, 0, r, r, r);
            grd.addColorStop(0, 'rgba(255,244,250,1)');
            grd.addColorStop(0.3, 'rgba(255,214,232,0.55)');
            grd.addColorStop(1, 'rgba(255,214,232,0)');
            g.fillStyle = grd;
            g.fillRect(0, 0, sw, sh);
        });
    }

    // контур сердца (path) — для спрайта-сердечка и парящих сердечек
    function heartPath(g, cx, cy, s) {
        const h = s * 0.5;
        g.beginPath();
        g.moveTo(cx, cy + h * 0.92);
        g.bezierCurveTo(cx - h * 1.9, cy + h * 0.1, cx - h * 1.15, cy - h * 1.3, cx, cy - h * 0.42);
        g.bezierCurveTo(cx + h * 1.15, cy - h * 1.3, cx + h * 1.9, cy + h * 0.1, cx, cy + h * 0.92);
        g.closePath();
    }

    // маленькое сердечко-глиф (финальная фаза: слово → сердечко)
    function heartGlyphSprite(color) {
        const key = 'g|' + color;
        const cached = spriteCache.get(key);
        if (cached) return cached;

        return makeSprite(key, GLYPH_SIZE + 16, GLYPH_SIZE + 16, function (g, sw, sh) {
            const cx = sw / 2;
            const cy = sh / 2;
            const s = GLYPH_SIZE;
            g.shadowColor = color;
            g.shadowBlur = 7;
            g.fillStyle = color;
            heartPath(g, cx, cy, s);
            g.fill();
            heartPath(g, cx, cy, s);
            g.fill();
            g.shadowBlur = 0;
            g.globalAlpha = 0.4;
            g.fillStyle = '#ffd9e6';
            heartPath(g, cx, cy - s * 0.04, s * 0.55);
            g.fill();
            g.globalAlpha = 1;
        });
    }

    // наложение спрайта: сдвиг + масштаб + альфа (+поворот, если нужен)
    function drawSprite(sp, x, y, spriteScale, alpha, rot) {
        if (alpha <= 0.01 || !sp) return;
        const w = sp.w * spriteScale;
        const h = sp.h * spriteScale;
        ctx.globalAlpha = alpha;
        if (rot) {
            ctx.save();
            ctx.translate(x, y);
            ctx.rotate(rot);
            ctx.drawImage(sp.canvas, -w * 0.5, -h * 0.5, w, h);
            ctx.restore();
        } else {
            ctx.drawImage(sp.canvas, x - w * 0.5, y - h * 0.5, w, h);
        }
        ctx.globalAlpha = 1;
    }

    // ---------- ГЕОМЕТРИЯ / РАЗМЕРЫ ----------
    function updateSize() {
        width = Math.max(1, window.innerWidth);
        height = Math.max(1, window.innerHeight);

        const newDpr = Math.min(window.devicePixelRatio || 1, 2);
        if (newDpr !== dpr) {
            dpr = newDpr;
            clearSpriteCache(); // спрайты пересоздадутся под новый DPR
        }

        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.globalAlpha = 1;
        ctx.shadowBlur = 0;

        // Сердце (32×30 условных единиц) целиком умещается в полосе
        // между подписью сверху и панелью управления снизу.
        const bandTop = 65;
        const bandHeight = Math.max(220, height - 150);
        // 140px — зазор на ширину самих строк «I LOVE YOU» вокруг контурных точек
        scale = Math.min(Math.max(80, width - 140) / 32, bandHeight * 0.92 / 30);
        offsetX = width / 2;
        offsetY = bandTop + bandHeight / 2 - 2 * scale; // центр bbox сердца — центр полосы
        centerY = bandTop + bandHeight / 2;

        // имя в центре сердца
        const nameFs = Math.max(16, Math.min(72, Math.round(scale * 3)));
        nameSprite = textSprite('КАТЯ', '#ffd9e6', nameFs, '700');

        // градиент создаётся один раз на размер экрана, а не каждый кадр
        backgroundGradient = ctx.createLinearGradient(0, 0, width, height);
        backgroundGradient.addColorStop(0, '#0a0718');
        backgroundGradient.addColorStop(1, '#1c0b24');
    }

    // классические точки сердца (остриё вниз)
    function generateHeartPoints(count) {
        const points = [];
        for (let i = 0; i < count; i++) {
            const t = (i / count) * Math.PI * 2;
            const x = 16 * Math.pow(Math.sin(t), 3);
            let y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
            y = -y;
            points.push({ x: x, y: y });
        }
        // внутренние точки: сжатые копии контурных — так заполнение
        // гарантированно остаётся внутри силуэта
        for (let i = 0; i < count * 0.3; i++) {
            const src = points[(Math.random() * count) | 0];
            const k = 0.15 + Math.random() * 0.55;
            points.push({
                x: src.x * k + (Math.random() - 0.5),
                y: src.y * k + (Math.random() - 0.5)
            });
        }
        return points;
    }

    // ---------- СТИЛЬ 1: СЕРДЦЕ ИЗ СЛОВ ----------
    function initHeartStyle() {
        const points = generateHeartPoints(520);
        heartParts = [];
        for (let i = 0; i < points.length; i++) {
            const p = points[i];
            const color = LOVE_COLORS[i % LOVE_COLORS.length];
            const sizeBase = 10 + (i % 14);
            heartParts.push({
                ox: p.x,              // нормализованные координаты сердца
                oy: p.y,
                x: Math.random() * width,   // стартовое разбросанное положение
                y: Math.random() * height,
                color: color,
                phase: i * 0.012,
                sizeBase: sizeBase,
                floatXoff: Math.sin(i * 0.08) * 0.7,
                floatYoff: Math.cos(i * 0.09) * 0.7,
                sp: textSprite('I LOVE YOU', color, sizeBase, '500', '#ffbbcc', 0.45),
                // сборка (bezier)
                ax0: 0, ay0: 0, cx: 0, cy: 0, delay: 0, dur: 1, u: 1,
                // удар сердца (импульс)
                bv: 0,
                // финал
                fx: null, fy: null, glyph: null, hide: false, ft: 1
            });
        }
    }

    // подготовка траекторий сборки — вызывается при старте анимации
    // и при каждом применении стиля «heart» в фазе assemble
    function prepareAssemblePaths() {
        const t0x = offsetX;
        const t0y = offsetY;
        for (let i = 0; i < heartParts.length; i++) {
            const p = heartParts[i];
            p.ax0 = p.x;
            p.ay0 = p.y;
            p.u = 0;
            p.bv = 0;
            p.hide = false;
            p.ft = 1;
            p.fx = null;
            p.delay = Math.random() * 1.9;      // max 1.9
            p.dur = 1.35 + Math.random() * 0.5; // max 1.85 → всего ≤ 3.75
            // контрольная точка: середина пути + перпендикулярный сдвиг для дуги
            const ex = t0x + p.ox * scale;
            const ey = t0y + p.oy * scale;
            const dx = ex - p.ax0;
            const dy = ey - p.ay0;
            const len = Math.sqrt(dx * dx + dy * dy) || 1;
            const mx = (p.ax0 + ex) / 2;
            const my = (p.ay0 + ey) / 2;
            const off = (Math.random() - 0.5) * len * 0.6;
            p.cx = mx + (-dy / len) * off;
            p.cy = my + (dx / len) * off;
        }
    }

    function drawHeartStyle() {
        for (let i = 0; i < heartParts.length; i++) {
            const p = heartParts[i];
            const individual = time + p.phase;
            const sizePulse = 0.85 + Math.sin(individual * 2.8) * 0.18;
            const sprScale = Math.max(0.5, Math.min(1.7, sizePulse * (1 + beatP * 0.12)));
            const appear = (phase === 'assemble') ? Math.min(1, 0.25 + p.u * 2.5) : 1;
            const alpha = (0.7 + Math.sin(individual * 3.2) * 0.25) * fade * appear;
            const rot = sprScale > 0.7 ? Math.sin(individual * 1.5) * 0.06 : 0;

            drawSprite(p.sp, p.x, p.y, sprScale, alpha, rot);
        }
    }

    // ---------- СТИЛЬ 2: ЛЮБОВНЫЙ ДОЖДЬ ----------
    const RAIN_TEXTS = ['I LOVE YOU', 'ЛЮБЛЮ', '❤️', 'ТЫ МОЯ РАДОСТЬ'];

    function initRainStyle() {
        rainDrops = [];
        for (let i = 0; i < 180; i++) {
            const color = LOVE_COLORS[Math.floor(Math.random() * LOVE_COLORS.length)];
            const size = Math.round(12 + Math.random() * 12);
            const text = RAIN_TEXTS[Math.floor(Math.random() * RAIN_TEXTS.length)];
            rainDrops.push({
                x: Math.random() * 100,   // процент ширины
                y: Math.random() * 100,   // процент высоты
                speed: 1 + Math.random() * 2.5,
                text: text,
                color: color,
                size: size,
                phase: Math.random() * Math.PI * 2,
                sp: textSprite(text, color, size, '500')
            });
        }
    }

    function drawRainStyle() {
        for (let i = 0; i < rainDrops.length; i++) {
            const d = rainDrops[i];
            const yPercent = (d.y + time * d.speed) % 120;
            const xPos = (d.x / 100) * width;
            const yPos = (yPercent / 100) * height - 50;

            const alpha = (0.6 + Math.sin(time * 3 + d.phase) * 0.3) * fade;
            const fontSize = d.size * (0.8 + Math.sin(time * 2 + d.phase) * 0.2);

            drawSprite(d.sp, xPos, yPos, fontSize / d.size, alpha, 0);
        }
    }

    // ---------- СТИЛЬ 3: ВОЗДУШНЫЕ ШАРЫ ----------
    const BALLOON_TEXTS = ['I LOVE YOU', 'ТЫ ЛУЧШАЯ', 'МОЁ СЕРДЦЕ', 'НАВСЕГДА', 'СЧАСТЛИВ'];

    function initBalloonsStyle() {
        balloons = [];
        for (let i = 0; i < 65; i++) {
            const color = LOVE_COLORS[Math.floor(Math.random() * LOVE_COLORS.length)];
            const size = Math.round(14 + Math.random() * 12);
            const text = BALLOON_TEXTS[Math.floor(Math.random() * BALLOON_TEXTS.length)];
            balloons.push({
                x: 15 + Math.random() * 70,          // процент ширины (с запасом от краёв)
                y: Math.random() * (height * 1.7) - height * 0.15, // пиксели
                vy: -(30 + Math.random() * 40),      // пиксели в секунду, вверх
                text: text,
                color: color,
                size: size,
                swing: Math.random() * Math.PI * 2,
                swingSpeed: 0.5 + Math.random(),
                sp: balloonSprite(text, color, size)
            });
        }
    }

    function drawBalloonsStyle(dt) {
        for (let i = 0; i < balloons.length; i++) {
            const b = balloons[i];

            b.y += b.vy * dt;
            if (b.y < -160) b.y = height + 160;

            const swingX = Math.sin(time * b.swingSpeed + b.swing) * 12;
            const xPos = (b.x / 100) * width + swingX;

            const alpha = (0.8 + Math.sin(time * 2) * 0.2) * fade;
            const spriteScale = 0.9 + Math.sin(time * 1.5) * 0.1;

            drawSprite(b.sp, xPos, b.y, spriteScale, alpha, 0);
        }
    }

    // ---------- СТИЛЬ 4: СВЕТЛЯЧКИ ЛЮБВИ ----------
    const FIREFLY_TEXTS = ['✨ LOVE ✨', 'I ❤️ U', 'МОЯ ЛУНА', 'СЧАСТЬЕ'];

    function initFirefliesStyle() {
        fireflies = [];
        for (let i = 0; i < 120; i++) {
            const color = LOVE_COLORS[Math.floor(Math.random() * LOVE_COLORS.length)];
            const size = Math.round(12 + Math.random() * 11);
            const text = FIREFLY_TEXTS[Math.floor(Math.random() * FIREFLY_TEXTS.length)];
            fireflies.push({
                x: Math.random() * width,
                y: Math.random() * height,
                vx: (Math.random() - 0.5) * 48, // пиксели в секунду
                vy: (Math.random() - 0.5) * 48,
                text: text,
                color: color,
                size: size,
                phase: Math.random() * Math.PI * 2,
                sp: textSprite(text, color, size, '500', '#ffaacc', 0.5)
            });
        }
    }

    function drawFirefliesStyle(dt) {
        for (let i = 0; i < fireflies.length; i++) {
            const f = fireflies[i];

            f.x += (f.vx + Math.sin(time * 1.2 + f.phase) * 30) * dt;
            f.y += (f.vy + Math.cos(time * 1.5 + f.phase) * 30) * dt;

            if (f.x < -50) f.x = width + 30;
            else if (f.x > width + 50) f.x = -30;
            if (f.y < -50) f.y = height + 30;
            else if (f.y > height + 50) f.y = -30;

            const alpha = (0.6 + Math.sin(time * 3 + f.phase) * 0.4) * fade;
            const fontSize = f.size * (0.8 + Math.sin(time * 2.5 + f.phase) * 0.25);

            drawSprite(f.sp, f.x, f.y, fontSize / f.size, alpha, 0);
        }
    }

    // ---------- СТИЛЬ 5: ВОЛНА ПРИЗНАНИЙ ----------
    const WAVE_PHRASES = ['I LOVE YOU', 'ТЫ МОЁ СОЛНЦЕ', 'ОБОЖАЮ', 'НАВСЕГДА ТВОЙ', 'СЧАСТЛИВ С ТОБОЙ'];

    function initWaveStyle() {
        waveWords = [];
        for (let i = 0; i < 220; i++) {
            const size = 11 + (i % 13);
            const text = WAVE_PHRASES[i % WAVE_PHRASES.length];
            const color = LOVE_COLORS[i % LOVE_COLORS.length];
            waveWords.push({
                offset: i * 0.08,
                yOffset: (Math.random() - 0.5) * 70,
                text: text,
                color: color,
                size: size,
                speed: 1.2 + Math.random() * 1.2,
                sp: textSprite(text, color, size, '500')
            });
        }
    }

    function drawWaveStyle() {
        const amplitude = 60 + Math.sin(time * 0.8) * 15;
        const frequency = 0.012;

        for (let i = 0; i < waveWords.length; i++) {
            const w = waveWords[i];
            const xPos = (time * w.speed * 35 + w.offset * 25) % (width + 200) - 100;
            if (xPos < -50 || xPos > width + 50) continue;

            const yPos = centerY + Math.sin(xPos * frequency + time) * amplitude + w.yOffset;
            const alpha = (0.7 + Math.sin(time * 2 + w.offset) * 0.3) * fade;
            const fontSize = w.size * (0.9 + Math.sin(time * 2.5 + w.offset) * 0.15);

            drawSprite(w.sp, xPos, yPos, fontSize / w.size, alpha, 0);
        }
    }

    // ---------- ФИНАЛЬНАЯ НАДПИСЬ ----------
    // Пиксели надписи «Катя, я люблю тебя ♥» запекаются в массив точек —
    // к ним частицы сердца превращаются в финале.
    function buildFinalePoints() {
        finalePoints = [];
        finaleSprite = null;

        const maxW = Math.min(width - 40, 1000);
        measureCtx.font = '700 100px ' + FONT;
        const w100 = measureCtx.measureText(CFG.finaleText).width || 1000;
        let fs = Math.min(110, (maxW / w100) * 100);
        fs = Math.max(18, fs);

        measureCtx.font = '700 ' + Math.round(fs) + 'px ' + FONT;
        const tw = Math.ceil(measureCtx.measureText(CFG.finaleText).width);
        const th = Math.ceil(fs * 1.4);
        const pad = Math.ceil(fs * 0.6);

        const c = document.createElement('canvas');
        c.width = Math.max(2, tw + pad * 2);
        c.height = Math.max(2, th + pad * 2);
        const g = c.getContext('2d', { willReadFrequently: true });
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.font = '700 ' + Math.round(fs) + 'px ' + FONT;

        // надпись со свечением
        g.shadowColor = '#ff4d6d';
        g.shadowBlur = fs * 0.4;
        g.fillStyle = '#ffe3ec';
        g.fillText(CFG.finaleText, c.width / 2, c.height / 2);
        g.fillText(CFG.finaleText, c.width / 2, c.height / 2);
        g.shadowBlur = 0;
        g.fillStyle = '#fff0f6';
        g.fillText(CFG.finaleText, c.width / 2, c.height / 2);

        // спрайт надписи для подложки за частицами
        finaleSprite = {
            canvas: c,
            w: c.width,
            h: c.height,
            cx: offsetX,
            cy: centerY
        };

        let data;
        try {
            data = g.getImageData(0, 0, c.width, c.height).data;
        } catch (e) {
            return; // фallback: частицы останутся в форме сердца
        }

        const pts = [];
        const step = Math.max(2, Math.round(fs / 14));
        const originX = offsetX - c.width / 2;
        const originY = centerY - c.height / 2;
        for (let y = 0; y < c.height; y += step) {
            for (let x = 0; x < c.width; x += step) {
                const a = data[(y * c.width + x) * 4 + 3];
                if (a > 170) pts.push({ x: originX + x, y: originY + y });
            }
        }
        finalePoints = pts;
    }

    function assignFinaleTargets() {
        const n = finalePoints ? finalePoints.length : 0;
        const m = heartParts.length;

        if (n === 0) {
            // не удалось вырезать надпись — остаёмся сердцем
            for (let i = 0; i < m; i++) {
                const p = heartParts[i];
                p.fx = null;
                p.fy = null;
                p.hide = false;
                p.glyph = heartGlyphSprite(p.color);
            }
            return;
        }

        const start = Math.floor(Math.random() * n);
        for (let i = 0; i < m; i++) {
            const p = heartParts[i];
            p.glyph = heartGlyphSprite(p.color);
            if (n >= m) {
                const q = finalePoints[(start + Math.floor(i * n / m)) % n];
                p.fx = q.x;
                p.fy = q.y;
                p.hide = false;
            } else if (i < n) {
                const q = finalePoints[(start + i) % n];
                p.fx = q.x;
                p.fy = q.y;
                p.hide = false;
            } else {
                p.fx = null;    // лишние частицы плавно гаснут
                p.fy = null;
                p.hide = true;
            }
        }
    }

    // подготовка финала (хук применяется при любом применении стиля heart)
    function prepareFinale() {
        buildFinalePoints();
        assignFinaleTargets();
        finaleReady = true;
    }

    // кроссфейд слово → сердечко
    function finaleBlend() {
        if (phase !== 'finale' || !finaleReady) return 0;
        return smooth(Math.min(1, finaleT / CFG.finaleDur), 0.25, 0.85);
    }

    function drawFinale(k) {
        // подложка финальной надписи позади частиц
        if (finaleSprite && k > 0.01) {
            ctx.globalAlpha = 0.65 * k;
            ctx.drawImage(
                finaleSprite.canvas,
                finaleSprite.cx - finaleSprite.w / 2,
                finaleSprite.cy - finaleSprite.h / 2,
                finaleSprite.w,
                finaleSprite.h
            );
            ctx.globalAlpha = 1;
        }

        for (let i = 0; i < heartParts.length; i++) {
            const p = heartParts[i];
            if (p.ft < 0.02) continue;
            const individual = time + p.phase;
            const sizePulse = 0.85 + Math.sin(individual * 2.8) * 0.18;
            const sprScale = Math.max(0.5, Math.min(1.7, sizePulse * (1 + beatP * 0.12)));
            const alpha = (0.75 + Math.sin(individual * 3.2) * 0.2) * p.ft;
            const rot = Math.sin(individual * 1.5) * 0.05;

            if (k < 0.999) {
                drawSprite(p.sp, p.x, p.y, sprScale, alpha * (1 - k), rot);
            }
            if (k > 0.001 && p.glyph) {
                const gs = Math.max(0.22, p.sizeBase * 0.0346 * sprScale);
                drawSprite(p.glyph, p.x, p.y, gs, alpha * k, rot);
            }
        }
    }

    // ---------- ДВИЖЕНИЕ ЧАСТИЦ СЕРДЦА ----------
    function updateHeartParts(dt) {
        const hp = 1 + Math.sin(time * 2.4) * 0.035 + beatP * 0.06;
        const finaleActive = (phase === 'finale' && finaleReady);
        const followK = 1 - Math.exp(-(finaleActive ? 3.2 : 6) * dt);
        const ftK = 1 - Math.exp(-8 * dt);
        const beatDecay = Math.exp(-dt * 6);
        const bcx = offsetX;
        const bcy = finaleActive ? centerY : offsetY;
        const R = CFG.pointerRadius;

        for (let i = 0; i < heartParts.length; i++) {
            const p = heartParts[i];

            let tx, ty;
            if (finaleActive && p.fx !== null) {
                tx = p.fx + Math.sin(time * 1.3 + p.floatXoff) * 1.6;
                ty = p.fy + Math.cos(time * 1.1 + p.floatYoff) * 1.6;
                p.ft += ((p.hide ? 0 : 1) - p.ft) * ftK;
            } else {
                tx = offsetX + p.ox * scale * hp + Math.sin(time * 1.2 + p.floatXoff) * 0.8;
                ty = offsetY + p.oy * scale * hp + Math.cos(time + p.floatYoff) * 0.8;
                p.ft += (1 - p.ft) * ftK;
            }

            // притяжение к курсору / пальцу
            if (pointerInside) {
                const dx = pointerX - tx;
                const dy = pointerY - ty;
                const d2 = dx * dx + dy * dy;
                if (d2 < R * R) {
                    const d = Math.sqrt(d2) || 1;
                    const f = 1 - d / R;
                    const pull = f * f * 46;
                    tx += (dx / d) * pull;
                    ty += (dy / d) * pull;
                }
            }

            if (phase === 'assemble') {
                // квадратичная кривая Безье: P0 (разброс) → P1 (дуга) → цель
                p.u = clamp((assembleT - p.delay) / p.dur, 0, 1);
                const s = easeInOut(p.u);
                const is = 1 - s;
                p.x = is * is * p.ax0 + 2 * is * s * p.cx + s * s * tx;
                p.y = is * is * p.ay0 + 2 * is * s * p.cy + s * s * ty;
            } else {
                // экспоненциальное преследование цели
                p.x += (tx - p.x) * followK;
                p.y += (ty - p.y) * followK;
            }

            // удар сердца: волна от центра
            if (p.bv !== 0) {
                let nx = p.x - bcx;
                let ny = p.y - bcy;
                let L = Math.sqrt(nx * nx + ny * ny);
                if (L < 3) { nx = p.ox; ny = p.oy; L = Math.sqrt(nx * nx + ny * ny) || 1; }
                p.x += (nx / L) * p.bv * dt;
                p.y += (ny / L) * p.bv * dt;
                p.bv *= beatDecay;
                if (Math.abs(p.bv) < 0.05) p.bv = 0;
            }
        }
    }

    // ---------- ИМЯ В ЦЕНТРЕ СЕРДЦА ----------
    function nameAlphaFor(k) {
        if (!started) return 0;
        if (phase === 'assemble') return smooth(assembleT, 2.0, 3.4);
        if (phase === 'main') return 1;
        if (phase === 'finale') return 1 - k;
        return 0;
    }

    function drawName(alpha) {
        if (alpha <= 0.02 || !nameSprite) return;
        const cx = offsetX;
        const cy = offsetY;

        // тёмный ореол, чтобы имя читалось поверх частиц
        const r = nameSprite.w * 0.62;
        const grd = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
        grd.addColorStop(0, 'rgba(10,7,24,0.9)');
        grd.addColorStop(1, 'rgba(10,7,24,0)');
        ctx.globalAlpha = alpha;
        ctx.fillStyle = grd;
        ctx.beginPath();
        ctx.ellipse(cx, cy, r, r * 0.7, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;

        drawSprite(nameSprite, cx, cy, 1 + beatP * 0.03, alpha, 0);
    }

    // ---------- ФОН: ЗВЁЗДЫ, BOKEH, ПАРЯЩИЕ СЕРДЕЧКА, МЕТЕОРЫ ----------
    function initStars() {
        stars = [];
        const count = Math.min(130, Math.max(50, Math.round(width * height / 11000)));
        for (let i = 0; i < count; i++) {
            stars.push({
                nx: Math.random(), // нормализованные координаты — переживают resize
                ny: Math.random(),
                size: 5 + Math.random() * 9,
                phase: Math.random() * Math.PI * 2,
                speed: 0.4 + Math.random() * 1.1
            });
        }
    }

    function initBokeh() {
        bokeh = [];
        const colors = ['255,107,157', '168,120,255', '255,150,190', '255,80,130'];
        for (let i = 0; i < 14; i++) {
            bokeh.push({
                nx: Math.random(),
                ny: Math.random(),
                r: 40 + Math.random() * 90,
                col: colors[i % colors.length],
                a: 0.04 + Math.random() * 0.06,
                ph: Math.random() * Math.PI * 2,
                speed: 0.08 + Math.random() * 0.15
            });
        }
    }

    function initFloatHearts() {
        floatHearts = [];
        for (let i = 0; i < 12; i++) {
            floatHearts.push({
                nx: Math.random(),
                y: Math.random() * height,
                size: 10 + Math.random() * 14,
                color: LOVE_COLORS[i % LOVE_COLORS.length],
                vy: -(8 + Math.random() * 16),
                ph: Math.random() * Math.PI * 2
            });
        }
    }

    function drawBackground() {
        // сброс состояния: иначе фон рисуется с остаточным shadowBlur
        // и globalAlpha предыдущего кадра — это и баг, и огромные тормоза
        ctx.globalAlpha = 1;
        ctx.shadowBlur = 0;
        ctx.globalCompositeOperation = 'source-over';

        ctx.fillStyle = backgroundGradient;
        ctx.fillRect(0, 0, width, height);

        const sp = starSprite();
        for (let i = 0; i < stars.length; i++) {
            const s = stars[i];
            const a = 0.18 + (0.5 + 0.5 * Math.sin(time * s.speed + s.phase)) * 0.55;
            ctx.globalAlpha = a;
            ctx.drawImage(sp.canvas, s.nx * width - s.size / 2, s.ny * height - s.size / 2, s.size, s.size);
        }
        ctx.globalAlpha = 1;
    }

    function drawBokeh() {
        ctx.globalCompositeOperation = 'lighter';
        for (let i = 0; i < bokeh.length; i++) {
            const b = bokeh[i];
            const x = (b.nx + Math.sin(time * b.speed + b.ph) * 0.03) * width;
            const y = (b.ny + Math.cos(time * b.speed * 0.8 + b.ph) * 0.03) * height;
            const a = b.a * (0.7 + 0.3 * Math.sin(time * 0.6 + b.ph));
            const grd = ctx.createRadialGradient(x, y, 0, x, y, b.r);
            grd.addColorStop(0, 'rgba(' + b.col + ',' + a.toFixed(3) + ')');
            grd.addColorStop(1, 'rgba(' + b.col + ',0)');
            ctx.fillStyle = grd;
            ctx.beginPath();
            ctx.arc(x, y, b.r, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalCompositeOperation = 'source-over';
    }

    function drawFloatHearts(dt) {
        if (phase === 'intro') return;
        for (let i = 0; i < floatHearts.length; i++) {
            const h = floatHearts[i];
            h.y += h.vy * dt;
            if (h.y < -30) {
                h.y = height + 20;
                h.nx = Math.random();
            }
            const x = h.nx * width + Math.sin(time * 0.9 + h.ph) * 14;
            const alpha = (0.22 + 0.18 * Math.sin(time * 1.4 + h.ph)) * fade;
            const sp = heartGlyphSprite(h.color);
            drawSprite(sp, x, h.y, h.size / GLYPH_SIZE, alpha, Math.sin(time * 0.7 + h.ph) * 0.25);
        }
    }

    function drawMeteors(dt) {
        meteorTimer -= dt;
        if (meteorTimer <= 0) {
            meteors.push({
                x: width * (0.25 + Math.random() * 0.7),
                y: -20,
                vx: -(60 + Math.random() * 80),
                vy: 140 + Math.random() * 120,
                life: 0,
                max: 1.1 + Math.random() * 0.4
            });
            meteorTimer = 6 + Math.random() * 9;
        }

        let drew = false;
        for (let i = meteors.length - 1; i >= 0; i--) {
            const m = meteors[i];
            m.life += dt;
            m.x += m.vx * dt;
            m.y += m.vy * dt;
            if (m.life > m.max || m.y > height + 40 || m.x < -80) {
                meteors.splice(i, 1);
                continue;
            }
            if (!drew) {
                ctx.globalCompositeOperation = 'lighter';
                drew = true;
            }
            const a = Math.sin((m.life / m.max) * Math.PI);
            const tailX = m.x - m.vx * 0.28;
            const tailY = m.y - m.vy * 0.28;
            const grd = ctx.createLinearGradient(m.x, m.y, tailX, tailY);
            grd.addColorStop(0, 'rgba(255,235,245,' + (0.85 * a).toFixed(3) + ')');
            grd.addColorStop(1, 'rgba(255,150,190,0)');
            ctx.strokeStyle = grd;
            ctx.lineWidth = 2.2;
            ctx.beginPath();
            ctx.moveTo(m.x, m.y);
            ctx.lineTo(tailX, tailY);
            ctx.stroke();
        }
        if (drew) ctx.globalCompositeOperation = 'source-over';
    }

    // ---------- ИСКРЫ ПО КЛИКУ ----------
    function spawnSparks(x, y) {
        const n = 16 + Math.floor(Math.random() * 7);
        for (let i = 0; i < n; i++) {
            const ang = Math.random() * Math.PI * 2;
            const spd = 60 + Math.random() * 220;
            sparks.push({
                x: x,
                y: y,
                vx: Math.cos(ang) * spd,
                vy: Math.sin(ang) * spd - 60,
                life: 0,
                max: 0.5 + Math.random() * 0.5,
                size: 5 + Math.random() * 9,
                color: LOVE_COLORS[Math.floor(Math.random() * LOVE_COLORS.length)]
            });
        }
    }

    function drawSparks(dt) {
        if (!sparks.length) return;
        const sp = starSprite();
        for (let i = sparks.length - 1; i >= 0; i--) {
            const s = sparks[i];
            s.life += dt;
            if (s.life >= s.max) {
                sparks.splice(i, 1);
                continue;
            }
            s.vy += 220 * dt;
            s.x += s.vx * dt;
            s.y += s.vy * dt;
            const t = 1 - s.life / s.max;
            const sz = s.size * (0.5 + t * 0.8);
            ctx.globalAlpha = t * 0.9;
            ctx.drawImage(sp.canvas, s.x - sz / 2, s.y - sz / 2, sz, sz);
            ctx.globalAlpha = 1;
        }
    }

    // ---------- УДАР СЕРДЦА ----------
    function applyBeatImpulse(strength) {
        const finaleActive = (phase === 'finale' && finaleReady);
        const bcx = offsetX;
        const bcy = finaleActive ? centerY : offsetY;
        for (let i = 0; i < heartParts.length; i++) {
            const p = heartParts[i];
            const dx = p.x - bcx;
            const dy = p.y - bcy;
            const d2 = dx * dx + dy * dy;
            p.bv += 58 * strength * Math.exp(-d2 / (2 * 70 * 70));
        }
    }

    function triggerBeat() {
        beatP = 1;
        beat2At = time + 0.24;
        applyBeatImpulse(1);
        playBeatSound();
    }

    function drawBeatFlash() {
        if (beatP < 0.01) return;
        const r = Math.min(width, height) * 0.5;
        const grd = ctx.createRadialGradient(offsetX, offsetY, 0, offsetX, offsetY, r);
        grd.addColorStop(0, 'rgba(255,80,130,' + (0.2 * beatP).toFixed(3) + ')');
        grd.addColorStop(1, 'rgba(255,80,130,0)');
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = grd;
        ctx.fillRect(0, 0, width, height);
        ctx.globalCompositeOperation = 'source-over';
    }

    // ---------- ЗВУК: ТИХОЕ СЕРДЦЕБИЕНИЕ (Web Audio, без файлов) ----------
    function ensureAudio() {
        if (audioCtx) return;
        try {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) return;
            audioCtx = new AC();
            masterGain = audioCtx.createGain();
            masterGain.gain.value = muted ? 0 : 0.2;
            masterGain.connect(audioCtx.destination);
        } catch (e) {
            audioCtx = null;
        }
    }

    function thump(at, vol, f) {
        if (!audioCtx || !masterGain || muted) return;
        try {
            const t = audioCtx.currentTime + at;
            const osc = audioCtx.createOscillator();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(f, t);
            osc.frequency.exponentialRampToValueAtTime(f * 0.55, t + 0.22);

            const lp = audioCtx.createBiquadFilter();
            lp.type = 'lowpass';
            lp.frequency.value = 260;
            lp.Q.value = 0.7;

            const g = audioCtx.createGain();
            g.gain.setValueAtTime(0.0001, t);
            g.gain.exponentialRampToValueAtTime(vol, t + 0.015);
            g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);

            osc.connect(lp);
            lp.connect(g);
            g.connect(masterGain);
            osc.start(t);
            osc.stop(t + 0.35);
        } catch (e) { /* звук не критичен */ }
    }

    function playBeatSound() {
        thump(0, 1.0, 62);     // «тук»
        thump(0.24, 0.55, 52); // «тук» потише
    }

    // ---------- УПРАВЛЕНИЕ СТИЛЯМИ ----------
    const CAPTIONS = {
        heart: '✨ Сердце из слов «I LOVE YOU» ✨',
        rain: '🌧️ Дождь из признаний 🌧️',
        balloons: '🎈 Воздушные шары с любовью 🎈',
        fireflies: '✨ Светлячки нежности ✨',
        wave: '🌊 Волна бесконечной любви 🌊'
    };
    const FINALE_CAPTION = '💖 Катя, я люблю тебя 💖';

    function setActiveBtn(style) {
        document.querySelectorAll('.btn[data-style]').forEach(function (b) {
            b.classList.toggle('active', b.dataset.style === style);
        });
    }

    function switchStyle(style) {
        // освобождаем спрайты старого стиля (память) и создаём частицы нового
        clearSpriteCache();

        if (style === 'rain') { currentStyle = 'rain'; initRainStyle(); }
        else if (style === 'balloons') { currentStyle = 'balloons'; initBalloonsStyle(); }
        else if (style === 'fireflies') { currentStyle = 'fireflies'; initFirefliesStyle(); }
        else if (style === 'wave') { currentStyle = 'wave'; initWaveStyle(); }
        else { currentStyle = 'heart'; initHeartStyle(); }

        currentStyleIndex = Math.max(0, STYLES.indexOf(currentStyle));
        captionEl.textContent = (phase === 'finale')
            ? FINALE_CAPTION
            : (CAPTIONS[currentStyle] || CAPTIONS.heart);

        // хуки сценария
        if (currentStyle === 'heart') {
            if (phase === 'assemble') prepareAssemblePaths();
            if (phase === 'finale' && !finaleReady) prepareFinale();
        }
    }

    function scheduleNextStyle() {
        const base = pendingStyle || currentStyle;
        const idx = Math.max(0, STYLES.indexOf(base));
        const next = STYLES[(idx + 1) % STYLES.length];
        if (next !== currentStyle) pendingStyle = next;
    }

    function startAssemble() {
        phase = 'assemble';
        assembleT = 0;
        scenarioT = 0;
        finaleT = 0;
        finaleReady = false;
        finaleDone = false;
        replayShown = false;
        fade = 1;
        pendingStyle = null;
        cycleTimer = 0;
        replayEl.classList.remove('show');
        captionEl.textContent = CAPTIONS.heart;
        setActiveBtn('heart');
        nextBeat = time + 0.5;

        if (currentStyle !== 'heart') {
            pendingStyle = 'heart'; // применится на первом же затухании
        } else {
            // разбросать частицы и заново построить траектории
            for (let i = 0; i < heartParts.length; i++) {
                const p = heartParts[i];
                p.x = Math.random() * width;
                p.y = Math.random() * height;
            }
            prepareAssemblePaths();
        }
    }

    function startFinale() {
        if (phase === 'finale') return;
        phase = 'finale';
        finaleT = 0;
        finaleReady = false;
        cycleTimer = 0;
        pendingStyle = null;
        captionEl.textContent = FINALE_CAPTION;
        setActiveBtn('heart');

        if (currentStyle === 'heart') {
            prepareFinale();
        } else {
            pendingStyle = 'heart'; // старый стиль плавно затухнет, применится heart
        }
    }

    function exitFinale(style) {
        phase = 'main';
        finaleReady = false;
        finaleT = 0;
        scenarioT = 0;
        finaleDone = true;
        replayShown = false;
        replayEl.classList.remove('show');
        for (let i = 0; i < heartParts.length; i++) {
            heartParts[i].hide = false;
            heartParts[i].ft = 1;
        }
        pendingStyle = style || null;
        if (style) {
            captionEl.textContent = CAPTIONS[style] || CAPTIONS.heart;
            setActiveBtn(style);
        }
    }

    // ---------- ФОН/СТИЛЬ: ГЛАВНЫЙ ЦИКЛ ----------
    function drawCurrentStyle(dt) {
        if (currentStyle === 'heart') drawHeartStyle();
        else if (currentStyle === 'rain') drawRainStyle();
        else if (currentStyle === 'balloons') drawBalloonsStyle(dt);
        else if (currentStyle === 'fireflies') drawFirefliesStyle(dt);
        else drawWaveStyle();
    }

    function animate(ts) {
        const dt = Math.min(MAX_DT, Math.max(0, (ts - lastTs) / 1000));
        lastTs = ts;
        time += dt; // без обрезки: рывок каждые ~12 секунд исчез

        // таймеры сценария
        if (phase === 'assemble' || phase === 'main') scenarioT += dt;

        // сердцебиение
        if (started) {
            if (time >= nextBeat) {
                triggerBeat();
                nextBeat += CFG.beatInterval;
            }
            if (beat2At > 0 && time >= beat2At) {
                beatP = Math.max(beatP, 0.55);
                applyBeatImpulse(0.5);
                beat2At = -1;
            }
            beatP *= Math.exp(-dt * 7);
        }

        // кроссфейд смены стиля: старый стиль гаснет → переключение → новый вспыхивает
        if (pendingStyle !== null) {
            fade -= dt / CFG.fadeTime;
            if (fade <= 0) {
                fade = 0;
                const next = pendingStyle;
                pendingStyle = null;
                switchStyle(next);
            }
        } else if (fade < 1) {
            fade = Math.min(1, fade + dt / CFG.fadeTime);
        }

        // смена фаз
        if (phase === 'assemble') {
            assembleT += dt;
            if (assembleT >= CFG.assembleTime) {
                phase = 'main';
                cycleTimer = 0;
            }
        } else if (phase === 'main') {
            if (!finaleDone && scenarioT >= CFG.finaleAfter) {
                startFinale();
            } else {
                cycleTimer += dt;
                if (pendingStyle === null && cycleTimer >= CFG.styleCycle) {
                    cycleTimer = 0;
                    scheduleNextStyle();
                }
            }
        } else if (phase === 'finale' && finaleReady) {
            finaleT += dt;
            if (finaleT >= CFG.finaleDur && !replayShown) {
                replayShown = true;
                replayEl.classList.add('show');
            }
        }

        // ---------- РЕНДЕР ----------
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        drawBackground();
        drawBokeh();
        drawMeteors(dt);

        if (phase !== 'intro') {
            const k = finaleBlend();
            updateHeartParts(dt);

            if (phase === 'finale' && finaleReady) {
                drawFinale(k);
            } else {
                drawCurrentStyle(dt);
            }

            drawName(nameAlphaFor(k));
            drawFloatHearts(dt);
            drawSparks(dt);
            drawBeatFlash();
        }

        requestAnimationFrame(animate);
    }

    // ---------- ОБРАБОТЧИКИ ----------
    function handleResize() {
        const prevDpr = dpr;
        updateSize();

        if (dpr !== prevDpr) {
            // спрайты были пересозданы — перевыбираем стиль, чтобы
            // у частиц появились ссылки на новые спрайты (хуки сами
            // перепостроят траектории сборки / финальные цели)
            switchStyle(currentStyle);
        }

        if (phase === 'finale' && finaleReady) {
            buildFinalePoints();
            assignFinaleTargets();
        }

        // держим светлячков в границах экрана
        if (currentStyle === 'fireflies') {
            for (let i = 0; i < fireflies.length; i++) {
                const f = fireflies[i];
                if (f.x > width) f.x = width - 30;
                if (f.y > height) f.y = height - 30;
            }
        }
    }

    document.querySelectorAll('.btn[data-style]').forEach(function (btn) {
        btn.addEventListener('click', function () {
            const style = btn.dataset.style;
            if (style === currentStyle && pendingStyle === null) return;
            if (phase === 'finale') {
                exitFinale(style);
            } else {
                pendingStyle = style;
                captionEl.textContent = CAPTIONS[style] || CAPTIONS.heart;
                setActiveBtn(style);
            }
        });
    });

    openBtn.addEventListener('click', function () {
        if (started) return;
        started = true;
        ensureAudio();
        if (audioCtx && audioCtx.state === 'suspended') {
            try { audioCtx.resume(); } catch (e) { /* ignore */ }
        }
        document.body.classList.add('started');
        introEl.classList.add('done');
        setTimeout(function () { introEl.style.display = 'none'; }, 1000);
        startAssemble();
    });

    replayBtn.addEventListener('click', function () {
        startAssemble();
    });

    soundBtn.addEventListener('click', function () {
        muted = !muted;
        ensureAudio();
        if (masterGain) masterGain.gain.value = muted ? 0 : 0.2;
        soundBtn.textContent = muted ? '🔇' : '🔊';
    });

    // курсор / палец
    window.addEventListener('pointermove', function (e) {
        pointerX = e.clientX;
        pointerY = e.clientY;
        pointerInside = true;
    }, { passive: true });

    window.addEventListener('pointerleave', function () {
        pointerInside = false;
    });

    window.addEventListener('pointerdown', function (e) {
        pointerX = e.clientX;
        pointerY = e.clientY;
        pointerInside = true;
        if (started && phase !== 'intro') {
            spawnSparks(e.clientX, e.clientY);
        }
    }, { passive: true });

    window.addEventListener('resize', handleResize);

    // ---------- СТАРТ ----------
    function init() {
        updateSize();
        initStars();
        initBokeh();
        initFloatHearts();
        initHeartStyle();
        lastTs = performance.now();
        requestAnimationFrame(animate);
    }

    init();
})();
