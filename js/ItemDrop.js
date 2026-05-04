import * as THREE from 'three';

const _dropGlowGeo = new THREE.SphereGeometry(0.42, 8, 6);
_dropGlowGeo.userData.shared = true;

/**
 * アイテムドロップ
 * 敵撃破時にランダムでドロップ
 * タイプ: health, grenade, score
 */
export class ItemDrop {
    constructor(scene, position, type = 'health') {
        this.scene = scene;
        this.type = type;
        this.alive = true;
        this.age = 0;
        this.maxAge = 12; // 12秒で消える
        this.collected = false;

        this.group = new THREE.Group();
        this._buildModel();

        // 既存ビルダのバランスを維持しつつ全体を大型化（見えやすさ重視）
        const ITEM_SCALE = 2.0;
        this.modelScale = ITEM_SCALE;
        this.group.scale.setScalar(ITEM_SCALE);

        this.group.position.copy(position);
        this.group.position.y = 1.4;
        this.scene.add(this.group);

        // 光のエフェクト
        const lightColors = {
            health: 0x44FF44,
            grenade: 0xFF8844,
            score: 0xFFDD44,
            weapon_H: 0xFFCC33,
            weapon_R: 0xCC3333,
            weapon_F: 0xFF6611,
            weapon_S: 0x33CC99,
            score_big: 0xFFDD44,
            power_BIG: 0xFF44AA,
            power_SPREAD: 0x44CCFF,
            power_FLAME: 0xFF7711,
        };
        const glowColor = lightColors[type] || 0xFFFFFF;
        this.glowColor = glowColor;
        // PointLight をアイテムごとに持つと後半のライト数が増えてシェーダ負荷が跳ねる。
        // 加算合成の発光メッシュで視認性を維持し、動的ライト数は増やさない。
        this.glow = new THREE.Mesh(
            _dropGlowGeo,
            new THREE.MeshBasicMaterial({
                color: glowColor,
                transparent: true,
                opacity: 0.42,
                blending: THREE.AdditiveBlending,
                depthWrite: false,
                fog: false,
            })
        );
        this.glow.position.set(0, 0.6, 0);
        this.glow.scale.set(1.1, 0.55, 1.1);
        this.group.add(this.glow);

        // 上向き光柱（地上から立ち上るビーム）。子は group に乗っているので
        // group.scale で一緒に拡大される — sizes はモデル原寸ベースで指定。
        const beamGeo = new THREE.CylinderGeometry(0.18, 0.32, 3.6, 12, 1, true);
        const beamMat = new THREE.MeshBasicMaterial({
            color: glowColor, transparent: true, opacity: 0.32,
            blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false,
        });
        this.beam = new THREE.Mesh(beamGeo, beamMat);
        this.beam.position.y = 1.4;
        this.group.add(this.beam);

        // 接地リング（自分の足元を強調）
        const ringGeo = new THREE.RingGeometry(0.5, 0.85, 28);
        const ringMat = new THREE.MeshBasicMaterial({
            color: glowColor, transparent: true, opacity: 0.55,
            side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false,
        });
        this.ring = new THREE.Mesh(ringGeo, ringMat);
        this.ring.rotation.x = -Math.PI / 2;
        this.ring.position.y = -1.4;  // 地面 (Y≈0) に置くため group ローカル -1.4
        this.group.add(this.ring);
    }

    _buildModel() {
        switch (this.type) {
            case 'health':
                this._buildHealth();
                break;
            case 'grenade':
                this._buildGrenade();
                break;
            case 'score':
                this._buildScore(false);
                break;
            case 'score_big':
                this._buildScore(true);
                break;
            case 'weapon_H':
                this._buildWeaponIcon('H', 0xFFCC33);
                break;
            case 'weapon_R':
                this._buildWeaponIcon('R', 0xCC3333);
                break;
            case 'weapon_F':
                this._buildWeaponIcon('F', 0xFF6611);
                break;
            case 'weapon_S':
                this._buildWeaponIcon('S', 0x33CC99);
                break;
            case 'power_BIG':
                this._buildPowerUpIcon('P', 0xFF44AA);  // POWER
                break;
            case 'power_SPREAD':
                this._buildPowerUpIcon('3', 0x44CCFF);  // 3-WAY
                break;
            case 'power_FLAME':
                this._buildPowerUpIcon('F', 0xFF7711);  // FLAME
                break;
        }
    }

