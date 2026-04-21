# Metal Slug 3D — ゲーム性改善 実装設計ドキュメント

本ドキュメントは、既存コード (`/Users/masuda_1/Desktop/METAL_SLUG/`) に対して
ゲーム性を Metal Slug 原作に近づけるための具体的な実装設計です。
各セクションは独立しており、上から順に実装していけます。

> **このドキュメントの使い方**
> - 「変更対象」= 既存ファイルのどの関数に差し込むか
> - 「新規ファイル」= 追加で作成するモジュール
> - 「擬似コード」= コピペ可能なリファレンス実装断片
> - 「接続ポイント」= `main.js` のコールバック配線で足すべき行

実装順の推奨: **Feature 1 → 5 → 4 → 6 → 2 → 3** (依存度の低いもの・手応えが早いものから)

---

## Feature 1: POW（捕虜）救出システム

### 1.1 目的・概要
Metal Slug シリーズの象徴的ギミック。戦場に縛られた捕虜兵がおり、プレイヤーが接触
または敵を倒すことで解放される。解放すると走って逃げながら **感謝のアニメーション**
を行い、一定時間後に **武器POW・点数・手榴弾** のいずれかを残して去る。

### 1.2 新規ファイル: `js/POW.js`

```js
// js/POW.js
import * as THREE from 'three';

const POW_STATES = {
    TIED: 'tied',           // 縛られている（初期状態）
    RELEASED: 'released',   // 解放されて走り回る
    GRATEFUL: 'grateful',   // 感謝アニメ（両手を挙げる）
    LEAVING: 'leaving',     // 画面外へ走り去る
    DEAD: 'dead',
};

export class POW {
    constructor(scene, position) {
        this.scene = scene;
        this.state = POW_STATES.TIED;
        this.alive = true;
        this.hp = 5;              // 流れ弾で死ぬことがある
        this.age = 0;
        this.stateTime = 0;
        this.reward = this._rollReward(); // 'weapon_H' | 'weapon_R' | 'grenade' | 'score_big'
        this.runSpeed = 6.0;
        this.walkPhase = 0;

        this.group = new THREE.Group();
        this._buildModel();
        this.group.position.copy(position);
        this.scene.add(this.group);
    }

    _rollReward() {
        const roll = Math.random();
        if (roll < 0.40) return 'weapon_H';      // ヘビーマシンガン
        if (roll < 0.65) return 'weapon_R';      // ロケットランチャー
        if (roll < 0.85) return 'grenade';       // 手榴弾+5
        return 'score_big';                       // 5000点
    }

    _buildModel() {
        // 縛られ状態: くたびれたボランティア兵(茶のローブ、赤いバンダナ、顎ヒゲ)
        const bodyMat = new THREE.MeshStandardMaterial({ color: 0x9B7A4A, roughness: 0.85 });
        const headMat = new THREE.MeshStandardMaterial({ color: 0xE8C28F, roughness: 0.7 });
        const bandMat = new THREE.MeshStandardMaterial({ color: 0xCC2222, roughness: 0.7 });
        const ropeMat = new THREE.MeshStandardMaterial({ color: 0x6B4F2C, roughness: 0.9 });

        // 胴体
        const torso = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.8, 0.35), bodyMat);
        torso.position.y = 1.1;
        this.group.add(torso);

        // 頭
        const head = new THREE.Mesh(new THREE.SphereGeometry(0.28, 10, 8), headMat);
        head.position.y = 1.75;
        head.scale.set(1.0, 1.1, 1.0);
        this.group.add(head);

        // バンダナ（赤）
        const band = new THREE.Mesh(new THREE.TorusGeometry(0.28, 0.06, 6, 12), bandMat);
        band.position.y = 1.88;
        band.rotation.x = Math.PI / 2;
        this.group.add(band);

        // 腕（TIED 状態で体の前で縛られている）
        this.armL = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.42, 0.14), bodyMat);
        this.armL.position.set(-0.22, 1.0, 0.15);
        this.group.add(this.armL);
        this.armR = this.armL.clone();
        this.armR.position.set(0.22, 1.0, 0.15);
        this.group.add(this.armR);

        // 縛りロープ（TIED 状態のみ表示）
        this.ropes = new THREE.Group();
        for (let y of [0.9, 1.1, 1.3]) {
            const r = new THREE.Mesh(
                new THREE.TorusGeometry(0.28, 0.025, 4, 10),
                ropeMat
            );
            r.position.y = y;
            r.rotation.x = Math.PI / 2;
            this.ropes.add(r);
        }
        this.group.add(this.ropes);

        // 足
        this.legL = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.42, 0.18), bodyMat);
        this.legL.position.set(-0.12, 0.5, 0);
        this.group.add(this.legL);
        this.legR = this.legL.clone();
        this.legR.position.set(0.12, 0.5, 0);
        this.group.add(this.legR);

        // 目印: 頭上の「!」マーク（TIED 状態で点滅）
        this.exclaim = this._makeExclaim();
        this.exclaim.position.y = 2.4;
        this.group.add(this.exclaim);
    }

    _makeExclaim() {
        const g = new THREE.Group();
        const mat = new THREE.MeshBasicMaterial({ color: 0xFFEE33 });
        const stem = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.28, 0.08), mat);
        stem.position.y = 0.15;
        const dot = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.08), mat);
        dot.position.y = -0.05;
        g.add(stem); g.add(dot);
        return g;
    }

    /**
     * プレイヤーが接触 or 近接攻撃でロープを切断 → RELEASED
     */
    release() {
        if (this.state !== POW_STATES.TIED) return;
        this.state = POW_STATES.RELEASED;
        this.stateTime = 0;
        // ロープを外す
        this.group.remove(this.ropes);
        this.ropes = null;
        // 腕を上へ（感謝ポーズへの準備）
        this.armL.rotation.z = 0.2;
        this.armR.rotation.z = -0.2;
        // ! マーク消す
        this.group.remove(this.exclaim);
        this.exclaim = null;
    }

    update(dt, playerPos) {
        if (!this.alive) return;
        this.age += dt;
        this.stateTime += dt;

        if (this.state === POW_STATES.TIED) {
            // ! マーク点滅
            if (this.exclaim) this.exclaim.visible = Math.floor(this.age * 4) % 2 === 0;
            // プレイヤー接触判定は GameManager 側で行う
            return;
        }

        if (this.state === POW_STATES.RELEASED) {
            // 1.2 秒喜んだ後 LEAVING へ
            this.armL.rotation.z = Math.sin(this.stateTime * 10) * 0.4 + 1.2;
            this.armR.rotation.z = -Math.sin(this.stateTime * 10) * 0.4 - 1.2;
            if (this.stateTime > 1.2) {
                this.state = POW_STATES.LEAVING;
                this.stateTime = 0;
                // 近くに報酬アイテムをドロップ（本体は逃げる）
                this._dropReward();
            }
            return;
        }

        if (this.state === POW_STATES.LEAVING) {
            // プレイヤーから逃げる方向へ走る（XZ 平面）
            const dx = this.group.position.x - playerPos.x;
            const dz = this.group.position.z - playerPos.z;
            const len = Math.hypot(dx, dz) || 1;
            this.group.position.x += (dx / len) * this.runSpeed * dt;
            this.group.position.z += (dz / len) * this.runSpeed * dt;
            this.group.rotation.y = Math.atan2(dx, dz);
            // 走り歩行アニメ
            this.walkPhase += dt * 15;
            this.legL.rotation.x = Math.sin(this.walkPhase) * 0.6;
            this.legR.rotation.x = -Math.sin(this.walkPhase) * 0.6;
            // 4 秒で消滅
            if (this.stateTime > 4.0) {
                this.alive = false;
            }
        }
    }

    _dropReward() {
        // GameManager が this.pendingReward を見て ItemDrop を作る
        this.pendingReward = this.reward;
    }

    takeDamage(amount) {
        if (!this.alive || this.state === POW_STATES.LEAVING) return;
        this.hp -= amount;
        if (this.hp <= 0) {
            this.alive = false;
            this.state = POW_STATES.DEAD;
        }
    }

    destroy() {
        this.alive = false;
        this.scene.remove(this.group);
        this.group.traverse(c => {
            if (c.isMesh) { c.geometry.dispose(); c.material.dispose(); }
        });
    }
}
```

