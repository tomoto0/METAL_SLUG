import * as THREE from 'three';

/**
 * 弾丸クラス
 * owner: 'player' or 'enemy'
 * type: 'bullet' | 'cannon' | 'rocket' | 'bomb'
 */

// 弾丸用の共有ジオメトリ・マテリアル（毎フレーム生成→GC負荷を解消）
// emissive を強めにして PointLight 無しでも視認性を確保
const _bulletGeo  = new THREE.SphereGeometry(0.1, 6, 4);
const _bulletMat  = new THREE.MeshBasicMaterial({ color: 0xFFEE44 });
const _trailBulletGeo = new THREE.CylinderGeometry(0.03, 0.07, 0.45, 4);
const _trailBulletMat = new THREE.MeshBasicMaterial({ color: 0xFFFF88, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false });

const _cannonGeo  = new THREE.CylinderGeometry(0.08, 0.13, 0.55, 8);
const _cannonMat  = new THREE.MeshBasicMaterial({ color: 0xFFAA44 });
const _cannonTrailGeo = new THREE.SphereGeometry(0.18, 6, 4);
const _cannonTrailMat = new THREE.MeshBasicMaterial({ color: 0x999999, transparent: true, opacity: 0.35, depthWrite: false });

const _rocketBodyGeo = new THREE.CylinderGeometry(0.06, 0.09, 0.65, 6);
const _rocketBodyMat = new THREE.MeshBasicMaterial({ color: 0x607030 });
const _rocketFlameGeo = new THREE.ConeGeometry(0.07, 0.35, 6);
const _rocketFlameMat = new THREE.MeshBasicMaterial({ color: 0xFF5500, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false });

const _bombGeo = new THREE.SphereGeometry(0.2, 8, 6);
const _bombMat = new THREE.MeshBasicMaterial({ color: 0x333333 });
const _bombFinGeo = new THREE.BoxGeometry(0.02, 0.15, 0.15);
const _bombFinMat = new THREE.MeshBasicMaterial({ color: 0x444444 });

const _SHARED_GEOMS = new Set([
    _bulletGeo, _trailBulletGeo, _cannonGeo, _cannonTrailGeo,
    _rocketBodyGeo, _rocketFlameGeo, _bombGeo, _bombFinGeo,
]);
const _SHARED_MATS = new Set([
    _bulletMat, _trailBulletMat, _cannonMat, _cannonTrailMat,
    _rocketBodyMat, _rocketFlameMat, _bombMat, _bombFinMat,
]);

export class Projectile {
    constructor(scene, {
        position,
        direction,
        speed = 40,
        damage = 10,
        owner = 'player',
        type = 'bullet',
        maxDistance = 120,
        gravity = 0,
        hitRadius,
        blastRadius,
        explosionVisual,
    }) {
        this.scene = scene;
        this.speed = speed;
        this.damage = damage;
        this.owner = owner;
        this.type = type;
        this.maxDistance = maxDistance;
        this.gravity = gravity;
        this.alive = true;
        this.distanceTraveled = 0;
        this.destroyed = false;
        this.previousPosition = position.clone();
        this.impactPending = false;
        this.impactPosition = position.clone();

        const defaults = this._getTypeDefaults(type);
        this.hitRadius = hitRadius ?? defaults.hitRadius;
        this.blastRadius = blastRadius ?? defaults.blastRadius;
        this.explosionVisual = explosionVisual ?? defaults.explosionVisual;
        this.explosive = this.blastRadius > 0;

        this.velocity = direction.clone().normalize().multiplyScalar(speed);
        this.group = new THREE.Group();
        this.group.position.copy(position);

        this._buildMesh();
        this.scene.add(this.group);
    }

    _getTypeDefaults(type) {
        switch (type) {
            case 'cannon':
                return { hitRadius: 0.4, blastRadius: 3.8, explosionVisual: 'large' };
            case 'rocket':
                return { hitRadius: 0.32, blastRadius: 2.8, explosionVisual: 'large' };
            case 'bomb':
                return { hitRadius: 0.34, blastRadius: 3.5, explosionVisual: 'large' };
            default:
                return { hitRadius: 0.18, blastRadius: 0, explosionVisual: 'small' };
        }
    }

    _buildMesh() {
        switch (this.type) {
            case 'cannon':
                this._buildCannon();
                break;
            case 'rocket':
                this._buildRocket();
                break;
            case 'bomb':
                this._buildBomb();
                break;
            default:
                this._buildBullet();
        }
    }

