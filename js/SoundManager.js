/**
 * SoundManager - プロシージャル音声合成エンジン + 実音声BGM
 * Web Audio APIを使用してSEをランタイム生成
 * BGMはOpenGameArt.orgからダウンロードしたロイヤリティフリー音源を使用
 * 
 * BGM Credits (CC-BY-SA 3.0):
 *  - Battle BGM: "Commando Team (Action) [loop cut]" by Grégoire Lourme
 *    https://opengameart.org/content/commando-team-action-loop-cut
 *  - Title BGM: "Military (Soundtrack)" by Fato Shadow
 *    https://opengameart.org/content/military-soundtrack
 */
export class SoundManager {
    constructor() {
        this.ctx = null;
        this.masterGain = null;
        this.sfxGain = null;
        this.bgmGain = null;
        this.initialized = false;
        this.muted = false;
        this.bgmPlaying = false;

        // BGM用ノード（実音声ファイル再生）
        this._bgmSource = null;
        this._bgmBuffer = null;
        this._titleBgmBuffer = null;
        this._bgmLoaded = false;
        this._titleBgmLoaded = false;
        this._bgmLoading = false;
        this._titleBgmLoading = false;
        this._bgmLoadFailed = false;
        this._currentBgmType = null; // 'battle' | 'title'
        this._pendingBattleBgmStart = false;

        // フォールバック用プロシージャルBGM
        this._bgmNodes = [];
        this._bgmInterval = null;
        this._bgmBeat = 0;
        this._bgmTempo = 140; // BPM

        // 初回ユーザー操作で初期化
        this._initOnInteraction();
    }

    _initOnInteraction() {
        const handler = () => {
            if (!this.initialized) {
                this._init();
            }
            window.removeEventListener('click', handler);
            window.removeEventListener('keydown', handler);
        };
        window.addEventListener('click', handler);
        window.addEventListener('keydown', handler);
    }

    _init() {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        this.masterGain = this.ctx.createGain();
        this.masterGain.gain.value = 0.6;
        this.masterGain.connect(this.ctx.destination);

        this.sfxGain = this.ctx.createGain();
        this.sfxGain.gain.value = 0.7;
        this.sfxGain.connect(this.masterGain);

        this.bgmGain = this.ctx.createGain();
        this.bgmGain.gain.value = 0.35;
        this.bgmGain.connect(this.masterGain);

        this.initialized = true;

        // BGM音声ファイルを非同期ロード（モジュール基準で解決してパスずれを防ぐ）
        // タイトル: bgm_title.ogg / ゲーム中: bgm_battle.ogg
        const battleBgmUrls = [
            new URL('../audio/bgm_battle.ogg', import.meta.url).href,
        ];
        const titleBgmUrl = new URL('../audio/bgm_title.ogg', import.meta.url).href;
        this._loadFirstAvailableBGM(battleBgmUrls, 'battle');
        this._loadBGM(titleBgmUrl, 'title');
    }

    async _loadFirstAvailableBGM(urls, type) {
        if (type === 'battle') {
            this._bgmLoading = true;
            this._bgmLoadFailed = false;
        }
        for (const url of urls) {
            // eslint-disable-next-line no-await-in-loop
            const ok = await this._loadBGM(url, type);
            if (ok) {
                if (type === 'battle') this._bgmLoading = false;
                return true;
            }
        }
        if (type === 'battle') {
            this._bgmLoading = false;
            this._bgmLoadFailed = true;
            console.warn('Battle BGM候補のロードに失敗。プロシージャルBGMへフォールバックします。');
        }
        return false;
    }

    /**
     * BGM音声ファイルをロード
     */
    async _loadBGM(url, type) {
        try {
            const response = await fetch(url);
            if (!response.ok) {
                console.warn(`BGMファイルのロードに失敗: ${url} (${response.status})`);
                return false;
            }
            const arrayBuffer = await response.arrayBuffer();
            const audioBuffer = await this.ctx.decodeAudioData(arrayBuffer);
            
            if (type === 'battle') {
                this._bgmBuffer = audioBuffer;
                this._bgmLoaded = true;
                this._bgmLoadFailed = false;
                console.log(`🎵 Battle BGM loaded successfully: ${url}`);
                if (this._pendingBattleBgmStart && !this.bgmPlaying) {
                    this._pendingBattleBgmStart = false;
                    this._playAudioBGM(this._bgmBuffer, 'battle');
                }
            } else if (type === 'title') {
                this._titleBgmBuffer = audioBuffer;
                this._titleBgmLoaded = true;
                this._titleBgmLoading = false;
                console.log('🎵 Title BGM loaded successfully');
            }
            return true;
        } catch (err) {
            console.warn(`BGMデコードエラー (${type}):`, err);
            return false;
        }
    }