### 1.3 変更対象: `GameManager.js`

**(a) コンストラクタに追加:**
```js
this.pows = [];
this.powSpawnTimer = 0;
this.powSpawnInterval = 22.0; // 22秒ごとに1体
this.onPowRescued = null;     // コールバック: UI通知用
```

**(b) `update()` 内のループに追加:**
```js
// POW スポーン
this.powSpawnTimer += dt;
if (this.powSpawnTimer > this.powSpawnInterval && this.pows.length < 2) {
    this._spawnPOW();
    this.powSpawnTimer = 0;
}

// POW 更新
for (let i = this.pows.length - 1; i >= 0; i--) {
    const pow = this.pows[i];
    pow.update(dt, player.getPosition());

    // プレイヤー接触で解放（TIED 時のみ）
    if (pow.state === 'tied') {
        const d = pow.group.position.distanceTo(player.getPosition());
        if (d < 2.5) {
            pow.release();
            if (this.onPowRescued) this.onPowRescued(pow.reward);
        }
    }

    // 報酬ドロップ確定時
    if (pow.pendingReward) {
        const dropPos = pow.group.position.clone();
        this.items.push(new ItemDrop(this.scene, dropPos, pow.pendingReward));
        pow.pendingReward = null;
    }

    if (!pow.alive) {
        pow.destroy();
        this.pows.splice(i, 1);
    }
}
```