    /**
     * 通常弾（プレイヤーのバルカン砲弾）
     * 共有 geo/mat。MeshBasic + 加算ブレンドのトレイルで自照効果を再現。
     */
    _buildBullet() {
        const bullet = new THREE.Mesh(_bulletGeo, _bulletMat);
        bullet.scale.set(1, 1, 1.5);
        this.group.add(bullet);

        this.trail = new THREE.Mesh(_trailBulletGeo, _trailBulletMat);
        this.trail.rotation.z = Math.PI / 2;
        this.trail.position.x = -0.25;
        this.group.add(this.trail);
    }

    /**
     * 主砲弾
     */
    _buildCannon() {
        const shell = new THREE.Mesh(_cannonGeo, _cannonMat);
        shell.rotation.z = Math.PI / 2;
        this.group.add(shell);

        this.trail = new THREE.Mesh(_cannonTrailGeo, _cannonTrailMat);
        this.trail.position.x = -0.35;
        this.group.add(this.trail);
    }

    /**
     * ロケット弾
     */
    _buildRocket() {
        const body = new THREE.Mesh(_rocketBodyGeo, _rocketBodyMat);
        body.rotation.z = Math.PI / 2;
        this.group.add(body);

        this.trail = new THREE.Mesh(_rocketFlameGeo, _rocketFlameMat);
        this.trail.rotation.z = -Math.PI / 2;
        this.trail.position.x = -0.45;
        this.group.add(this.trail);
    }

    /**
     * 爆弾（重力で落下）
     */
    _buildBomb() {
        const bomb = new THREE.Mesh(_bombGeo, _bombMat);
        this.group.add(bomb);

        for (let i = 0; i < 4; i++) {
            const fin = new THREE.Mesh(_bombFinGeo, _bombFinMat);
            fin.position.y = 0.2;
            fin.rotation.y = (Math.PI / 2) * i;
            this.group.add(fin);
        }
    }

    update(dt) {
        if (!this.alive || this.impactPending) return;

        this.previousPosition.copy(this.group.position);

        // 重力適用（爆弾用）
        if (this.gravity > 0) {
            this.velocity.y -= this.gravity * dt;
        }

        // 移動
        const movement = this.velocity.clone().multiplyScalar(dt);
        this.group.position.add(movement);
        this.distanceTraveled += movement.length();

        // 弾の向きを速度方向に合わせる
        if (this.velocity.lengthSq() > 0) {
            const dir = this.velocity.clone().normalize();
            this.group.lookAt(
                this.group.position.x + dir.x,
                this.group.position.y + dir.y,
                this.group.position.z + dir.z
            );
        }

        // トレイルのフリッカー
        if (this.trail) {
            this.trail.scale.setScalar(0.8 + Math.random() * 0.4);
        }

        // 消滅条件
        if (this.distanceTraveled > this.maxDistance) {
            if (this.explosive) {
                this.markImpact(this.group.position);
            } else {
                this.destroy();
            }
            return;
        }
        // 地面に着弾
        if (this.group.position.y < 0) {
            if (this.explosive) {
                const impactPos = this.group.position.clone();
                impactPos.y = 0.15;
                this.markImpact(impactPos);
            } else {
                this.destroy();
            }
        }
    }

    markImpact(position = this.group.position) {
        if (this.impactPending || this.destroyed) return;
        this.impactPending = true;
        this.alive = false;
        this.impactPosition.copy(position);
        this.group.position.copy(position);
        this.group.visible = false;
    }

    destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        this.alive = false;
        this.impactPending = false;
        this.scene.remove(this.group);
        // 共有 geo/mat は破棄しない。それ以外（万一あれば）のみ解放。
        this.group.traverse(child => {
            if (child.isMesh) {
                if (child.geometry && !_SHARED_GEOMS.has(child.geometry)) child.geometry.dispose();
                if (child.material && !_SHARED_MATS.has(child.material)) child.material.dispose();
            }
        });
    }

    getPosition() {
        return this.group.position;
    }

    getBoundingSphere() {
        const radius = Math.max(this.hitRadius, this.type === 'bomb' ? 0.25 : (this.type === 'cannon' ? 0.15 : 0.12));
        return new THREE.Sphere(this.group.position, radius);
    }
}