    _buildPowerUpIcon(letter, color) {
        // パワーアップは発光クリスタル + 保護リングで武器ケースと差別化する。
        const core = new THREE.Mesh(
            new THREE.OctahedronGeometry(0.48, 1),
            new THREE.MeshStandardMaterial({
                color, emissive: new THREE.Color(color), emissiveIntensity: 0.7,
                roughness: 0.25, metalness: 0.4,
            })
        );
        this.group.add(core);

        const capMat = new THREE.MeshStandardMaterial({ color: 0x2E3840, roughness: 0.35, metalness: 0.65 });
        for (const y of [-0.42, 0.42]) {
            const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.34, 0.12, 10), capMat);
            cap.position.y = y;
            this.group.add(cap);
        }

        // 三重リング（時限パワーアップの特別感）
        for (const tilt of [0, Math.PI / 2, Math.PI / 4]) {
            const ring = new THREE.Mesh(
                new THREE.TorusGeometry(0.58, 0.045, 6, 18),
                new THREE.MeshStandardMaterial({
                    color: 0xFFFFFF,
                    emissive: new THREE.Color(0xFFFFFF), emissiveIntensity: 0.6,
                })
            );
            ring.rotation.x = Math.PI / 2;
            ring.rotation.z = tilt;
            this.group.add(ring);
        }

        // 文字プレート
        const canvas = document.createElement('canvas');
        canvas.width = 64; canvas.height = 64;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#222';
        ctx.fillRect(0, 0, 64, 64);
        ctx.fillStyle = '#FFF';
        ctx.font = 'bold 48px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(letter, 32, 34);
        const tex = new THREE.CanvasTexture(canvas);

        for (const zSign of [1, -1]) {
            const plate = new THREE.Mesh(
                new THREE.PlaneGeometry(0.5, 0.5),
                new THREE.MeshBasicMaterial({ map: tex, transparent: true })
            );
            plate.position.z = 0.42 * zSign;
            if (zSign < 0) plate.rotation.y = Math.PI;
            this.group.add(plate);
        }
    }

    _buildWeaponIcon(letter, color) {
        // 武器補給は軍用ケース。側面に letter、上面にハンドルを付ける。
        const box = new THREE.Mesh(
            new THREE.BoxGeometry(0.78, 0.46, 0.62),
            new THREE.MeshStandardMaterial({
                color, emissive: new THREE.Color(color), emissiveIntensity: 0.4,
                roughness: 0.3, metalness: 0.5,
            })
        );
        this.group.add(box);

        const trimMat = new THREE.MeshStandardMaterial({ color: 0xF4E9C8, roughness: 0.35, metalness: 0.35 });
        for (const y of [-0.18, 0.18]) {
            const band = new THREE.Mesh(new THREE.BoxGeometry(0.86, 0.05, 0.68), trimMat);
            band.position.y = y;
            this.group.add(band);
        }
        const handle = new THREE.Mesh(
            new THREE.TorusGeometry(0.24, 0.035, 6, 14, Math.PI),
            trimMat
        );
        handle.position.y = 0.27;
        handle.rotation.z = Math.PI;
        this.group.add(handle);

        // letter を canvas で描画
        const canvas = document.createElement('canvas');
        canvas.width = 64; canvas.height = 64;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#111';
        ctx.fillRect(0, 0, 64, 64);
        ctx.fillStyle = '#FFF';
        ctx.font = 'bold 48px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(letter, 32, 34);
        const tex = new THREE.CanvasTexture(canvas);

        for (const zSign of [1, -1]) {
            const plate = new THREE.Mesh(
                new THREE.PlaneGeometry(0.42, 0.42),
                new THREE.MeshBasicMaterial({ map: tex, transparent: true })
            );
            plate.position.z = 0.325 * zSign;
            if (zSign < 0) plate.rotation.y = Math.PI;
            this.group.add(plate);
        }
    }

    _buildHealth() {
        // 医療カプセル: 横置きシリンダー + 白い十字 + 緑の端キャップ。
        const capsuleMat = new THREE.MeshStandardMaterial({
            color: 0x35C96A, emissive: 0x0B4A24, emissiveIntensity: 0.35,
            roughness: 0.26, metalness: 0.45,
        });
        const capsule = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.62, 16), capsuleMat);
        capsule.rotation.z = Math.PI / 2;
        this.group.add(capsule);

        const capMat = new THREE.MeshStandardMaterial({ color: 0xEAF6DF, roughness: 0.34, metalness: 0.25 });
        for (const x of [-0.34, 0.34]) {
            const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.225, 0.225, 0.06, 16), capMat);
            cap.rotation.z = Math.PI / 2;
            cap.position.x = x;
            this.group.add(cap);
        }

        const crossH = new THREE.BoxGeometry(0.24, 0.07, 0.025);
        const crossV = new THREE.BoxGeometry(0.07, 0.24, 0.025);
        const crossMat = new THREE.MeshBasicMaterial({ color: 0xFFFFFF });
        const h = new THREE.Mesh(crossH, crossMat);
        const v = new THREE.Mesh(crossV, crossMat);
        h.position.z = 0.225;
        v.position.z = 0.225;
        this.group.add(h, v);
    }

    _buildGrenade() {
        // 小型弾薬箱: 鉄帯と手榴弾ピクトで補給感を強調。
        const boxGeo = new THREE.BoxGeometry(0.3, 0.25, 0.2);
        const boxMat = new THREE.MeshStandardMaterial({
            color: 0x8B5A2B, roughness: 0.78, metalness: 0.18,
        });
        const box = new THREE.Mesh(boxGeo, boxMat);
        this.group.add(box);

        const bandMat = new THREE.MeshStandardMaterial({ color: 0x2D332E, roughness: 0.55, metalness: 0.45 });
        for (const x of [-0.11, 0.11]) {
            const band = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.28, 0.23), bandMat);
            band.position.x = x;
            this.group.add(band);
        }
        const handle = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.035, 0.04), bandMat);
        handle.position.y = 0.16;
        this.group.add(handle);

        // Gマーク
        const markGeo = new THREE.CircleGeometry(0.08, 6);
        const markMat = new THREE.MeshBasicMaterial({
            color: 0xFF8844,
            side: THREE.DoubleSide,
        });
        const mark = new THREE.Mesh(markGeo, markMat);
        mark.position.z = 0.11;
        this.group.add(mark);
    }

    _buildScore(isBig = false) {
        if (isBig) {
            // 大型ボーナス: 金属バンド付きの宝箱。
            const chestMat = new THREE.MeshStandardMaterial({ color: 0xB66A28, roughness: 0.55, metalness: 0.2 });
            const lidMat = new THREE.MeshStandardMaterial({ color: 0xE2A13A, roughness: 0.35, metalness: 0.45 });
            const base = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.34, 0.44), chestMat);
            base.position.y = -0.04;
            this.group.add(base);
            const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.30, 0.30, 0.46, 14, 1, false, 0, Math.PI), lidMat);
            lid.rotation.z = Math.PI / 2;
            lid.position.y = 0.15;
            this.group.add(lid);
            const bandMat = new THREE.MeshStandardMaterial({ color: 0xFFF0A0, roughness: 0.28, metalness: 0.75 });
            for (const x of [-0.22, 0.22]) {
                const band = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.44, 0.50), bandMat);
                band.position.x = x;
                this.group.add(band);
            }
            const lock = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.14, 0.035), bandMat);
            lock.position.set(0, 0.02, 0.235);
            this.group.add(lock);
            return;
        }

        // ゴールド勲章/コイン
        const coinGeo = new THREE.CylinderGeometry(0.22, 0.22, 0.07, 18);
        const coinMat = new THREE.MeshStandardMaterial({
            color: 0xFFDD00,
            emissive: 0x886600,
            emissiveIntensity: 0.25,
            roughness: 0.15,
            metalness: 0.85,
        });
        const coin = new THREE.Mesh(coinGeo, coinMat);
        coin.rotation.x = Math.PI / 2;
        this.group.add(coin);

        const ribbonMat = new THREE.MeshStandardMaterial({ color: 0xCC3030, roughness: 0.65 });
        for (const x of [-0.06, 0.06]) {
            const ribbon = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.20, 0.025), ribbonMat);
            ribbon.position.set(x, -0.18, 0);
            ribbon.rotation.z = x < 0 ? 0.18 : -0.18;
            this.group.add(ribbon);
        }

        // 星マーク
        const starGeo = new THREE.CircleGeometry(0.1, 5);
        const starMat = new THREE.MeshBasicMaterial({
            color: 0xFFFF88,
            side: THREE.DoubleSide,
        });
        const star = new THREE.Mesh(starGeo, starMat);
        star.position.z = 0.04;
        star.rotation.x = Math.PI / 2;
        this.group.add(star);
    }

    update(dt) {
        if (!this.alive) return;

        this.age += dt;

        // 回転
        this.group.rotation.y += dt * 3;

        // ふわふわ浮遊
        this.group.position.y = 1.4 + Math.sin(this.age * 3) * 0.2;

        // 光の点滅（可視性重視で常時強め）
        if (this.glow) {
            const pulse = 0.5 + Math.sin(this.age * 5) * 0.5;
            this.glow.scale.set(0.9 + pulse * 0.35, 0.45 + pulse * 0.18, 0.9 + pulse * 0.35);
            if (this.glow.material) {
                this.glow.material.opacity = 0.26 + pulse * 0.24;
            }
        }

        // 光柱・リング演出
        if (this.beam) {
            this.beam.material.opacity = 0.28 + Math.sin(this.age * 4) * 0.1;
        }
        if (this.ring) {
            const s = 1.0 + Math.sin(this.age * 4) * 0.18;
            this.ring.scale.setScalar(s);
            this.ring.material.opacity = 0.4 + Math.sin(this.age * 4) * 0.2;
        }

        // 消滅前の点滅（残り3秒）
        if (this.age > this.maxAge - 3) {
            this.group.visible = Math.floor(this.age * 6) % 2 === 0;
        }

        // 寿命切れ
        if (this.age >= this.maxAge) {
            this.alive = false;
        }
    }

    /**
     * プレイヤーとの距離で取得判定
     */
    checkPickup(playerPos) {
        if (!this.alive || this.collected) return false;

        const dx = this.group.position.x - playerPos.x;
        const dz = this.group.position.z - playerPos.z;
        const distSq = dx * dx + dz * dz;

        if (distSq < 3.2 * 3.2) {
            this.collected = true;
            this.alive = false;
            return true;
        }
        return false;
    }

    /**
     * アイテム効果を適用
     */
    applyEffect(player) {
        // Metal Slug 原作準拠の弾数 (H=200, R=30, F=50, S=30)
        const weaponAmmo = { weapon_H: 200, weapon_R: 30, weapon_F: 50, weapon_S: 30 };
        // パワーアップの効果時間（秒）
        const powerDur = { power_BIG: 12, power_SPREAD: 14, power_FLAME: 10 };
        switch (this.type) {
            case 'health':
                player.hp = Math.min(player.hp + 30, player.maxHp);
                break;
            case 'grenade':
                // ボム補給: 2発補充
                player.grenadeCount = Math.min(player.grenadeCount + 2, player.maxGrenades);
                break;
            case 'score':
                return 300;  // 小コイン (原作: 100〜500 帯)
            case 'score_big':
                return 5000; // 大ボーナス (捕虜救出 reward 相当)
            default:
                if (this.type.startsWith('power_') && player.applyPowerUp) {
                    const code = this.type.split('_')[1];
                    player.applyPowerUp(code, powerDur[this.type] || 10);
                } else if (this.type.startsWith('weapon_') && player.equipSpecial) {
                    const code = this.type.split('_')[1];
                    player.equipSpecial(code, weaponAmmo[this.type] || 50);
                }
                break;
        }
        return 0;
    }

    destroy() {
        if (!this.alive && !this.group.parent) return;
        this.alive = false;
        this.scene.remove(this.group);
        this.group.traverse(child => {
            if (child.isMesh) {
                if (child.geometry && !(child.geometry.userData && child.geometry.userData.shared)) {
                    child.geometry.dispose();
                }
                if (child.material) {
                    const mats = Array.isArray(child.material) ? child.material : [child.material];
                    mats.forEach(m => {
                        if (m.map && m.map.dispose && !(m.map.userData && m.map.userData.shared)) m.map.dispose();
                        if (m.dispose && !(m.userData && m.userData.shared)) m.dispose();
                    });
                }
            }
        });
    }
}