**(c) `_spawnPOW()` を追加:**
```js
_spawnPOW() {
    const z = this.getScrollZ() + 30 + Math.random() * 10;
    const x = (Math.random() - 0.5) * 10;
    const pow = new POW(this.scene, new THREE.Vector3(x, 0, z));
    this.pows.push(pow);
}
```

**(d) 流れ弾による誤殺判定を `_checkCollisions()` 内に:**
```js
// プレイヤー弾 × POW（誤射チェック）
this.pows.forEach(pow => {
    if (!pow.alive || pow.state !== 'tied') return;
    player.projectiles.forEach(p => {
        if (!p.alive) return;
        if (p.getPosition().distanceTo(pow.group.position) < 0.8) {
            pow.takeDamage(10);
            p.alive = false;
        }
    });
});
```

### 1.4 接続ポイント: `main.js`
```js
gameManager.onPowRescued = (reward) => {
    uiManager.showRescueBanner(reward); // "POW RESCUED!"
    cameraZoomKick(0.05);
};
```

### 1.5 UI 追加 (`UIManager.js`)
```js
showRescueBanner(reward) {
    const el = document.createElement('div');
    el.className = 'rescue-banner';
    const label = {
        weapon_H: 'HEAVY MACHINE GUN!',
        weapon_R: 'ROCKET LAUNCHER!',
        grenade:  '+5 BOMBS!',
        score_big:'+5000 PTS!',
    }[reward] || 'RESCUED!';
    el.textContent = `POW! ${label}`;
    this.container.appendChild(el);
    setTimeout(() => el.remove(), 2000);
}
```

### 1.6 テスト観点
- 1 ウェーブで最大 2 体までしか湧かないこと
- プレイヤーが近接すると 1 フレームで解放、バンザイ、走り去る流れが途切れないこと
- 流れ弾で HP 0 になった場合 `RESCUED` バナーが出ず、リワードも落とさないこと

---

## Feature 2: 武器 POW ピックアップ（H / R / F / S / C）

### 2.1 目的・概要
Metal Slug の武器は **取ると一定弾数の特殊弾に切り替わり、0 になると基本武器に戻る**
使い切り型。現在 `ItemDrop` に `health / grenade / score` のみ実装されているので
以下を追加する:

| コード | 名称 | 効果 | 弾数 |
|-------|------|------|------|
| H | Heavy Machine Gun | 連射速度↑×2、ダメージ 1.5× | 200 |
| R | Rocket Launcher | 追尾ロケット、爆風 | 30 |
| F | Flame Shot | 短射程・貫通・DoT | 100 |
| S | Shotgun | 拡散 5 発、近距離特化 | 40 |
| C | Cannon Ammo | キャノン弾補充 | +10 |

### 2.2 変更対象: `Player.js`

**(a) コンストラクタに追加:**
```js
// 特殊武器ステート
this.specialWeapon = null;      // null | 'H' | 'R' | 'F' | 'S'
this.specialAmmo = 0;
this.baseFireRate = 0.15;       // 既存 fireRate のバックアップ
```

**(b) `_fireVulcan()` を分岐:**
```js
_fireVulcan(elapsedTime) {
    if (this.specialWeapon) {
        return this._fireSpecial(elapsedTime);
    }
    // ... 既存のバルカン処理
}

_fireSpecial(elapsedTime) {
    switch (this.specialWeapon) {
        case 'H':
            this.fireRate = 0.08;  // 連射速度 up
            this._fireVulcanBase(elapsedTime, { damage: 15, muzzleColor: 0xFFDD00 });
            break;
        case 'R':
            this.fireRate = 0.4;
            this._fireRocket(elapsedTime);
            break;
        case 'F':
            this.fireRate = 0.1;
            this._fireFlame(elapsedTime);
            break;
        case 'S':
            this.fireRate = 0.45;
            for (let i = -2; i <= 2; i++) {
                this._fireVulcanBase(elapsedTime, {
                    damage: 8, spread: i * 0.06, noRateLimit: i !== 0,
                });
            }
            break;
    }
    this.specialAmmo -= (this.specialWeapon === 'S' ? 1 : 1);
    if (this.specialAmmo <= 0) {
        this.specialWeapon = null;
        this.fireRate = this.baseFireRate;
    }
}
```

