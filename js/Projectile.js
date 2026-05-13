import * as THREE from 'three';

/**
 * 弾丸クラス
 * owner: 'player' or 'enemy'
 * type: 'bullet' | 'cannon' | 'rocket' | 'bomb' | 'flame'
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

// ロケット弾: 弾頭・本体・尾翼・噴射炎を組み合わせて軍用ミサイル風に。
const _rocketBodyGeo = new THREE.CylinderGeometry(0.075, 0.075, 0.55, 10);
const _rocketBodyMat = new THREE.MeshBasicMaterial({ color: 0x5A6A35 });
const _rocketNoseGeo = new THREE.ConeGeometry(0.075, 0.22, 10);
const _rocketNoseMat = new THREE.MeshBasicMaterial({ color: 0x9A9A8A });
const _rocketBandGeo = new THREE.CylinderGeometry(0.078, 0.078, 0.04, 10);
const _rocketBandMat = new THREE.MeshBasicMaterial({ color: 0x2C2C20 });
// fin: 厚さ X / 半径方向 Y / ロケット軸方向(Z) の順
const _rocketFinGeo = new THREE.BoxGeometry(0.02, 0.10, 0.16);
const _rocketFinMat = new THREE.MeshBasicMaterial({ color: 0x3A3A2A });
const _rocketExhaustOuterGeo = new THREE.ConeGeometry(0.11, 0.45, 8);
const _rocketExhaustOuterMat = new THREE.MeshBasicMaterial({ color: 0xFF6622, transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false });
const _rocketExhaustCoreGeo = new THREE.ConeGeometry(0.055, 0.22, 6);
const _rocketExhaustCoreMat = new THREE.MeshBasicMaterial({ color: 0xFFFFCC, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false });
const _rocketSmokePuffGeo = new THREE.SphereGeometry(0.10, 6, 4);
const _rocketSmokePuffMat = new THREE.MeshBasicMaterial({ color: 0x666660, transparent: true, opacity: 0.35, depthWrite: false });

// 火炎放射弾: 多層の球で火球を表現。マテリアルは個別フェード用に都度生成。
const _flameCoreGeo  = new THREE.SphereGeometry(0.16, 8, 6);
const _flameMidGeo   = new THREE.SphereGeometry(0.26, 8, 6);
const _flameOuterGeo = new THREE.SphereGeometry(0.38, 8, 6);
const _flameSmokeGeo = new THREE.SphereGeometry(0.32, 6, 4);

const _bombGeo = new THREE.SphereGeometry(0.2, 8, 6);
const _bombMat = new THREE.MeshBasicMaterial({ color: 0x333333 });
const _bombFinGeo = new THREE.BoxGeometry(0.02, 0.15, 0.15);
const _bombFinMat = new THREE.MeshBasicMaterial({ color: 0x444444 });

const _SHARED_GEOMS = new Set([
    _bulletGeo, _trailBulletGeo, _cannonGeo, _cannonTrailGeo,
    _rocketBodyGeo, _rocketNoseGeo, _rocketBandGeo, _rocketFinGeo,
    _rocketExhaustOuterGeo, _rocketExhaustCoreGeo, _rocketSmokePuffGeo,
    _flameCoreGeo, _flameMidGeo, _flameOuterGeo, _flameSmokeGeo,
    _bombGeo, _bombFinGeo,
]);
const _SHARED_MATS = new Set([
    _bulletMat, _trailBulletMat, _cannonMat, _cannonTrailMat,
    _rocketBodyMat, _rocketNoseMat, _rocketBandMat, _rocketFinMat,
    _rocketExhaustOuterMat, _rocketExhaustCoreMat, _rocketSmokePuffMat,
    _bombMat, _bombFinMat,
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
            case 'flame':
                return { hitRadius: 0.35, blastRadius: 0, explosionVisual: 'small' };
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
            case 'flame':
                this._buildFlame();
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
     * 円筒本体 + 円錐弾頭 + 4枚尾翼 + 多層噴射炎。
     * Object3D.lookAt の規約に従い、local +Z を進行方向とする
     * （弾頭が飛翔方向を向く）。
     */
    _buildRocket() {
        // 本体（円筒の軸を Z に揃える）
        const body = new THREE.Mesh(_rocketBodyGeo, _rocketBodyMat);
        body.rotation.x = Math.PI / 2;
        this.group.add(body);

        // 弾頭（先端を +Z（進行方向）に向ける）
        const nose = new THREE.Mesh(_rocketNoseGeo, _rocketNoseMat);
        nose.rotation.x = Math.PI / 2;
        nose.position.z = 0.275 + 0.11; // 本体先端 + 円錐半長
        this.group.add(nose);

        // 装飾バンド（前後2本）
        const bandFront = new THREE.Mesh(_rocketBandGeo, _rocketBandMat);
        bandFront.rotation.x = Math.PI / 2;
        bandFront.position.z = 0.16;
        this.group.add(bandFront);
        const bandRear = new THREE.Mesh(_rocketBandGeo, _rocketBandMat);
        bandRear.rotation.x = Math.PI / 2;
        bandRear.position.z = -0.18;
        this.group.add(bandRear);

        // 尾翼 4枚（後部に放射状、Z軸まわりに 90°ずつ）
        for (let i = 0; i < 4; i++) {
            const angle = (Math.PI / 2) * i;
            const fin = new THREE.Mesh(_rocketFinGeo, _rocketFinMat);
            fin.rotation.z = angle;
            fin.position.x = -Math.sin(angle) * 0.10;
            fin.position.y = Math.cos(angle) * 0.10;
            fin.position.z = -0.22;
            this.group.add(fin);
        }

        // 噴射炎（外側オレンジ、先端を -Z（後方）へ）
        const exhaustOuter = new THREE.Mesh(_rocketExhaustOuterGeo, _rocketExhaustOuterMat);
        exhaustOuter.rotation.x = -Math.PI / 2;
        exhaustOuter.position.z = -0.50;
        this.group.add(exhaustOuter);

        // 噴射炎（内側白熱コア）
        const exhaustCore = new THREE.Mesh(_rocketExhaustCoreGeo, _rocketExhaustCoreMat);
        exhaustCore.rotation.x = -Math.PI / 2;
        exhaustCore.position.z = -0.42;
        this.group.add(exhaustCore);

        // 後方に薄煙
        const smoke = new THREE.Mesh(_rocketSmokePuffGeo, _rocketSmokePuffMat);
        smoke.position.z = -0.62;
        this.group.add(smoke);

        // 既存トレイルフリッカー処理が利くように
        this.trail = exhaustOuter;
        this.exhaustCore = exhaustCore;
        this.smokePuff = smoke;
    }

    /**
     * 火炎放射弾
     * 白熱核 + オレンジ中層 + 深紅外層 + 黒煙を加算合成で重ねた火球。
     * 個別にゆらめく/拡大/減衰させるため material は per-instance で生成。
     */
    _buildFlame() {
        this.flameLayers = [];

        const coreMat = new THREE.MeshBasicMaterial({
            color: 0xFFFFE0, transparent: true, opacity: 0.95,
            blending: THREE.AdditiveBlending, depthWrite: false,
        });
        const core = new THREE.Mesh(_flameCoreGeo, coreMat);
        this.group.add(core);
        this.flameLayers.push({ mesh: core, baseOpacity: 0.95 });

        const midMat = new THREE.MeshBasicMaterial({
            color: 0xFFB033, transparent: true, opacity: 0.75,
            blending: THREE.AdditiveBlending, depthWrite: false,
        });
        const mid = new THREE.Mesh(_flameMidGeo, midMat);
        this.group.add(mid);
        this.flameLayers.push({ mesh: mid, baseOpacity: 0.75 });

        const outerMat = new THREE.MeshBasicMaterial({
            color: 0xFF3A00, transparent: true, opacity: 0.50,
            blending: THREE.AdditiveBlending, depthWrite: false,
        });
        const outer = new THREE.Mesh(_flameOuterGeo, outerMat);
        this.group.add(outer);
        this.flameLayers.push({ mesh: outer, baseOpacity: 0.50 });

        // 後方の薄煙
        const smokeMat = new THREE.MeshBasicMaterial({
            color: 0x222018, transparent: true, opacity: 0.22, depthWrite: false,
        });
        const smoke = new THREE.Mesh(_flameSmokeGeo, smokeMat);
        smoke.position.x = -0.30;
        this.group.add(smoke);
        this.flameLayers.push({ mesh: smoke, baseOpacity: 0.22, isSmoke: true });
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

        // ロケットの噴射コア・煙パフ追従揺らぎ
        if (this.type === 'rocket') {
            if (this.exhaustCore) {
                this.exhaustCore.scale.setScalar(0.85 + Math.random() * 0.35);
            }
            if (this.smokePuff) {
                const s = 0.9 + Math.random() * 0.6;
                this.smokePuff.scale.setScalar(s);
                this.smokePuff.material.opacity = 0.20 + Math.random() * 0.20;
            }
        }

        // 火炎放射: 各層を成長＋ゆらぎ＋減衰
        if (this.type === 'flame' && this.flameLayers) {
            const t = Math.min(1, this.distanceTraveled / Math.max(1, this.maxDistance));
            const grow = 0.7 + t * 1.4; // 0.7 → 2.1
            for (const layer of this.flameLayers) {
                if (layer.isSmoke) {
                    const sg = 0.6 + t * 2.0;
                    layer.mesh.scale.setScalar(sg);
                    layer.mesh.material.opacity = layer.baseOpacity * Math.max(0, 1 - t * 0.5);
                } else {
                    const flicker = 0.85 + Math.random() * 0.35;
                    layer.mesh.scale.setScalar(grow * flicker);
                    const fade = Math.pow(1 - t, 1.1);
                    layer.mesh.material.opacity = layer.baseOpacity * Math.max(0.1, fade);
                    // 球の中心をわずかにジッターさせて揺らぎを出す
                    layer.mesh.position.y = (Math.random() - 0.5) * 0.08;
                    layer.mesh.position.z = (Math.random() - 0.5) * 0.08;
                }
            }
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