    // ============================================
    // パブリックAPI
    // ============================================

    /** バルカン砲発射 */
    playVulcan() {
        if (!this._ready()) return;
        const t = this.ctx.currentTime;

        // 高周波バースト + ノイズ
        const osc = this.ctx.createOscillator();
        osc.type = 'square';
        osc.frequency.setValueAtTime(800, t);
        osc.frequency.exponentialRampToValueAtTime(200, t + 0.05);

        const gain = this.ctx.createGain();
        gain.gain.setValueAtTime(0.15, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.06);

        osc.connect(gain);
        gain.connect(this.sfxGain);
        osc.start(t);
        osc.stop(t + 0.06);
        this._autoDisconnect(osc, gain);

        // ノイズコンポーネント
        this._playNoise(t, 0.04, 0.12, 2000, 5000);
    }

    /** 主砲発射 */
    playCannon() {
        if (!this._ready()) return;
        const t = this.ctx.currentTime;

        // 低周波の重い爆発
        const osc = this.ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(150, t);
        osc.frequency.exponentialRampToValueAtTime(30, t + 0.3);

        const gain = this.ctx.createGain();
        gain.gain.setValueAtTime(0.4, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.4);

        // ディストーション
        const dist = this._createDistortion(20);
        osc.connect(dist);
        dist.connect(gain);
        gain.connect(this.sfxGain);
        osc.start(t);
        osc.stop(t + 0.4);
        this._autoDisconnect(osc, dist, gain);

        // 衝撃波ノイズ
        this._playNoise(t, 0.15, 0.25, 100, 4000);

        // サブベースランブル
        const sub = this.ctx.createOscillator();
        sub.type = 'sine';
        sub.frequency.setValueAtTime(60, t);
        sub.frequency.exponentialRampToValueAtTime(20, t + 0.5);
        const subGain = this.ctx.createGain();
        subGain.gain.setValueAtTime(0.3, t);
        subGain.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
        sub.connect(subGain);
        subGain.connect(this.sfxGain);
        sub.start(t);
        sub.stop(t + 0.5);
        this._autoDisconnect(sub, subGain);
    }

    /** 敵被弾（メタリック） */
    playEnemyHit() {
        if (!this._ready()) return;
        const t = this.ctx.currentTime;

        const osc = this.ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(1200 + Math.random() * 400, t);
        osc.frequency.exponentialRampToValueAtTime(300, t + 0.08);

        const gain = this.ctx.createGain();
        gain.gain.setValueAtTime(0.1, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.1);

        osc.connect(gain);
        gain.connect(this.sfxGain);
        osc.start(t);
        osc.stop(t + 0.1);
        this._autoDisconnect(osc, gain);
    }

    /** 小爆発（歩兵撃破） */
    playExplosionSmall() {
        if (!this._ready()) return;
        const t = this.ctx.currentTime;

        // メイン爆発音
        const osc = this.ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(200, t);
        osc.frequency.exponentialRampToValueAtTime(40, t + 0.2);

        const gain = this.ctx.createGain();
        gain.gain.setValueAtTime(0.2, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.3);

        const dist = this._createDistortion(10);
        osc.connect(dist);
        dist.connect(gain);
        gain.connect(this.sfxGain);
        osc.start(t);
        osc.stop(t + 0.3);
        this._autoDisconnect(osc, dist, gain);

        this._playNoise(t, 0.15, 0.2, 200, 6000);
    }

    /** 大爆発（戦車・航空機撃破） */
    playExplosionLarge() {
        if (!this._ready()) return;
        const t = this.ctx.currentTime;

        // 重い低周波
        const osc = this.ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(120, t);
        osc.frequency.exponentialRampToValueAtTime(20, t + 0.6);

        const gain = this.ctx.createGain();
        gain.gain.setValueAtTime(0.35, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.8);

        const dist = this._createDistortion(30);
        osc.connect(dist);
        dist.connect(gain);
        gain.connect(this.sfxGain);
        osc.start(t);
        osc.stop(t + 0.8);
        this._autoDisconnect(osc, dist, gain);

        // クラッシュノイズ
        this._playNoise(t, 0.3, 0.5, 100, 8000);

        // 二次爆発
        setTimeout(() => {
            if (!this._ready()) return;
            const t2 = this.ctx.currentTime;
            this._playNoise(t2, 0.15, 0.2, 200, 5000);
        }, 150);
    }