**(c) `equipSpecial(code, ammo)` を追加:**
```js
equipSpecial(code, ammo) {
    this.specialWeapon = code;
    this.specialAmmo = ammo;
    // 砲身の色を武器ごとに変える（フィードバック）
    const colorMap = { H: 0xFFCC33, R: 0xCC3333, F: 0xFF6611, S: 0x33CC99 };
    if (this.vulcanGroup && colorMap[code]) {
        this.vulcanGroup.traverse(c => {
            if (c.isMesh) c.material.emissive = new THREE.Color(colorMap[code]);
        });
    }
}
```

### 2.3 変更対象: `ItemDrop.js`

新しいケースを `_buildModel()` に追加:
```js
case 'weapon_H': this._buildWeaponIcon('H', 0xFFCC33); break;
case 'weapon_R': this._buildWeaponIcon('R', 0xCC3333); break;
case 'weapon_F': this._buildWeaponIcon('F', 0xFF6611); break;
case 'weapon_S': this._buildWeaponIcon('S', 0x33CC99); break;

_buildWeaponIcon(letter, color) {
    // 枠（立方体）
    const box = new THREE.Mesh(
        new THREE.BoxGeometry(0.7, 0.7, 0.7),
        new THREE.MeshStandardMaterial({
            color, emissive: color, emissiveIntensity: 0.4,
            roughness: 0.3, metalness: 0.5,
        })
    );
    this.group.add(box);

    // 文字プレート（CanvasTexture で "H" などを描画）
    const canvas = document.createElement('canvas');
    canvas.width = 64; canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#222';
    ctx.fillRect(0, 0, 64, 64);
    ctx.fillStyle = '#FFF';
    ctx.font = 'bold 52px "Press Start 2P", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(letter, 32, 36);
    const tex = new THREE.CanvasTexture(canvas);
    const plate = new THREE.Mesh(
        new THREE.PlaneGeometry(0.6, 0.6),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true })
    );
    plate.position.z = 0.36;
    this.group.add(plate);
    // 反対面にもコピー
    const plate2 = plate.clone();
    plate2.rotation.y = Math.PI;
    plate2.position.z = -0.36;
    this.group.add(plate2);
}
```

### 2.4 変更対象: `GameManager._checkCollisions()`

アイテム収集判定に追加:
```js
if (this.items[i].type.startsWith('weapon_')) {
    const code = this.items[i].type.slice(-1); // H/R/F/S
    const ammoMap = { H: 200, R: 30, F: 100, S: 40 };
    player.equipSpecial(code, ammoMap[code]);
    // ...既存の collect 処理
}
```

### 2.5 UI 追加 (`UIManager.js`)
HUD の ARMS アイコンを動的に差し替え:
```js
updateArmsIndicator(player) {
    const arms = document.getElementById('arms-value');
    if (player.specialWeapon) {
        arms.textContent = `${player.specialWeapon}×${player.specialAmmo}`;
        arms.style.color = '#FFCC33';
    } else {
        arms.textContent = '∞';
        arms.style.color = '#FFF';
    }
}
```

---

## Feature 3: 徒歩モード ⇔ 搭乗モード（降車ギミック）

### 3.1 目的・概要
Metal Slug 原作では、乗り物（SV-001）がダメージで大破する前に降りて身軽に戦える
システムがある。降車中はプレイヤー小さい / 俊敏 / 被弾即死 / 再搭乗可能。

### 3.2 新規ファイル: `js/Marco.js` (徒歩キャラ)

