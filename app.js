/* ================================================================
   VoiceCraft — Application Logic (Web Speech API)
   Fixed: robust speech handling, chunking, error recovery
   ================================================================ */

(() => {
    'use strict';

    // ── Check for Speech API support ──
    if (!('speechSynthesis' in window)) {
        document.body.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:center;height:100vh;
                font-family:Inter,sans-serif;color:#eee;text-align:center;padding:40px;
                background:#08080c;">
                <div>
                    <h1 style="font-size:2rem;margin-bottom:12px;">Browser Not Supported</h1>
                    <p style="color:#888;font-size:1rem;">
                        Your browser does not support the Web Speech API.<br>
                        Please use <strong>Google Chrome</strong>, <strong>Microsoft Edge</strong>, or <strong>Safari</strong>.
                    </p>
                </div>
            </div>`;
        return;
    }

    // ── DOM References ──
    const $ = (id) => document.getElementById(id);
    const textInput       = $('text-input');
    const charCounter     = $('char-counter');
    const wordCounter     = $('word-counter');
    const btnClear        = $('btn-clear');
    const btnPaste        = $('btn-paste');
    const voiceSelect     = $('voice-select');
    const voiceCountBadge = $('voice-count-badge');
    const genderToggle    = $('gender-toggle');
    const speedRange      = $('speed-range');
    const speedValue      = $('speed-value');
    const pitchRange      = $('pitch-range');
    const pitchValue      = $('pitch-value');
    const volumeRange     = $('volume-range');
    const volumeValue     = $('volume-value');
    const btnSpeak        = $('btn-speak');
    const btnPlayLabel    = $('btn-play-label');
    const iconPlay        = document.querySelector('.icon-play');
    const iconPause       = document.querySelector('.icon-pause');
    const btnPreview      = $('btn-preview');
    const btnStop         = $('btn-stop');
    const vizBars         = $('visualizer-bars');
    const vizLabel        = $('visualizer-label');
    const progressWrap    = $('progress-wrap');
    const progressFill    = $('progress-fill');
    const progressLabel   = $('progress-label');
    const navStatus       = $('nav-status');
    const toastContainer  = $('toast-container');

    // ── State ──
    const synth = window.speechSynthesis;
    let allVoices = [];
    let filteredVoices = [];
    let currentGender = 'all';
    let isSpeaking = false;
    let isPaused = false;
    let progressTimer = null;
    let chromeResumeTimer = null;

    // ── Language Detection ──
    // Maps Unicode script ranges to language codes
    const SCRIPT_LANG_MAP = [
        { range: /[\u0900-\u097F]/, lang: 'hi', label: 'Hindi' },
        { range: /[\u0980-\u09FF]/, lang: 'bn', label: 'Bengali' },
        { range: /[\u0A00-\u0A7F]/, lang: 'pa', label: 'Punjabi' },
        { range: /[\u0A80-\u0AFF]/, lang: 'gu', label: 'Gujarati' },
        { range: /[\u0B00-\u0B7F]/, lang: 'or', label: 'Odia' },
        { range: /[\u0B80-\u0BFF]/, lang: 'ta', label: 'Tamil' },
        { range: /[\u0C00-\u0C7F]/, lang: 'te', label: 'Telugu' },
        { range: /[\u0C80-\u0CFF]/, lang: 'kn', label: 'Kannada' },
        { range: /[\u0D00-\u0D7F]/, lang: 'ml', label: 'Malayalam' },
        { range: /[\u0600-\u06FF]/, lang: 'ar', label: 'Arabic/Urdu' },
        { range: /[\u4E00-\u9FFF]/, lang: 'zh', label: 'Chinese' },
        { range: /[\u3040-\u309F\u30A0-\u30FF]/, lang: 'ja', label: 'Japanese' },
        { range: /[\uAC00-\uD7AF]/, lang: 'ko', label: 'Korean' },
        { range: /[\u0400-\u04FF]/, lang: 'ru', label: 'Russian' },
    ];

    function detectLanguage(text) {
        // Count characters per script
        const scriptCounts = [];
        for (const entry of SCRIPT_LANG_MAP) {
            const matches = text.match(new RegExp(entry.range.source, 'g'));
            const count = matches ? matches.length : 0;
            if (count > 0) scriptCounts.push({ ...entry, count });
        }

        // Count Latin/English characters
        const latinMatches = text.match(/[a-zA-Z]/g);
        const latinCount = latinMatches ? latinMatches.length : 0;

        // Sort by count descending
        scriptCounts.sort((a, b) => b.count - a.count);

        const best = scriptCounts[0];

        if (!best || best.count < 2) {
            return { lang: 'en', label: 'English', mixed: false };
        }

        // Check if text is mixed (has both non-Latin script AND significant Latin chars)
        // This catches Hinglish, Spanglish, etc.
        const isMixed = latinCount >= 3 && best.count >= 3;

        return {
            lang: best.lang,
            label: isMixed ? `${best.label} (Mixed)` : best.label,
            mixed: isMixed,
            // For mixed content, we'll use the non-English language's voice
            // because Hindi/Tamil/etc. voices handle English words naturally
            // but English voices CANNOT handle Devanagari/Tamil/etc. scripts
            primaryLangCode: best.lang
        };
    }

    // Find the best voice for a detected language
    function findVoiceForLang(langCode) {
        const lc = langCode.toLowerCase();

        // Primary: match by lang tag (e.g., "hi-IN", "hi")
        let candidates = allVoices.filter(v =>
            v.lang && (v.lang.toLowerCase().startsWith(lc + '-') || v.lang.toLowerCase() === lc)
        );

        // Fallback: match by name keywords if lang tag matching found nothing
        // This helps when voice lang is tagged differently (e.g., "hin" instead of "hi")
        if (candidates.length === 0) {
            const nameKeywords = {
                'hi': ['hindi', 'hemant', 'kalpana', 'swara', 'हिन्दी', 'हिंदी'],
                'bn': ['bengali', 'bangla'],
                'ta': ['tamil'],
                'te': ['telugu'],
                'gu': ['gujarati'],
                'kn': ['kannada'],
                'ml': ['malayalam'],
                'pa': ['punjabi'],
                'mr': ['marathi'],
            };
            const keywords = nameKeywords[lc] || [];
            if (keywords.length > 0) {
                candidates = allVoices.filter(v => {
                    const nameLower = v.name.toLowerCase();
                    return keywords.some(kw => nameLower.includes(kw));
                });
            }
        }

        // Debug: log what we found
        if (lc === 'hi') {
            console.log(`[VoiceCraft] Hindi voice search: found ${candidates.length} candidates:`,
                candidates.map(v => `${v.name} (${v.lang})`));
            console.log(`[VoiceCraft] All ${allVoices.length} available voices:`,
                allVoices.map(v => `${v.name} [${v.lang}]`));
        }

        if (candidates.length === 0) return null;

        // Prefer gender-matched voice if filter is active
        if (currentGender !== 'all') {
            const genderMatch = candidates.find(v => v._gender === currentGender);
            if (genderMatch) return genderMatch;
        }

        // Prefer Google voices (better quality, especially for Hindi)
        const googleVoice = candidates.find(v => v.name.toLowerCase().includes('google'));
        if (googleVoice) return googleVoice;

        // Prefer non-local (cloud) voices — usually better quality
        const cloudVoice = candidates.find(v => !v.localService);
        if (cloudVoice) return cloudVoice;

        return candidates[0];
    }

    // Get all available voices for a language (used for info display)
    function getVoicesForLang(langCode) {
        const lc = langCode.toLowerCase();
        return allVoices.filter(v =>
            v.lang && (v.lang.toLowerCase().startsWith(lc + '-') || v.lang.toLowerCase() === lc)
        );
    }

    // ── Gender heuristics ──
    const FEMALE_NAMES = [
        'zira', 'hazel', 'susan', 'catherine', 'samantha', 'victoria', 'karen', 'moira',
        'tessa', 'fiona', 'alice', 'ellen', 'amanda', 'angela', 'bella', 'clara',
        'diana', 'emma', 'grace', 'helen', 'irene', 'jane', 'kate', 'laura',
        'maria', 'nancy', 'olivia', 'rachel', 'sarah', 'lisa', 'jennifer', 'elsa',
        'heera', 'irina', 'haruka', 'helena', 'eva', 'sabina', 'hoda', 'tracy',
        'linda', 'anna', 'natasha', 'paulina', 'joana', 'luciana', 'francisca',
        'montserrat', 'daria', 'katja', 'amelie', 'chloe', 'nicky', 'ioana',
        'sara', 'monica', 'paola', 'kathy', 'audrey', 'yelda',
        'aria', 'jenny', 'michelle', 'sonia', 'abigail', 'elizabeth', 'emily',
        'maisie', 'harriet', 'siobhan', 'stephanie', 'zoe', 'rebecca', 'matilda',
        'faye', 'kirsty', 'heather', 'kendra', 'kimberly', 'melina', 'allison',
        'prerna', 'neerja', 'ananya', 'aarohi', 'madhur', 'kiara', 'kavya',
        'tashvi', 'shruti', 'female'
    ];

    const MALE_NAMES = [
        'david', 'guy', 'ryan', 'christopher', 'eric', 'liam', 'connor', 'andrew',
        'brian', 'steffan', 'george', 'mark', 'james', 'daniel', 'alex', 'fred',
        'ravi', 'thomas', 'richard', 'charles', 'paul', 'aaron', 'albert', 'arthur',
        'bruce', 'carlos', 'craig', 'diego', 'edward', 'frank', 'gordon', 'henry',
        'ivan', 'jack', 'kevin', 'lee', 'michael', 'nathan', 'oliver', 'peter',
        'robert', 'stephen', 'victor', 'william', 'jorge', 'pablo', 'luca', 'andrei',
        'cosimo', 'filip', 'mehdi', 'lado', 'sam', 'mitch', 'luke', 'ian', 'logan',
        'marcus', 'harry', 'charlie', 'calum', 'neil', 'hugh', 'sean', 'benjamin',
        'joshua', 'cooper', 'ryder', 'steve', 'male'
    ];

    function guessGender(voice) {
        const lower = voice.name.toLowerCase();
        // Split on non-alphanumeric characters to get individual words
        const words = lower.split(/[^a-z0-9]+/);

        // 1. First check for exact word matches (highly accurate, avoids "evan" matching "eva")
        for (const w of words) {
            if (FEMALE_NAMES.includes(w)) return 'female';
            if (MALE_NAMES.includes(w)) return 'male';
        }

        // 2. Fallback to substring matching if names are run together (e.g. "GoogleUKEnglishMale")
        for (const f of FEMALE_NAMES) {
            if (lower.includes(f)) return 'female';
        }
        for (const m of MALE_NAMES) {
            if (lower.includes(m)) return 'male';
        }

        return 'unknown';
    }

    // ── Visualizer Setup ──
    function initVisualizer() {
        vizBars.innerHTML = '';
        const count = 50;
        for (let i = 0; i < count; i++) {
            const bar = document.createElement('div');
            bar.classList.add('viz-bar');
            const lo = 3 + Math.random() * 3;
            const hi = 10 + Math.random() * 22;
            const speed = 0.3 + Math.random() * 0.5;
            const delay = Math.random() * 0.4;
            bar.style.setProperty('--bar-lo', `${lo}px`);
            bar.style.setProperty('--bar-hi', `${hi}px`);
            bar.style.setProperty('--bar-speed', `${speed}s`);
            bar.style.animationDelay = `${delay}s`;
            bar.style.height = `${lo}px`;
            vizBars.appendChild(bar);
        }
    }

    // ── Load & Clean Voices ──
    function loadVoices() {
        const voices = synth.getVoices();
        if (voices.length === 0) return;

        // Step 1: Remove voices with no name or lang
        let cleaned = voices.filter(v => v.name && v.name.trim() && v.lang && v.lang.trim());

        // Step 2: Remove exact duplicates (same name — browsers often list voices twice)
        const seen = new Set();
        cleaned = cleaned.filter(v => {
            const key = v.name;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });

        // Step 3: Keep ONLY English voices
        cleaned = cleaned.filter(v => v.lang.toLowerCase().startsWith('en'));

        // Step 4: Remove known novelty/broken voices
        const junkPatterns = [
            /bad news/i, /good news/i, /bells/i, /boing/i,
            /bubbles/i, /cellos/i, /zarvox/i, /trinoids/i,
            /whisper/i, /deranged/i, /hysterical/i, /organ/i,
            /superstar/i, /ralph/i, /junior/i, /bahh/i,
            /wobble/i, /pipe organ/i, /jester/i,
        ];
        cleaned = cleaned.filter(v => {
            const name = v.name.trim();
            return !junkPatterns.some(p => p.test(name));
        });

        // Step 5: Tag gender
        cleaned.forEach(v => { v._gender = guessGender(v); });

        allVoices = cleaned;
        filterVoices();
    }

    function filterVoices() {
        if (currentGender === 'all') {
            filteredVoices = [...allVoices];
        } else {
            const matched = allVoices.filter(v => v._gender === currentGender);
            filteredVoices = matched.length > 0 ? matched : [...allVoices];
        }
        populateSelect();
    }

    function cleanVoiceName(name) {
        // Clean up verbose voice names for readability
        // "Microsoft David - English (United States)" → "Microsoft David"
        // "Google हिन्दी" → "Google हिन्दी"
        return name
            .replace(/\s*-\s*.*$/, '')           // Remove " - English (United States)"
            .replace(/\s*\(.*?\)\s*$/, '')       // Remove trailing "(Natural)" etc.
            .trim();
    }

    function populateSelect() {
        const prev = voiceSelect.value;
        voiceSelect.innerHTML = '';

        // Group by English variant
        const langNames = {
            'en-US': '🇺🇸 English (US)',
            'en-GB': '🇬🇧 English (UK)',
            'en-IN': '🇮🇳 English (India)',
            'en-AU': '🇦🇺 English (Australia)',
            'en-CA': '🇨🇦 English (Canada)',
            'en-IE': '🇮🇪 English (Ireland)',
            'en-ZA': '🇿🇦 English (South Africa)',
            'en-NZ': '🇳🇿 English (New Zealand)',
            'en-SG': '🇸🇬 English (Singapore)',
            'en-PH': '🇵🇭 English (Philippines)',
        };

        const groups = {};
        filteredVoices.forEach(v => {
            const langLabel = langNames[v.lang] || 'English';
            if (!groups[langLabel]) groups[langLabel] = [];
            groups[langLabel].push(v);
        });

        // Sort: US first, then UK, India, then rest
        const priority = ['US', 'UK', 'India'];
        const sortedKeys = Object.keys(groups).sort((a, b) => {
            const aIdx = priority.findIndex(p => a.includes(p));
            const bIdx = priority.findIndex(p => b.includes(p));
            const aPri = aIdx >= 0 ? aIdx : 99;
            const bPri = bIdx >= 0 ? bIdx : 99;
            if (aPri !== bPri) return aPri - bPri;
            return a.localeCompare(b);
        });

        sortedKeys.forEach(langLabel => {
            const optgroup = document.createElement('optgroup');
            optgroup.label = langLabel;
            groups[langLabel].forEach(v => {
                const opt = document.createElement('option');
                const displayName = cleanVoiceName(v.name);
                const genderIcon = v._gender === 'male' ? ' ♂' : v._gender === 'female' ? ' ♀' : '';
                const cloudIcon = v.localService ? '' : ' ☁️';
                opt.value = v.name;
                opt.textContent = `${displayName}${genderIcon}${cloudIcon}`;
                if (v.name === prev) opt.selected = true;
                optgroup.appendChild(opt);
            });
            voiceSelect.appendChild(optgroup);
        });

        voiceCountBadge.textContent = `${filteredVoices.length} voices`;

        // Show a toast the first time voices are loaded
        if (filteredVoices.length > 0 && !loadVoices._toastShown) {
            loadVoices._toastShown = true;
            const maleCount = allVoices.filter(v => v._gender === 'male').length;
            const femaleCount = allVoices.filter(v => v._gender === 'female').length;
            showToast(`${allVoices.length} English voices loaded (${maleCount} male, ${femaleCount} female)`, 'success');
        }
    }

    function getSelectedVoice() {
        return allVoices.find(v => v.name === voiceSelect.value) || null;
    }

    // ── Speech Engine ──
    // Split text into chunks to avoid Chrome's ~15s cutoff bug
    function splitIntoChunks(text, maxLen = 200) {
        const sentences = text.match(/[^.!?]+[.!?]*\s*/g) || [text];
        const chunks = [];
        let current = '';

        for (const sentence of sentences) {
            if ((current + sentence).length > maxLen && current.length > 0) {
                chunks.push(current.trim());
                current = sentence;
            } else {
                current += sentence;
            }
        }
        if (current.trim()) chunks.push(current.trim());
        return chunks;
    }

    function speak(text, isPreview = false) {
        const trimmed = text.trim();
        if (!trimmed) {
            showToast('Please enter some text first.', 'error');
            return;
        }

        // Cancel anything in progress
        synth.cancel();
        clearTimers();

        const voice = getSelectedVoice();

        // Split text by newlines then sentences
        const rawLines = trimmed.split(/\n+/).filter(l => l.trim());
        let chunks;
        if (isPreview) {
            chunks = [trimmed.split(/\s+/).slice(0, 20).join(' ')];
        } else {
            chunks = [];
            for (const line of rawLines) {
                const lineChunks = splitIntoChunks(line, 180);
                chunks.push(...lineChunks);
            }
            if (chunks.length === 0) chunks = [trimmed];
        }

        const totalChunks = chunks.length;
        let currentChunkIdx = 0;

        const rate   = parseFloat(speedRange.value);
        const pitch  = parseFloat(pitchRange.value);
        const volume = parseFloat(volumeRange.value);

        // Estimated total duration
        const wordCount = trimmed.split(/\s+/).length;
        const estimatedMs = (wordCount / (150 * rate)) * 60000;
        const startTime = Date.now();

        function speakChunk() {
            if (currentChunkIdx >= totalChunks) {
                onFinish();
                return;
            }

            const utterance = new SpeechSynthesisUtterance(chunks[currentChunkIdx]);
            if (voice) {
                utterance.voice = voice;
                utterance.lang = voice.lang;
            }
            utterance.rate = rate;
            utterance.pitch = pitch;
            utterance.volume = volume;

            utterance.onstart = () => {
                isSpeaking = true;
                isPaused = false;
                updateUI('speaking');

                // Chrome workaround: pause/resume every 10s to prevent cutoff
                clearChromeTimer();
                chromeResumeTimer = setInterval(() => {
                    if (synth.speaking && !synth.paused) {
                        synth.pause();
                        setTimeout(() => {
                            if (synth.paused) synth.resume();
                        }, 50);
                    }
                }, 10000);
            };

            utterance.onend = () => {
                clearChromeTimer();
                currentChunkIdx++;
                if (currentChunkIdx < totalChunks && isSpeaking) {
                    speakChunk();
                } else {
                    onFinish();
                }
            };

            utterance.onerror = (e) => {
                clearChromeTimer();
                // 'canceled' errors are expected when we stop manually
                if (e.error === 'canceled' || e.error === 'interrupted') return;
                console.warn('Speech error:', e.error, e);

                // Give specific guidance based on the error
                if (e.error === 'language-unavailable' || e.error === 'voice-unavailable') {
                    showToast(
                        `No ${detected.label} voice available. Install ${detected.label} language pack in Windows Settings → Time & Language → Speech.`,
                        'error'
                    );
                } else if (e.error === 'synthesis-unavailable' || e.error === 'synthesis-failed') {
                    showToast('Speech synthesis failed. Try selecting a different voice.', 'error');
                } else {
                    showToast(`Speech error: ${e.error}. Try selecting a different voice.`, 'error');
                }
                onFinish(true);
            };

            synth.speak(utterance);
        }

        // Start progress tracking
        if (!isPreview) {
            progressWrap.classList.remove('hidden');
            progressFill.style.width = '0%';
            progressTimer = setInterval(() => {
                const elapsed = Date.now() - startTime;
                const pct = Math.min((elapsed / estimatedMs) * 100, 97);
                progressFill.style.width = `${pct}%`;
                const remaining = Math.max(0, Math.ceil((estimatedMs - elapsed) / 1000));
                progressLabel.textContent = remaining > 0 ? `~${remaining}s remaining` : 'Finishing...';
            }, 250);
        }

        speakChunk();
    }

    function onFinish(isError = false) {
        isSpeaking = false;
        isPaused = false;
        clearTimers();

        if (!isError) {
            progressFill.style.width = '100%';
            progressLabel.textContent = 'Completed';
            setTimeout(() => progressWrap.classList.add('hidden'), 2000);
        } else {
            progressWrap.classList.add('hidden');
        }

        updateUI('ready');
    }

    function stopSpeaking() {
        synth.cancel();
        isSpeaking = false;
        isPaused = false;
        clearTimers();
        progressWrap.classList.add('hidden');
        updateUI('stopped');
        setTimeout(() => {
            if (!isSpeaking) updateUI('ready');
        }, 1500);
    }

    function togglePause() {
        if (isPaused) {
            synth.resume();
            isPaused = false;
            updateUI('speaking');
        } else {
            synth.pause();
            isPaused = true;
            clearChromeTimer();
            updateUI('paused');
        }
    }

    function clearTimers() {
        if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
        clearChromeTimer();
    }

    function clearChromeTimer() {
        if (chromeResumeTimer) { clearInterval(chromeResumeTimer); chromeResumeTimer = null; }
    }

    // ── UI State Updates ──
    function updateUI(state) {
        const statusDot = navStatus.querySelector('.status-dot');
        const statusLabel = navStatus.querySelector('.status-label');

        switch (state) {
            case 'speaking':
                btnSpeak.classList.add('speaking');
                btnPlayLabel.textContent = 'Pause';
                iconPlay.classList.add('hidden');
                iconPause.classList.remove('hidden');
                vizBars.classList.add('active');
                vizLabel.textContent = 'Speaking...';
                vizLabel.classList.add('speaking');
                navStatus.className = 'status-chip speaking';
                statusLabel.textContent = 'Speaking';
                break;

            case 'paused':
                btnSpeak.classList.remove('speaking');
                btnPlayLabel.textContent = 'Resume';
                iconPlay.classList.remove('hidden');
                iconPause.classList.add('hidden');
                vizBars.classList.remove('active');
                vizLabel.textContent = 'Paused';
                vizLabel.classList.add('speaking');
                navStatus.className = 'status-chip';
                statusLabel.textContent = 'Paused';
                break;

            case 'stopped':
                btnSpeak.classList.remove('speaking');
                btnPlayLabel.textContent = 'Speak';
                iconPlay.classList.remove('hidden');
                iconPause.classList.add('hidden');
                vizBars.classList.remove('active');
                vizLabel.textContent = 'Stopped';
                vizLabel.classList.remove('speaking');
                navStatus.className = 'status-chip';
                statusLabel.textContent = 'Stopped';
                break;

            case 'ready':
            default:
                btnSpeak.classList.remove('speaking');
                btnPlayLabel.textContent = 'Speak';
                iconPlay.classList.remove('hidden');
                iconPause.classList.add('hidden');
                vizBars.classList.remove('active');
                vizLabel.textContent = 'Ready to speak';
                vizLabel.classList.remove('speaking');
                navStatus.className = 'status-chip';
                statusLabel.textContent = 'Ready';
                break;
        }
    }

    // ── Toast Notifications ──
    function showToast(message, type = 'info') {
        const icons = { error: '⚠️', success: '✅', info: '💡' };
        const toast = document.createElement('div');
        toast.className = `toast-msg ${type}`;
        toast.innerHTML = `<span class="toast-icon">${icons[type] || icons.info}</span><span>${message}</span>`;
        toastContainer.appendChild(toast);

        setTimeout(() => {
            toast.classList.add('out');
            setTimeout(() => toast.remove(), 300);
        }, 3500);
    }

    // ── Text Counting & Language Indicator ──
    function updateCounts() {
        const text = textInput.value;
        const chars = text.length;
        const words = text.trim() ? text.trim().split(/\s+/).length : 0;
        charCounter.textContent = `${chars.toLocaleString()} characters`;

        // Show detected language alongside word count
        const detected = detectLanguage(text);
        const langIndicator = detected.lang !== 'en' && chars > 2 ? ` • ${detected.label} detected` : '';
        wordCounter.textContent = `${words.toLocaleString()} word${words !== 1 ? 's' : ''}${langIndicator}`;
    }

    // ── Event Wiring ──

    textInput.addEventListener('input', updateCounts);

    btnClear.addEventListener('click', () => {
        textInput.value = '';
        updateCounts();
        textInput.focus();
        showToast('Text cleared', 'info');
    });

    btnPaste.addEventListener('click', async () => {
        try {
            const text = await navigator.clipboard.readText();
            textInput.value = text.slice(0, 10000);
            updateCounts();
            showToast('Text pasted from clipboard', 'success');
        } catch {
            showToast('Clipboard access denied. Paste manually with Ctrl+V.', 'error');
        }
    });

    // Gender toggle
    genderToggle.addEventListener('click', (e) => {
        const btn = e.target.closest('.pill');
        if (!btn) return;
        currentGender = btn.dataset.gender;
        genderToggle.querySelectorAll('.pill').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        filterVoices();
    });

    // Sliders
    speedRange.addEventListener('input', () => {
        speedValue.textContent = `${parseFloat(speedRange.value).toFixed(2)}x`;
    });
    pitchRange.addEventListener('input', () => {
        pitchValue.textContent = parseFloat(pitchRange.value).toFixed(1);
    });
    volumeRange.addEventListener('input', () => {
        volumeValue.textContent = `${Math.round(parseFloat(volumeRange.value) * 100)}%`;
    });

    // Speak / Pause
    btnSpeak.addEventListener('click', () => {
        if (isSpeaking) {
            togglePause();
        } else {
            speak(textInput.value);
        }
    });

    // Preview
    btnPreview.addEventListener('click', () => {
        const text = textInput.value.trim();
        if (!text) {
            showToast('Enter text to preview', 'error');
            return;
        }
        const preview = text.split(/\s+/).slice(0, 20).join(' ');
        speak(preview, true);
    });

    // Stop
    btnStop.addEventListener('click', stopSpeaking);

    // Keyboard shortcut: Ctrl+Enter to speak
    textInput.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.key === 'Enter') {
            e.preventDefault();
            if (isSpeaking) {
                stopSpeaking();
            } else {
                speak(textInput.value);
            }
        }
    });

    // ── Voice Loading ──
    if (synth.onvoiceschanged !== undefined) {
        synth.onvoiceschanged = loadVoices;
    }

    // ── Init ──
    initVisualizer();
    loadVoices();

    // Retry voice loading (needed on some browsers)
    setTimeout(loadVoices, 200);
    setTimeout(loadVoices, 1000);
    setTimeout(loadVoices, 3000);

})();
