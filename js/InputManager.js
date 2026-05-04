export class InputManager {
    constructor(canvas) {
        this.keys = {};
        this.justPressedKeys = new Set();
        this.mouseX = 0;
        this.mouseY = 0;
        this.isMouseDown = false;
        this.isRightMouseDown = false;
        this.leftMousePressed = false;
        this.rightMousePressed = false;
        this.canvas = canvas;

        // バルカン自動射撃モード（V キーでトグル。デフォルトON）
        this.autoFireMode = true;

        // ゲーム入力で消費するキーのみ preventDefault する。
        // ブラウザショートカット（Ctrl+W, Ctrl+T, Cmd+R 等）と修飾キー組み合わせは透過させる。
        const GAME_KEY_CODES = new Set([
            'KeyW', 'KeyA', 'KeyS', 'KeyD',
            'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
            'Space',
            'KeyC', 'ControlLeft', 'ControlRight',
            'ShiftLeft', 'ShiftRight',
            'KeyE', 'KeyF', 'KeyB', 'KeyQ', 'KeyV', 'KeyM', 'KeyR',
        ]);

        window.addEventListener('keydown', (e) => {
            if (!this.keys[e.code]) {
                this.justPressedKeys.add(e.code);
            }
            this.keys[e.code] = true;
            // ブラウザショートカット（修飾キー併用）はゲーム側で握りつぶさない
            const hasModifier = e.ctrlKey || e.metaKey || e.altKey;
            if (GAME_KEY_CODES.has(e.code) && !hasModifier) {
                e.preventDefault();
            }
        });

        window.addEventListener('keyup', (e) => {
            this.keys[e.code] = false;
            // macOS では Cmd 保持中の他キーの keyup が抑制される。Cmd 離した瞬間に
            // 押下中状態のキーを全クリアして "押しっぱなし" を防ぐ。
            if (e.code === 'MetaLeft' || e.code === 'MetaRight') {
                for (const k of Object.keys(this.keys)) {
                    if (k !== 'MetaLeft' && k !== 'MetaRight') this.keys[k] = false;
                }
            }
        });

        // フォーカス喪失時はキーをクリアして "押しっぱなし" バグを防ぐ
        window.addEventListener('blur', () => {
            this.keys = {};
            this.isMouseDown = false;
            this.isRightMouseDown = false;
        });

        window.addEventListener('mousemove', (e) => {
            // NDC (-1 to 1)
            this.mouseX = (e.clientX / window.innerWidth) * 2 - 1;
            this.mouseY = -(e.clientY / window.innerHeight) * 2 + 1;
        });

        window.addEventListener('mousedown', (e) => {
            if (e.button === 0) {
                if (!this.isMouseDown) this.leftMousePressed = true;
                this.isMouseDown = true;
            }
            if (e.button === 2) {
                if (!this.isRightMouseDown) this.rightMousePressed = true;
                this.isRightMouseDown = true;
            }
        });

        window.addEventListener('mouseup', (e) => {
            if (e.button === 0) this.isMouseDown = false;
            if (e.button === 2) this.isRightMouseDown = false;
        });

        // コンテキストメニュー無効化（右クリック）
        window.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    isKeyDown(code) {
        return !!this.keys[code];
    }

    isKeyPressed(code) {
        return this.justPressedKeys.has(code);
    }

    endFrame() {
        this.justPressedKeys.clear();
        this.leftMousePressed = false;
        this.rightMousePressed = false;
    }

    // ============================================
    // 移動（WASD と 矢印キー）
    // ============================================
    // 注: 既存の Player/Marco コードは「moveLeft → world -X / 画面右へ」の意味で
    // 入力を消費するため、ここで画面方向 ↔ world 軸の反転を吸収している。
    // 画面右（D / →）を押したら moveLeft=true、画面左（A / ←）を押したら moveRight=true。
    get moveLeft() {
        return this.isKeyDown('ArrowRight') || this.isKeyDown('KeyD');
    }

    get moveRight() {
        return this.isKeyDown('ArrowLeft') || this.isKeyDown('KeyA');
    }

    get moveForward() {
        return this.isKeyDown('ArrowUp') || this.isKeyDown('KeyW');
    }

    get moveBackward() {
        return this.isKeyDown('ArrowDown') || this.isKeyDown('KeyS');
    }

    // ============================================
    // 射撃
    // ============================================
    /**
     * バルカン砲の発射条件:
     * - autoFire ON → 常に発射（元の動作）
     * - autoFire OFF → 左クリック or V キー長押しで発射
     */
    get fireHeld() {
        if (this.autoFireMode) return true;
        return this.isMouseDown || this.isKeyDown('KeyV');
    }

    get firePressed() {
        return this.leftMousePressed;
    }

    /**
     * キャノン発射（チャージ射撃）:
     * 右クリック / F キー / Command (Meta) キー
     * （Shift はダッシュに使用）
     */
    get altFireHeld() {
        return this.isRightMouseDown
            || this.isKeyDown('KeyF')
            || this.isKeyDown('MetaLeft')
            || this.isKeyDown('MetaRight');
    }

    /**
     * ボム: B キー (pressed = just pressed, held = held down for preview)
     */
    get grenadePressed() {
        return this.isKeyPressed('KeyB');
    }

    get grenadeHeld() {
        return this.isKeyDown('KeyB');
    }

    /**
     * 降車 / 搭乗: Q キー
     */
    get dismountPressed() {
        return this.isKeyPressed('KeyQ');
    }

    /**
     * ジャンプ: Space
     */
    get jumpPressed() {
        return this.isKeyPressed('Space');
    }

    /**
     * しゃがみ: C / Ctrl
     */
    get crouchHeld() {
        return this.isKeyDown('KeyC') || this.isKeyDown('ControlLeft') || this.isKeyDown('ControlRight');
    }

    /**
     * ダッシュ（ブースト）: Shift（業界慣習）。E は互換維持。
     */
    get dashPressed() {
        return this.isKeyPressed('ShiftLeft')
            || this.isKeyPressed('ShiftRight')
            || this.isKeyPressed('KeyE');
    }

    /**
     * 自動射撃モードのトグル: V キー押下で切り替え
     */
    get autoFireTogglePressed() {
        return this.isKeyPressed('KeyV');
    }

}