```js
// js/Marco.js
import * as THREE from 'three';
import { Projectile } from './Projectile.js';

export class Marco {
    constructor(scene) {
        this.scene = scene;
        this.alive = true;
        this.hp = 1; // 徒歩は被弾一撃死
        this.group = new THREE.Group();
        this._buildModel();
        this.scene.add(this.group);
        this.group.visible = false;
        this.speed = 15; // 戦車より速い
        this.aimAngle = 0;
        this.fireRate = 0.12;
        this.lastFireTime = 0;
        this.projectiles = [];
        this.walkPhase = 0;
    }

    _buildModel() {
        const skinMat = new THREE.MeshStandardMaterial({ color: 0xE8C28F });
        const shirtMat = new THREE.MeshStandardMaterial({ color: 0x4A6B3A }); // 緑シャツ
        const pantsMat = new THREE.MeshStandardMaterial({ color: 0x6B5A38 }); // カーキパンツ
        const hatMat = new THREE.MeshStandardMaterial({ color: 0xAA3322 });   // 赤バンダナ

        const torso = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.7, 0.3), shirtMat);
        torso.position.y = 1.05;
        this.group.add(torso);

        const head = new THREE.Mesh(new THREE.SphereGeometry(0.25, 8, 6), skinMat);
        head.position.y = 1.65;
        this.group.add(head);

        // 赤バンダナ（マルコ！）
        const band = new THREE.Mesh(new THREE.TorusGeometry(0.26, 0.06, 4, 8), hatMat);
        band.position.y = 1.75;
        band.rotation.x = Math.PI / 2;
        this.group.add(band);

        this.gun = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.1, 0.1),
            new THREE.MeshStandardMaterial({ color: 0x222222, metalness: 0.7 }));
        this.gun.position.set(0.35, 1.1, 0);
        this.group.add(this.gun);

        this.legL = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.4, 0.18), pantsMat);
        this.legL.position.set(-0.12, 0.5, 0);
        this.group.add(this.legL);
        this.legR = this.legL.clone();
        this.legR.position.set(0.12, 0.5, 0);
        this.group.add(this.legR);
    }

    mount(tankPos) {
        this.group.visible = false;
        this.alive = true;
    }

    dismount(tankPos) {
        this.group.position.copy(tankPos);
        this.group.position.x += 1.5;
        this.group.visible = true;
        this.hp = 1;
    }

    update(dt, input, scrollZ) {
        if (!this.alive || !this.group.visible) return;
        let mx = 0, mz = 0;
        if (input.moveLeft) mx -= 1;
        if (input.moveRight) mx += 1;
        if (input.moveForward) mz += 1;
        if (input.moveBackward) mz -= 1;
        const len = Math.hypot(mx, mz);
        if (len > 0) {
            mx /= len; mz /= len;
            this.group.position.x += mx * this.speed * dt;
            this.group.position.z += mz * this.speed * dt;
            this.walkPhase += dt * 10;
            this.legL.rotation.x = Math.sin(this.walkPhase) * 0.5;
            this.legR.rotation.x = -Math.sin(this.walkPhase) * 0.5;
        }
        // 射撃（input.aimPoint を受け取る）
        // ...
    }

    takeDamage() {
        if (!this.alive) return;
        this.alive = false; // 一撃死
        this.group.visible = false;
    }
}
```

### 3.3 変更対象: `main.js`

```js
const marco = new Marco(scene);
let mode = 'tank'; // 'tank' | 'foot'

// E キーで降車/搭乗
inputManager.onDismountPressed = () => {
    if (mode === 'tank') {
        mode = 'foot';
        marco.dismount(player.group.position.clone());
        player.group.visible = false; // 戦車は残す(再搭乗可能)
    } else {
        // 戦車に近ければ再搭乗
        const d = marco.group.position.distanceTo(player.group.position);
        if (d < 3) {
            mode = 'tank';
            marco.mount(player.group.position);
            player.group.visible = true;
        }
    }
};

// 更新ループ内で切り替え
if (mode === 'tank') {
    player.update(dt, input, elapsedTime);
} else {
    marco.update(dt, input, scrollZ);
    // 徒歩時の弾やダメージは GameManager に別経路で通知
}

// 戦車が大破したら自動で徒歩モードへ
gameManager.onPlayerTankDestroyed = () => {
    mode = 'foot';
    marco.dismount(player.group.position.clone());
};
```

### 3.4 注意点
- 徒歩中は `gameManager.update()` に渡す「プレイヤーオブジェクト」を `marco` に差し替える
  必要がある。`Player` と `Marco` が同じインターフェース
  (`getPosition()`, `takeDamage()`, `isInvincible()`, `projectiles`) を満たすように実装。
- カメラ追尾は `laneX` を `mode === 'tank' ? player.localOffsetX : marco.group.position.x` に分岐。

---

## Feature 4: 戦車の段階的破損表現 & スモーク

### 4.1 目的・概要
HP に応じて戦車の見た目が変わる。
- HP 100-70%: 無傷
- HP 70-40%: 左サイドに焦げ跡テクスチャ + 小さな黒煙パーティクル
- HP 40-15%: 前面装甲に亀裂（赤い発光ライン）+ 火花パーティクル
- HP 15-0%: 継続的な赤いオーバーレイ発光 + 大きな炎と黒煙の柱

