import * as THREE from 'three';

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

        this.group.position.copy(position);
        this.group.position.y = 1.0;
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
        };
        this.glow = new THREE.PointLight(lightColors[type] || 0xFFFFFF, 0.8, 5);
        this.glow.position.set(0, 0.5, 0);
        this.group.add(this.glow);
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
            case 'score_big':
                this._buildScore();
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
        }
    }

    _buildWeaponIcon(letter, color) {
        const box = new THREE.Mesh(
            new THREE.BoxGeometry(0.7, 0.7, 0.7),
            new THREE.MeshStandardMaterial({
                color, emissive: new THREE.Color(color), emissiveIntensity: 0.4,
                roughness: 0.3, metalness: 0.5,
            })
        );
        this.group.add(box);

        // 枠リング
        const ring = new THREE.Mesh(
            new THREE.TorusGeometry(0.42, 0.06, 6, 12),
            new THREE.MeshStandardMaterial({ color: 0xFFFFFF, emissive: new THREE.Color(0xFFFFFF), emissiveIntensity: 0.5 })
        );
        ring.rotation.x = Math.PI / 2;
        this.group.add(ring);

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
                new THREE.PlaneGeometry(0.56, 0.56),
                new THREE.MeshBasicMaterial({ map: tex, transparent: true })
            );
            plate.position.z = 0.36 * zSign;
            if (zSign < 0) plate.rotation.y = Math.PI;
            this.group.add(plate);
        }
    }

    _buildHealth() {
        // 缶詰風のHP回復アイテム
        const canGeo = new THREE.CylinderGeometry(0.22, 0.22, 0.38, 8);
        const canMat = new THREE.MeshStandardMaterial({
            color: 0x33BB33,
            emissive: 0x115511,
            emissiveIntensity: 0.3,
            roughness: 0.35,
            metalness: 0.55,
        });
        const can = new THREE.Mesh(canGeo, canMat);
        this.group.add(can);

        // 十字マーク
        const crossH = new THREE.BoxGeometry(0.18, 0.06, 0.02);
        const crossV = new THREE.BoxGeometry(0.06, 0.18, 0.02);
        const crossMat = new THREE.MeshBasicMaterial({ color: 0xFFFFFF });
        const h = new THREE.Mesh(crossH, crossMat);
        const v = new THREE.Mesh(crossV, crossMat);
        h.position.z = 0.21;
        v.position.z = 0.21;
        this.group.add(h, v);
    }

    _buildGrenade() {
        // 弾薬箱
        const boxGeo = new THREE.BoxGeometry(0.3, 0.25, 0.2);
        const boxMat = new THREE.MeshStandardMaterial({
            color: 0x8B5A2B,
            roughness: 0.7,
        });
        const box = new THREE.Mesh(boxGeo, boxMat);
        this.group.add(box);

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

    _buildScore() {
        // ゴールドコイン
        const coinGeo = new THREE.CylinderGeometry(0.22, 0.22, 0.07, 14);
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
        this.group.position.y = 1.0 + Math.sin(this.age * 3) * 0.15;

        // 光の点滅
        if (this.glow) {
            this.glow.intensity = 0.5 + Math.sin(this.age * 5) * 0.3;
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

        if (distSq < 2.5 * 2.5) {
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
        switch (this.type) {
            case 'health':
                player.hp = Math.min(player.hp + 30, player.maxHp);
                break;
            case 'grenade':
                // 原作のボム補給は 10 発固定
                player.grenadeCount = Math.min(player.grenadeCount + 10, player.maxGrenades);
                break;
            case 'score':
                return 300;  // 小コイン (原作: 100〜500 帯)
            case 'score_big':
                return 5000; // 大ボーナス (捕虜救出 reward 相当)
            default:
                if (this.type.startsWith('weapon_') && player.equipSpecial) {
                    const code = this.type.split('_')[1];
                    player.equipSpecial(code, weaponAmmo[this.type] || 50);
                }
                break;
        }
        return 0;
    }

    destroy() {
        this.alive = false;
        this.scene.remove(this.group);
    }
}
