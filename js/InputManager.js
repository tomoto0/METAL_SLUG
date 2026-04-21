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

        // マウスが最近動いたかどうか（マウス照準 vs キーボード照準の切り替え用）
        this.mouseActive = true;
        this._mouseIdleTimer = 0;

        // バルカン自動射撃モード（V キーでトグル。デフォルトON）
        this.autoFireMode = true;

        window.addEventListener('keydown', (e) => {
            if (!this.keys[e.code]) {
                this.justPressedKeys.add(e.code);
            }
            this.keys[e.code] = true;
            // ゲーム中に効くキーはデフォルト動作を止める
            // （ただし F5/F12 等のブラウザ機能は許可）
            if (!e.code.startsWith('F') || e.code === 'KeyF') {
                e.preventDefault();
            }
        });

        window.addEventListener('keyup', (e) => {
            this.keys[e.code] = false;
        });

        window.addEventListener('mousemove', (e) => {
            // NDC (-1 to 1)
            this.mouseX = (e.clientX / window.innerWidth) * 2 - 1;
            this.mouseY = -(e.clientY / window.innerHeight) * 2 + 1;
            // マウスが動いたらマウス照準モードに
            this.mouseActive = true;
            this._mouseIdleTimer = 0;
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
    // 移動（カーソルキー）
    // ============================================
    // 画面の向き（3/4 背後カメラ）に合わせて ← / → を反転
    get moveLeft() {
        return this.isKeyDown('ArrowRight');
    }

    get moveRight() {
        return this.isKeyDown('ArrowLeft');
    }

    get moveForward() {
        return this.isKeyDown('ArrowUp');
    }

    get moveBackward() {
        return this.isKeyDown('ArrowDown');
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
     * 右クリック / F / SHIFT キー
     */
    get altFireHeld() {
        return this.isRightMouseDown
            || this.isKeyDown('KeyF')
            || this.isKeyDown('ShiftLeft')
            || this.isKeyDown('ShiftRight');
    }

    /**
     * 手榴弾: G キー (pressed = just pressed, held = held down for preview)
     */
    get grenadePressed() {
        return this.isKeyPressed('KeyG');
    }

    get grenadeHeld() {
        return this.isKeyDown('KeyG');
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
     * ダッシュ: E （SHIFT はキャノンに割り当てたので除外）
     */
    get dashPressed() {
        return this.isKeyPressed('KeyE');
    }

    /**
     * 自動射撃モードのトグル: V キー押下で切り替え
     */
    get autoFireTogglePressed() {
        return this.isKeyPressed('KeyV');
    }

    // 照準はマウス専用（WASD キーボードエイムは廃止）
    get aimUp()    { return false; }
    get aimDown()  { return false; }
    get aimLeft()  { return false; }
    get aimRight() { return false; }

    updateAimMode(dt) {
        // マウス専用モードを維持
        this.mouseActive = true;
    }
}