### 4.2 変更対象: `Player.js`

**(a) `update()` の最後に追加:**
```js
this._updateDamageVisuals(dt);
```

**(b) 新メソッド:**
```js
_updateDamageVisuals(dt) {
    const hpRatio = this.hp / this.maxHp;

    // スモークパーティクル生成レート
    let smokeRate = 0;
    if (hpRatio < 0.7) smokeRate = 0.3;
    if (hpRatio < 0.4) smokeRate = 0.15;
    if (hpRatio < 0.15) smokeRate = 0.07;

    if (smokeRate > 0) {
        this._damageSmokeTimer = (this._damageSmokeTimer || 0) + dt;
        if (this._damageSmokeTimer > smokeRate) {
            this._damageSmokeTimer = 0;
            this._spawnDamageSmoke(hpRatio);
        }
    }

    // 赤発光（瀕死警告）
    if (hpRatio < 0.15) {
        const pulse = Math.abs(Math.sin(Date.now() * 0.008));
        if (this.hullGroup) {
            this.hullGroup.traverse(c => {
                if (c.isMesh && c.material && !c._damageIgnore) {
                    c.material.emissive = c.material.emissive || new THREE.Color();
                    c.material.emissive.setHex(0xFF2211);
                    c.material.emissiveIntensity = pulse * 0.4;
                }
            });
        }
    }
}

_spawnDamageSmoke(hpRatio) {
    const severe = hpRatio < 0.15;
    const color = severe ? 0x222222 : 0x555555;
    const size = severe ? 0.5 : 0.25;
    const puff = new THREE.Mesh(
        new THREE.SphereGeometry(size, 6, 5),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6 })
    );
    const pos = this.group.position;
    puff.position.set(
        pos.x + (Math.random() - 0.5) * 1.2,
        pos.y + 1.8 + Math.random() * 0.5,
        pos.z + (Math.random() - 0.5) * 1.0
    );
    this.scene.add(puff);
    this.exhaustParticles.push({
        mesh: puff, age: 0,
        maxAge: severe ? 2.0 : 1.2,
        vy: severe ? 2.5 : 1.5,
        vx: (Math.random() - 0.5) * 0.5,
        vz: -0.8,
        scaleRate: 3.0,
    });

    // 瀕死なら火花も
    if (severe && Math.random() < 0.4) {
        const spark = new THREE.Mesh(
            new THREE.SphereGeometry(0.06, 4, 3),
            new THREE.MeshBasicMaterial({ color: 0xFF8822 })
        );
        spark.position.copy(puff.position);
        this.scene.add(spark);
        this.exhaustParticles.push({
            mesh: spark, age: 0, maxAge: 0.4,
            vy: 3, vx: (Math.random() - 0.5) * 3,
            vz: (Math.random() - 0.5) * 3, scaleRate: 0,
        });
    }
}
```

### 4.3 追加オプション: 焦げテクスチャオーバーレイ
HP 70% 以下でアウトラインメッシュをかぶせる方式:
```js
_applyScorchMarks() {
    if (this._scorchApplied) return;
    this._scorchApplied = true;
    const scorch = new THREE.Mesh(
        new THREE.SphereGeometry(1.31, 16, 12),
        new THREE.MeshBasicMaterial({
            color: 0x111111, transparent: true, opacity: 0.35,
            alphaMap: this._generateScorchAlpha(),
        })
    );
    this.hullGroup.add(scorch);
}
```

---

## Feature 5: コンボボーナス & スコアポップ

### 5.1 目的・概要
既存の `UIManager` にコンボシステムは実装済みとのこと。これを拡張し、
**「BONUS!」「AIR COMBO!」「HEADSHOT!」** などの画面中央ポップ文字と、
**スコア 3D 数字が敵の位置から浮き上がる** 演出を追加する。

### 5.2 変更対象: `UIManager.js`