    /** プレイヤー被弾 */
    playPlayerHit() {
        if (!this._ready()) return;
        const t = this.ctx.currentTime;

        // 重いインパクト
        const osc = this.ctx.createOscillator();
        osc.type = 'square';
        osc.frequency.setValueAtTime(100, t);
        osc.frequency.exponentialRampToValueAtTime(40, t + 0.15);

        const gain = this.ctx.createGain();
        gain.gain.setValueAtTime(0.25, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.2);

        osc.connect(gain);
        gain.connect(this.sfxGain);
        osc.start(t);
        osc.stop(t + 0.2);
        this._autoDisconnect(osc, gain);

        // 警告ビープ
        const warn = this.ctx.createOscillator();
        warn.type = 'sine';
        warn.frequency.setValueAtTime(880, t + 0.05);
        const warnGain = this.ctx.createGain();
        warnGain.gain.setValueAtTime(0.08, t + 0.05);
        warnGain.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
        warn.connect(warnGain);
        warnGain.connect(this.sfxGain);
        warn.start(t + 0.05);
        warn.stop(t + 0.2);
        this._autoDisconnect(warn, warnGain);
    }

    /** コンボヒット音（ピッチが上がる） */
    playCombo(comboCount) {
        if (!this._ready()) return;
        const t = this.ctx.currentTime;

        const baseFreq = 440 + Math.min(comboCount * 60, 1200);
        const osc = this.ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(baseFreq, t);
        osc.frequency.exponentialRampToValueAtTime(baseFreq * 1.5, t + 0.1);

        const gain = this.ctx.createGain();
        gain.gain.setValueAtTime(0.08, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.15);

        osc.connect(gain);
        gain.connect(this.sfxGain);
        osc.start(t);
        osc.stop(t + 0.15);
        this._autoDisconnect(osc, gain);
    }

    /** ウェーブ開始ファンファーレ */
    playWaveStart() {
        if (!this._ready()) return;
        const t = this.ctx.currentTime;

        const notes = [523, 659, 784, 1047]; // C5, E5, G5, C6
        notes.forEach((freq, i) => {
            const osc = this.ctx.createOscillator();
            osc.type = 'square';
            osc.frequency.setValueAtTime(freq, t + i * 0.1);

            const gain = this.ctx.createGain();
            gain.gain.setValueAtTime(0.08, t + i * 0.1);
            gain.gain.exponentialRampToValueAtTime(0.001, t + i * 0.1 + 0.2);

            osc.connect(gain);
            gain.connect(this.sfxGain);
            osc.start(t + i * 0.1);
            osc.stop(t + i * 0.1 + 0.2);
            this._autoDisconnect(osc, gain);
        });
    }

    /** ゲームオーバー音 */
    playGameOver() {
        if (!this._ready()) return;
        const t = this.ctx.currentTime;

        // 下降する不穏な音
        const notes = [440, 370, 311, 261];
        notes.forEach((freq, i) => {
            const osc = this.ctx.createOscillator();
            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(freq, t + i * 0.3);

            const gain = this.ctx.createGain();
            gain.gain.setValueAtTime(0.1, t + i * 0.3);
            gain.gain.exponentialRampToValueAtTime(0.001, t + i * 0.3 + 0.4);

            const filter = this.ctx.createBiquadFilter();
            filter.type = 'lowpass';
            filter.frequency.value = 1000;

            osc.connect(filter);
            filter.connect(gain);
            gain.connect(this.sfxGain);
            osc.start(t + i * 0.3);
            osc.stop(t + i * 0.3 + 0.4);
            this._autoDisconnect(osc, filter, gain);
        });

        this.stopBGM();
    }

    /** ミッションスタート音 */
    playMissionStart() {
        if (!this._ready()) return;
        const t = this.ctx.currentTime;

        // 上昇するアルペジオ
        const notes = [262, 330, 392, 523, 659, 784];
        notes.forEach((freq, i) => {
            const osc = this.ctx.createOscillator();
            osc.type = 'square';
            osc.frequency.setValueAtTime(freq, t + i * 0.08);

            const gain = this.ctx.createGain();
            gain.gain.setValueAtTime(0.06, t + i * 0.08);
            gain.gain.exponentialRampToValueAtTime(0.001, t + i * 0.08 + 0.15);

            osc.connect(gain);
            gain.connect(this.sfxGain);
            osc.start(t + i * 0.08);
            osc.stop(t + i * 0.08 + 0.15);
            this._autoDisconnect(osc, gain);
        });
    }

