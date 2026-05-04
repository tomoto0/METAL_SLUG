import * as THREE from 'three';
import { Projectile } from './Projectile.js';

/**
 * 敵基底クラス
 * 全敵種の共通ロジック: HP管理, AI状態, 発砲, 被弾
 */
export class Enemy {
    constructor(scene, {
        position = new THREE.Vector3(),
        hp = 10,
        speed = 3,
        scoreValue = 100,
        fireRate = 1.5,
        damage = 5,
        type = 'infantry',
    }) {
        this.scene = scene;
        this.hp = hp;
        this.maxHp = hp;
        this.speed = speed;
        this.scoreValue = scoreValue;
        this.fireRate = fireRate;
        this.damage = damage;
        this.type = type;
        this.alive = true;
        this.lastFireTime = 0;
        this.projectiles = [];

        // 被弾フラッシュ
        this.flashTimer = 0;
        this.originalMaterials = [];

        this.group = new THREE.Group();
        this.group.position.copy(position);
    }

    /**
     * サブクラスで呼ぶ: メッシュ追加後にマテリアルを記録
     */
    _recordMaterials() {
        this.group.traverse(child => {
            if (child.isMesh) {
                this.originalMaterials.push({
                    mesh: child,
                    color: child.material.color.getHex(),
                });
            }
        });
    }

    /**
     * 被弾
     */
    takeDamage(amount) {
        if (!this.alive) return;
        this.hp -= amount;
        this.flashTimer = 0.1; // 赤フラッシュ

        // 赤く光らせる
        this.group.traverse(child => {
            if (child.isMesh && child.material.color) {
                child.material.color.setHex(0xFF3333);
            }
        });

        if (this.hp <= 0) {
            this.hp = 0;
            this.alive = false;
        }
    }

    /**
     * フラッシュ回復
     */
    _updateFlash(dt) {
        if (this.flashTimer > 0) {
            this.flashTimer -= dt;
            if (this.flashTimer <= 0) {
                // 元の色に復帰
                this.originalMaterials.forEach(entry => {
                    entry.mesh.material.color.setHex(entry.color);
                });
            }
        }
    }

    /**
     * 弾丸更新
     */
    _updateProjectiles(dt) {
        this.projectiles.forEach(p => p.update(dt));
        this.projectiles = this.projectiles.filter(p => p.alive || p.impactPending);
    }

    /**
     * プレイヤー方向への射撃（サブクラスがオーバーライド可能）
     */
    _fire(playerPos, elapsedTime) {
        if (elapsedTime - this.lastFireTime < this.fireRate) return;
        this.lastFireTime = elapsedTime;

        const muzzlePos = this.group.position.clone();
        muzzlePos.y += 0.8;

        const dir = new THREE.Vector3().subVectors(playerPos, muzzlePos);
        dir.y = 0;
        dir.normalize();

        const bullet = new Projectile(this.scene, {
            position: muzzlePos,
            direction: dir,
            speed: 15,
            damage: this.damage,
            owner: 'enemy',
            type: 'bullet',
            maxDistance: 60,
        });
        this.projectiles.push(bullet);
    }

    /**
     * 破壊時のクリーンアップ
     */
    destroy() {
        this.alive = false;
        this.scene.remove(this.group);
        this.group.traverse(child => {
            if (child.isMesh) {
                const g = child.geometry;
                if (g && !(g.userData && g.userData.shared)) g.dispose();
                const m = child.material;
                if (m && !(m.userData && m.userData.shared)) m.dispose();
            }
        });
        // 残弾も消す
        this.projectiles.forEach(p => p.destroy());
        this.projectiles = [];
        // _recordMaterials() で蓄えた mesh 参照を切る。
        // dispose 済みでも JS 側参照が残ると敵 1 体あたり数十 mesh 分の
        // クロージャが GC 対象にならず、長時間プレイで累積する。
        this.originalMaterials.length = 0;
    }

    getPosition() {
        return this.group.position;
    }

    /**
     * AABB当たり判定用Box3を返す
     */
    getBoundingBox() {
        const box = new THREE.Box3().setFromObject(this.group);
        return box;
    }

    /**
     * サブクラスが実装: update(dt, playerPos, elapsedTime)
     */
    update(dt, playerPos, elapsedTime) {
        this._updateFlash(dt);
        this._updateProjectiles(dt);
    }
}