**(a) `onEnemyKilled(enemy, killType)` を拡張:**
```js
onEnemyKilled(enemy, killType) {
    const baseScore = enemy.scoreValue || 100;
    this.comboCount++;
    this.comboTimer = 2.0;

    // コンボ倍率
    let mult = 1;
    if (this.comboCount >= 20) mult = 5;
    else if (this.comboCount >= 10) mult = 3;
    else if (this.comboCount >= 5)  mult = 2;
    else if (this.comboCount >= 3)  mult = 1.5;

    // ボーナス判定
    let bonusLabel = null;
    if (killType === 'headshot') bonusLabel = 'HEADSHOT!';
    else if (enemy.constructor.name === 'Aircraft') bonusLabel = 'AIR COMBO!';
    else if (this.comboCount === 10) bonusLabel = '10 HIT COMBO!';
    else if (this.comboCount === 20) bonusLabel = '20 HIT RAMPAGE!';
    else if (this._allEnemiesOnScreen() === 0) bonusLabel = 'CLEAR!';

    const finalScore = Math.floor(baseScore * mult);
    this._spawn3DScorePopup(enemy.group.position, finalScore, mult);
    if (bonusLabel) this._spawnCenterBanner(bonusLabel, mult);

    return finalScore;
}
```

**(b) 3D スコアポップ（DOM で overlay 表示）:**
```js
_spawn3DScorePopup(worldPos, score, mult) {
    const el = document.createElement('div');
    el.className = 'score-popup';
    el.textContent = `+${score}`;
    if (mult >= 3) el.classList.add('score-popup--huge');
    else if (mult >= 2) el.classList.add('score-popup--big');
    document.body.appendChild(el);

    // 毎フレーム追従
    const life = 1.2;
    const start = performance.now();
    const self = this;
    const loop = () => {
        const t = (performance.now() - start) / 1000;
        if (t > life) { el.remove(); return; }
        const v = worldPos.clone();
        v.y += 2 + t * 3; // 浮き上がる
        v.project(self.camera);
        el.style.left = `${(v.x * 0.5 + 0.5) * innerWidth}px`;
        el.style.top  = `${(-v.y * 0.5 + 0.5) * innerHeight}px`;
        el.style.opacity = `${1 - t / life}`;
        requestAnimationFrame(loop);
    };
    loop();
}
```

**(c) CSS 追加 (`css/style.css`):**
```css
.score-popup {
    position: fixed; pointer-events: none; z-index: 100;
    font-family: "Press Start 2P", monospace;
    color: #FFEE44; text-shadow: 2px 2px 0 #000, -1px -1px 0 #000;
    font-size: 20px; transform: translate(-50%, -50%);
}
.score-popup--big  { font-size: 28px; color: #FF8822; }
.score-popup--huge { font-size: 36px; color: #FF2222; animation: shake 0.2s infinite; }

.bonus-banner {
    position: fixed; left: 50%; top: 35%;
    transform: translate(-50%, -50%) scale(0);
    font-family: "Press Start 2P", monospace;
    color: #FFEE44; font-size: 48px;
    text-shadow: 4px 4px 0 #CC2200, -2px -2px 0 #000;
    animation: bonus-pop 1.2s ease-out forwards;
    z-index: 90;
}
@keyframes bonus-pop {
    0%   { transform: translate(-50%, -50%) scale(0) rotate(-30deg); }
    30%  { transform: translate(-50%, -50%) scale(1.3) rotate(5deg); }
    50%  { transform: translate(-50%, -50%) scale(1.0) rotate(0); }
    80%  { opacity: 1; }
    100% { transform: translate(-50%, -100%) scale(0.8); opacity: 0; }
}
```

### 5.3 接続ポイント
既に `gameManager.onEnemyKilled -> uiManager.onEnemyKilled` があるので、
`killType` 引数を渡せるよう `Enemy` 側で判定ロジックを追加:
```js
// Enemy.takeDamage()
if (bullet.hitPart === 'head') this._lastKillType = 'headshot';
```

---

## Feature 6: 手榴弾の高弧モーション & 巨大爆風

### 6.1 目的・概要
現在 `Player._throwGrenade()` は弾道物理はあるが、視覚フィードバックが弱い。
Metal Slug の手榴弾は **投擲時に白いパス（放物線プレビュー）** が表示され、
着弾時には **Explosion と同じ大きさ＋炎と破片** が発生する。

### 6.2 変更対象: `Player.js`