    // ============================================
    // BGM — 実音声ファイル再生（フォールバック: プロシージャル）
    // ============================================

    /**
     * 戦闘BGMを開始
     */
    startBGM() {
        if (!this._ready() || this.bgmPlaying) return;

        // 実音声ファイルが読み込み済みの場合
        if (this._bgmLoaded && this._bgmBuffer) {
            this._playAudioBGM(this._bgmBuffer, 'battle');
            return;
        }

        // 初回開始直後はロード中になりやすい。ロード完了後に自動再生する。
        if (this._bgmLoading) {
            this._pendingBattleBgmStart = true;
            return;
        }

        // ファイル未取得時のみフォールバック
        if (!this._bgmLoadFailed) {
            this._pendingBattleBgmStart = true;
            return;
        }

        console.log('⚡ Battle BGM未取得 — プロシージャルBGMにフォールバック');
        this._startProceduralBGM();
    }

    /**
     * タイトルBGMを開始
     */
    startTitleBGM() {
        if (!this._ready() || this.bgmPlaying) return;

        if (this._titleBgmLoaded && this._titleBgmBuffer) {
            this._playAudioBGM(this._titleBgmBuffer, 'title');
            return;
        }

        // フォールバック不要（タイトル画面はBGM無しでも可）
        console.log('⚡ Title BGMファイル未ロード');
    }

    /**
     * 実音声ファイルでBGMを再生（ループ再生）
     */
    _playAudioBGM(buffer, type) {
        // 前のBGMを停止
        this._stopAudioBGM();

        this.bgmPlaying = true;
        this._currentBgmType = type;

        this._bgmSource = this.ctx.createBufferSource();
        this._bgmSource.buffer = buffer;
        this._bgmSource.loop = true;
        this._bgmSource.connect(this.bgmGain);
        this._bgmSource.start(0);

        console.log(`🎵 ${type} BGM再生開始`);
    }

    /**
     * 実音声BGMを停止
     */
    _stopAudioBGM() {
        if (this._bgmSource) {
            try {
                this._bgmSource.stop();
            } catch (e) {
                // 既に停止済み
            }
            this._bgmSource.disconnect();
            this._bgmSource = null;
        }
    }

    stopBGM() {
        this.bgmPlaying = false;
        this._currentBgmType = null;

        // 実音声BGM停止
        this._stopAudioBGM();

        // プロシージャルBGM停止
        if (this._bgmInterval) {
            clearInterval(this._bgmInterval);
            this._bgmInterval = null;
        }
    }

    // ============================================
    // プロシージャルBGM（フォールバック用）
    // ============================================

    _startProceduralBGM() {
        this.bgmPlaying = true;
        this._bgmBeat = 0;
        this._currentBgmType = 'procedural';

        const beatDuration = 60 / this._bgmTempo;

        this._bgmInterval = setInterval(() => {
            if (!this._ready() || !this.bgmPlaying) return;
            this._playBGMBeat(this._bgmBeat, beatDuration);
            this._bgmBeat = (this._bgmBeat + 1) % 32;
        }, beatDuration * 1000);
    }