**(a) 照準時に予測パスを表示:**
```js
// constructor
this.grenadeTrajectory = this._makeTrajectoryLine();

_makeTrajectoryLine() {
    const geo = new THREE.BufferGeometry();
    const positions = new Float32Array(60); // 20 点 × 3
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.LineDashedMaterial({
        color: 0xFFFFAA, dashSize: 0.3, gapSize: 0.2, transparent: true, opacity: 0.6,
    });
    const line = new THREE.Line(geo, mat);
    line.visible = false;
    this.scene.add(line);
    return line;
}

_updateGrenadePreview(input) {
    if (!input.grenadeHeld || this.grenadeCount <= 0) {
        this.grenadeTrajectory.visible = false;
        return;
    }
    this.grenadeTrajectory.visible = true;

    const startPos = this.group.position.clone(); startPos.y += 1.5;
    const throwDir = new THREE.Vector3().subVectors(this.aimPoint, startPos);
    throwDir.y = 0;
    const throwDist = throwDir.length();
    throwDir.normalize();
    const speed = Math.min(throwDist * 1.2, 25);
    const v = new THREE.Vector3(throwDir.x * speed, 6 + throwDist * 0.15, throwDir.z * speed);
    const pos = startPos.clone();
    const positions = this.grenadeTrajectory.geometry.attributes.position.array;
    const dt = 0.08;
    for (let i = 0; i < 20; i++) {
        positions[i*3]   = pos.x;
        positions[i*3+1] = Math.max(0.05, pos.y);
        positions[i*3+2] = pos.z;
        v.y -= 20 * dt;
        pos.addScaledVector(v, dt);
        if (pos.y < 0) break;
    }
    this.grenadeTrajectory.geometry.attributes.position.needsUpdate = true;
    this.grenadeTrajectory.computeLineDistances();
}
```

**(b) `_throwGrenade()` の修正:**
```js
// grenadeのfuseTime 調整 + 巨大爆風指定（explosionVisual を Explosion.js 側で対応）
grenade.blastRadius = 6.0;
grenade.damage = 80;
grenade.explosionVisual = 'mega'; // 新規タイプ
```

### 6.3 変更対象: `Explosion.js`
```js
// コンストラクタで type === 'mega' を受け取る
if (options.type === 'mega') {
    this.maxAge = 0.8;
    this.scale = 2.5;
    this._spawnFireRing();
    this._spawnDebrisShower(25); // 25 片の破片
    this._spawnSmokePlume(8);    // 煙柱
    if (this.onCameraShake) this.onCameraShake(0.8);
}
```

### 6.4 UI: 投擲モーションの予告
```css
.grenade-ready-indicator {
    border: 2px solid #FFEE44;
    animation: pulse 0.6s infinite;
}
```

---

## 統合テスト観点

| ケース | 期待挙動 |
|-------|---------|
| POW を救出 → 武器 H を取得 → 200 発発射 → 0 で基本武器に戻る | 全段階でバグなし、UI が正しく反映 |
| 戦車 HP 14% で黒煙がもうもうと出る | スモークが途切れなく出続ける |
| 20 連キル | 「20 HIT RAMPAGE!」バナー、スコア 5× |
| 手榴弾を構えたまま照準を動かす | 予測パスが追従する |
| 敵群の中に手榴弾を投げ込む | 複数同時キル → コンボボーナス |
| 戦車大破 → 徒歩モード → 再搭乗 | 入力・カメラ・衝突判定の切替が破綻しない |

---

## 実装スケジュール目安

| Week | 内容 |
|------|------|
| 1 | Feature 5（コンボポップ）+ Feature 4（スモーク）→ 既存コードへの影響小、手応え即日 |
| 2 | Feature 1（POW）+ UIバナー統合 |
| 3 | Feature 2（武器ピックアップ）+ Feature 6（手榴弾演出） |
| 4 | Feature 3（徒歩モード）+ 総合デバッグ |

---

## 参考: 既存コードの主要接続ポイント（再掲）

| 既存ファイル | 行 / 関数 | 使い途 |
|------------|----------|-------|
| `main.js` | コールバック配線セクション | `onPowRescued`, `onPlayerTankDestroyed` を追加 |
| `GameManager.js` | `update()`, `_checkCollisions()` | POW 更新・接触・誤射判定の差し込み |
| `GameManager.js` | `_spawnEnemy()` と並列 | `_spawnPOW()` を新規追加 |
| `Player.js` | `constructor`, `_fireVulcan()`, `update()` | 特殊武器・被弾演出・手榴弾予測 |
| `UIManager.js` | `onEnemyKilled()`, `showBossHp()` と同階層 | `showRescueBanner()`, `_spawnCenterBanner()` |
| `ItemDrop.js` | `_buildModel()` | `weapon_*` ケース追加 |
| `Explosion.js` | コンストラクタ | `type === 'mega'` 分岐 |
| `css/style.css` | 末尾 | `.score-popup`, `.bonus-banner`, `.rescue-banner` |

---

**作成日:** 2026-04-16
**対象リポジトリ:** `/Users/masuda_1/Desktop/METAL_SLUG/`