    _playBGMBeat(beat, dur) {
        const t = this.ctx.currentTime;

        // === ドラムパターン ===
        // キック: 0,4,8,12,16,20,24,28 (4つ打ち)
        if (beat % 4 === 0) {
            this._playKick(t);
        }
        // スネア: 4,12,20,28
        if (beat % 8 === 4) {
            this._playSnare(t);
        }
        // ハイハット: 毎ビート + オフビート
        this._playHihat(t, beat % 2 === 0 ? 0.04 : 0.02);

        // === ベースライン ===
        // ミリタリーマーチ風のベース
        const bassPattern = [
            // bar1
            65, 0, 65, 87, 98, 0, 87, 65,
            // bar2
            73, 0, 73, 98, 110, 0, 98, 73,
            // bar3
            82, 0, 82, 110, 131, 0, 110, 82,
            // bar4
            73, 0, 73, 98, 87, 0, 65, 0,
        ];

        const bassFreq = bassPattern[beat];
        if (bassFreq > 0) {
            const osc = this.ctx.createOscillator();
            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(bassFreq, t);

            const filter = this.ctx.createBiquadFilter();
            filter.type = 'lowpass';
            filter.frequency.setValueAtTime(300, t);

            const gain = this.ctx.createGain();
            gain.gain.setValueAtTime(0.12, t);
            gain.gain.exponentialRampToValueAtTime(0.001, t + dur * 0.8);

            osc.connect(filter);
            filter.connect(gain);
            gain.connect(this.bgmGain);
            osc.start(t);
            osc.stop(t + dur * 0.8);
            this._autoDisconnect(osc, filter, gain);
        }

        // === メロディ（8ビートごとに短いフレーズ） ===
        if (beat % 8 === 0) {
            const melodyFragments = [
                [392, 440, 523, 440],
                [523, 587, 659, 523],
                [659, 587, 523, 440],
                [440, 392, 349, 392],
            ];
            const fragment = melodyFragments[Math.floor(beat / 8)];
            fragment.forEach((freq, i) => {
                const osc = this.ctx.createOscillator();
                osc.type = 'square';
                osc.frequency.setValueAtTime(freq, t + i * dur);

                const filter = this.ctx.createBiquadFilter();
                filter.type = 'lowpass';
                filter.frequency.value = 2000;

                const gain = this.ctx.createGain();
                gain.gain.setValueAtTime(0.04, t + i * dur);
                gain.gain.setValueAtTime(0.04, t + i * dur + dur * 0.6);
                gain.gain.exponentialRampToValueAtTime(0.001, t + i * dur + dur * 0.9);

                osc.connect(filter);
                filter.connect(gain);
                gain.connect(this.bgmGain);
                osc.start(t + i * dur);
                osc.stop(t + i * dur + dur);
                this._autoDisconnect(osc, filter, gain);
            });
        }
    }

    _playKick(t) {
        const osc = this.ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(150, t);
        osc.frequency.exponentialRampToValueAtTime(30, t + 0.1);

        const gain = this.ctx.createGain();
        gain.gain.setValueAtTime(0.2, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.15);

        osc.connect(gain);
        gain.connect(this.bgmGain);
        osc.start(t);
        osc.stop(t + 0.15);
        this._autoDisconnect(osc, gain);
    }

    _playSnare(t) {
        // ノイズ成分（共有バッファをランダムオフセットで使い回す）
        const sharedBuf = this._getSharedNoiseBuffer();
        const dur = 0.1;
        const offset = Math.random() * Math.max(0, sharedBuf.duration - dur - 0.01);
        const noise = this.ctx.createBufferSource();
        noise.buffer = sharedBuf;

        const filter = this.ctx.createBiquadFilter();
        filter.type = 'highpass';
        filter.frequency.value = 2000;

        const gain = this.ctx.createGain();
        gain.gain.setValueAtTime(0.15, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + dur);

        noise.connect(filter);
        filter.connect(gain);
        gain.connect(this.bgmGain);
        noise.start(t, offset, dur);
        noise.stop(t + dur);
        this._autoDisconnect(noise, filter, gain);

        // トーン成分
        const osc = this.ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(200, t);
        osc.frequency.exponentialRampToValueAtTime(100, t + 0.05);
        const oscGain = this.ctx.createGain();
        oscGain.gain.setValueAtTime(0.1, t);
        oscGain.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
        osc.connect(oscGain);
        oscGain.connect(this.bgmGain);
        osc.start(t);
        osc.stop(t + 0.08);
        this._autoDisconnect(osc, oscGain);
    }

    _playHihat(t, vol) {
        const sharedBuf = this._getSharedNoiseBuffer();
        const dur = 0.04;
        const offset = Math.random() * Math.max(0, sharedBuf.duration - dur - 0.01);
        const noise = this.ctx.createBufferSource();
        noise.buffer = sharedBuf;

        const filter = this.ctx.createBiquadFilter();
        filter.type = 'highpass';
        filter.frequency.value = 8000;

        const gain = this.ctx.createGain();
        gain.gain.setValueAtTime(vol, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + dur);

        noise.connect(filter);
        filter.connect(gain);
        gain.connect(this.bgmGain);
        noise.start(t, offset, dur);
        noise.stop(t + dur);
        this._autoDisconnect(noise, filter, gain);
    }

    // ============================================
    // ユーティリティ
    // ============================================

    _ready() {
        return this.initialized && !this.muted && this.ctx && this.ctx.state !== 'closed';
    }

    /**
     * 共有ホワイトノイズバッファ（2 秒分）。
     * 連射時に毎回 createBuffer + 数千要素の Float ループを実行すると
     * AudioBuffer インスタンスがブラウザ内部でしばらく解放されず、
     * JS ヒープ + WebAudio 用バッファメモリが膨張する。
     * 1 度作って使い回し、duration 引数で再生長を切り出す。
     */
    _getSharedNoiseBuffer() {
        if (!this._sharedNoiseBuffer) {
            const bufSize = Math.floor(this.ctx.sampleRate * 2.0);
            const buf = this.ctx.createBuffer(1, bufSize, this.ctx.sampleRate);
            const data = buf.getChannelData(0);
            for (let i = 0; i < bufSize; i++) data[i] = Math.random() * 2 - 1;
            this._sharedNoiseBuffer = buf;
        }
        return this._sharedNoiseBuffer;
    }

    /**
     * ディストーションカーブ（44100 サンプル = 176KB）の amount 別キャッシュ。
     * playCannon / playExplosion* が毎発射で _createDistortion を呼ぶと
     * 連射 1 回ごとに 176KB が確保される（1000 連射で ~170MB）。
     * 同一 amount のカーブは再利用する。
     */
    _getDistortionCurve(amount) {
        if (!this._distortionCurves) this._distortionCurves = new Map();
        let curve = this._distortionCurves.get(amount);
        if (curve) return curve;
        const k = amount;
        const samples = 44100;
        curve = new Float32Array(samples);
        const deg = Math.PI / 180;
        for (let i = 0; i < samples; i++) {
            const x = (i * 2) / samples - 1;
            curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x));
        }
        this._distortionCurves.set(amount, curve);
        return curve;
    }

    /**
     * 再生終了したノードチェーンを必ず disconnect する。
     * Web Audio は stop() しても接続を持ったままだと
     * ガベージコレクト対象にならないブラウザがあり、
     * 連射のたびに OscillatorNode/GainNode/BiquadFilterNode が滞留する。
     * 各ノードに onended を取り付けて確実に切り離す。
     */
    _autoDisconnect(endNode, ...nodes) {
        if (!endNode) return;
        endNode.onended = () => {
            try { endNode.disconnect(); } catch (_) { /* already disconnected */ }
            nodes.forEach(n => {
                if (!n) return;
                try { n.disconnect(); } catch (_) { /* noop */ }
            });
        };
    }

    _playNoise(startTime, gain, duration, lowFreq, highFreq) {
        // 共有バッファのランダムオフセットから duration 分だけ再生
        const sharedBuf = this._getSharedNoiseBuffer();
        const maxOffset = Math.max(0, sharedBuf.duration - duration - 0.01);
        const offset = Math.random() * maxOffset;

        const noise = this.ctx.createBufferSource();
        noise.buffer = sharedBuf;

        const bandpass = this.ctx.createBiquadFilter();
        bandpass.type = 'bandpass';
        bandpass.frequency.value = (lowFreq + highFreq) / 2;
        bandpass.Q.value = 0.5;

        const gainNode = this.ctx.createGain();
        gainNode.gain.setValueAtTime(gain, startTime);
        gainNode.gain.exponentialRampToValueAtTime(0.001, startTime + duration);

        noise.connect(bandpass);
        bandpass.connect(gainNode);
        gainNode.connect(this.sfxGain);
        noise.start(startTime, offset, duration);
        noise.stop(startTime + duration);
        this._autoDisconnect(noise, bandpass, gainNode);
    }

    _createDistortion(amount) {
        const dist = this.ctx.createWaveShaper();
        dist.curve = this._getDistortionCurve(amount);
        dist.oversample = '2x';
        return dist;
    }

    /** ミュート切替 */
    toggleMute() {
        this.muted = !this.muted;
        if (this.masterGain) {
            this.masterGain.gain.value = this.muted ? 0 : 0.6;
        }
        if (this.muted) {
            this.stopBGM();
        }
        return this.muted;
    }

    /** SFXボリューム設定 (0-1) */
    setSFXVolume(v) {
        if (this.sfxGain) this.sfxGain.gain.value = v;
    }

    /** BGMボリューム設定 (0-1) */
    setBGMVolume(v) {
        if (this.bgmGain) this.bgmGain.gain.value = v;
    }
}
